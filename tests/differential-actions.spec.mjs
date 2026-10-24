import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getEncoding } from 'js-tiktoken';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createTcrApp } from './fixtures/tcr-app.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
/** @param {import('playwright').Page} page @param {number} [since_version] @returns {Promise<any>} */
const query = (page, since_version) => page.evaluate(async cursor => {
  const navi = /** @type {any} */ (window.Navi);
  return navi.actions({ since_version: cursor, coordinateSpace: 'top' });
}, since_version);

test('SDK diffs preserve additions, removals, state, geometry, names and same-id remounts', async ({ page }) => {
  await page.goto('/settlement.html');
  const first = await query(page);
  expect(first.reset).toBe(true);
  const quiet = await query(page, first.state_version);
  expect(quiet.reset).toBe(false);
  expect(quiet.actions).toEqual([]);
  expect(quiet.state_version).toBeGreaterThan(first.state_version);
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.setAttribute('data-agent-target', 'diff-added'); button.textContent = 'Added';
    document.body.append(button);
    document.querySelector('[data-agent-target="inert"]')?.setAttribute('disabled', '');
  });
  const changed = await query(page, quiet.state_version);
  expect(changed.actions.find((/** @type {any} */ a) => a.target_id === 'diff-added')?.name).toBe('Added');
  expect(changed.actions.find((/** @type {any} */ a) => a.target_id === 'inert')?.state.is_enabled).toBe(false);
  await page.evaluate(() => {
    const old = document.querySelector('[data-agent-target="diff-added"]');
    old?.replaceWith(old.cloneNode(true));
  });
  const remount = await query(page, changed.state_version);
  expect(remount.actions.map((/** @type {any} */ a) => a.target_id)).toContain('diff-added');
  await page.evaluate(() => {
    document.querySelector('[data-agent-target="diff-added"]')?.remove();
    document.querySelector('[data-agent-target="inert"]')?.setAttribute('hidden', '');
  });
  const removed = await query(page, remount.state_version);
  expect(removed.actions).toContainEqual({ target_id: 'diff-added', removed: true });
  expect(removed.actions.find((/** @type {any} */ a) => a.target_id === 'inert')?.state.is_visible).toBe(false);
});

test('independent cursors, bounded history, filter changes and unusable cursors all reset instead of failing', async ({ page }) => {
  await page.goto('/settlement.html');
  const initial = await query(page);
  // Delta idempotency: two reads of the same cursor with no mutation between
  // them both answer "nothing changed" instead of re-sending unchanged rows.
  const a = await query(page, initial.state_version);
  const b = await query(page, initial.state_version);
  expect(a.reset).toBe(false);
  expect(b.reset).toBe(false);
  expect(a.actions).toEqual([]);
  expect(b.actions).toEqual([]);
  // The retained history is bounded, so a cursor older than the window is a
  // compaction miss: reset:true with a full snapshot and a usable new version.
  const stale = initial.state_version;
  for (let i = 0; i < 9; i++) await query(page);
  const expired = await query(page, stale);
  expect(expired.reset).toBe(true);
  expect(expired.actions.length).toBeGreaterThan(0);
  expect(expired.actions.every((/** @type {any} */ action) => action.removed !== true)).toBe(true);
  expect((await query(page, expired.state_version)).reset).toBe(false);
  // A different filter under the same cursor cannot reuse a cached row set.
  const full = await query(page);
  const filtered = await page.evaluate(cursor => /** @type {any} */ (window.Navi).actions({ since_version: cursor, viewportOnly: true }), full.state_version);
  expect(filtered.reset).toBe(true);
  expect(filtered.actions.length).toBeGreaterThan(0);
  const truncated = await page.evaluate(() => /** @type {any} */ (window.Navi).actions({ limit: 1, coordinateSpace: 'top' }));
  expect(truncated.truncated).toBe(true);
  // A truncated read is deliberately never cached, so a cursor taken from one
  // resets too: a partial snapshot can never become the base of a delta.
  const narrowed = await page.evaluate(cursor => /** @type {any} */ (window.Navi).actions({ since_version: cursor, limit: 1, coordinateSpace: 'top' }), truncated.state_version);
  expect(narrowed.reset).toBe(true);
  expect(narrowed.actions.length).toBe(1);
  // Out-of-bounds, negative, fractional and non-numeric cursors are a cache
  // miss, not a failure: reset:true plus a full snapshot keeps an agent moving,
  // and the reset version is immediately usable as the next cursor.
  for (const cursor of [-1, -0.5, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER, 1e12, '1', null, {}, true]) {
    const invalid = await page.evaluate(value => /** @type {any} */ (window.Navi).actions({ since_version: value, coordinateSpace: 'top' }), cursor);
    expect(invalid.reset, String(cursor)).toBe(true);
    expect(invalid.actions.length, String(cursor)).toBeGreaterThan(0);
    expect(invalid.truncated, String(cursor)).toBe(false);
    const recovered = await query(page, invalid.state_version);
    expect(recovered.reset, String(cursor)).toBe(false);
    expect(recovered.actions, String(cursor)).toEqual([]);
  }
});

test('style-only occlusion and same-origin frame changes are included in diffs', async ({ page }) => {
  await page.goto('/settlement.html');
  const initial = await query(page);
  await page.evaluate(() => {
    const target = document.querySelector('[data-agent-target="inert"]');
    const box = target?.getBoundingClientRect();
    if (!box) throw new Error('Missing fixture target');
    const cover = document.createElement('div');
    Object.assign(cover.style, { position: 'fixed', left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px`, zIndex: '9999', background: 'red' });
    document.body.append(cover);
  });
  const covered = await query(page, initial.state_version);
  expect(covered.actions.find((/** @type {any} */ a) => a.target_id === 'inert')?.state.is_occluded).toBe(true);
  await page.evaluate(() => {
    const frame = document.createElement('iframe');
    frame.srcdoc = '<button data-agent-target="frame-diff">Frame</button>';
    document.body.append(frame);
  });
  await page.frameLocator('iframe').getByRole('button', { name: 'Frame' }).waitFor();
  const framed = await query(page, covered.state_version);
  expect(framed.actions.map((/** @type {any} */ a) => a.target_id)).toContain('frame-diff');
});

test('MCP differential checkout cuts aggregate context by at least 50% versus identical full polling', async () => {
  test.setTimeout(120000);
  const app = await createTcrApp();
  const tokenizer = getEncoding('cl100k_base');
  /** @type {{mode: string, tokens: number, observations: number, success: boolean}[]} */
  const trials = [];
  try {
    for (const differential of [false, true]) {
      const client = new Client({ name: 'diff-checkout', version: '1.0.0' });
      await client.connect(new StdioClientTransport({ command: process.execPath, args: ['bin/navi-mcp.js'], cwd: root, stderr: 'pipe', env: { ...process.env, NAVI_ALLOW_LOCAL_NETWORK: '1' } }));
      let tokens = 0, observations = 0;
      /** @type {Map<string, any>} */
      const cache = new Map();
      /** @type {number | undefined} */
      let cursor;
      /** @param {string} name @param {Record<string, unknown>} args @returns {Promise<any>} */
      const call = async (name, args) => {
        const result = await client.callTool({ name, arguments: args });
        const text = /** @type {{text: string}[]} */ (result.content)[0].text;
        expect(result.isError, text).toBeFalsy();
        const body = JSON.parse(text);
        if (name === 'navi_get_actions') {
          tokens += tokenizer.encode(text).length; observations++;
          if (body.reset) cache.clear();
          for (const action of body.actions) {
            if (action.removed) cache.delete(action.target_id); else cache.set(action.target_id, action);
          }
          cursor = body.state_version;
        }
        return body;
      };
      const observe = () => call('navi_get_actions', differential && cursor !== undefined ? { since_version: cursor } : {});
      try {
        await call('navi_navigate', { url: `${app.origin}/checkout?seed=1` });
        // An unusable cursor resets on the transport too: it is answered with a
        // full snapshot rather than a tool error the caller cannot recover from.
        // This call is not counted: both paths run it identically.
        const recovered = JSON.parse(/** @type {{text: string}[]} */ ((await client.callTool({ name: 'navi_get_actions', arguments: { since_version: -5 } })).content)[0].text);
        expect(recovered.reset).toBe(true);
        expect(recovered.actions.length).toBeGreaterThan(0);
        const steps = [
          ['Search products', 'type', { text: 'backpack' }, 'mutation_settle'],
          ['Quantity', 'select', { value: '2' }, 'mutation_settle'],
          ['Add Trail backpack', 'click', {}, 'mutation_settle'],
          ['Review checkout', 'click', {}, 'navigation'],
          ['Email address', 'type', { text: 'agent@example.test' }, 'mutation_settle'],
          ['Shipping method', 'select', { value: 'express' }, 'mutation_settle'],
          ['Place sandbox order', 'click', {}, 'navigation']
        ];
        let finalUrl = '';
        for (const [name, action_type, payload, wait_for] of steps) {
          // Three identical observation opportunities per step: initial read,
          // planning read and safety recheck. Both paths use the same cadence.
          for (let i = 0; i < 3; i++) await observe();
          const target = [...cache.values()].find(action => action.name === name && action.state.is_enabled && action.state.is_visible && !action.state.is_occluded);
          expect(target, String(name)).toBeTruthy();
          const receipt = await call('navi_execute_action', { target_id: target.target_id, action_type, payload, settle: { wait_for } });
          expect(receipt.settled).toBe(true);
          finalUrl = receipt.final_url;
          if (wait_for === 'navigation') {
            await call('navi_navigate', { url: finalUrl });
            cursor = undefined; cache.clear();
          }
        }
        const url = new URL(finalUrl);
        const response = await fetch(`${app.origin}/api/order?cart=${url.searchParams.get('cart')}`);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ quantity: 2, email: 'agent@example.test', shipping: 'express', totalCents: 10700 });
        trials.push({ mode: differential ? 'differential' : 'full', tokens, observations, success: true });
      } finally { await client.close(); }
    }
  } finally { await app.close(); }
  const reduction = 1 - trials[1].tokens / trials[0].tokens;
  await writeFile('reports/differential-tokens.json', JSON.stringify({ recordedAt: new Date().toISOString(), node: process.version, tokenizer: 'cl100k_base', cadence: 'three observations per action on both paths', trials, reduction }, null, 2) + '\n');
  expect(trials[0].observations).toBe(trials[1].observations);
  expect(reduction).toBeGreaterThanOrEqual(.5);
});

test('100 sequential mutations: aggregate delta context stays far below full polling', async ({ page }) => {
  test.setTimeout(120000);
  await page.goto('/settlement.html');
  // The workload that caused the inflation: a list whose ids are stable while
  // one row re-renders per step, read every step by both strategies.
  await page.evaluate(() => {
    const list = document.createElement('div');
    list.id = 'diff-rows';
    for (let index = 0; index < 24; index++) {
      const button = document.createElement('button');
      button.setAttribute('data-agent-target', `row-${index}`);
      // Fixed geometry so a label change cannot shift its siblings: the
      // measurement stays isolated to the target that actually mutated.
      button.style.cssText = 'width:150px;white-space:nowrap;overflow:hidden;display:inline-block';
      button.textContent = `Row ${index} idle`;
      list.append(button);
    }
    document.body.append(list);
  });
  const tokenizer = getEncoding('cl100k_base');
  /** @param {number | undefined} since @returns {Promise<any>} */
  const read = since => page.evaluate(cursor => /** @type {any} */ (window.Navi).actions(cursor === undefined ? { coordinateSpace: 'top' } : { since_version: cursor, coordinateSpace: 'top' }), since);
  /** @type {{step: number, deltaTokens: number, fullTokens: number, deltaActions: number, fullActions: number}[]} */
  const samples = [];
  // Baseline read: a first observation is a reset by definition, so the cursor
  // starts from a completed snapshot and every measured step is a real delta.
  let cursor = (await read(undefined)).state_version;
  let deltaTokens = 0, fullTokens = 0, deltaActions = 0, fullActions = 0;
  for (let step = 0; step < 100; step++) {
    const index = step % 24, kind = step % 3;
    // Three mutation shapes a real flow produces, one target per step: an
    // actionability change, a label re-render, and a newly mounted control.
    await page.evaluate(({ index, step, kind }) => {
      const list = document.querySelector('#diff-rows');
      const row = list && list.querySelector(`[data-agent-target="row-${index}"]`);
      if (!list || !row) throw new Error('Missing fixture row');
      if (kind === 0) { if (row.hasAttribute('disabled')) row.removeAttribute('disabled'); else row.setAttribute('disabled', ''); }
      else if (kind === 1) row.textContent = `Row ${index} state ${step}`;
      else {
        const button = document.createElement('button');
        button.setAttribute('data-agent-target', `row-new-${step}`);
        button.style.cssText = 'width:150px;white-space:nowrap;overflow:hidden;display:inline-block';
        button.textContent = `Row new ${step}`;
        list.append(button);
      }
    }, { index, step, kind });
    const delta = await read(cursor);
    const full = await read(undefined);
    // One re-rendered row per step, and the delta never degrades into a reset.
    expect(delta.reset, `step ${step}`).toBe(false);
    expect(delta.actions.length, `step ${step}`).toBe(1);
    expect(full.reset, `step ${step}`).toBe(true);
    const deltaCount = tokenizer.encode(JSON.stringify(delta)).length;
    const fullCount = tokenizer.encode(JSON.stringify(full)).length;
    deltaTokens += deltaCount; fullTokens += fullCount;
    deltaActions += delta.actions.length; fullActions += full.actions.length;
    cursor = delta.state_version;
    if (step < 10) samples.push({ step, deltaTokens: deltaCount, fullTokens: fullCount, deltaActions: delta.actions.length, fullActions: full.actions.length });
  }
  expect(deltaActions).toBe(100);
  const reduction = 1 - deltaTokens / fullTokens;
  await writeFile('reports/differential-mutations.json', JSON.stringify({
    recordedAt: new Date().toISOString(), node: process.version, tokenizer: 'cl100k_base',
    workload: '24-control list plus 4 surrounding controls, 100 sequential single-target mutations (alternating actionability toggle, label re-render and newly mounted control), one delta read and one full read per step',
    mutations: 100,
    fullPolling: { tokens: fullTokens, meanTokensPerStep: fullTokens / 100, meanActionsPerStep: fullActions / 100 },
    differential: { tokens: deltaTokens, meanTokensPerStep: deltaTokens / 100, actionsReturned: deltaActions },
    reduction, firstTenSteps: samples
  }, null, 2) + '\n');
  expect(reduction).toBeGreaterThanOrEqual(.5);
});

test('any trial seed is accepted, so a benchmark iteration number cannot become a harness refusal', async () => {
  // The live benchmark uses its iteration number as the seed. A seed ceiling in the
  // fixture turned every trial past it into a 400 on the first add-to-cart, which a
  // report can only read as a model that failed the task.
  const app = await createTcrApp({ hard: true });
  try {
    const page = await fetch(`${app.origin}/checkout?seed=21`);
    expect(page.status).toBe(200);
    const cart = await fetch(`${app.origin}/api/cart?seed=21`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seed: 21, product: 'Trail backpack', quantity: 2 })
    });
    expect(cart.status).toBe(201);
    const created = await cart.json();
    const quote = await fetch(`${app.origin}/api/shipping?cart=${created.cart}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shipping: 'express' })
    });
    expect(quote.status).toBe(200);
    expect((await quote.json()).totalCents).toBe(10700);
  } finally { await app.close(); }
});

test('a rejected submission is reported to the caller, and a control name resolves where an id does not', async () => {
  test.setTimeout(120000);
  // The hard fixture refuses the first order submission and commits nothing, which
  // is the case an agent has to be able to tell apart from a page that is merely
  // slow: same URL, same controls, and the only explanation in a live region.
  const app = await createTcrApp({ hard: true });
  const client = new Client({ name: 'rejection-feedback', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['bin/navi-mcp.js'], cwd: root, stderr: 'pipe', env: { ...process.env, NAVI_ALLOW_LOCAL_NETWORK: '1' } }));
  /** @param {string} name @param {Record<string, unknown>} args @param {boolean} [expectedError] @returns {Promise<any>} */
  const call = async (name, args, expectedError = false) => {
    const result = await client.callTool({ name, arguments: args });
    const body = JSON.parse(/** @type {{text: string}[]} */ (result.content)[0].text);
    expect(result.isError === true, JSON.stringify(body)).toBe(expectedError);
    return body;
  };
  /** @param {string} label @param {Record<string, unknown>} [extra] @returns {Promise<any>} */
  const act = async (label, extra = {}) => {
    const map = await call('navi_get_actions', {});
    const matches = map.actions.filter((/** @type {any} */ action) => action.name === label && action.state.is_visible && action.state.is_enabled && !action.state.is_occluded);
    expect(matches, label).toHaveLength(1);
    return call('navi_execute_action', { target_id: matches[0].target_id, settle: { wait_for: 'mutation_settle', timeout_ms: 6000 }, ...extra });
  };
  try {
    await call('navi_navigate', { url: `${app.origin}/checkout?seed=3` });
    await act('Search products', { action_type: 'type', payload: { text: 'backpack' } });
    await act('Quantity', { action_type: 'select', payload: { value: '2' } });
    await act('Add Trail backpack', { action_type: 'click' });
    const review = await act('Review checkout', { action_type: 'click', settle: { wait_for: 'navigation', timeout_ms: 6000 } });
    expect(review.settled).toBe(true);
    await call('navi_navigate', { url: review.final_url });
    await act('Email address', { action_type: 'type', payload: { text: 'agent@example.test' } });
    await act('Shipping method', { action_type: 'select', payload: { value: 'express' } });
    // The refusal: dispatched, settled, still on the review page. Only the message
    // the page printed distinguishes it from a submission that is still in flight.
    const rejected = await act('Place sandbox order', { action_type: 'click' });
    expect(rejected.executed).toBe(true);
    expect(rejected.settled).toBe(true);
    expect(rejected.final_url).toContain('step=review');
    expect(rejected.page_messages.join(' ')).toContain('Payment details could not be verified');
    // And a page read says the same, for a planner that looked before acting again.
    const afterRejection = await call('navi_get_actions', {});
    expect(afterRejection.page_messages.join(' ')).toContain('Payment details could not be verified');
    // An unknown handle is refused with the nearest current controls rather than a
    // bare "not found", so a planner that invented an id is not left guessing. It
    // dispatched nothing, so the form is exactly where the refusal left it.
    const invented = await call('navi_execute_action', { target_id: 'cart_btn', action_type: 'click' }, true);
    expect(invented.error.code).toBe('NOT_FOUND');
    expect(invented.candidates.length).toBeGreaterThan(0);
    expect(invented.candidates[0]).toEqual(expect.objectContaining({ target_id: expect.any(String), name: expect.any(String) }));
    // A handle that is not an id is resolved against the control's own label: this
    // dispatched nothing on the first attempt, so acting on the resolved id is safe.
    const resubmitted = await call('navi_execute_action', {
      target_id: 'Place sandbox order', action_type: 'click', settle: { wait_for: 'navigation', timeout_ms: 6000 }
    });
    expect(resubmitted.resolved_from).toBe('Place sandbox order');
    expect(resubmitted.settled).toBe(true);
    const url = new URL(resubmitted.final_url);
    expect(url.searchParams.get('step')).toBe('complete');
    const order = await (await fetch(`${app.origin}/api/order?cart=${url.searchParams.get('cart')}`)).json();
    expect(order).toMatchObject({ quantity: 2, email: 'agent@example.test', shipping: 'express', totalCents: 10700 });
  } finally {
    await client.close();
    await app.close();
  }
});
