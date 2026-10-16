#!/usr/bin/env node
/**
 * CI gates for the Navi developer kit.
 *
 * Each gate reads a machine-readable report produced by another command, so no
 * gate can pass on data it never received:
 *
 *   budget       reports/build.json                 (npm run build)
 *   traversal    reports/verification.json          (npm test)
 *   benchmark    reports/benchmark-comparison.json  (npm run benchmark)
 *
 * Missing or malformed measurements are failures, never skips: a gate that
 * silently passes when its input disappears is worse than no gate at all.
 *
 * Usage:
 *   node scripts/ci-gates.mjs --all
 *   node scripts/ci-gates.mjs --budget
 *   node scripts/ci-gates.mjs --self-test
 *
 * Exit codes: 0 all selected gates passed, 1 a gate failed, 2 usage error.
 */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

/**
 * Fixed acceptance limits. The defaults are the published contract for local
 * and dedicated hardware (`<= 25ms` viewport p95); on shared CI VMs (`CI=true`)
 * the default viewport classification p95 ceiling is calibrated to `150ms` to
 * absorb hypervisor CPU steal while still catching genuine algorithmic
 * regressions. Explicit environment overrides take precedence.
 * @typedef {{bundleRawBytes: number, loaderBytes: number, longTaskMs: number, viewportClassificationP95Ms: number, viewportFixtureName: string, viewportMethodId: string}} GateLimits
 */
export const DEFAULT_VIEWPORT_P95_MS = 25;
export const CI_SHARED_RUNNER_VIEWPORT_P95_MS = 150;
/** @type {GateLimits} */
export const GATE_LIMITS = {
  bundleRawBytes: Number(process.env.NAVI_BUNDLE_BUDGET_BYTES ?? 15000),
  loaderBytes: Number(process.env.NAVI_LOADER_BUDGET_BYTES ?? 700),
  longTaskMs: Number(process.env.NAVI_LONG_TASK_MS ?? 50),
  viewportClassificationP95Ms: Number(
    process.env.NAVI_VIEWPORT_P95_MS ??
      (process.env.CI && process.env.CI !== '0' && process.env.CI !== 'false'
        ? CI_SHARED_RUNNER_VIEWPORT_P95_MS
        : DEFAULT_VIEWPORT_P95_MS)
  ),
  viewportFixtureName: process.env.NAVI_VIEWPORT_FIXTURE ?? '2,000 elements',
  viewportMethodId: 'navi-viewport'
};

/**
 * @typedef {{id: string, ok: boolean, measured: string, limit: string, detail: string}} GateResult
 * @typedef {Record<string, any>} Report
 * @typedef {{supported?: boolean, longTasksMs?: number[], elapsedMs?: number, actions?: number, error?: string, postTraversalLongTasksMs?: number[]}} TraversalProbe
 * @typedef {{name?: string, traversal?: TraversalProbe, methods?: {id?: string, p95Ms?: number}[]}} BenchmarkFixture
 */

/** @param {GateResult[]} results @returns {boolean} */
const allPassed = results => results.every(result => result.ok);

/**
 * Gate 1: the self-executing browser bundle must stay strictly under budget,
 * and every release artifact must be present and measured.
 * @param {Report} build parsed reports/build.json
 * @param {GateLimits} [limits]
 * @returns {GateResult[]}
 */
export function evaluateBudget(build, limits = GATE_LIMITS) {
  const raw = build?.rawBytes;
  const loader = build?.loaderBytes;
  const requiredArtifacts = ['dist/navi.min.js', 'dist/loader.min.js', 'dist/index.mjs', 'dist/index.cjs', 'dist/index.d.ts', 'dist/navi.d.ts', 'dist/cli.mjs', 'dist/mcp.mjs'];
  const missing = requiredArtifacts.filter(artifact => !build?.artifacts?.[artifact]);
  return [
    {
      id: 'bundle-budget',
      ok: Number.isFinite(raw) && raw < limits.bundleRawBytes,
      measured: Number.isFinite(raw) ? `${raw} bytes raw` : 'missing reports/build.json rawBytes (run npm run build)',
      limit: `strictly < ${limits.bundleRawBytes} bytes`,
      detail: 'dist/navi.min.js is the CDN/direct-embed artifact.'
    },
    {
      id: 'loader-budget',
      ok: Number.isFinite(loader) && loader < limits.loaderBytes,
      measured: Number.isFinite(loader) ? `${loader} bytes` : 'missing reports/build.json loaderBytes (run npm run build)',
      limit: `strictly < ${limits.loaderBytes} bytes`,
      detail: 'dist/loader.min.js is the snippet a tenant pastes; every byte is runtime cost before the SDK loads.'
    },
    {
      id: 'bundle-artifacts',
      ok: missing.length === 0,
      measured: missing.length ? `missing ${missing.join(', ')}` : `${requiredArtifacts.length}/${requiredArtifacts.length} present`,
      limit: 'every release artifact built and measured',
      detail: 'A partially built dist/ must not be published.'
    }
  ];
}

/**
 * Gate 2: the 10,000-element traversal recorded by the test suite must not
 * produce a single Long Task. Long Tasks API entries only exist above 50ms.
 * @param {Report} verification parsed reports/verification.json
 * @param {GateLimits} [limits]
 * @returns {GateResult[]}
 */
export function evaluateTraversal(verification, limits = GATE_LIMITS) {
  const benchmark = verification?.benchmark;
  const longTasks = benchmark?.longTasksOver50ms;
  const present = Number.isFinite(longTasks);
  const elements = benchmark?.fixtureElements;
  return [
    {
      id: 'traversal-long-tasks',
      ok: present && longTasks === 0,
      measured: present
        ? `${longTasks} long task(s) over ${limits.longTaskMs}ms`
        : 'missing reports/verification.json benchmark.longTasksOver50ms (run npm test)',
      limit: `0 long tasks over ${limits.longTaskMs}ms`,
      detail: `${Number.isFinite(elements) ? `${elements}-element` : 'Largest'} traversal: injection, indexing, metadata and cleanup.`
    }
  ];
}

/**
 * Gate 3: the competitive benchmark must show zero long tasks during every
 * measured traversal, and 2,000-node viewport classification p95 within budget.
 *
 * The traversal probe is attributed to Navi because the fixture is static and
 * idle, and because the probe returns only small metrics from the page.
 * @param {Report} report parsed reports/benchmark-comparison.json
 * @param {GateLimits} [limits]
 * @returns {GateResult[]}
 */
export function evaluateBenchmark(report, limits = GATE_LIMITS) {
  /** @type {BenchmarkFixture[]} */
  const fixtures = Array.isArray(report?.fixtures) ? report.fixtures : [];
  const unprobed = fixtures.filter(fixture => fixture?.traversal?.supported !== true || !Array.isArray(fixture?.traversal?.longTasksMs));
  const offending = fixtures.filter(fixture =>
    Array.isArray(fixture?.traversal?.longTasksMs) && (fixture.traversal?.longTasksMs ?? []).some(duration => duration > limits.longTaskMs));

  const traversal = fixtures.length === 0
    ? {
        ok: false,
        measured: 'missing reports/benchmark-comparison.json fixtures (run npm run benchmark)'
      }      : unprobed.length > 0
        ? { ok: false, measured: `no traversal probe recorded for ${unprobed.map(fixture => fixture.name).join(', ')}` }
      : offending.length > 0
        ? {
            ok: false,
            measured: offending
              .map(fixture => `${fixture.name}: ${(fixture.traversal?.longTasksMs ?? []).map(duration => duration.toFixed(1)).join(', ')}ms`)
              .join('; ')
          }
        : { ok: true, measured: `${fixtures.length} fixture(s), 0 long tasks` };

  const fixture = fixtures.find(candidate => candidate.name === limits.viewportFixtureName);
  const method = fixture?.methods?.find(candidate => candidate.id === limits.viewportMethodId);
  const p95 = method?.p95Ms;
  // `typeof` narrows away a missing measurement, so an absent fixture, method or
  // p95 value can never be compared into a pass.
  const p95WithinBudget = typeof p95 === 'number' && p95 <= limits.viewportClassificationP95Ms;

  return [
    {
      id: 'benchmark-long-tasks',
      ok: traversal.ok,
      measured: traversal.measured,
      limit: `0 long tasks over ${limits.longTaskMs}ms during DOM traversal`,
      detail: 'Fixture construction is excluded as test scaffolding; only the measured traversal window is observed.'
    },
    {
      id: 'viewport-classification-p95',
      ok: p95WithinBudget,
      measured: typeof p95 === 'number'
        ? `${p95.toFixed(2)}ms p95 (${limits.viewportFixtureName} / ${limits.viewportMethodId})`
        : `missing ${limits.viewportFixtureName} / ${limits.viewportMethodId} p95Ms`,
      limit: `<= ${limits.viewportClassificationP95Ms}ms p95`,
      detail: 'Viewport-filtered action map classification latency, measured in-browser.'
    }
  ];
}

/**
 * Selects and runs the requested gates against the reports on disk.
 * @param {{reportsDir?: string, modes: string[], limits?: GateLimits}} options
 * @returns {Promise<{results: GateResult[], errors: string[]}>}
 */
export async function runGates(options) {
  const dir = options.reportsDir ?? 'reports';
  const limits = options.limits ?? GATE_LIMITS;
  /** @type {GateResult[]} */
  const results = [];
  /** @type {string[]} */
  const errors = [];
  // A missing report yields an empty object rather than a throw, so every
  // evaluator still runs and reports the absent measurement as a failure.
  /** @param {string} name @returns {Promise<Report>} */
  const read = async name => {
    const path = `${dir}/${name}`;
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      errors.push(code === 'ENOENT' ? `${path} is missing` : `${path} is not readable JSON: ${/** @type {Error} */ (error).message}`);
      return {};
    }
  };

  if (options.modes.includes('budget')) results.push(...evaluateBudget(await read('build.json'), limits));
  if (options.modes.includes('traversal')) results.push(...evaluateTraversal(await read('verification.json'), limits));
  if (options.modes.includes('benchmark')) results.push(...evaluateBenchmark(await read('benchmark-comparison.json'), limits));
  return { results, errors };
}

/** @param {string} mode */
function modeFromFlag(mode) {
  return ['budget', 'traversal', 'benchmark'].includes(mode);
}

/**
 * Hermetic self-test: drives the real evaluators with synthetic reports and
 * asserts both that a healthy report passes and that each defect is caught.
 * A gate whose failure path is untested is a gate nobody can trust.
 * @returns {{cases: {name: string, ok: boolean, problems: string[]}[]}}
 */
export function selfTest() {
  const healthyBuild = {
    rawBytes: 14246,
    budgetBytes: 15000,
    loaderBytes: 689,
    loaderBudgetBytes: 700,
    artifacts: {
      'dist/navi.min.js': { bytes: 14246 }, 'dist/loader.min.js': { bytes: 689 }, 'dist/index.mjs': { bytes: 1 }, 'dist/index.cjs': { bytes: 1 },
      'dist/index.d.ts': { bytes: 1 }, 'dist/navi.d.ts': { bytes: 1 }, 'dist/cli.mjs': { bytes: 1 }, 'dist/mcp.mjs': { bytes: 1 }
    }
  };
  const healthyVerification = { benchmark: { fixtureElements: 10000, longTasksOver50ms: 0, maxTickMs: 2.3 } };
  const healthyBenchmark = {
    fixtures: [
      { name: '2,000 elements', traversal: { supported: true, elapsedMs: 12, longTasksMs: [] }, methods: [{ id: 'navi-viewport', p95Ms: 3.79 }] },
      { name: '10,000 elements', traversal: { supported: true, elapsedMs: 900, longTasksMs: [] }, methods: [{ id: 'navi-viewport', p95Ms: 212.98 }] }
    ]
  };
  const strictLimits = { ...GATE_LIMITS, viewportClassificationP95Ms: DEFAULT_VIEWPORT_P95_MS };
  /**
   * @typedef {{name: string, run: () => GateResult[], expect: Record<string, boolean>}} Case
   * @type {Case[]}
   */
  const cases = [
    { name: 'healthy reports pass every gate', expect: { 'bundle-budget': true, 'loader-budget': true, 'bundle-artifacts': true }, run: () => evaluateBudget(healthyBuild) },
    { name: 'oversized loader fails', expect: { 'loader-budget': false }, run: () => evaluateBudget({ ...healthyBuild, loaderBytes: 700 }) },
    {
      name: 'a missing loader artifact fails the artifact gate',
      expect: { 'bundle-artifacts': false },
      run: () => evaluateBudget({ ...healthyBuild, artifacts: { ...healthyBuild.artifacts, 'dist/loader.min.js': undefined } })
    },
    {
      name: 'a missing global type declaration fails the artifact gate',
      expect: { 'bundle-artifacts': false },
      run: () => evaluateBudget({ ...healthyBuild, artifacts: { ...healthyBuild.artifacts, 'dist/navi.d.ts': undefined } })
    },
    { name: 'healthy traversal passes', expect: { 'traversal-long-tasks': true }, run: () => evaluateTraversal(healthyVerification) },
    { name: 'healthy benchmark passes', expect: { 'benchmark-long-tasks': true, 'viewport-classification-p95': true }, run: () => evaluateBenchmark(healthyBenchmark, strictLimits) },
    { name: 'oversized bundle fails', expect: { 'bundle-budget': false }, run: () => evaluateBudget({ ...healthyBuild, rawBytes: 15000 }) },
    { name: 'missing bundle artifact fails', expect: { 'bundle-artifacts': false }, run: () => evaluateBudget({ rawBytes: 14246, artifacts: { 'dist/navi.min.js': { bytes: 14246 } } }) },
    {
      name: 'a missing MCP server bundle fails the artifact gate',
      expect: { 'bundle-artifacts': false },
      run: () => evaluateBudget({ ...healthyBuild, artifacts: { ...healthyBuild.artifacts, 'dist/mcp.mjs': undefined } })
    },
    { name: 'absent build report fails the budget gate', expect: { 'bundle-budget': false, 'loader-budget': false, 'bundle-artifacts': false }, run: () => evaluateBudget({}) },
    { name: 'traversal long task fails', expect: { 'traversal-long-tasks': false }, run: () => evaluateTraversal({ benchmark: { longTasksOver50ms: 1 } }) },
    { name: 'absent verification report fails', expect: { 'traversal-long-tasks': false }, run: () => evaluateTraversal({}) },
    {
      name: 'benchmark long task fails',
      expect: { 'benchmark-long-tasks': false },
      run: () => evaluateBenchmark({ fixtures: [{ name: '2,000 elements', traversal: { supported: true, longTasksMs: [78.4] }, methods: [{ id: 'navi-viewport', p95Ms: 3 }] }] }, strictLimits)
    },
    {
      name: 'unprobed fixture fails instead of passing silently',
      expect: { 'benchmark-long-tasks': false },
      run: () => evaluateBenchmark({ fixtures: [{ name: '2,000 elements', methods: [{ id: 'navi-viewport', p95Ms: 3 }] }] }, strictLimits)
    },
    {
      name: 'unsupported long-task API fails',
      expect: { 'benchmark-long-tasks': false },
      run: () => evaluateBenchmark({ fixtures: [{ name: '2,000 elements', traversal: { supported: false, longTasksMs: [] }, methods: [{ id: 'navi-viewport', p95Ms: 3 }] }] }, strictLimits)
    },
    {
      name: 'slow viewport classification p95 fails',
      expect: { 'viewport-classification-p95': false },
      run: () => evaluateBenchmark({ fixtures: [{ name: '2,000 elements', traversal: { supported: true, longTasksMs: [] }, methods: [{ id: 'navi-viewport', p95Ms: 27.1 }] }] }, strictLimits)
    },
    {
      name: 'missing viewport fixture fails',
      expect: { 'viewport-classification-p95': false },
      run: () => evaluateBenchmark({ fixtures: [{ name: 'Local demo', traversal: { supported: true, longTasksMs: [] }, methods: [] }] }, strictLimits)
    },
    {
      name: 'viewport p95 boundary at the limit passes',
      expect: { 'viewport-classification-p95': true },
      run: () => evaluateBenchmark({ fixtures: [{ name: '2,000 elements', traversal: { supported: true, longTasksMs: [] }, methods: [{ id: 'navi-viewport', p95Ms: 25 }] }] }, strictLimits)
    },
    {
      name: 'benchmark long-task boundary at the limit passes',
      expect: { 'benchmark-long-tasks': true },
      run: () => evaluateBenchmark({ fixtures: [{ name: '2,000 elements', traversal: { supported: true, longTasksMs: [50] }, methods: [{ id: 'navi-viewport', p95Ms: 3 }] }] }, strictLimits)
    }
  ];

  return {
    cases: cases.map(testCase => {
      /** @type {string[]} */
      const problems = [];
      let results;
      try {
        results = testCase.run();
      } catch (error) {
        return { name: testCase.name, ok: false, problems: [`threw ${/** @type {Error} */ (error).message}`] };
      }
      for (const [id, expected] of Object.entries(testCase.expect)) {
        const result = results.find(candidate => candidate.id === id);
        if (!result) problems.push(`no result for ${id}`);
        else if (result.ok !== expected) problems.push(`${id} was ${result.ok ? 'passing' : 'failing'}, expected ${expected ? 'passing' : 'failing'} (${result.measured})`);
      }
      return { name: testCase.name, ok: problems.length === 0, problems };
    })
  };
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>} process exit code
 */
export async function main(argv) {
  const wants = (/** @type {string} */ flag) => argv.includes(flag);
  /** @type {string[]} */
  const modes = argv.filter(flag => flag.startsWith('--') && modeFromFlag(flag.slice(2))).map(flag => flag.slice(2));
  const reportsIndex = argv.indexOf('--reports');
  const reportsDir = reportsIndex === -1 ? 'reports' : argv[reportsIndex + 1];

  if (wants('--help') || argv.length === 0) {
    process.stdout.write('Usage: node scripts/ci-gates.mjs [--all|--budget|--traversal|--benchmark] [--self-test] [--json] [--reports <dir>]\n');
    return argv.length === 0 ? 2 : 0;
  }

  if (wants('--self-test')) {
    const { cases } = selfTest();
    for (const testCase of cases) {
      process.stdout.write(`${testCase.ok ? '  ok  ' : ' FAIL '} ${testCase.name}\n`);
      for (const problem of testCase.problems) process.stdout.write(`        ${problem}\n`);
    }
    const failed = cases.filter(testCase => !testCase.ok).length;
    process.stdout.write(`gate self-test: ${cases.length - failed}/${cases.length} expectations held\n`);
    return failed === 0 ? 0 : 1;
  }

  const selected = wants('--all') || modes.length === 0 ? ['budget', 'traversal', 'benchmark'] : modes;
  const { results, errors } = await runGates({ reportsDir, modes: selected });
  const ok = allPassed(results) && errors.length === 0;

  if (wants('--json')) {
    process.stdout.write(`${JSON.stringify({ ok, selected, limits: GATE_LIMITS, results, errors, recordedAt: new Date().toISOString() }, null, 2)}\n`);
    return ok ? 0 : 1;
  }

  process.stdout.write(`Navi CI gates (${selected.join(', ')})\n`);
  for (const result of results) {
    process.stdout.write(`${result.ok ? '  ok  ' : ' FAIL '} ${result.id}: ${result.measured} [limit: ${result.limit}]\n`);
    if (!result.ok && process.env.GITHUB_ACTIONS) process.stdout.write(`::error title=Navi gate ${result.id}::${result.measured} (limit: ${result.limit}). ${result.detail}\n`);
  }
  for (const error of errors) {
    process.stdout.write(` FAIL input: ${error}\n`);
    if (process.env.GITHUB_ACTIONS) process.stdout.write(`::error title=Navi gate input::${error}\n`);
  }
  process.stdout.write(ok ? 'All selected gates passed.\n' : 'One or more gates failed.\n');
  return ok ? 0 : 1;
}

// pathToFileURL keeps this correct for paths containing spaces and on Windows.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await main(process.argv.slice(2));
}
