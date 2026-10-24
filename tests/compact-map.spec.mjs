import { test, expect } from '@playwright/test';
import { getEncoding } from 'js-tiktoken';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { compactActionMap } from '../src/mcp/action-map.js';

const encoding = getEncoding('cl100k_base');
/** @param {any} result */
const body = result => JSON.parse(result.content[0].text);

test('compact maps preserve refusal reasons and differential removals', () => {
  const map = compactActionMap({
    version: '0.3.0', state_version: 9, reset: false, truncated: false,
    actions: [{ target_id: 'old', removed: true }, {
      target_id: 'pay', role: 'button', name: 'Pay', suggested_action: 'click',
      state: { is_visible: false, is_enabled: false, is_in_viewport: false, is_occluded: true },
      coordinates: { x: 1, y: 2, width: 3, height: 4 }
    }]
  });
  expect(map.reset).toBe(false);
  expect(map.state_version).toBe(9);
  expect(map.actions).toEqual([
    { target_id: 'old', removed: true },
    { target_id: 'pay', role: 'button', name: 'Pay', action: 'click', available: false, blocked_by: ['hidden', 'disabled', 'offscreen', 'occluded'] }
  ]);
});

test('compact MCP observations use fewer tokens while guarded execution still verifies the workflow', async ({ baseURL }) => {
  const client = new Client({ name: 'compact-observation-check', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['bin/navi-mcp.js'], env: { ...process.env, NAVI_ALLOW_LOCAL_NETWORK: '1' } });
  await client.connect(transport);
  try {
    await client.callTool({ name: 'navi_navigate', arguments: { url: baseURL } });
    const full = await client.callTool({ name: 'navi_get_actions', arguments: { all: true } });
    const compact = await client.callTool({ name: 'navi_get_actions', arguments: { all: true, compact: true } });
    const fullBody = body(full), compactBody = body(compact);
    expect(compactBody.format).toBe('compact');
    expect(compactBody.actions.map((/** @type {any} */ a) => a.target_id)).toEqual(fullBody.actions.map((/** @type {any} */ a) => a.target_id));
    for (const action of compactBody.actions) {
      const original = fullBody.actions.find((/** @type {any} */ a) => a.target_id === action.target_id);
      expect(action.available).toBe(original.state.is_visible && original.state.is_enabled && original.state.is_in_viewport && !original.state.is_occluded);
      expect(action).not.toHaveProperty('coordinates');
    }
    const fullTokens = encoding.encode(JSON.stringify(fullBody, null, 2)).length;
    const compactTokens = encoding.encode(JSON.stringify(compactBody, null, 2)).length;
    expect(compactTokens).toBeLessThan(fullTokens);
    const samples = [{ fullTokens, compactTokens }];
    for (let pair = 1; pair < 5; pair++) {
      const order = pair % 2 ? [true, false] : [false, true];
      const counts = new Map();
      for (const compactMode of order) {
        const observed = body(await client.callTool({ name: 'navi_get_actions', arguments: { all: true, compact: compactMode } }));
        expect(observed.actions.map((/** @type {any} */ a) => a.target_id)).toEqual(fullBody.actions.map((/** @type {any} */ a) => a.target_id));
        counts.set(compactMode, encoding.encode(JSON.stringify(observed, null, 2)).length);
      }
      expect(counts.get(true)).toBeLessThan(counts.get(false));
      samples.push({ fullTokens: counts.get(false), compactTokens: counts.get(true) });
    }
    console.log(JSON.stringify({ fixture: 'demo checkout full action map', tokenizer: 'cl100k_base', pairs: 5, samples, scope: 'observation payload only; no model or provider billing' }));
    const typed = body(await client.callTool({ name: 'navi_execute_action', arguments: { target_id: 'checkout-email', action_type: 'type', payload: { text: 'compact@example.test' } } }));
    expect(typed.dispatched).toBe(true);
    const after = body(await client.callTool({ name: 'navi_get_actions', arguments: { all: true, compact: true } }));
    const submit = after.actions.find((/** @type {any} */ a) => a.target_id === 'checkout-submit');
    expect(submit.available).toBe(true);
    const executed = body(await client.callTool({ name: 'navi_execute_action', arguments: { target_id: submit.target_id, action_type: submit.action, settle: { wait_for: 'mutation_settle' } } }));
    expect(executed.dispatched).toBe(true);
    const outcome = body(await client.callTool({ name: 'navi_read_text', arguments: { selector: '#status' } }));
    expect(outcome.text).toBe('Sandbox checkout complete — no payment was made.');
    const cursor = body(await client.callTool({ name: 'navi_get_actions', arguments: { compact: true, all: true, since_version: after.state_version } }));
    expect(cursor.reset).toBe(false);
    const invalid = body(await client.callTool({ name: 'navi_execute_action', arguments: { target_id: 'absent', action_type: 'click' } }));
    expect(invalid.error.code).toBe('NOT_FOUND');
  } finally {
    await client.close();
  }
});
