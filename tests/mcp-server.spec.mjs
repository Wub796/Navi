import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * End-to-end MCP server checks.
 *
 * The interactive test drives the server with the official
 * @modelcontextprotocol/sdk Client, so protocol conformance is asserted by the
 * reference implementation rather than by this repository's own assumptions.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const binPath = join(root, 'bin', 'navi-mcp.js');

/**
 * The JSON body every tool returns inside its text content block.
 * @typedef {{ok?: boolean, error?: {code: string, message: string, guidance?: string}, url?: string, title?: string, status?: number | null, protocolVersion?: string, actions?: import('../types/index.js').NaviAction[], viewportOnly?: boolean, truncated?: boolean, passed?: boolean, dispatched?: boolean, mode?: string, trusted_fallback?: boolean, may_have_applied?: boolean, sdk?: {strategy: string, injected: boolean}, matches?: number, checks?: {label: string, ok: boolean, expected: unknown, observed: unknown}[], observed?: {role: string, name: string, state: {is_enabled: boolean, is_visible: boolean, is_occluded: boolean}} | null}} ToolBody
 */
/** @param {any} result @returns {ToolBody} */
const envelope = result => JSON.parse(result.content[0].text);

test('an MCP client drives a multi-step form and receives actionable refusals', async ({ baseURL }) => {
  test.setTimeout(180000);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [binPath],
    cwd: root,
    stderr: 'pipe',
    env: { ...process.env, NAVI_MCP_DEBUG: '1' }
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += String(chunk); });
  const client = new Client({ name: 'navi-mcp-e2e', version: '1.0.0' });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    expect(listed.tools.map(tool => tool.name).sort()).toEqual(['navi_assert_state', 'navi_execute_action', 'navi_get_actions', 'navi_navigate', 'navi_set_session']);
    for (const tool of listed.tools) expect(tool.inputSchema?.type, `${tool.name} schema`).toBe('object');

    // No page yet: the envelope names the recovery tool.
    const early = await client.callTool({ name: 'navi_get_actions', arguments: {} });
    expect(early.isError).toBe(true);
    expect(envelope(early).error?.code).toBe('NO_PAGE');
    expect(envelope(early).error?.message).toContain('navi_navigate');

    const nav = await client.callTool({ name: 'navi_navigate', arguments: { url: baseURL, width: 1360, height: 900 } });
    expect(nav.isError).toBeFalsy();
    const navBody = envelope(nav);
    expect(navBody.ok).toBe(true);
    expect(navBody.protocolVersion).toBe('0.3.0');
    // The demo page ships the bundle itself, so the server should detect it and
    // report the strategy it used rather than re-injecting.
    expect(['already-present', 'tag', 'evaluate']).toContain(navBody.sdk?.strategy);
    expect(navBody.sdk?.injected).toBe(false);
    expect(navBody.actions).toBeGreaterThan(4);
    expect(navBody.title).toContain('Navi');

    // Viewport-filtered by default, full map on request.
    const viewportMap = envelope(await client.callTool({ name: 'navi_get_actions', arguments: {} }));
    expect(viewportMap.viewportOnly).toBe(true);
    expect(viewportMap.truncated).toBe(false);
    const all = envelope(await client.callTool({ name: 'navi_get_actions', arguments: { all: true } }));
    expect(all.viewportOnly).toBe(false);
    expect((all.actions ?? []).every(action => typeof action.target_id === 'string' && typeof action.role === 'string')).toBe(true);
    const ids = (all.actions ?? []).map(action => action.target_id);
    for (const id of ['checkout-form', 'checkout-email', 'checkout-delivery', 'checkout-add-discount', 'checkout-submit']) {
      expect(ids, `action map contains ${id}`).toContain(id);
    }

    // Multi-step form interaction.
    const state = envelope(await client.callTool({ name: 'navi_assert_state', arguments: { target_id: 'checkout-email', visible: true, enabled: true, in_viewport: true, name_contains: 'Email' } }));
    expect(state.passed).toBe(true);
    expect((state.checks ?? []).every(check => check.ok)).toBe(true);
    expect(state.observed?.state.is_enabled).toBe(true);

    const typed = envelope(await client.callTool({ name: 'navi_execute_action', arguments: { target_id: 'checkout-email', action_type: 'type', payload: { text: 'agent+nv@navi.test' } } }));
    expect(typed.dispatched).toBe(true);
    expect(typed.mode).toBe('synthetic');
    expect(typed.trusted_fallback).toBe(false);

    const selected = envelope(await client.callTool({ name: 'navi_execute_action', arguments: { target_id: 'checkout-delivery', action_type: 'select', payload: { value: 'Send me a link' } } }));
    expect(selected.dispatched).toBe(true);

    const added = envelope(await client.callTool({ name: 'navi_execute_action', arguments: { target_id: 'checkout-add-discount', action_type: 'click' } }));
    expect(added.dispatched).toBe(true);

    // Dynamic update: the interaction created a control and disabled another.
    const afterAdd = envelope(await client.callTool({ name: 'navi_get_actions', arguments: { all: true } }));
    expect((afterAdd.actions ?? []).map(action => action.target_id)).toContain('checkout-discount');
    const disabled = envelope(await client.callTool({ name: 'navi_assert_state', arguments: { target_id: 'checkout-add-discount', enabled: false } }));
    expect(disabled.passed).toBe(true);
    expect(disabled.observed?.state.is_enabled).toBe(false);
    const failedAssert = envelope(await client.callTool({ name: 'navi_assert_state', arguments: { target_id: 'checkout-submit', name: 'Not the real name' } }));
    expect(failedAssert.passed).toBe(false);
    expect((failedAssert.checks ?? []).filter(check => !check.ok).map(check => check.label)).toContain('name');

    // Acting on a disabled control is refused before dispatch, with guidance.
    const refused = await client.callTool({ name: 'navi_execute_action', arguments: { target_id: 'checkout-add-discount', action_type: 'click' } });
    expect(refused.isError).toBe(true);
    const refusedBody = envelope(refused);
    expect(refusedBody.error?.code).toBe('UNAVAILABLE');
    expect(refusedBody.error?.message).toContain('disabled');
    expect(refusedBody.may_have_applied).toBeUndefined();

    // A missing target names the recovery tool.
    const missing = await client.callTool({ name: 'navi_execute_action', arguments: { target_id: 'no-such-target', action_type: 'click' } });
    expect(missing.isError).toBe(true);
    expect(envelope(missing).error?.code).toBe('NOT_FOUND');
    expect(envelope(missing).error?.message).toContain('navi_get_actions');

    // The consequential step completes the form.
    const submit = envelope(await client.callTool({ name: 'navi_execute_action', arguments: { target_id: 'checkout-submit', action_type: 'click' } }));
    expect(submit.dispatched).toBe(true);

    // Only credential-free http(s) targets are opened.
    for (const url of ['file:///etc/passwd', 'https://user:pass@example.com/', 'not a url']) {
      const bad = await client.callTool({ name: 'navi_navigate', arguments: { url } });
      expect(bad.isError, `rejects ${url}`).toBe(true);
      expect(envelope(bad).error?.code).toBe('INVALID_URL');
    }
    // A refusal must not copy embedded credentials into the model's context.
    const credentialed = envelope(await client.callTool({ name: 'navi_navigate', arguments: { url: 'https://user:pass@example.com/' } }));
    expect(credentialed.error?.message).toContain('[redacted]@');
    expect(credentialed.error?.message).not.toContain('user:pass');

    const unknown = await client.callTool({ name: 'navi_nope', arguments: {} });
    expect(unknown.isError).toBe(true);
    expect(envelope(unknown).error?.code).toBe('UNKNOWN_TOOL');

    // Diagnostics belong on stderr; stdout carried only JSON-RPC.
    expect(stderr).toContain('tools/call');
  } finally {
    await client.close();
  }
});

test('trusted-input fallback is automatic by default and refused under --no-fallback', async ({ baseURL }) => {
  test.setTimeout(120000);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [binPath, '--no-fallback'],
    cwd: root,
    stderr: 'pipe',
    env: { ...process.env, NAVI_MCP_DEBUG: '1' }
  });
  const client = new Client({ name: 'navi-mcp-strict', version: '1.0.0' });
  await client.connect(transport);
  try {
    // The strict-CSP fixture ships the bundle from its own origin and marks one
    // control data-navi-trusted="true".
    const nav = envelope(await client.callTool({ name: 'navi_navigate', arguments: { url: `${baseURL}/csp.html` } }));
    expect(nav.ok).toBe(true);
    const ids = (envelope(await client.callTool({ name: 'navi_get_actions', arguments: { all: true } })).actions ?? []).map(action => action.target_id);
    expect(ids).toContain('csp-trusted');

    // Synthetic dispatch is unaffected by the strict switch.
    const typed = envelope(await client.callTool({ name: 'navi_execute_action', arguments: { target_id: 'csp-name', action_type: 'type', payload: { text: 'Ada Lovelace' } } }));
    expect(typed.mode).toBe('synthetic');
    expect(typed.dispatched).toBe(true);
    const submitted = envelope(await client.callTool({ name: 'navi_execute_action', arguments: { target_id: 'csp-submit', action_type: 'click' } }));
    expect(submitted.dispatched).toBe(true);
    expect(submitted.mode).toBe('synthetic');

    // Trusted input is refused instead of being driven by real mouse/keyboard.
    const refused = await client.callTool({ name: 'navi_execute_action', arguments: { target_id: 'csp-trusted', action_type: 'click' } });
    expect(refused.isError).toBe(true);
    const body = envelope(refused);
    expect(body.error?.code).toBe('FALLBACK_DISABLED');
    expect(body.error?.message).toContain('--no-fallback');
    expect(body.dispatched).toBeUndefined();
  } finally {
    await client.close();
  }

  // The same tool call in a default session is what the spec asks for: a
  // data-navi-trusted control is driven by real hardware input automatically.
  const normal = new Client({ name: 'navi-mcp-default', version: '1.0.0' });
  await normal.connect(new StdioClientTransport({
    command: process.execPath,
    args: [binPath],
    cwd: root,
    stderr: 'pipe',
    env: { ...process.env, NAVI_MCP_DEBUG: '0' }
  }));
  try {
    const reopened = envelope(await normal.callTool({ name: 'navi_navigate', arguments: { url: `${baseURL}/csp.html` } }));
    expect(reopened.ok).toBe(true);
    const driven = envelope(await normal.callTool({ name: 'navi_execute_action', arguments: { target_id: 'csp-trusted', action_type: 'click' } }));
    expect(driven.dispatched).toBe(true);
    expect(driven.mode).toBe('native-driver');
    expect(driven.trusted_fallback).toBe(true);
  } finally {
    await normal.close();
  }
});

test('the server speaks spec-conformant JSON-RPC over stdio', async () => {
  test.setTimeout(60000);
  const child = spawn(process.execPath, [binPath], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NAVI_MCP_DEBUG: '1' } });
  const reader = createInterface({ input: child.stdout });
  /** @type {((line: string) => void)[]} */
  const pending = [];
  /** @type {string[]} */
  const strayOutput = [];
  reader.on('line', line => {
    const waiter = pending.shift();
    if (waiter) waiter(line);
    else strayOutput.push(line);
  });
  /** @type {string[]} */
  const stderrLines = [];
  createInterface({ input: child.stderr }).on('line', line => stderrLines.push(line));
  /** @param {object} message */
  const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
  const nextResponse = () => new Promise(/** @param {(value: any) => void} resolve */ resolve => {
    const timer = setTimeout(() => resolve({ __timeout: true }), 15000);
    pending.push(line => { clearTimeout(timer); resolve(JSON.parse(line)); });
  });

  try {
    await new Promise(resolve => setTimeout(resolve, 300));

    // Requests before initialize are refused with the protocol's own code.
    send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const early = await nextResponse();
    expect(early.id).toBe(1);
    expect(early.error.code).toBe(-32002);
    expect(early.jsonrpc).toBe('2.0');

    // A malformed frame is reported as a parse error without killing the server.
    child.stdin.write('{not json\n');
    const parseError = await nextResponse();
    expect(parseError.error.code).toBe(-32700);
    expect(parseError.id).toBeNull();

    // Unknown protocol versions negotiate down to the server's newest.
    send({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } });
    const init = await nextResponse();
    expect(init.id).toBe(2);
    expect(init.result.protocolVersion).toBe('2025-11-25');
    expect(init.result.capabilities.tools).toBeDefined();
    expect(init.result.serverInfo.name).toBe('navi-mcp-server');
    expect(Array.isArray(init.result.instructions)).toBe(false);

    // A supported version is echoed back rather than overridden.
    send({ jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } });
    expect((await nextResponse()).result.protocolVersion).toBe('2024-11-05');

    // Notifications must never be answered; the next reply is the ping's.
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    send({ jsonrpc: '2.0', id: 4, method: 'ping' });
    const pong = await nextResponse();
    expect(pong.id, 'notification must not consume a response slot').toBe(4);
    expect(pong.result).toEqual({});

    send({ jsonrpc: '2.0', id: 5, method: 'tools/list' });
    const tools = await nextResponse();
    /** @type {{name: string}[]} */
    const listedTools = tools.result.tools;
    expect(listedTools).toHaveLength(5);
    expect(listedTools.map(tool => tool.name)).toContain('navi_execute_action');

    send({ jsonrpc: '2.0', id: 6, method: 'resources/list' });
    expect((await nextResponse()).error.code).toBe(-32601);

    send({ jsonrpc: '2.0', id: 7 });
    expect((await nextResponse()).error.code).toBe(-32600);

    expect(strayOutput).toEqual([]);
  } finally {
    child.stdin.end();
    const exited = await new Promise(resolve => {
      const timer = setTimeout(() => resolve('timeout'), 15000);
      child.on('exit', code => { clearTimeout(timer); resolve(code); });
    });
    expect(exited, 'server exits when stdin closes').toBe(0);
    expect(stderrLines.length).toBeGreaterThan(0);
  }
});
