import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSseServer } from '../src/mcp/sse.js';

/**
 * Security and resource bounds on the remote MCP transport.
 *
 * An open SSE port is an open browser, so three properties are asserted here
 * rather than assumed: a bearer token gates both endpoints, the session ceiling
 * answers excess streams with 503 instead of starting another browser, and an
 * idle stream is reaped with its session closed. The lifecycle cases run against
 * `createSseServer` with a stub session, which is the only way to observe that
 * the *browser* was closed rather than merely that the stream ended; one case
 * drives the hardened server through the official SDK client end to end.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const binPath = join(root, 'bin', 'navi-mcp.js');

/** @typedef {{closed: number, close: () => Promise<void>}} StubSession */

/** @param {number} ms */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Unwrap the tool envelope the server returns. @param {any} result @returns {any} */
const envelope = result => JSON.parse(result.content[0].text);

/** Ask the OS for an unused port so concurrent runs cannot collide. */
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
 * Boot a transport whose sessions are stubs, so the bounds can be exercised
 * without launching Chromium.
 * @param {{authToken?: string, maxSessions?: number, idleTimeoutMs?: number}} [options]
 */
async function startTransport(options = {}) {
  /** @type {StubSession[]} */
  const sessions = [];
  const server = await createSseServer({
    port: 0,
    ...options,
    createSession: () => {
      /** @type {StubSession} */
      const session = { closed: 0, close: async () => { session.closed++; } };
      sessions.push(session);
      return session;
    },
    handleMessage: async message => (message?.id === undefined ? null : { jsonrpc: '2.0', id: message.id, result: { ok: true } })
  });
  return { server, sessions, base: `http://127.0.0.1:${server.port}` };
}

/** The number of open sessions the server reports. @param {string} base */
async function openSessions(base) {
  const response = await fetch(`${base}/healthz`);
  return (await response.json()).sessions;
}

/** Resolve the marker `'timeout'` after `ms`, so a stalled read can be abandoned.
 * @param {number} ms @returns {Promise<'timeout'>} */
const after = ms => new Promise(/** @param {(value: 'timeout') => void} resolve */ resolve => { setTimeout(() => resolve('timeout'), ms); });

/**
 * One reader per body: a ReadableStream can only be locked once, and these tests
 * both read frames and later close the stream. Frames are accumulated across
 * calls, so a reply that arrives in a later chunk is still found.
 * @param {ReadableStream<Uint8Array>} body
 */
function openStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const fail = (/** @type {number} */ timeoutMs) => new Error(`timed out after ${timeoutMs}ms; received ${JSON.stringify(text)}`);
  /** @param {(text: string) => boolean} predicate @param {number} [timeoutMs] */
  const readUntil = async (predicate, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(text)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw fail(timeoutMs);
      const chunk = await Promise.race([reader.read(), after(remaining)]);
      if (chunk === 'timeout') throw fail(timeoutMs);
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text;
  };
  return {
    readUntil,
    /** Read to the end, so a stream the server closed is observed as closed. @param {number} [timeoutMs] */
    readToEnd: (timeoutMs) => readUntil(() => false, timeoutMs),
    cancel: () => reader.cancel()
  };
}

/** Run the MCP binary to completion and capture how it exited.
 * @param {string[]} args */
async function runCli(args) {
  const child = spawn(process.execPath, [binPath, ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
  let stdout = '', stderr = '';
  child.stdout?.on('data', chunk => { stdout += String(chunk); });
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  const code = await new Promise(/** @param {(value: number | null) => void} resolve */ resolve => {
    const timer = setTimeout(() => resolve(null), 15000);
    child.on('exit', exitCode => { clearTimeout(timer); resolve(exitCode); });
  });
  if (code === null) child.kill('SIGKILL');
  return { code, stdout, stderr };
}

/**
 * Poll the SSE endpoint until it is genuinely streaming. Each probe aborts its
 * own body so a not-yet-ready server cannot leak a connection into the run.
 * @param {string} url @param {() => string} stderr @param {Record<string, string>} [headers]
 */
async function waitForEventStream(url, stderr, headers = {}) {
  const deadline = Date.now() + 8000;
  let last = 'no attempt completed';
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1000);
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { accept: 'text/event-stream', ...headers } });
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

test('a bearer token gates both SSE endpoints and is never echoed back', async () => {
  const { server, base } = await startTransport({ authToken: 'sekret-token' });
  try {
    const anonymous = await fetch(`${base}/sse`);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toContain('Bearer');
    const body = await anonymous.text();
    expect(JSON.parse(body).error.code).toBe('UNAUTHORIZED');
    expect(body, 'a rejection must not repeat the credential').not.toContain('sekret-token');

    const wrong = await fetch(`${base}/sse`, { headers: { Authorization: 'Bearer sekret-toke' } });
    expect(wrong.status, 'a wrong token of the same length is refused').toBe(401);
    const notBearer = await fetch(`${base}/sse`, { headers: { Authorization: 'sekret-token' } });
    expect(notBearer.status, 'the scheme is required, not just the value').toBe(401);

    // Auth is decided before the session lookup, so an unauthenticated caller
    // cannot probe which session ids are live.
    const post = await fetch(`${base}/message?sessionId=00000000-0000-4000-8000-000000000000`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
    });
    expect(post.status).toBe(401);

    const good = await fetch(`${base}/sse`, { headers: { Authorization: 'Bearer sekret-token' } });
    expect(good.status).toBe(200);
    expect(good.headers.get('content-type')).toContain('text/event-stream');
    if (!good.body) throw new Error('the authenticated stream carried no body');
    const stream = openStream(good.body);
    const frame = await stream.readUntil(text => text.includes('event: endpoint'));
    const sessionId = /sessionId=([0-9a-f-]+)/.exec(frame)?.[1] ?? '';
    expect(sessionId).not.toBe('');

    // The same credential carries the message through, and the reply arrives on
    // the stream rather than in the POST response.
    const accepted = await fetch(`${base}/message?sessionId=${sessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sekret-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' })
    });
    expect(accepted.status).toBe(202);
    const reply = await stream.readUntil(text => text.includes('"id":7'));
    expect(reply).toContain('"result"');
    await stream.cancel();
  } finally {
    await server.close();
  }
});

test('the session ceiling answers excess streams with 503 and releases the slot', async () => {
  const { server, sessions, base } = await startTransport({ maxSessions: 1 });
  try {
    const first = await fetch(`${base}/sse`);
    expect(first.status).toBe(200);
    if (!first.body) throw new Error('the first stream carried no body');
    const firstStream = openStream(first.body);
    await firstStream.readUntil(text => text.includes('event: endpoint'));
    expect(sessions.length).toBe(1);

    const second = await fetch(`${base}/sse`);
    expect(second.status).toBe(503);
    expect(second.headers.get('retry-after')).toBe('5');
    expect((await second.json()).error.code).toBe('TOO_MANY_SESSIONS');
    expect(sessions.length, 'a refused stream must not start another session').toBe(1);

    const health = await (await fetch(`${base}/healthz`)).json();
    expect(health).toMatchObject({ ok: true, transport: 'sse', sessions: 1, maxSessions: 1, auth: 'none' });

    // Capacity is a live count, not a latch: closing the stream frees the slot.
    await firstStream.cancel();
    await expect.poll(() => openSessions(base)).toBe(0);
    expect(sessions[0].closed, 'the closed stream must close its session').toBe(1);

    const third = await fetch(`${base}/sse`);
    expect(third.status).toBe(200);
    await third.body?.cancel();
  } finally {
    await server.close();
  }
});

test('an idle session is reaped and its browser closed, while a busy one survives', async () => {
  let releaseCall = () => {};
  const held = new Promise(resolve => { releaseCall = () => resolve(undefined); });
  /** @type {StubSession[]} */
  const sessions = [];
  const server = await createSseServer({
    port: 0,
    idleTimeoutMs: 400,
    createSession: () => {
      /** @type {StubSession} */
      const session = { closed: 0, close: async () => { session.closed++; } };
      sessions.push(session);
      return session;
    },
    // The first call never resolves on its own: it stands in for a tool call that
    // outlives the idle window, which must not be reaped underneath the caller.
    handleMessage: async (message, state) => {
      state.log('slow call holding the session');
      await held;
      return { jsonrpc: '2.0', id: message?.id ?? null, result: { ok: true } };
    }
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const idle = await fetch(`${base}/sse`);
    if (!idle.body) throw new Error('the idle stream carried no body');
    const idleStream = openStream(idle.body);
    await idleStream.readUntil(text => text.includes('event: endpoint'));
    // The stream ends by itself and names why.
    const tail = await idleStream.readToEnd();
    expect(tail).toContain('idle timeout after 0.4s');
    expect(sessions[0].closed).toBe(1);
    await expect.poll(() => openSessions(base)).toBe(0);

    const busy = await fetch(`${base}/sse`);
    if (!busy.body) throw new Error('the busy stream carried no body');
    const busyStream = openStream(busy.body);
    const frame = await busyStream.readUntil(text => text.includes('event: endpoint'));
    const sessionId = /sessionId=([0-9a-f-]+)/.exec(frame)?.[1] ?? '';
    const posted = await fetch(`${base}/message?sessionId=${sessionId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' })
    });
    expect(posted.status).toBe(202);
    // Well past the idle window, the in-flight call still owns its session.
    await sleep(1200);
    expect(await openSessions(base), 'a call in flight must not be reaped').toBe(1);
    expect(sessions[1].closed).toBe(0);

    releaseCall();
    const answered = await busyStream.readUntil(text => text.includes('"id":9'));
    expect(answered).toContain('"result"');
    // With the call finished and no further traffic, the reaper takes it.
    const afterBusy = await busyStream.readToEnd();
    expect(afterBusy).toContain('idle timeout');
    await expect.poll(() => openSessions(base)).toBe(0);
    expect(sessions[1].closed).toBe(1);
  } finally {
    releaseCall();
    await server.close();
  }
});

test('a non-loopback bind without an auth token is refused, and bad bounds are rejected', async () => {
  const exposed = await runCli(['--transport', 'sse', '--host', '0.0.0.0', '--port', '0']);
  expect(exposed.code).toBe(2);
  expect(exposed.stderr).toContain('refusing to bind 0.0.0.0 without an auth token');

  const nextFlag = await runCli(['--transport', 'sse', '--auth-token', '--port', '0']);
  expect(nextFlag.code).toBe(2);
  expect(nextFlag.stderr).toContain('--auth-token needs a value');

  // An empty host reaches Node as "every interface", so it is refused before the
  // token rule can be satisfied by it.
  const emptyHost = await runCli(['--transport', 'sse', '--host', '']);
  expect(emptyHost.code).toBe(2);
  expect(emptyHost.stderr).toContain('--host needs a host name or address');

  const zeroSessions = await runCli(['--transport', 'sse', '--max-sessions', '0']);
  expect(zeroSessions.code).toBe(2);
  expect(zeroSessions.stderr).toContain('--max-sessions must be a positive integer');

  const negativeIdle = await runCli(['--transport', 'sse', '--idle-timeout', '-1']);
  expect(negativeIdle.code).toBe(2);
  expect(negativeIdle.stderr).toContain('--idle-timeout must be a non-negative number');

  const help = await runCli(['--help']);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain('--auth-token');
  expect(help.stdout).toContain('NAVI_MCP_TOKEN');
});

test('the official MCP client drives a hardened server once it presents the token', async ({ baseURL }) => {
  test.setTimeout(120000);
  const token = 'navi-hardened-token';
  const port = await freePort();
  const child = spawn(process.execPath, [binPath, '--transport', 'sse', '--port', String(port), '--auth-token', token, '--max-sessions', '2', '--idle-timeout', '120'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env }
  });
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  child.on('error', error => { stderr += `spawn error: ${error.message}`; });

  const url = `http://127.0.0.1:${port}/sse`;
  const client = new Client({ name: 'navi-mcp-sse-hardened', version: '1.0.0' });
  try {
    await waitForEventStream(url, () => stderr, { Authorization: `Bearer ${token}` });

    // The hardened server is still hardened for everyone else while it serves
    // the authenticated client.
    const anonymous = await fetch(url);
    expect(anonymous.status).toBe(401);
    await anonymous.body?.cancel();

    await client.connect(new SSEClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const listed = await client.listTools();
    expect(listed.tools.map(tool => tool.name).sort()).toEqual(['navi_assert_state', 'navi_execute_action', 'navi_get_actions', 'navi_navigate', 'navi_set_session']);

    const nav = await client.callTool({ name: 'navi_navigate', arguments: { url: `${baseURL}/`, width: 1360, height: 900 } });
    expect(nav.isError).toBeFalsy();
    expect(envelope(nav).protocolVersion).toBe('0.3.0');

    const executed = envelope(await client.callTool({ name: 'navi_execute_action', arguments: { target_id: 'checkout-email', action_type: 'type', payload: { text: 'hardened@navi.test' } } }));
    expect(executed.dispatched).toBe(true);

    const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
    expect(health).toMatchObject({ sessions: 1, maxSessions: 2, auth: 'bearer' });

    expect(stderr, 'the token must never reach a log').not.toContain(token);
  } finally {
    await client.close();
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
