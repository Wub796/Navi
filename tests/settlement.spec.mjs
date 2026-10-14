import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NaviPlaywrightAdapter } from '../src/adapter.js';
import { completeSettle } from '../src/settle.js';

/**
 * Deterministic post-action settlement.
 *
 * The fixture (`/settlement.html`) gives each control a different kind of effect:
 * `open-modal` inserts a control and hides itself, `close-modal` dismisses its own
 * modal, `inert` does nothing, and `go-step` navigates. Every mode is therefore
 * asserted against a real effect, and a timeout is asserted against an action
 * that is still reported as executed — a settle receipt must never be a guess in
 * either direction.
 *
 * The MCP case drives the same page through the shipped server so the receipt
 * fields in the tool envelope are verified where an agent actually reads them.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const binPath = join(root, 'bin', 'navi-mcp.js');

/** @param {any} result @returns {any} */
const envelope = result => JSON.parse(result.content[0].text);

test('navigation does not report a destroyed execution context as a committed destination', async () => {
  let committed = false;
  let reads = 0;
  const page = {
    url: () => committed ? 'https://shop.example/complete' : 'https://shop.example/review',
    evaluate: async () => {
      if (++reads === 1) throw new Error('Execution context was destroyed, most likely because of a navigation');
      committed = true;
      return undefined;
    }
  };
  const outcome = await completeSettle(page, { waitFor: 'navigation', timeoutMs: 1000, quietMs: 100 }, 'place', { token: 'old-document', beforeUrl: page.url(), armed: true });
  expect(outcome.settled).toBe(true);
  expect(reads).toBe(2);
  expect(page.url()).toBe('https://shop.example/complete');
});

test('mutation_settle settles when the action replaced the document it was observing', async () => {
  // The observers are armed on a document, so a full-page navigation takes them down
  // with it: the wait surfaces as a destroyed execution context at the moment the
  // effect commits, which is a settlement and not an unsettled failure.
  const page = {
    url: () => 'https://shop.example/checkout/complete',
    evaluate: async () => { throw new Error('Execution context was destroyed, most likely because of a navigation'); },
    waitForLoadState: async () => undefined
  };
  const outcome = await completeSettle(page, { waitFor: 'mutation_settle', timeoutMs: 1000, quietMs: 100 }, 'place-order',
    { token: 'old-document', beforeUrl: 'https://shop.example/checkout', armed: true });
  expect(outcome.settled).toBe(true);
  expect(outcome.reason).toBe('document_replaced');
});

test('a reload that keeps the URL settles on the document marker', async () => {
  let reads = 0;
  const page = {
    url: () => 'https://shop.example/cart',
    evaluate: async () => {
      // First read: the armed wait died with the document. Second: the marker on the
      // document that replaced it, where the armed marker is gone.
      if (++reads === 1) throw new Error('Execution context was destroyed, most likely because of a navigation');
      return undefined;
    },
    waitForLoadState: async () => undefined
  };
  const outcome = await completeSettle(page, { waitFor: 'mutation_settle', timeoutMs: 1000, quietMs: 100 }, 'review',
    { token: 'old-document', beforeUrl: page.url(), armed: true });
  expect(outcome.settled).toBe(true);
  expect(outcome.reason).toBe('document_replaced');
  expect(reads).toBe(2);
});

test('a destroyed context with no replacement document stays an honest failure', async () => {
  // A destroyed context is evidence of a navigation, not proof of one, so a page that
  // never becomes a different document keeps the reported failure rather than being
  // settled by a blanket rule.
  const page = {
    url: () => 'https://shop.example/cart',
    evaluate: async () => { throw new Error('Execution context was destroyed'); },
    waitForLoadState: async () => undefined
  };
  const outcome = await completeSettle(page, { waitFor: 'mutation_settle', timeoutMs: 150, quietMs: 100 }, 'review',
    { token: 'old-document', beforeUrl: 'https://shop.example/cart', armed: true });
  expect(outcome.settled).toBe(false);
  expect(outcome.reason).toContain('settle_failed');
});

test.describe('settlement receipts from the adapter', () => {
  test('mutation_settle waits for the DOM insert an action makes', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/settlement.html`);
    const adapter = new NaviPlaywrightAdapter(page);
    const result = await adapter.execute('open-modal', 'click', {}, { wait_for: 'mutation_settle', timeout_ms: 3000 });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.settle?.mode).toBe('mutation_settle');
    expect(result.settle?.settled).toBe(true);
    expect(result.settle?.elapsed_ms).toBeGreaterThan(0);
    expect(result.settle?.final_url).toContain('/settlement.html');
    // The wait is load-bearing: the control the click inserted is discoverable.
    const map = await adapter.discover({ limit: 5000 });
    expect(map.actions.map(action => action.target_id)).toContain('close-modal');
    // An unconfigured call carries no receipt, so it cannot be mistaken for a
    // settled one.
    const plain = await adapter.execute('inert', 'click', {});
    expect(plain.ok).toBe(true);
    expect(plain.settle).toBeUndefined();
  });

  test('target_hidden resolves when the action hides its own target', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/settlement.html`);
    const adapter = new NaviPlaywrightAdapter(page);
    const result = await adapter.execute('open-modal', 'click', {}, { wait_for: 'target_hidden', timeout_ms: 3000 });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.settle?.mode).toBe('target_hidden');
    expect(result.settle?.settled).toBe(true);
    const map = await adapter.discover({ limit: 5000 });
    expect(map.actions.find(action => action.target_id === 'open-modal')?.state.is_visible).toBe(false);
  });

  test('target_hidden resolves when a modal dismisses its own control', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/settlement.html`);
    const adapter = new NaviPlaywrightAdapter(page);
    expect((await adapter.execute('open-modal', 'click', {}, { wait_for: 'mutation_settle' })).ok).toBe(true);
    const dismissed = await adapter.execute('close-modal', 'click', {}, { wait_for: 'target_hidden', timeout_ms: 3000 });
    expect(dismissed.ok, JSON.stringify(dismissed)).toBe(true);
    expect(dismissed.settle?.settled).toBe(true);
    expect(await page.locator('#state').textContent()).toBe('modal dismissed');
    const map = await adapter.discover({ limit: 5000 });
    expect(map.actions.find(action => action.target_id === 'close-modal')?.state.is_visible).toBe(false);
  });

  test('an action that hides nothing reports settled:false without losing the execution', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/settlement.html`);
    const adapter = new NaviPlaywrightAdapter(page);
    const result = await adapter.execute('inert', 'click', {}, { wait_for: 'target_hidden', timeout_ms: 400 });
    // The action ran; the requested condition simply never held.
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.result?.dispatched).toBe(true);
    expect(result.mode).toBe('synthetic');
    expect(result.settle?.settled).toBe(false);
    expect(result.settle?.reason).toBe('timeout');
    expect(result.settle?.elapsed_ms).toBeGreaterThanOrEqual(400);
  });

  test('navigation waits for the URL change even when the context dies mid-dispatch', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/settlement.html`);
    const adapter = new NaviPlaywrightAdapter(page);
    // The click navigates, which can destroy the execution context before the
    // in-page settle returns. The receipt must still report the dispatch.
    const result = await adapter.execute('go-step', 'click', {}, { wait_for: 'navigation', timeout_ms: 5000 });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.result?.dispatched).toBe(true);
    expect(result.settle?.mode).toBe('navigation');
    expect(result.settle?.settled).toBe(true);
    expect(result.settle?.final_url).toContain('step=2');
    expect(page.url()).toContain('step=2');
  });

  test('the same navigating click settles a mutation wait instead of failing it', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/settlement.html`);
    const adapter = new NaviPlaywrightAdapter(page);
    // The click applied and replaced the document the observers were armed on. Either
    // the DOM went quiet before the navigation committed, or the replacement was
    // observed; both are settlements, and neither is reported as an unsettled action.
    const result = await adapter.execute('go-step', 'click', {}, { wait_for: 'mutation_settle', timeout_ms: 5000 });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.result?.dispatched).toBe(true);
    expect(result.settle?.mode).toBe('mutation_settle');
    expect(result.settle?.settled).toBe(true);
    expect(result.settle?.final_url).toContain('step=2');
    expect([undefined, 'document_replaced']).toContain(result.settle?.reason);
  });

  test('an invalid settle request is refused before anything is dispatched', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/settlement.html`);
    const adapter = new NaviPlaywrightAdapter(page);
    const invalid = [
      { wait_for: 'parallax' },
      { wait_for: 'mutation_settle', timeout_ms: 0 },
      { wait_for: 'mutation_settle', timeout_ms: 60001 },
      { wait_for: 'mutation_settle', timeout_ms: 100.5 },
      { wait_for: 'mutation_settle', typo_ms: 500 },
      { wait_for: 'mutation_settle', timeout_ms: '1000' },
      'mutation_settle'
    ];
    for (const settle of invalid) {
      const result = await adapter.execute('open-modal', 'click', {}, settle);
      expect(result.ok, JSON.stringify(settle)).toBe(false);
      expect(result.error?.code, JSON.stringify(settle)).toBe('INVALID_SETTLE');
    }
    // Nothing was dispatched by any of the refusals.
    expect(await page.locator('#state').textContent()).toBe('idle');
    expect(await page.locator('#offer').count()).toBe(0);
  });
});

test('navi_execute_action returns the settlement receipt in its envelope', async ({ baseURL }) => {
  test.setTimeout(180000);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [binPath],
    cwd: root,
    stderr: 'pipe',
    env: { ...process.env, NAVI_ALLOW_LOCAL_NETWORK: '1' }
  });
  const client = new Client({ name: 'navi-mcp-settlement', version: '1.0.0' });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    const tool = listed.tools.find(candidate => candidate.name === 'navi_execute_action');
    expect(tool, 'navi_execute_action must be advertised').toBeTruthy();
    expect(Object.keys(tool?.inputSchema?.properties ?? {})).toContain('settle');

    const nav = await client.callTool({ name: 'navi_navigate', arguments: { url: `${baseURL}/settlement.html` } });
    expect(envelope(nav).ok).toBe(true);

    const settled = await client.callTool({
      name: 'navi_execute_action',
      arguments: { target_id: 'open-modal', action_type: 'click', settle: { wait_for: 'mutation_settle', timeout_ms: 3000 } }
    });
    const body = envelope(settled);
    expect(settled.isError, JSON.stringify(body)).toBeFalsy();
    expect(body.executed).toBe(true);
    expect(body.dispatched).toBe(true);
    expect(body.settled).toBe(true);
    expect(typeof body.elapsed_ms).toBe('number');
    expect(body.final_url).toContain('/settlement.html');
    expect(body.settle).toBe('mutation_settle');

    // A refused request is a tool error with actionable guidance, and the action
    // is not dispatched.
    const refused = await client.callTool({
      name: 'navi_execute_action',
      arguments: { target_id: 'close-modal', action_type: 'click', settle: { wait_for: 'parallax' } }
    });
    expect(refused.isError).toBe(true);
    expect(envelope(refused).error?.code).toBe('INVALID_SETTLE');
    expect(envelope(refused).error?.message).toContain('mutation_settle');

    // Without a settle request the receipt is omitted, not fabricated.
    const plain = envelope(await client.callTool({ name: 'navi_execute_action', arguments: { target_id: 'inert', action_type: 'click' } }));
    expect(plain.executed).toBe(true);
    expect(plain.settled).toBeUndefined();
  } finally {
    await client.close();
  }
});
