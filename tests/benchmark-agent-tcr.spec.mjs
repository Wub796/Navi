import { test, expect, chromium } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getEncoding } from 'js-tiktoken';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { createTcrApp } from './fixtures/tcr-app.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const encoding = getEncoding('cl100k_base');
const iterations = 10;
const manualWaitMs = 300;
/** @typedef {{name: string, role: 'textbox'|'combobox'|'button', action: 'type'|'select'|'click', value?: string, navigation?: string}} Step */
/** Both controllers receive the same task and semantic control names, never IDs. @type {Step[]} */
const steps = [
  { name: 'Search products', role: 'textbox', action: 'type', value: 'backpack' },
  { name: 'Quantity', role: 'combobox', action: 'select', value: '2' },
  { name: 'Add Trail backpack', role: 'button', action: 'click' },
  { name: 'Review checkout', role: 'button', action: 'click', navigation: 'review' },
  { name: 'Email address', role: 'textbox', action: 'type', value: 'agent@example.test' },
  { name: 'Shipping method', role: 'combobox', action: 'select', value: 'express' },
  { name: 'Place sandbox order', role: 'button', action: 'click', navigation: 'complete' }
];
/** @typedef {{path: string, iteration: number, success: boolean, wallMs: number, contextTokens: number, contextBytes: number, observations: number, receipts: {mode: string, settled: boolean, elapsedMs: number}[], error?: string}} Trial */
/** @param {number[]} values */
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
/** @param {number[]} values */
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];

/** @param {string} path @param {number} iteration */
function trialRecord(path, iteration) {
  return /** @type {Trial} */ ({ path, iteration, success: false, wallMs: 0, contextTokens: 0, contextBytes: 0, observations: 0, receipts: [] });
}
/** Tokenize exactly what the controller observes, once per observation. @param {Trial} trial @param {string} text */
function observe(trial, text) {
  trial.contextTokens += encoding.encode(text).length;
  trial.contextBytes += Buffer.byteLength(text);
  trial.observations++;
}
/** Independent oracle: committed cart/order state and matching confirmation URL. @param {string} origin @param {string} finalUrl */
async function verifyOrder(origin, finalUrl) {
  const url = new URL(finalUrl);
  expect(url.pathname).toBe('/checkout');
  expect(url.searchParams.get('step')).toBe('complete');
  const response = await fetch(`${origin}/api/order?cart=${url.searchParams.get('cart')}`);
  expect(response.status).toBe(200);
  const order = await response.json();
  expect(order).toEqual({ order: url.searchParams.get('order'), product: 'Trail backpack', quantity: 2, email: 'agent@example.test', shipping: 'express', totalCents: 10700 });
}

/** @param {string} origin @param {number} seed */
async function standardTrial(origin, seed) {
  const trial = trialRecord('Playwright role locators + explicit waits', seed);
  const start = performance.now();
  /** @type {import('playwright').Browser | undefined} */
  let browser;
  try {
    // The comparison must run under the same browser posture as Navi's own
    // paths: Playwright appends --no-sandbox unless the sandbox is requested.
    browser = await chromium.launch({ headless: true, chromiumSandbox: true });
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    await page.goto(`${origin}/checkout?seed=${seed}`, { waitUntil: 'load' });
    for (const step of steps) {
      const snapshot = await page.locator('body').ariaSnapshot();
      observe(trial, snapshot);
      expect(snapshot, `observation must contain ${step.name}`).toContain(step.name);
      const locator = page.getByRole(step.role, { name: step.name, exact: true });
      if (step.action === 'type') await locator.fill(/** @type {string} */ (step.value), { timeout: 3000 });
      else if (step.action === 'select') await locator.selectOption(/** @type {string} */ (step.value), { timeout: 3000 });
      else await locator.click({ timeout: 3000 });
      if (step.navigation) await page.waitForURL(url => url.searchParams.get('step') === step.navigation, { timeout: 5000, waitUntil: 'load' });
      else await page.waitForTimeout(manualWaitMs);
    }
    const confirmation = await page.locator('body').ariaSnapshot();
    observe(trial, confirmation);
    expect(confirmation).toContain('Order confirmed');
    await verifyOrder(origin, page.url());
    trial.success = true;
  } catch (error) {
    trial.error = error instanceof Error ? error.message : String(error);
  } finally {
    trial.wallMs = performance.now() - start;
    await browser?.close();
  }
  return trial;
}

/** @param {string} origin @param {number} seed */
async function naviTrial(origin, seed) {
  const trial = trialRecord('Navi MCP + settlement receipts', seed);
  const transport = new StdioClientTransport({ command: process.execPath, args: ['bin/navi-mcp.js'], cwd: root, stderr: 'pipe', env: { ...process.env, NAVI_ALLOW_LOCAL_NETWORK: '1' } });
  const client = new Client({ name: 'navi-tcr-benchmark', version: '1.0.0' });
  await client.connect(transport);
  /** Unwrap the actual MCP envelope, not a local adapter shortcut. @param {string} name @param {Record<string, unknown>} args @param {boolean} [context] @returns {Promise<any>} */
  const call = async (name, args, context = false) => {
    const result = await client.callTool({ name, arguments: args });
    const content = /** @type {{type: string, text: string}[]} */ (result.content);
    const text = content.map(item => item.text).join('\n');
    if (context) observe(trial, text);
    const body = JSON.parse(text);
    expect(result.isError, text).toBeFalsy();
    expect(body.ok, text).toBe(true);
    return body;
  };
  const start = performance.now();
  try {
    await call('navi_navigate', { url: `${origin}/checkout?seed=${seed}` });
    let finalUrl = '';
    for (const step of steps) {
      // Planner observation: the compact map is the documented planner format.
      // Execution still re-checks the full live state before dispatching.
      const map = await call('navi_get_actions', { compact: true }, true);
      expect(map.truncated).toBe(false);
      const candidates = /** @type {{target_id: string, name: string, role: string, available: boolean}[]} */ (map.actions).filter(action => action.name === step.name && action.role === step.role && action.available);
      expect(candidates, `one actionable ${step.name}`).toHaveLength(1);
      const mode = step.navigation ? 'navigation' : 'mutation_settle';
      const receipt = await call('navi_execute_action', {
        target_id: candidates[0].target_id, action_type: step.action,
        payload: step.action === 'type' ? { text: step.value } : step.action === 'select' ? { value: step.value } : {},
        settle: { wait_for: mode, timeout_ms: 5000 }
      });
      expect(receipt.executed).toBe(true);
      expect(receipt.dispatched).toBe(true);
      expect(receipt.settled).toBe(true);
      expect(receipt.settle).toBe(mode);
      expect(receipt.elapsed_ms).toBeGreaterThanOrEqual(0);
      if (step.navigation) expect(new URL(receipt.final_url).searchParams.get('step')).toBe(step.navigation);
      trial.receipts.push({ mode, settled: receipt.settled, elapsedMs: receipt.elapsed_ms });
      finalUrl = receipt.final_url;
      // Reinstall/detect SDK in the new document, as an MCP agent must do.
      if (step.navigation) await call('navi_navigate', { url: finalUrl });
    }
    // Navi's action map deliberately omits non-interactive confirmation text.
    // The final URL and independent server oracle establish business success.
    await verifyOrder(origin, finalUrl);
    trial.success = true;
  } catch (error) {
    trial.error = error instanceof Error ? error.message : String(error);
  } finally {
    trial.wallMs = performance.now() - start;
    await client.close();
  }
  return trial;
}

test('paired dynamic checkout TCR benchmark: ten trials per execution path', async () => {
  test.setTimeout(240000);
  const app = await createTcrApp();
  /** @type {Trial[]} */
  const trials = [];
  try {
    for (let seed = 1; seed <= iterations; seed++) {
      const paths = seed % 2 ? [standardTrial, naviTrial] : [naviTrial, standardTrial];
      for (const run of paths) trials.push(await run(app.origin, seed));
    }
  } finally { await app.close(); }
  const summaries = [...new Set(trials.map(trial => trial.path))].map(path => {
    const rows = trials.filter(trial => trial.path === path);
    return {
      path, successes: rows.filter(trial => trial.success).length, trials: rows.length,
      tcr: rows.filter(trial => trial.success).length / rows.length * 100,
      totalContextTokens: rows.reduce((sum, trial) => sum + trial.contextTokens, 0),
      meanContextTokens: mean(rows.map(trial => trial.contextTokens)),
      meanWallMs: mean(rows.map(trial => trial.wallMs)), p95WallMs: p95(rows.map(trial => trial.wallMs)),
      totalWallMs: rows.reduce((sum, trial) => sum + trial.wallMs, 0)
    };
  });
  const report = {
    recordedAt: new Date().toISOString(), iterations, manualWaitMs,
    environment: { node: process.version, platform: `${os.platform()} ${os.arch()}`, cpu: os.cpus()[0]?.model, playwright: JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../node_modules/playwright/package.json', import.meta.url), 'utf8')).version },
    tokenizer: 'js-tiktoken cl100k_base', planner: 'deterministic semantic task controller; no LLM requests', summaries, trials
  };
  const markdown = `# Dynamic checkout task completion benchmark\n\nRecorded ${report.recordedAt}. ${report.environment.platform}, ${report.environment.cpu}, Node ${report.environment.node}, Playwright ${report.environment.playwright}.\n\n` +
    '| Execution path | Completed | TCR | DOM-context tokens total (10 trials) | Tokens/task mean | Wall time/task mean | Wall time/task p95 |\n|---|---:|---:|---:|---:|---:|---:|\n' +
    summaries.map(row => `| ${row.path} | ${row.successes}/${row.trials} | ${row.tcr.toFixed(0)}% | ${row.totalContextTokens.toLocaleString('en-US')} | ${row.meanContextTokens.toFixed(1)} | ${(row.meanWallMs / 1000).toFixed(3)}s | ${(row.p95WallMs / 1000).toFixed(3)}s |`).join('\n') +
    '\n\n## Methodology and boundaries\n\n' +
    '- Live, disposable local HTTP application with actual fetch requests, debounced product filtering, cart creation, shipping quotes, full-document navigation and server-side order commits. No public site, payment, or external service is contacted. Both paths order two Trail backpacks with Express shipping for $107.00; an independent HTTP oracle checks every committed field and order identifier.\n' +
    '- Ten fresh-browser trials per path, paired on deterministic latency seeds (60–260ms responses); path order alternates to reduce warm-cache/order bias. No retries, ignored failures or discarded samples. TCR means a fully correct server-side order on the first attempt, not merely a successful click.\n' +
    `- Native baseline uses current Playwright role locators, normal actionability auto-waits, ${manualWaitMs}ms explicit sleeps after non-navigation actions, 3s action timeouts and 5s navigation timeouts. It is not deliberately weakened with stale selectors or ambiguous locators.\n` +
    '- Navi uses the official MCP SDK over stdio and real navi_get_actions/navi_execute_action calls. Every target is resolved from a fresh map by accessible name, role and actionable state, not a fixture ID. Every execution must return executed/dispatched/settled:true and the requested mutation_settle or navigation receipt. Navigation is followed by SDK reinitialization through navi_navigate; its cost is included.\n' +
    '- DOM-context tokens are exact cl100k_base counts of each observed Playwright body ARIA snapshot or complete MCP action-map text envelope, including repeated observations. Tokens are counted using the same tokenizer, not characters/4. These are observation-payload tokens that a planner would receive, **not actual billed agent/LLM consumption**. No LLM planner is connected: both autonomous paths use the same deterministic semantic task controller. Prompt, tool-schema, execution-receipt and generated reasoning tokens are excluded.\n' +
    '- Wall time includes cold Chromium launch, context creation, initial navigation, all observations/actions/waits, SDK reinjection and independent outcome verification; excludes MCP client process startup/handshake, browser shutdown, tokenizer construction and report I/O. Observation tokenization itself is included for both. p95 is nearest rank (with n=10, the maximum). Failures retain their elapsed time and error in the raw report.\n' +
    '- The app visibly mutates a progress indicator throughout asynchronous work. Thus DOM quiet can follow its visible completion; settlement alone cannot prove arbitrary network/business completion on applications without such signals. The server oracle is still required.\n' +
    '- This controlled checkout is a reproducible real-browser integration benchmark, not evidence of performance on external production applications or general LLM task-planning ability. Ten trials are too few to establish a universal flakiness rate; 10/10 does not prove zero failure probability. Rich action maps can cost more tokens than a compact ARIA snapshot; no positive speedup or token-reduction assertion is imposed.\n\n' +
    '## Reproduce\n\n```sh\nnpm ci --no-audit --no-fund\nnpx playwright install chromium\nnpm run benchmark:tcr\n```\n\nThe benchmark starts and stops its own application; the Playwright suite also owns its configured demo server. [Raw per-trial measurements](tcr-benchmark.json) · [Application](../demo/tcr-checkout.html) · [Benchmark source](../tests/benchmark-agent-tcr.spec.mjs)\n';
  await mkdir('reports', { recursive: true });
  await writeFile('reports/tcr-benchmark.json', JSON.stringify(report, null, 2) + '\n');
  await writeFile('reports/TCR-BENCHMARK.md', markdown);
  console.table(summaries);
  expect(trials, 'all paired trials must be recorded').toHaveLength(20);
  expect(trials.filter(trial => !trial.success), 'no checkout failures; inspect raw errors').toEqual([]);
  expect(trials.filter(trial => trial.path.startsWith('Navi')).flatMap(trial => trial.receipts)).toHaveLength(70);
});
