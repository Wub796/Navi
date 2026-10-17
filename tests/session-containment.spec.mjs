import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { NaviSession, MAX_PAGES_PER_SESSION, handleMessage } from '../src/mcp/server.js';
import { createSseServer, SESSION_MAX_TTL_MS, MAX_PENDING_MESSAGES } from '../src/mcp/sse.js';
import { containedGet, createContainmentProxy, isPrivateAddress, resolveDestination } from '../src/mcp/containment.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

/** @param {any} result */
const body = result => JSON.parse(result.content[0].text);
/** @param {boolean} enabled */
function session(enabled) {
  const before = process.env.NAVI_ALLOW_LOCAL_NETWORK;
  if (enabled) process.env.NAVI_ALLOW_LOCAL_NETWORK = '1';
  else delete process.env.NAVI_ALLOW_LOCAL_NETWORK;
  try { return new NaviSession(); }
  finally {
    if (before === undefined) delete process.env.NAVI_ALLOW_LOCAL_NETWORK;
    else process.env.NAVI_ALLOW_LOCAL_NETWORK = before;
  }
}

/** A private trap: tests must prove requests never arrived, not just a tool error. */
async function fixture() {
  const hits = /** @type {string[]} */ ([]);
  const server = createServer((req, res) => {
    hits.push(req.url ?? '');
    if (req.url === '/download') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="test.txt"' });
      res.end('session-only download'); return;
    }
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/trap' }); res.end(); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end('<button data-agent-target="ok">Contained page</button><a id="download" href="/download">Download</a>');
  });
  await new Promise(/** @param {(value?: void) => void} resolve */ resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture address');
  return { origin: `http://127.0.0.1:${address.port}`, hits, close: () => new Promise(/** @param {(value?: void) => void} resolve */ resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

test('navi_navigate rejects metadata, private networks and normalized loopback without launching Chromium', async () => {
  const s = session(false);
  try {
    for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:3001/healthz', 'http://localhost:3001/', 'http://127.9.8.7/', 'http://10.1.2.3/', 'http://172.31.0.1/', 'http://192.168.1.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://2130706433/', 'http://0x7f000001/', 'http://localhost./']) {
      expect(body(await s.navigate({ url })).error.code, url).toBe('ERR_BLOCKED_BY_CONTAINMENT');
    }
    expect(s.browser).toBeNull();
    expect(s.downloadDirectory).toBeNull();
    expect(isPrivateAddress('fc00::1')).toBe(true);
    expect(isPrivateAddress('fe80::1')).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false);
    await expect(resolveDestination('http://localhost/', false)).rejects.toMatchObject({ code: 'ERR_BLOCKED_BY_CONTAINMENT' });
  } finally { await s.close(); }
});

test('context interception and pinned proxy deny private subresources, iframe and redirect targets', async () => {
  const f = await fixture();
  const s = session(false);
  const proxy = await createContainmentProxy(false, () => {});
  try {
    await expect(containedGet(`${f.origin}/trap`, false)).rejects.toMatchObject({ code: 'ERR_BLOCKED_BY_CONTAINMENT' });
    // Fulfill only a public document, with strict containment already active.
    // It attempts private fetches, iframes, images and a redirected navigation.
    const local = session(false);
    try {
      await local.initialize();
      await local.context.route('http://8.8.8.8/document', (/** @type {any} */ route) => route.fulfill({ contentType: 'text/html', body: '<button>Public test document</button>' }));
      expect(body(await local.navigate({ url: 'http://8.8.8.8/document' })).ok).toBe(true);
      await local.page.evaluate(async (/** @type {string} */ origin) => {
        await fetch(`${origin}/trap`).catch(() => {});
        const frame = document.createElement('iframe'); frame.src = `${origin}/trap-frame`; document.body.append(frame);
        const image = document.createElement('img'); image.src = `${origin}/trap-image`; document.body.append(image);
      }, f.origin);
      await expect.poll(() => local.blockedRequests).toBeGreaterThanOrEqual(3);
      expect(f.hits.filter(path => path.startsWith('/trap'))).toEqual([]);
      await local.context.route('http://8.8.8.8/redirect', (/** @type {any} */ route) => route.fulfill({ status: 302, headers: { Location: `${f.origin}/trap-redirect` } }));
      expect(body(await local.navigate({ url: 'http://8.8.8.8/redirect' })).error.code).toBe('ERR_BLOCKED_BY_CONTAINMENT');
      expect(f.hits.filter(path => path.startsWith('/trap'))).toEqual([]);
    } finally { await local.close(); }
    // Exercise the strict proxy, including CONNECT and redirects, independently
    // of Chromium route checks; no private trap must receive even one request.
    const response = await new Promise(/** @param {(value: number) => void} resolve @param {(error: Error) => void} reject */ async (resolve, reject) => {
      const { request } = await import('node:http');
      const req = request(proxy.url, { path: `${f.origin}/trap-proxy` }, res => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject); req.end();
    });
    expect(response).toBe(403);
    const connectStatus = await new Promise(/** @param {(value: number) => void} resolve @param {(error: Error) => void} reject */ async (resolve, reject) => {
      const { request } = await import('node:http');
      const req = request(proxy.url, { method: 'CONNECT', path: '127.0.0.1:3001' });
      req.on('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode ?? 0); });
      req.on('error', reject); req.end();
    });
    expect(connectStatus).toBe(403);
    expect(f.hits.filter(path => path.startsWith('/trap'))).toEqual([]);
  } finally { await proxy.close(); await s.close(); await f.close(); }
});

test('download directory is private, session-scoped and removed along with actual downloaded files', async () => {
  const f = await fixture(); const s = session(true);
  try {
    expect(body(await s.navigate({ url: f.origin })).ok).toBe(true);
    const directory = /** @type {string} */ (s.downloadDirectory);
    expect(directory).toContain(`navi-downloads-${s.sessionId}-`);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    const [download] = await Promise.all([s.page.waitForEvent('download'), s.page.locator('#download').click()]);
    const path = await download.path();
    expect(path.startsWith(directory)).toBe(true);
    expect(await readFile(path, 'utf8')).toBe('session-only download');
    expect((await readdir(directory)).length).toBeGreaterThan(0);
    const browser = s.browser;
    await s.close();
    expect(browser.isConnected()).toBe(false);
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(body(await s.navigate({ url: f.origin })).error.code).toBe('SESSION_CLOSED');
  } finally { await s.close(); await f.close(); }
});

test('concurrent contexts do not share cookies, localStorage, indexedDB or cache', async () => {
  const f = await fixture(); const a = session(true); const b = session(true);
  try {
    expect(body(await a.navigate({ url: f.origin })).ok).toBe(true);
    expect(body(await b.navigate({ url: f.origin })).ok).toBe(true);
    expect(a.context).not.toBe(b.context);
    expect(a.downloadDirectory).not.toBe(b.downloadDirectory);
    await a.page.evaluate(async () => {
      document.cookie = 'secret=session-a'; localStorage.setItem('secret', 'session-a');
      await new Promise((resolve, reject) => { const r = indexedDB.open('session-a'); r.onsuccess = () => { r.result.close(); resolve(null); }; r.onerror = () => reject(r.error); });
      await caches.open('session-a');
    });
    expect(await b.page.evaluate(async () => ({ cookies: document.cookie, secret: localStorage.getItem('secret'), databases: await indexedDB.databases(), caches: await caches.keys() })))
      .toEqual({ cookies: '', secret: null, databases: [], caches: [] });
    await a.close();
    expect(b.browser.isConnected()).toBe(true);
    expect(await b.page.title()).toBe('');
  } finally { await a.close(); await b.close(); await f.close(); }
});

test('popup storms cannot retain more than three pages and sensitive permissions are denied', async () => {
  const f = await fixture(); const s = session(true);
  try {
    expect(body(await s.navigate({ url: f.origin })).ok).toBe(true);
    await s.page.evaluate(() => { for (let i = 0; i < 8; i++) window.open('about:blank', `_blank${i}`); });
    await expect.poll(() => s.context.pages().length).toBe(MAX_PAGES_PER_SESSION);
    const permissions = await s.page.evaluate(async () => {
      const names = ['geolocation', 'camera', 'microphone', 'notifications', 'clipboard-read', 'clipboard-write'];
      const states = await Promise.all(names.map(async name => (await navigator.permissions.query({ name: /** @type {PermissionName} */ (name) })).state));
      return { states, notification: await Notification.requestPermission(), geo: await new Promise(resolve => navigator.geolocation.getCurrentPosition(() => resolve('granted'), e => resolve(e.code))), clipboard: await navigator.clipboard.writeText('must-not-write').then(() => 'granted', () => 'denied') };
    });
    expect(permissions.states).toEqual(Array(6).fill('denied'));
    expect(permissions.notification).toBe('denied');
    expect(permissions.geo).toBe(1);
    expect(permissions.clipboard).toBe('denied');
  } finally { await s.close(); await f.close(); }
});

test('SSE hard TTL evicts busy sessions, drops queued calls and joins cleanup', async () => {
  let release = () => {};
  const held = new Promise(resolve => { release = () => resolve(null); });
  let calls = 0, closed = 0;
  const server = await createSseServer({ port: 0, idleTimeoutMs: 0, sessionMaxTtlMs: 400,
    createSession: () => ({ close: async () => { closed++; release(); } }),
    handleMessage: async () => { calls++; await held; return null; } });
  try {
    const stream = await fetch(`http://127.0.0.1:${server.port}/sse`);
    const reader = stream.body?.getReader();
    if (!reader) throw new Error('Missing stream');
    const first = await reader.read(); const text = new TextDecoder().decode(first.value);
    const id = /sessionId=([a-f0-9-]+)/.exec(text)?.[1];
    const post = () => fetch(`http://127.0.0.1:${server.port}/message?sessionId=${id}`, { method: 'POST', body: JSON.stringify({ id: 1, method: 'ping' }) });
    for (let i = 0; i < MAX_PENDING_MESSAGES; i++) expect((await post()).status).toBe(202);
    expect((await post()).status).toBe(429);
    await expect.poll(() => closed).toBe(1);
    await expect.poll(() => server.sessions.size).toBe(0);
    expect(calls).toBe(1);
    await reader.cancel();
    expect(SESSION_MAX_TTL_MS).toBe(1800000);
  } finally { release(); await server.close(); }
});

test('hard TTL closes a real browser even when a tool call is held open', async () => {
  const f = await fixture(); const s = session(true);
  expect(body(await s.navigate({ url: f.origin })).ok).toBe(true);
  const browser = s.browser; const directory = /** @type {string} */ (s.downloadDirectory);
  const remote = await createSseServer({ port: 0, idleTimeoutMs: 0, sessionMaxTtlMs: 300, createSession: () => s,
    handleMessage: async () => { await new Promise(resolve => s.context.once('close', resolve)); return null; } });
  try {
    const response = await fetch(`http://127.0.0.1:${remote.port}/sse`);
    const reader = response.body?.getReader(); if (!reader) throw new Error('No stream');
    const frame = new TextDecoder().decode((await reader.read()).value);
    const id = /sessionId=([a-f0-9-]+)/.exec(frame)?.[1];
    expect((await fetch(`http://127.0.0.1:${remote.port}/message?sessionId=${id}`, { method: 'POST', body: '{"id":1,"method":"held"}' })).status).toBe(202);
    await expect.poll(() => remote.sessions.size).toBe(0);
    expect(browser.isConnected()).toBe(false);
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await reader.cancel();
  } finally { await remote.close(); await s.close(); await f.close(); }
});

test('disposal during launch cannot resurrect Chromium and external context disposal purges files', async () => {
  const starting = session(true);
  const launched = starting.initialize().then(() => null, error => error);
  // Close in the turn the launch begins. `close()` flips the flag before the launch
  // path resumes past its first await, so the browser it spawns is refused and
  // disposed — which is the interleaving this test is about. Polling for the download
  // directory first made that a race instead: on a loaded runner the launch can finish
  // before the poll returns, and the assertion below then measured scheduling rather
  // than the session. The directory the launch creates after the close is still
  // checked, by the cleanup assertion below.
  await starting.close();
  expect(await launched).not.toBeNull();
  expect(starting.browser).toBeNull();
  const surviving = (await readdir(tmpdir())).filter(name => name.startsWith(`navi-downloads-${starting.sessionId}-`));
  expect(surviving, 'a refused launch must remove the directory it created').toEqual([]);
  const f = await fixture(); const active = session(true);
  try {
    expect(body(await active.navigate({ url: f.origin })).ok).toBe(true);
    const directory = /** @type {string} */ (active.downloadDirectory);
    await active.context.close();
    await active.close();
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await active.close(); await f.close(); }
});

test('authenticated SSE disconnect closes a real browser and removes its directory', async () => {
  const f = await fixture();
  const sessions = /** @type {NaviSession[]} */ ([]);
  const remote = await createSseServer({ port: 0, authToken: 'test-only', createSession: id => { const s = session(true); sessions.push(s); return s; }, handleMessage });
  const headers = { Authorization: 'Bearer test-only' };
  const client = new Client({ name: 'containment-test', version: '1' });
  try {
    await client.connect(new SSEClientTransport(new URL(`http://127.0.0.1:${remote.port}/sse`), { requestInit: { headers }, eventSourceInit: { fetch: (input, init) => fetch(input, { ...init, headers }) } }));
    expect(body(await client.callTool({ name: 'navi_navigate', arguments: { url: f.origin } })).ok).toBe(true);
    const browser = sessions[0].browser; const directory = /** @type {string} */ (sessions[0].downloadDirectory);
    await client.close();
    await expect.poll(() => remote.sessions.size).toBe(0);
    expect(browser.isConnected()).toBe(false);
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await client.close(); await remote.close(); await f.close(); }
});
