// Standalone agent harness. Runs a reviewed JSON flow against any http(s) URL
// using the Navi adapter, or inspects the action dictionary without executing.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { NaviPlaywrightAdapter, NAVI_PROTOCOL_VERSION } from './adapter.js';
import { runFlow, validateFlow } from './flow.js';
import { ensureNavi, isAllowedUrl, resolveChromium, resolveSdkPath } from './browser.js';

// Re-exported for existing consumers of the CLI module.
export { isAllowedUrl };

export const EXIT = { OK: 0, FAILED: 1, USAGE: 2, ENVIRONMENT: 3 };
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const HELP = `navi · agent harness for the Navi protocol

Usage
  navi run --url <url> --action-file <flow.json> [options]
  navi discover --url <url> [--json]

Options
  --url <url>              Target http(s) URL. Required unless the flow declares one.
  --action-file <path>     JSON flow file (see flows/example-checkout.json).
  --timeout <ms>           Per-step timeout, 1-120000. Default 15000.
  --viewport <WxH>         Browser viewport. Default 1360x900.
  --headed                 Run with a visible browser window.
  --json                   Print the machine-readable report only.
  --report <path>          Also write the JSON report to a file.
  --discover               With run: print targets and exit without executing.
  --allow-consequential    Permit steps marked "consequential": true.
  --strict-synthetic       Never fall back to native driver input.
  --quiet                  Suppress per-step lines.
  --help, --version

Exit codes
  0 success   1 flow or assertion failure   2 usage or invalid flow   3 environment failure

Safety
  Flows are untrusted input: they are schema-validated, never eval'd, and steps
  marked consequential require --allow-consequential. Failed or timed-out actions
  are reported, never retried automatically, because they may already have applied.
`;

/** @typedef {{command:'run'|'discover'|'help'|'version'|null,url?:string,actionFile?:string,timeoutMs:number,viewport:{width:number,height:number},headed:boolean,json:boolean,report?:string,discoverOnly:boolean,allowConsequential:boolean,fallback:boolean,quiet:boolean,errors:string[]}} Options */

/** @param {string[]} argv @returns {Options} */
export function parseArgs(argv) {
  /** @type {Options} */
  const options = { command: null, timeoutMs: 15000, viewport: { width: 1360, height: 900 }, headed: false, json: false, discoverOnly: false, allowConsequential: false, fallback: true, quiet: false, errors: [] };
  const list = [...argv];
  if (list[0] === 'run' || list[0] === 'discover') options.command = /** @type {'run'|'discover'} */ (list.shift());
  else if (list.includes('--help') || list.includes('-h')) { options.command = 'help'; return options; }
  else if (list.includes('--version') || list.includes('-v')) { options.command = 'version'; return options; }
  else if (list.length) options.command = 'run';
  while (list.length) {
    const flag = /** @type {string} */ (list.shift());
    /** @param {string} name */
    const value = (name) => {
      const next = list.shift();
      if (next === undefined || next.startsWith('--')) options.errors.push(`${name} requires a value`);
      return next || '';
    };
    switch (flag) {
      case '--url': options.url = value('--url'); break;
      case '--action-file': case '--flow': case '-f': options.actionFile = value(flag); break;
      case '--report': options.report = value('--report'); break;
      case '--timeout': {
        const raw = Number(value('--timeout'));
        if (!Number.isFinite(raw) || raw < 1 || raw > 120000) options.errors.push('--timeout must be a number between 1 and 120000');
        else options.timeoutMs = Math.floor(raw);
        break;
      }
      case '--viewport': {
        const match = /^(\d{3,5})x(\d{3,5})$/.exec(value('--viewport'));
        if (!match) options.errors.push('--viewport must look like 1360x900');
        else options.viewport = { width: Number(match[1]), height: Number(match[2]) };
        break;
      }
      case '--headed': options.headed = true; break;
      case '--json': options.json = true; break;
      case '--discover': options.discoverOnly = true; break;
      case '--allow-consequential': options.allowConsequential = true; break;
      case '--strict-synthetic': options.fallback = false; break;
      case '--quiet': options.quiet = true; break;
      default: options.errors.push(`unknown argument "${flag}"`);
    }
  }
  if (options.url && !isAllowedUrl(options.url)) options.errors.push('--url must be an http(s) URL without embedded credentials');
  if (options.command === 'discover' && !options.url) options.errors.push('discover requires --url');
  if (options.command === 'run' && !options.url && !options.actionFile) options.errors.push('run requires --url, --action-file, or both');
  return options;
}

/** @param {string} text */
function parseFlowDocument(text) {
  return JSON.parse(text, (key, value) => {
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`flow JSON contains forbidden key "${key}"`);
    return value;
  });
}

async function packageVersion() {
  try {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    return String(manifest.version || NAVI_PROTOCOL_VERSION);
  } catch { return NAVI_PROTOCOL_VERSION; }
}

/** @param {string | undefined} target */
function describeUrl(target) {
  try { return new URL(/** @type {string} */ (target)).origin; } catch { return target || ''; }
}

/**
 * @param {string[]} argv
 * @param {{stdout?: (line: string) => void, stderr?: (line: string) => void}} [io]
 * @returns {Promise<number>} process exit code
 */
export async function main(argv, io = {}) {
  const out = io.stdout || ((/** @type {string} */ line) => process.stdout.write(line + '\n'));
  const err = io.stderr || ((/** @type {string} */ line) => process.stderr.write(line + '\n'));
  const options = parseArgs(argv);
  if (options.command === 'help' || !options.command) { out(HELP); return options.command === 'help' ? EXIT.OK : EXIT.USAGE; }
  if (options.command === 'version') { out(await packageVersion()); return EXIT.OK; }
  if (options.errors.length) { for (const message of options.errors) err(`error: ${message}`); err('Run "navi --help" for usage.'); return EXIT.USAGE; }

  /** @type {ReturnType<typeof validateFlow> | null} */
  let validated = null;
  if (options.actionFile) {
    let text;
    try { text = await readFile(isAbsolute(options.actionFile) ? options.actionFile : resolve(process.cwd(), options.actionFile), 'utf8'); }
    catch (error) { err(`error: cannot read flow file ${options.actionFile}: ${/** @type {Error} */ (error).message}`); return EXIT.USAGE; }
    let document;
    try { document = parseFlowDocument(text); }
    catch (error) { err(`error: invalid flow JSON: ${/** @type {Error} */ (error).message}`); return EXIT.USAGE; }
    validated = validateFlow(document);
    if (!validated.ok) { for (const message of validated.errors) err(`error: ${message}`); return EXIT.USAGE; }
  }
  const flowUrl = validated?.flow.url;
  const url = options.url || flowUrl;
  if (!url) { err('error: no target URL; pass --url or set "url" in the flow file'); return EXIT.USAGE; }
  if (!isAllowedUrl(url)) { err(`error: refusing to open unsupported URL "${url}"`); return EXIT.USAGE; }

  /** @type {any} */
  let chromium;
  /** @type {string} */
  let sdkPath;
  try { chromium = await resolveChromium(); sdkPath = resolveSdkPath(); }
  catch (error) {
    err(`error: ${/** @type {Error} */ (error).message}`);
    return EXIT.ENVIRONMENT;
  }

  const startedAt = new Date().toISOString();
  const began = Date.now();
  const browser = await chromium.launch({ headless: !options.headed });
  /** @type {any} */
  let page;
  try {
    page = await browser.newPage({ viewport: options.viewport });
    const loaded = await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    if (loaded && loaded.status() >= 400) {
      err(`error: ${url} responded with HTTP ${loaded.status()}`);
      /** @type {any} */ (page);
      return EXIT.ENVIRONMENT;
    }
    const install = await ensureNavi(page, sdkPath);
    const adapter = new NaviPlaywrightAdapter(page, { fallback: options.fallback });
    /** @type {any[]} */
    let targets = [];
    /** @type {any[]} */
    let steps = [];
    let ok = true;
    let failedStep;
    /** @type {{code:string,message:string}|undefined} */
    let failure;
    if (options.command === 'discover' || options.discoverOnly) {
      const map = await adapter.discover();
      targets = map.actions;
    } else if (validated?.ok) {
      const result = await runFlow({ adapter, page, flow: validated.flow, allowConsequential: options.allowConsequential, timeoutMs: options.timeoutMs });
      ok = result.ok;
      steps = result.steps;
      failedStep = result.failedStep;
      failure = failedStep?.error;
    }
    const discovery = Boolean(targets.length || options.discoverOnly || options.command === 'discover');
    const report = {
      tool: 'navi',
      packageVersion: await packageVersion(),
      protocolVersion: install.version,
      mode: discovery ? 'discover' : 'run',
      flow: validated?.ok ? validated.flow.name : undefined,
      url: page.url(),
      origin: describeUrl(page.url()),
      startedAt,
      durationMs: Date.now() - began,
      ok,
      ...(failure ? { failure } : {}),
      ...(targets.length ? { targets } : {}),
      ...(validated?.ok && !discovery ? { steps } : {})
    };
    if (options.report) {
      const path = isAbsolute(options.report) ? options.report : resolve(process.cwd(), options.report);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(report, null, 2) + '\n');
    }
    if (options.json) out(JSON.stringify(report, null, 2));
    else {
      out(`navi ${report.packageVersion} · protocol ${report.protocolVersion} · ${report.mode}`);
      out(`url    ${report.url}`);
      out(`sdk    ${sdkPath}${install.injected ? ' (injected)' : ' (already present)'}`);
      if (targets.length) {
        out(`targets (${targets.length}):`);
        for (const target of targets) {
          const state = target.state || {};
          const flags = [state.is_enabled === false ? 'disabled' : 'enabled', state.is_visible === false ? 'hidden' : 'visible', state.is_in_viewport === false ? 'off-viewport' : 'in-viewport', state.is_occluded ? 'occluded' : 'clear'].join(' · ');
          out(`  ${String(target.target_id).padEnd(28)} ${String(target.role).padEnd(10)} ${flags}  ${JSON.stringify(target.name)}`);
        }
      }
      if (!options.quiet) {
        for (const step of steps) {
          const status = step.ok ? 'ok  ' : 'FAIL';
          if (!options.json) out(`${status} ${String(step.index + 1).padStart(2)}. ${step.label} (${step.kind}${step.mode ? `, ${step.mode}` : ''}, ${step.durationMs}ms)`);
          if (step.error) out(`     ${step.error.code}: ${step.error.message}`);
        }
      }
      out(`result: ${ok ? 'PASSED' : 'FAILED'} in ${report.durationMs}ms${steps.length ? ` (${steps.filter(step => step.ok).length}/${steps.length} steps)` : ''}`);
    }
    // A blocked consequential step is an operator policy error, not a flow failure.
    if (failure?.code === 'CONSEQUENTIAL_BLOCKED') return EXIT.USAGE;
    return ok ? EXIT.OK : EXIT.FAILED;
  } catch (error) {
    const failure = /** @type {Error & {code?: string}} */ (error);
    err(`error: ${failure.message}`);
    return failure.code === 'NO_SDK' || failure.code === 'NO_BROWSER' ? EXIT.ENVIRONMENT : EXIT.FAILED;
  } finally {
    await browser.close().catch(() => undefined);
  }
}
