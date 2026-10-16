import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { readFile, stat, writeFile, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const demoUrl = 'http://127.0.0.1:4174/';

/** @param {string[]} args @param {{timeout?: number}} [options] */
async function cli(args, options = {}) {
  try {
    const result = await run('node', [join(root, 'bin/navi-agent.js'), ...args], {
      cwd: root, timeout: options.timeout ?? 60000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env }
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = /** @type {any} */ (error);
    return { code: typeof failure.code === 'number' ? failure.code : 1, stdout: String(failure.stdout || ''), stderr: String(failure.stderr || '') };
  }
}

/** @param {string} name @param {unknown} document */
async function tempFlow(name, document) {
  const dir = await mkdtemp(join(tmpdir(), 'navi-flow-'));
  const path = join(dir, `${name}.json`);
  await writeFile(path, JSON.stringify(document, null, 2));
  return path;
}

test('release artifacts exist and navi.min.js respects the strict size budget', async () => {
  const report = JSON.parse(await readFile('reports/build.json', 'utf8'));
  expect(report.rawBytes).toBeLessThan(15000);
  expect(report.budgetBytes).toBe(15000);
  for (const path of ['dist/navi.min.js', 'dist/index.mjs', 'dist/index.cjs', 'dist/index.d.ts', 'dist/navi.d.ts', 'dist/cli.mjs', 'dist/mcp.mjs']) {
    const info = await stat(path);
    expect(info.size, `${path} should not be empty`).toBeGreaterThan(0);
    expect(report.artifacts[path].bytes).toBe(info.size);
  }
  const sdk = await readFile('dist/navi.min.js', 'utf8');
  expect(sdk).toContain('Navi');
  expect(sdk.startsWith('#!/')).toBe(false);
  for (const bundle of ['dist/cli.mjs', 'dist/mcp.mjs']) {
    expect((await readFile(bundle, 'utf8')).startsWith('#!/usr/bin/env node'), `${bundle} must be executable`).toBe(true);
  }
});

test('esm and commonjs entry points both expose the adapter and helpers', async () => {
  // Dynamic specifier: dist/ is generated, so don't let tsc resolve it statically.
  const esm = await import(new URL('../dist/index.mjs', import.meta.url).href);
  for (const name of ['NaviPlaywrightAdapter', 'naviAdapter', 'validateFlow', 'runFlow', 'installNavi', 'connectNavi', 'naviSdkPath', 'NAVI_PROTOCOL_VERSION', 'NAVI_SDK_FILE']) {
    expect(typeof esm[name], `esm export ${name}`).toBeTruthy();
  }
  expect(esm.NAVI_PROTOCOL_VERSION).toBe('0.3.0');
  expect(esm.naviSdkPath().endsWith('navi.min.js')).toBe(true);
  expect((await stat(esm.naviSdkPath())).size).toBeGreaterThan(0);

  const cjs = require(join(root, 'dist/index.cjs'));
  for (const name of ['NaviPlaywrightAdapter', 'naviAdapter', 'validateFlow', 'runFlow', 'installNavi', 'naviSdkPath']) {
    expect(typeof cjs[name], `cjs export ${name}`).toBeTruthy();
  }
  expect(typeof cjs.NaviPlaywrightAdapter).toBe('function');
  expect(cjs.naviSdkPath().endsWith('navi.min.js')).toBe(true);
  expect((await stat(cjs.naviSdkPath())).size).toBeGreaterThan(0);
  expect(new cjs.NaviPlaywrightAdapter({ url: () => demoUrl, evaluate: async () => ({}), mouse: { click: async () => {} }, keyboard: { press: async () => {}, insertText: async () => {} } })).toBeTruthy();
});

test('connectNavi injects the SDK into a page that does not already have it', async ({ page }) => {
  await page.goto('/frame.html');
  expect(await page.evaluate(() => Boolean(window.Navi))).toBe(false);

  const { connectNavi, installNavi, naviSdkPath } = await import(new URL('../dist/index.mjs', import.meta.url).href);
  const { adapter, sdkPath } = await connectNavi(page);
  expect(sdkPath).toBe(naviSdkPath());
  expect(await page.evaluate(() => Boolean(window.Navi))).toBe(true);

  const map = await adapter.discover();
  expect(map.version).toBe('0.3.0');
  expect(map.truncated).toBe(false);
  const targets = /** @type {Array<{target_id: string}>} */ (map.actions);
  expect(targets.some(action => action.target_id === 'payment-demo')).toBe(true);
  const executed = await adapter.execute('payment-demo', 'click');
  expect(executed.ok, JSON.stringify(executed.error)).toBe(true);
  expect(executed.mode).toBe('synthetic');
  expect(await page.locator('button').getAttribute('aria-pressed')).toBe('true');

  // Re-installing is a no-op, and strict mode refuses trusted-input fallback.
  expect(await installNavi(page)).toBe(naviSdkPath());
  const strict = await connectNavi(page, { fallback: false });
  expect(strict.adapter.fallback).toBe(false);
  expect(strict.sdkPath).toBeNull();
});

test('published types describe the adapter, flow schema and exports map', async () => {
  const types = await readFile('dist/index.d.ts', 'utf8');
  for (const token of ['NaviPlaywrightAdapter', 'NaviFlowDocument', 'NaviStepResult', 'installNavi', 'runFlow']) {
    expect(types).toContain(token);
  }
  // The client-side SDK surface must be typed from the package entry, not only from the browser global file.
  expect(types).toMatch(/export interface NaviAPI \{[\s\S]*ready\(\)[\s\S]*actions\(/);
  const browserTypes = await readFile('dist/navi.d.ts', 'utf8');
  expect(browserTypes).toContain('interface Window { Navi?: NaviAPI }');
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  expect(manifest.types).toBe('./dist/index.d.ts');
  expect(manifest.main).toBe('./dist/index.cjs');
  expect(manifest.module).toBe('./dist/index.mjs');
  // npm normalises each `bin` target as it publishes and logs `bin[…] script name was
  // cleaned` for a path that needed it, so the manifest carries the published form rather
  // than one the publish step has to rewrite — and each target is a real file on disk, so a
  // cleaned name cannot silently point at nothing.
  expect(manifest.bin).toEqual({ navi: 'bin/navi-agent.js', 'navi-mcp': 'bin/navi-mcp.js' });
  for (const target of Object.values(manifest.bin)) {
    expect(target.startsWith('./'), `${target} must be in the form npm publishes`).toBe(false);
    expect((await readFile(target, 'utf8')).length).toBeGreaterThan(0);
  }
  expect(manifest.exports['.'].import).toBe('./dist/index.mjs');
  expect(manifest.exports['.'].require).toBe('./dist/index.cjs');
  expect(manifest.exports['./navi.min.js'].default).toBe('./dist/navi.min.js');
  // Subpath consumers must resolve the browser global types, not just the JS file.
  expect(manifest.exports['./navi.min.js'].types).toBe('./dist/navi.d.ts');
  expect(manifest.files).toContain('bin');
  expect(manifest.private).toBeUndefined();
});

test('cli runs the shipped example flow through the adapter', async () => {
  const report = join(await mkdtemp(join(tmpdir(), 'navi-report-')), 'run.json');
  const result = await cli(['run', '--url', demoUrl, '--action-file', 'flows/example-checkout.json', '--allow-consequential', '--json', '--report', report]);
  expect(result.stderr).toBe('');
  expect(result.code, result.stdout || result.stderr).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.tool).toBe('navi');
  expect(payload.mode).toBe('run');
  expect(payload.ok).toBe(true);
  expect(payload.protocolVersion).toBe('0.3.0');
  expect(payload.flow).toBe('example-checkout');
  expect(payload.steps.length).toBeGreaterThanOrEqual(9);
  expect(payload.steps.every((/** @type {any} */ step) => step.ok)).toBe(true);
  // Closed-shadow and iframe targets must execute through the synthetic bridge.
  for (const label of ['gift wrapping', 'payment method']) {
    const step = payload.steps.find((/** @type {any} */ entry) => entry.label === label);
    expect(step?.mode, `${label} mode`).toBe('synthetic');
  }
  const written = JSON.parse(await readFile(report, 'utf8'));
  expect(written.ok).toBe(true);
  expect(written.origin).toBe(demoUrl.replace(/\/$/, ''));
});

test('cli discover mode lists actionable targets without executing the flow', async () => {
  const result = await cli(['discover', '--url', demoUrl]);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain('checkout-submit');
  expect(result.stdout).toContain('targets (');
  const json = await cli(['discover', '--url', demoUrl, '--json']);
  const payload = JSON.parse(json.stdout);
  expect(payload.mode).toBe('discover');
  expect(payload.steps).toBeUndefined();
  const submit = payload.targets.find((/** @type {any} */ target) => target.target_id === 'checkout-submit');
  expect(submit.state.is_enabled).toBe(true);
  expect(submit.state.is_occluded).toBe(false);
  expect(typeof submit.coordinates.width).toBe('number');
});

test('cli scrollTo step brings a below-the-fold target into view', async () => {
  const path = await tempFlow('scroll', {
    name: 'scroll',
    steps: [
      { label: 'scroll to email', scrollTo: 'checkout-email' },
      // The email field is required, so omitting it makes the browser block submit
      // and the outcome assertion below would fail on purpose.
      { label: 'email', target: 'checkout-email', action: 'type', text: 'scroll@example.com' },
      { label: 'scroll to submit', scrollTo: 'checkout-submit' },
      { label: 'submit', target: 'checkout-submit', action: 'click', consequential: true },
      { label: 'outcome', assert: 'text', selector: '#status', contains: 'Sandbox checkout complete' }
    ]
  });
  // A short viewport puts the submit button below the fold; without the step it must fail.
  const withoutScroll = await cli(['run', '--url', demoUrl, '--viewport', '900x500', '--action-file', 'flows/example-checkout.json', '--allow-consequential', '--json']);
  expect(withoutScroll.code).toBe(1);
  expect(JSON.parse(withoutScroll.stdout).failure.code).toBe('UNAVAILABLE');

  const scrolled = await cli(['run', '--url', demoUrl, '--viewport', '900x500', '--action-file', path, '--allow-consequential', '--json']);
  expect(scrolled.code, scrolled.stdout || scrolled.stderr).toBe(0);
  const payload = JSON.parse(scrolled.stdout);
  expect(payload.ok).toBe(true);
  expect(payload.steps.map((/** @type {any} */ step) => step.kind)).toEqual(['scrollTo', 'action', 'scrollTo', 'action', 'assert']);
  expect(payload.steps.every((/** @type {any} */ step) => step.ok)).toBe(true);

  const unreachable = await tempFlow('scroll-missing', { steps: [{ scrollTo: 'does-not-exist' }] });
  const failed = await cli(['run', '--url', demoUrl, '--action-file', unreachable, '--json']);
  expect(failed.code).toBe(1);
  expect(JSON.parse(failed.stdout).failure.code).toBe('SCROLL_TARGET_UNREACHABLE');
});

test('cli fails the run when an assertion does not match', async () => {
  const path = await tempFlow('mismatch', { name: 'mismatch', steps: [{ assert: 'text', selector: '#status', equals: 'not the outcome' }] });
  const result = await cli(['run', '--url', demoUrl, '--action-file', path, '--json']);
  expect(result.code).toBe(1);
  const payload = JSON.parse(result.stdout);
  expect(payload.ok).toBe(false);
  expect(payload.failure.code).toBe('ASSERTION_FAILED');
  expect(payload.failure.message).toContain('expected text');
});

test('cli enforces flow policy, strict schema and url safety with usage errors', async () => {
  const blocked = await cli(['run', '--url', demoUrl, '--action-file', 'flows/example-checkout.json', '--json']);
  expect(blocked.code).toBe(2);
  const blockedReport = JSON.parse(blocked.stdout);
  expect(blockedReport.failure.code).toBe('CONSEQUENTIAL_BLOCKED');

  const unknownField = await tempFlow('unknown', { steps: [{ target: 'a', action: 'click', surprise: true }] });
  const schema = await cli(['run', '--url', demoUrl, '--action-file', unknownField]);
  expect(schema.code).toBe(2);
  expect(schema.stderr).toContain('unknown field "surprise"');

  const pollution = await tempFlow('pollution', JSON.parse('{"steps":[{"target":"a","action":"click","__proto__":{"polluted":1}}]}'));
  const bad = await cli(['run', '--url', demoUrl, '--action-file', pollution]);
  expect(bad.code).toBe(2);

  const unsafe = await cli(['run', '--url', 'file:///etc/passwd']);
  expect(unsafe.code).toBe(2);
  expect(unsafe.stderr).toContain('http(s)');

  const credentials = await cli(['run', '--url', 'http://user:pass@127.0.0.1:4174/']);
  expect(credentials.code).toBe(2);

  const unknownArg = await cli(['run', '--url', demoUrl, '--nope']);
  expect(unknownArg.code).toBe(2);
  expect(unknownArg.stderr).toContain('unknown argument');

  const noTarget = await cli(['run']);
  expect(noTarget.code).toBe(2);
});

test('cli help and version are usable without a browser', async () => {
  const help = await cli(['--help']);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain('navi run --url');
  expect(help.stdout).toContain('--allow-consequential');
  const version = await cli(['--version']);
  expect(version.code).toBe(0);
  expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
});
