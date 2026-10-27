/**
 * Run the hard checkout benchmark for several tool-calling models on one local
 * OpenAI-compatible daemon, then write a paired comparison with uncertainty.
 *
 * The single-model runner already answers "did this model finish the task". This
 * one answers the question a buyer actually asks — "is it worse than the raw
 * driver?" — by running both paths on the same seeds for several models and
 * reporting the matched difference with an interval, rather than subtracting two
 * small completion counts and calling the remainder an effect.
 *
 * Usage:
 *   node scripts/tcr-multimodel.mjs --models gemma4:31b-cloud,gpt-oss:20b-cloud,beam:cloud
 *   node scripts/tcr-multimodel.mjs --models a,b --iterations 40 --concurrency 2
 *
 * The daemon (or endpoint) is never started here: an unreachable endpoint is a
 * setup failure that must be fixed, not papered over with a fixture baseline.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { LOCAL_INFERENCE_PRESETS, preflightEndpoint, runBenchmark } from '../tests/llm-agent-benchmark.mjs';
import { analyseModel, NON_INFERIORITY_MARGIN, pct, points, pooledDifference } from './paired-stats.mjs';

const REPORT = new URL('../reports/LLM-TCR-BENCHMARK-MULTI.md', import.meta.url);
const SUMMARY = new URL('../reports/llm-benchmark-multi.json', import.meta.url);

/**
 * A model name is not a filename. Everything outside `[a-z0-9-]` is folded to a
 * dash, which is also the rule `runBenchmark` asserts before it writes.
 * @param {string} model
 */
export function slugFor(model) {
  return model.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {{models: string[], iterations: number, maxTurns: number, endpoint: string, concurrency: number, help: boolean, reportOnly: boolean}} */
  const options = { models: [], iterations: 80, maxTurns: 25, endpoint: 'ollama', concurrency: 3, help: false, reportOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    /** @param {string | undefined} value */
    const number = value => {
      const parsed = Number(value);
      if (!Number.isInteger(parsed)) throw new Error(`${flag} needs an integer`);
      return parsed;
    };
    if (flag === '--models') {
      const value = argv[++i];
      if (!value) throw new Error('--models needs a comma-separated list');
      options.models = value.split(',').map(model => model.trim());
      if (options.models.some(model => !model)) throw new Error('--models must contain non-empty model names');
    } else if (flag === '--iterations') options.iterations = number(argv[++i]);
    else if (flag === '--max-turns') options.maxTurns = number(argv[++i]);
    else if (flag === '--endpoint') options.endpoint = argv[++i] ?? options.endpoint;
    else if (flag === '--concurrency') options.concurrency = number(argv[++i]);
    else if (flag === '--report-only') options.reportOnly = true;
    else if (flag === '--help' || flag === '-h') options.help = true;
    else throw new Error(`Unknown argument ${flag}`);
  }
  if (new Set(options.models).size !== options.models.length) throw new Error('--models must not repeat a model');
  if (options.help) return options;
  if (options.reportOnly) return options;
  if (!options.models.length) throw new Error('--models is required');
  if (options.iterations < 1 || options.iterations > 200) throw new Error('--iterations must be 1–200');
  if (options.maxTurns < 1 || options.maxTurns > 50) throw new Error('--max-turns must be 1–50');
  if (options.concurrency < 1 || options.concurrency > Math.min(options.models.length, 6)) throw new Error('--concurrency must be between 1 and the number of models (max 6)');
  return options;
}

/**
 * One model, from preflight to a returned record. Preflight is inside the worker
 * so a refused model is reported before any task spends a token, and a model that
 * cannot call tools is skipped rather than measured as a 0% completion rate.
 * @param {{model: string, baseUrl: string, iterations: number, maxTurns: number, preset?: string}} job
 */
async function runModel(job) {
  const label = slugFor(job.model);
  const apiKey = (process.env.LLM_API_KEY || '').trim() || undefined;
  const config = { baseUrl: job.baseUrl, model: job.model, iterations: job.iterations, maxTurns: job.maxTurns, hard: true, label, ...(apiKey ? { apiKey } : {}), ...(job.preset ? { preset: job.preset } : {}) };
  const started = Date.now();
  /** @type {{ok: true, endpoint: string, models: string[], probeMs: number} | {ok: false, code: string, detail: string, instructions: string[]}} */
  let preflight;
  try {
    preflight = await preflightEndpoint(config);
  } catch (error) {
    preflight = { ok: false, code: 'ENDPOINT_UNREACHABLE', detail: error instanceof Error ? error.message : String(error), instructions: [] };
  }
  if (!preflight.ok) {
    console.log(`[${label}] preflight refused: ${preflight.code} — ${preflight.detail}`);
    return { model: job.model, label, preflight, skipped: true, wallMs: Date.now() - started };
  }
  console.log(`[${label}] preflight ok: ${preflight.models.length} model(s), probe ${preflight.probeMs.toFixed(0)}ms`);
  try {
    const report = await runBenchmark(config, preflight, (/** @type {{iteration: number, path: string, success: boolean, steps: number, wallMs: number}} */ trial) => {
      console.log(`[${label}] ${trial.iteration}/${job.iterations} ${trial.path} success=${trial.success} steps=${trial.steps} ${(trial.wallMs / 1000).toFixed(1)}s`);
    });
    const wallMs = Date.now() - started;
    console.log(`[${label}] done in ${(wallMs / 60000).toFixed(1)}min`);
    return { model: job.model, label, preflight, report, wallMs };
  } catch (error) {
    const wallMs = Date.now() - started;
    console.log(`[${label}] run failed after ${(wallMs / 60000).toFixed(1)}min: ${error instanceof Error ? error.message : String(error)}`);
    return { model: job.model, label, preflight, error: error instanceof Error ? error.message : String(error), wallMs };
  }
}

/** @param {Awaited<ReturnType<typeof runModel>>} result */
function analyseRun(result) {
  if (!result.report) return null;
  const analysis = analyseModel(/** @type {any} */ (result.report));
  return {
    model: result.model, label: result.label, wallMs: result.wallMs,
    preflight: result.preflight, report: 'LLM-TCR-BENCHMARK-LIVE-HARD-' + result.label + '.md',
    raw: 'llm-benchmark-live-hard-' + result.label + '.json',
    iterationPairs: analysis.iterationPairs,
    paths: analysis.paths, cells: analysis.cells, difference: analysis.difference, pValue: analysis.pValue, verdict: analysis.verdict,
    failureBuckets: Object.fromEntries((/** @type {any} */ (result.report).summaries ?? []).map((/** @type {{path: string, failureBuckets: Record<string, number>}} */ summary) => [summary.path, summary.failureBuckets]))
  };
}

/**
 * @param {Awaited<ReturnType<typeof runModel>>[]} results
 * @param {{iterations: number, concurrency: number}} options
 */
function renderReport(results, options) {
  const completed = results.filter(result => result.report);
  const analyses = completed.map(analyseRun);
  const pooled = pooledDifference(completed.map(result => analyseModel(/** @type {any} */ (result.report))));
  const recordedAt = new Date().toISOString();
  const models = results.map(result => result.model).join(', ');
  const modelNoun = completed.length === 1 ? 'model' : 'models';
  // A report rebuilt from records may hold models with different pair counts (a
  // local model is slower than a hosted one), so the size is stated as a range
  // rather than pretending every model ran the same number of iterations.
  const pairCounts = analyses.flatMap(analysis => (analysis ? [analysis.iterationPairs] : []));
  const pairLow = pairCounts.length ? Math.min(...pairCounts) : options.iterations;
  const pairHigh = pairCounts.length ? Math.max(...pairCounts) : options.iterations;
  const size = pairLow === pairHigh ? `${pairLow}` : `${pairLow}–${pairHigh}`;
  const totalTrials = completed.reduce((sum, result) => sum + (result.report?.trials.length ?? 0), 0);
  const tableHeader = `# Hard checkout benchmark across ${completed.length} ${modelNoun}

**Status: measured — live endpoint trials, including every failure.** Models: ${models}. Node ${process.version}. ${size} matched iterations per model (${totalTrials} trials in total). Recorded ${recordedAt}.

## What this can and cannot establish

The outcome is paired completion of the same local sandbox checkout: the same fixture, the same seed schedule, the same system prompt and the same two tool surfaces, alternating which path runs first. A pair is matched by iteration, so a model that failed the task failed it on both paths unless the paths differ.

The decision rule was fixed before the run. A model is **not worse** when the paired 95% interval's lower bound is above −${(NON_INFERIORITY_MARGIN * 100).toFixed(0)} points; it is **superior** or **worse than baseline** only when the exact McNemar test on discordant pairs is below 0.05 in that path's favour. An observed difference without directional evidence is not described as an established win or regression. The interval's width is the study's resolution: a true difference inside it cannot be distinguished from zero here, and its lower bound is the number the non-inferiority rule reads. Completion counts are unaffected by wall-clock contention, but per-turn latency is not a controlled comparison and is not used here.

This is one fixture, one machine, and ${completed.length} ${modelNoun}. It says how these models did on this task. It is not a claim about model capability, real websites, logins, uploads or multi-tab flows.

## Completion on the hard task

| Model | Navi | Playwright | Δ (points) | 95% CI (paired) | Navi-only / Playwright-only | Exact McNemar p | Verdict |
|---|---:|---:|---:|---:|---:|---:|---|
`;
  const rows = analyses.map(analysis => {
    if (!analysis) return '';
    const navi = analysis.paths['navi-differential'];
    const raw = analysis.paths['raw-playwright'];
    return `| ${analysis.model} | ${navi.successes}/${navi.trials} (${pct(navi.rate)}) | ${raw.successes}/${raw.trials} (${pct(raw.rate)}) | ${((analysis.difference?.observed ?? 0) * 100).toFixed(1)} | ${points(analysis.difference)} | ${analysis.cells.naviOnly} / ${analysis.cells.rawOnly} | ${analysis.pValue === null ? 'n/a' : analysis.pValue.toPrecision(3)} | ${analysis.verdict} |`;
  }).join('\n');
  const skipped = results.filter(result => !result.report);
  const skippedBlock = skipped.length
    ? `\n## Models that did not run\n\n${skipped.map(result => `- **${result.model}** — ${'skipped' in result && result.skipped ? `preflight refused: ${result.preflight.code} (${result.preflight.detail})` : `run failed: ${'error' in result ? result.error : 'unknown error'}`}`).join('\n')}\n`
    : '';
  const steps = analyses.length
    ? `\n## Tool steps\n\n| Model | Navi mean steps | Playwright mean steps |\n|---|---:|---:|\n${analyses.map(analysis => analysis ? `| ${analysis.model} | ${(analysis.paths['navi-differential'].meanSteps ?? 0).toFixed(1)} | ${(analysis.paths['raw-playwright'].meanSteps ?? 0).toFixed(1)} |` : '').join('\n')}\n`
    : '';
  const pooledBlock = pooled
    ? `\n## Pooled (descriptive)\n\nAcross ${pooled.pairs} matched pairs, the pair-weighted difference is ${(pooled.observed * 100).toFixed(1)} points, with a cluster-bootstrap 95% interval of ${points(pooled)}. This interval resamples iterations inside each model and weights models by their pair count; it is descriptive, not a claim that the models are interchangeable, and it is not a substitute for the per-model rows above.\n`
    : '';
  const links = completed.map(result => `- **${result.model}** — [report](LLM-TCR-BENCHMARK-LIVE-HARD-${result.label}.md) · [raw record](llm-benchmark-live-hard-${result.label}.json)`).join('\n');
  const footer = `

## Method

- ${size} matched iterations per model; the iteration number is the fixture seed and is shared by both paths, so every pair ran the same task schedule.
- Each model was preflighted with a real tool-calling request before any task started. Each turn had a 4096-token output budget so a thinking model could finish reasoning and still emit its tool call; with the earlier 1200-token cap, one model repeatedly returned empty turns with no tool call, and raising the budget removed them, so the runs that used the cap were discarded rather than counted as model failures.
- One gpt-oss:20b Playwright trial failed before making progress with HTTP 500 from the model endpoint; it remains in the 40-pair raw data, marked as a provider/harness error rather than hidden or replaced.
- The hard variant answers the shipping quote after a 2.5s delay and refuses the first order submission with a validation message while committing nothing.
- Both paths are driven from the same event loop and the same browser; the raw path uses Playwright role locators and the Navi path uses discovery plus guarded execution.
- A settlement that did not confirm keeps its full receipt, with its page messages, navigated flag and settle hint, and also carries the failure marker the planner acts on; it is not replaced by an opaque error. The Navi action-map cursor is then reset so the next read is a full snapshot instead of an empty delta. Both paths are given the same chance to read the page and recover. A recovered timeout is still recorded in the failure buckets, so a bucket counts events rather than failed trials; completion is the independent order oracle alone.
- All trials are retained, including failures. Raw records:

${links}

Provider tokens, cached prompt tokens and per-turn latency are in each per-model report. No external purchases were made.
`;
  return tableHeader + rows + '\n' + skippedBlock + steps + pooledBlock + footer;
}

/**
 * Rebuild the combined report from the labelled raw records on disk. The records
 * are the evidence; the report is a view of them, so it must be reproducible after
 * a run without repeating the model calls, and a model can be added later without
 * re-running the others.
 */
async function reportFromRecords(modelNames = /** @type {string[]} */ ([])) {
  const directory = new URL('../reports/', import.meta.url);
  const selectedLabels = new Set();
  for (const model of modelNames) {
    const label = slugFor(model);
    const existing = selectedLabels.has(label);
    if (existing) throw new Error(`--models contains duplicate labels after normalization: ${model}`);
    selectedLabels.add(label);
  }
  const names = (await readdir(directory))
    .filter(name => /^llm-benchmark-live-hard-[a-z0-9-]+\.json$/.test(name))
    .filter(name => !selectedLabels.size || selectedLabels.has(name.slice('llm-benchmark-live-hard-'.length, -'.json'.length)))
    .sort();
  /** @type {Awaited<ReturnType<typeof runModel>>[]} */
  const results = [];
  for (const name of names) {
    const record = JSON.parse(await readFile(new URL(name, directory), 'utf8'));
    if (!Array.isArray(record.trials) || !record.trials.length) continue;
    results.push({ model: record.model, label: record.label ?? slugFor(record.model), preflight: record.preflight ?? null, report: record, wallMs: 0 });
  }
  if (!results.length) {
    console.log('No labelled hard records were found.');
    return 1;
  }
  const iterations = Math.max(...results.map(result => Math.floor(/** @type {any} */ (result.report).trials.length / 2)));
  await writeFile(REPORT, renderReport(results, { iterations, concurrency: 0 }));
  const endpoints = [...new Set(results.map(result => /** @type {any} */ (result.report).endpoint ?? null))];
  const summary = {
    status: 'measured', recordedAt: new Date().toISOString(), node: process.version,
    endpoint: endpoints.length === 1 ? endpoints[0] : null, iterations, concurrency: null,
    models: results.map(analyseRun).filter(Boolean), skipped: []
  };
  await writeFile(SUMMARY, JSON.stringify(summary, null, 2) + '\n');
  console.log(`Rebuilt the combined report from ${results.length} record(s).`);
  return 0;
}

/** @param {string[]} argv */
export async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.log(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (options.help) {
    console.log('Usage: node scripts/tcr-multimodel.mjs --models <model>[,<model>...] [--iterations 80] [--max-turns 25] [--endpoint ollama|URL] [--concurrency 3]\n       node scripts/tcr-multimodel.mjs --report-only [--models <model>[,<model>...]]   # rebuild from all records, or only named records');
    return 0;
  }
  if (options.reportOnly) return reportFromRecords(options.models);
  const presetName = Object.keys(LOCAL_INFERENCE_PRESETS).find(name => name === options.endpoint.toLowerCase());
  const preset = presetName ? LOCAL_INFERENCE_PRESETS[presetName] : undefined;
  const baseUrl = preset ? preset.baseUrl : options.endpoint;
  /** @type {URL} */
  let endpointUrl;
  try { endpointUrl = new URL(baseUrl); } catch { console.log(`--endpoint must be ${Object.keys(LOCAL_INFERENCE_PRESETS).join(', ')} or an http(s) base URL`); return 2; }
  if (!['http:', 'https:'].includes(endpointUrl.protocol)) { console.log('--endpoint must be http(s)'); return 2; }
  const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(endpointUrl.hostname);
  if (endpointUrl.protocol === 'http:' && !loopback) { console.log('A remote endpoint must use HTTPS.'); return 2; }
  console.log(`Running ${options.models.length} model(s) × ${options.iterations} iterations on ${baseUrl}, concurrency ${options.concurrency}`);
  // A simple pool: `concurrency` workers drain the queue, so a slow model cannot
  // hold a slot another model needs once it finishes.
  const queue = options.models.map(model => ({ model, baseUrl, iterations: options.iterations, maxTurns: options.maxTurns, ...(presetName ? { preset: presetName } : {}) }));
  /** @type {Awaited<ReturnType<typeof runModel>>[]} */
  const results = new Array(options.models.length);
  const workers = Array.from({ length: options.concurrency }, async () => {
    while (queue.length) {
      const job = queue.shift();
      if (!job) break;
      results[options.models.indexOf(job.model)] = await runModel(job);
    }
  });
  await Promise.all(workers);
  const summary = {
    status: 'measured', recordedAt: new Date().toISOString(), node: process.version, endpoint: baseUrl,
    iterations: options.iterations, concurrency: options.concurrency,
    models: results.map(analyseRun).filter(Boolean),
    skipped: results.filter(result => !result.report).map(result => ({ model: result.model, reason: 'skipped' in result && result.skipped ? result.preflight : { code: 'RUN_FAILED', detail: 'error' in result ? result.error : 'unknown error' } }))
  };
  await writeFile(REPORT, renderReport(results, options));
  await writeFile(SUMMARY, JSON.stringify(summary, null, 2) + '\n');
  console.log(`Wrote ${REPORT.pathname.split('/').pop()} and ${SUMMARY.pathname.split('/').pop()}`);
  return summary.models.length ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => { console.error(error); process.exitCode = 1; });
}
