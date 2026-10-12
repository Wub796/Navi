import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * End-to-end MCP checks over the SSE (HTTP) transport.
 *
 * The same server binary is launched with `--transport sse`, and the official
 * @modelcontextprotocol/sdk SSE client drives it, so the remote transport is
 * held to the same protocol conformance as the stdio one: same tool surface,
 * same envelopes, same actionable refusals. Only 127.0.0.1 is touched.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const binPath = join(root, 'bin', 'navi-mcp.js');

/** @typedef {{ok?: boolean, error?: {code: string, message: string}, protocolVersion?: string, actions?: import('../types/index.js').NaviAction[], viewportOnly?: boolean, truncated?: boolean, passed?: boolean, dispatched?: boolean, mode?: string, target_id?: string}} ToolBody */

/** @param {any} result @returns {ToolBody} */
const envelope = result => JSON.parse(result.content[0].text);

/** @param {number} ms */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Ask the OS for an unused port so concurrent runs cannot collide. @returns {Promise<number>} */
async function freePort() {
  const probe = createServer();
  return await new Promise(/** @param {(value: number) => void} resolve */ resolve => {
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Poll the SSE endpoint until it is genuinely streaming. Each probe aborts its
 * own body so a not-yet-ready server cannot leak a connection into the run.
 * @param {string} url
 * @param {() => string} stderr
 */
async function waitForEventStream(url, stderr) {
  const deadline = Date.now() + 8000;
  let last = 'no attempt completed';
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1000);
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { accept: 'text/event-stream' } });
      const type = response.headers.get('content-type') ?? '';
      await response.body?.cancel();
      if (response.ok && type.includes('text/event-stream')) return;
      last = `HTTP ${response.status} ${type || '(no content-type)'}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
    }
    await sleep(150);
  }
  throw new Error(`the SSE endpoint never became ready (last: ${last}); child stderr:\n${stderr()}`);
}

test('an MCP client drives the same multi-step flow over the SSE transport', async ({ baseURL }) => {
  test.setTimeout(120000);
  const port = await freePort();
  const child = spawn(process.execPath, [binPath, '--transport', 'sse', '--port', String(port)], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NAVI_ALLOW_LOCAL_NETWORK: '1' }
  });
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  child.on('error', error => { stderr += `spawn error: ${error.message}`; });

  const url = `http://127.0.0.1:${port}/sse`;
  const client = new Client({ name: 'navi-mcp-sse', version: '1.0.0' });
  try {
    await waitForEventStream(url, () => stderr);
    await client.connect(new SSEClientTransport(new URL(url)));

    // The remote transport must expose the same tool surface as stdio.
    const listed = await client.listTools();
    expect(listed.tools.map(tool => tool.name).sort()).toEqual(['navi_assert_state', 'navi_execute_action', 'navi_get_actions', 'navi_navigate', 'navi_set_session']);
    for (const tool of listed.tools) expect(tool.inputSchema?.type, `${tool.name} schema`).toBe('object');

    // No page yet: the refusal is structured exactly as it is over stdio.
    const early = await client.callTool({ name: 'navi_get_actions', arguments: {} });
    expect(early.isError).toBe(true);
    expect(envelope(early).error?.code).toBe('NO_PAGE');

    const nav = await client.callTool({ name: 'navi_navigate', arguments: { url: `${baseURL}/`, width: 1360, height: 900 } });
    expect(nav.isError).toBeFalsy();
    const navBody = envelope(nav);
    expect(navBody.ok).toBe(true);
    expect(navBody.protocolVersion).toBe('0.3.0');

    // A real flow, not just a read: the interaction creates a control the
    // remote client must then discover through a re-render.
    const typed = envelope(await client.callTool({ name: 'navi_execute_action', arguments: { target_id: 'checkout-email', action_type: 'type', payload: { text: 'sse@navi.test' } } }));
    expect(typed.dispatched).toBe(true);

    const selected = envelope(await client.callTool({ name: 'navi_execute_action', arguments: { target_id: 'checkout-delivery', action_type: 'select', payload: { value: 'Send me a link' } } }));
    expect(selected.dispatched).toBe(true);

    const added = envelope(await client.callTool({ name: 'navi_execute_action', arguments: { target_id: 'checkout-add-discount', action_type: 'click' } }));
    expect(added.dispatched).toBe(true);

    const afterAdd = envelope(await client.callTool({ name: 'navi_get_actions', arguments: { all: true } }));
    expect((afterAdd.actions ?? []).map(action => action.target_id), 'the dynamic re-render is visible over SSE').toContain('checkout-discount');

    const state = envelope(await client.callTool({ name: 'navi_assert_state', arguments: { target_id: 'checkout-email', name_contains: 'Email' } }));
    expect(state.passed).toBe(true);

    const submitted = envelope(await client.callTool({ name: 'navi_execute_action', arguments: { target_id: 'checkout-submit', action_type: 'click' } }));
    expect(submitted.dispatched).toBe(true);

    const refused = await client.callTool({ name: 'navi_execute_action', arguments: { target_id: 'checkout-add-discount', action_type: 'click' } });
    expect(refused.isError).toBe(true);
    expect(envelope(refused).error?.code).toBe('UNAVAILABLE');
  } finally {
    await client.close();
    // A child that already died (for example on a bad flag) must not be mistaken
    // for a clean stop, so the exit state is inspected before and after the kill.
    const waitForExit = () => new Promise(/** @param {(value: number | string | null) => void} resolve */ resolve => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(child.exitCode ?? child.signalCode); return; }
      const timer = setTimeout(() => resolve('timeout'), 5000);
      child.on('exit', code => { clearTimeout(timer); resolve(code ?? 'signal'); });
    });
    child.kill('SIGTERM');
    const exited = await waitForExit();
    expect(exited, `the SSE server must exit when asked; stderr:\n${stderr}`).not.toBe('timeout');
  }
});
