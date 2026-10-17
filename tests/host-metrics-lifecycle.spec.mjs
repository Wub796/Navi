import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  createNaviHostServer,
  createRateLimiter,
  SHUTDOWN_DEADLINE_MS
} from '../server/index.js';
import { createStore, lifecyclePaths, sqliteAvailable } from '../server/store.js';
import { createSseServer, SHUTDOWN_DEADLINE_MS as MCP_SHUTDOWN_DEADLINE_MS } from '../src/mcp/sse.js';

/**
 * Host observability, write-ahead-log lifecycle and process shutdown.
 *
 * The metrics endpoint and the store are asserted in-process, where a counter's
 * value can be tied to the request that moved it; the shutdown paths are asserted
 * against the real entry points, because "the process exits 0 and leaves nothing
 * behind" is a property of a process rather than of a function.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const binPath = join(root, 'bin/navi-mcp.js');

/** @type {any[]} */
const started = [];
/** @type {import('node:child_process').ChildProcess[]} */
const children = [];

/** @param {string} [suffix] @returns {string} */
const tempFile = suffix => join(tmpdir(), `navi-lifecycle-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.${suffix}`);

/** @param {any} [options] @returns {Promise<any>} */
async function startHost(options = {}) {
  const host = await createNaviHostServer({
    port: 0,
    tenants: new Map([['key-alpha', 'tenant-alpha'], ['key-beta', 'tenant-beta']]),
    storeFile: tempFile('db'),
    // The scheduled sweep is deliberately off, and the startup sweep with it: a
    // sweep is a real prune and moves the counters, but it is a background writer,
    // so a test asserting an exact counter value would be racing it. Pruning is
    // driven explicitly here, one route call at a time.
    retentionDays: 0,
    ...options
  });
  started.push(host);
  return host;
}

test.afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await waitForExit(child);
  }
  for (const host of started.splice(0)) await host.close();
});

/** @param {number} days @returns {string} */
const daysAgo = days => new Date(Date.now() - days * 86400000).toISOString();

/** @param {Record<string, unknown>} [overrides] @returns {any} */
const violation = (overrides = {}) => ({
  tenant_id: 'tenant-alpha',
  session_id: 'session-1',
  category: 'private_ipv4',
  target_url: 'http://10.0.0.1/',
  resolved_ip: '10.0.0.1',
  ...overrides
});

/** @param {number} port @returns {Promise<string>} */
const metricsBody = async (port) => {
  const response = await fetch(`http://127.0.0.1:${port}/metrics`);
  expect(response.status, 'the metrics endpoint must be readable without credentials').toBe(200);
  return response.text();
};

/** @param {string} body @param {string} series @returns {string | null} */
const seriesLine = (body, series) => body.split('\n').find(line => line.startsWith(`${series} `) || line.startsWith(`${series}{`)) ?? null;

/** Wait for a child to exit, bounded. @param {import('node:child_process').ChildProcess} child @returns {Promise<number | string>} */
const waitForExit = (child) => new Promise(resolve => {
  if (child.exitCode !== null || child.signalCode !== null) { resolve(child.exitCode ?? String(child.signalCode)); return; }
  const timer = setTimeout(() => resolve('timeout'), 20000);
  child.on('exit', code => { clearTimeout(timer); resolve(code ?? 'signal'); });
});

/**
 * Spawn the host CLI and wait until it is listening. The printed line is the
 * readiness signal, and one HTTP round trip follows it, so a signal sent after
 * this point cannot arrive before the process installed its handlers.
 * @param {string} storeFile store the child is told to open
 * @returns {Promise<{child: import('node:child_process').ChildProcess, port: number, stderr: () => string, exit: () => Promise<number | string>}>}
 */
async function startHostCli(storeFile) {
  const boot = Math.floor(Date.now() / 1000);
  const child = spawn(process.execPath, [join(root, 'server/index.js'), '--host', '127.0.0.1', '--port', '0', '--store', storeFile], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NAVI_TENANTS: 'key-alpha:tenant-alpha' }
  });
  children.push(child);
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  const port = await new Promise((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error(`the host never reported a listening port; stderr:\n${stderr}`)), 20000);
    child.stdout?.on('data', chunk => {
      stdout += String(chunk);
      const match = /navi-host: http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`the host exited early with ${code}; stderr:\n${stderr}`)); });
  });
  expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 'the host must answer once it reports its port').toBe(200);
  const body = await metricsBody(port);
  const timestamp = Number(seriesLine(body, 'process_start_time_seconds')?.split(' ')[1]);
  expect(body).toContain('# TYPE process_start_time_seconds gauge');
  expect(timestamp).toBeGreaterThanOrEqual(boot);
  expect(timestamp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  return { child, port, stderr: () => stderr, exit: () => waitForExit(child) };
}

/**
 * A page a real browser can load. The session's download directory only exists
 * once a browser was actually launched, so navigation is what proves teardown had
 * something to clean up.
 * @returns {Promise<{url: string, close: () => Promise<void>}>}
 */
async function fixtureServer() {
  const server = createHttpServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<button data-agent-target="go">Go</button>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(null)));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/`,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); })
  };
}

/** Session download directories the browser creates and teardown must remove.
 * @returns {Promise<string[]>} */
const downloadDirectories = async () => (await readdir(tmpdir())).filter(name => name.startsWith('navi-downloads-'));

test('the metrics endpoint serves Prometheus text and carries no request data', async () => {
  const keys = ['key-alpha', 'key-beta'];
  const host = await startHost();
  const response = await fetch(`http://127.0.0.1:${host.port}/metrics`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
  expect(response.headers.get('cache-control'), 'a scrape must never be cached').toBe('no-store');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  const body = await response.text();
  for (const name of ['navi_host_requests_total', 'navi_host_rate_limited_total', 'navi_host_prune_events_total', 'navi_host_pruned_records_total', 'navi_host_active_tenants', 'navi_host_store_bytes']) {
    expect(body, `${name} must be declared`).toContain(`# TYPE ${name} `);
  }
  // The label-free aggregates are present from the first scrape, so an alerting
  // query has a series before any traffic arrives.
  expect(seriesLine(body, 'navi_host_prune_events_total')).toBe('navi_host_prune_events_total 0');
  expect(body).toMatch(/navi_host_active_tenants \d+/);
  // Parity with the MCP exposition: aggregate only. No URL, no key, no session.
  expect(body).not.toContain('http');
  for (const key of keys) expect(body, 'a scrape must not carry a credential').not.toContain(key);
  expect(body).not.toContain('session-1');
  expect(seriesLine(body, 'navi_host_store_bytes')).toBe(`navi_host_store_bytes ${(await stat(host.store.file)).size}`);
  expect((await fetch(`http://127.0.0.1:${host.port}/metrics`, { method: 'POST' })).status).toBe(405);
});

test('NAVI_METRICS_TOKEN protects the scrape and the quota window is reported per tenant', async () => {
  const host = await startHost({
    metricsToken: 'scrape-secret',
    tenants: new Map(/** @type {[string, any][]} */ ([
      ['key-alpha', { id: 'tenant-alpha', max_events_per_window: 2, window_seconds: 60 }],
      ['key-beta', 'tenant-beta']
    ]))
  });
  const base = `http://127.0.0.1:${host.port}`;
  // Unset, the scrape stays open (every other test in this file reads it anonymously).
  // Set, it is an operator-only read and the refusal is a JSON 401, not an empty page.
  expect((await fetch(`${base}/metrics`)).status).toBe(401);
  const unknownToken = await fetch(`${base}/metrics`, { headers: { Authorization: 'Bearer wrong-secret' } });
  expect(unknownToken.status).toBe(401);
  expect(await unknownToken.json()).toEqual({ error: 'Unauthorized' });
  // A malformed credential is refused the same way as a wrong one.
  expect((await fetch(`${base}/metrics`, { headers: { Authorization: 'scrape-secret' } })).status).toBe(401);
  // Liveness is deliberately not behind the scrape credential: a container probe
  // has no business holding the operator's token.
  expect((await fetch(`${base}/healthz`)).status).toBe(200);

  const beacon = { tenant_id: 'tenant-alpha', url_origin: 'https://shop.example.com', actions_indexed: 1, actions_executed: 0, execution_failures: 0 };
  const ingest = () => fetch(`${base}/v1/telemetry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer key-alpha' },
    body: JSON.stringify(beacon)
  });
  expect((await ingest()).status).toBe(202);
  expect((await ingest()).status).toBe(202);
  const exceeded = await ingest();
  expect(exceeded.status).toBe(429);
  expect(await exceeded.json()).toEqual({ error: 'Quota exceeded' });
  expect(Number(exceeded.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);

  const scrape = await fetch(`${base}/metrics`, { headers: { Authorization: 'Bearer scrape-secret' } });
  expect(scrape.status).toBe(200);
  const body = await scrape.text();
  // The ceiling comes from the tenant's configuration; the count and the window are
  // the persisted state the ingest route charged, so a restart reports the same
  // numbers instead of an empty window beside a configured ceiling.
  expect(seriesLine(body, 'navi_host_tenant_quota_limit{tenant_id="tenant-alpha"}')).toBe('navi_host_tenant_quota_limit{tenant_id="tenant-alpha"} 2');
  expect(seriesLine(body, 'navi_host_tenant_quota_events{tenant_id="tenant-alpha"}')).toBe('navi_host_tenant_quota_events{tenant_id="tenant-alpha"} 2');
  const windowStart = Number(seriesLine(body, 'navi_host_tenant_quota_window_start_seconds{tenant_id="tenant-alpha"}')?.split(' ')[1]);
  expect(windowStart).toBeGreaterThan(0);
  expect(windowStart).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  expect(seriesLine(body, 'navi_host_quota_exceeded_total{tenant_id="tenant-alpha"}')).toBe('navi_host_quota_exceeded_total{tenant_id="tenant-alpha"} 1');
  // An unmetered tenant has no window to report: a zero series per tenant would be a
  // label that says nothing, and the scrape stays aggregate-only.
  expect(body).not.toContain('tenant_id="tenant-beta"');
  expect(body).not.toContain('scrape-secret');
  expect(body).not.toContain('key-alpha');

  // The same window is what the tenant's own read returns, authenticated by its
  // bearer key rather than by the scrape credential.
  const read = await fetch(`${base}/v1/telemetry`, { headers: { Authorization: 'Bearer key-alpha' } });
  expect(read.status).toBe(200);
  const summary = await read.json();
  expect(summary.tenant_id).toBe('tenant-alpha');
  expect(summary.summary.events).toBe(2);
  expect(summary.quota).toMatchObject({ max_events_per_window: 2, window_seconds: 60, event_count: 2 });
  // The gauge is whole Unix seconds and the read is milliseconds; the same window
  // is what both report, so the second is the floor of the first.
  expect(Math.floor(summary.quota.window_start_ms / 1000)).toBe(windowStart);
  const unmetered = await (await fetch(`${base}/v1/telemetry?key=key-beta`)).json();
  expect(unmetered.quota, 'an unmetered tenant reports no quota rather than a zero ceiling').toBeNull();
});

test('request counters carry the route and the status, never the requested path', async () => {
  const host = await startHost();
  const base = `http://127.0.0.1:${host.port}`;
  expect((await fetch(`${base}/v1/navi.js?key=key-alpha`)).status).toBe(200);
  expect((await fetch(`${base}/v1/navi.js?key=not-a-key`)).status).toBe(401);
  expect((await fetch(`${base}/healthz`)).status).toBe(200);
  const invented = `/scan-${Math.random().toString(16).slice(2)}`;
  expect((await fetch(`${base}${invented}`)).status).toBe(404);

  const body = await metricsBody(host.port);
  expect(body).toContain('navi_host_requests_total{route="navi.js",status="200"} 1');
  expect(body).toContain('navi_host_requests_total{route="navi.js",status="401"} 1');
  expect(body).toContain('navi_host_requests_total{route="healthz",status="200"} 1');
  // An unmatched path is one series, not one per path: a scanner cannot mint labels.
  expect(body).toContain('navi_host_requests_total{route="other",status="404"} 1');
  expect(body).not.toContain('scan-');
  // The scrape above is counted too, which is what proves the counter is written
  // when the response finishes rather than by a route that opted in.
  expect(await metricsBody(host.port)).toContain('navi_host_requests_total{route="metrics",status="200"} 1');
});

test('the rate-limit and prune counters describe the work that moved them', async () => {
  const host = await startHost({ rateLimiter: createRateLimiter({ perMinute: 120, burst: 2, timer: false }) });
  const base = `http://127.0.0.1:${host.port}`;
  const post = () => fetch(`${base}/v1/telemetry/violations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer key-alpha' },
    body: JSON.stringify(violation())
  });
  expect((await post()).status).toBe(202);
  expect((await post()).status).toBe(202);
  expect((await post()).status).toBe(429);

  await host.store.recordViolation(violation({ created_at: daysAgo(40) }));
  await host.store.recordViolation(violation({ created_at: daysAgo(40) }));
  const pruned = await fetch(`${base}/v1/tenants/tenant-alpha/maintenance/prune`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer key-alpha' },
    body: JSON.stringify({ max_age_days: 30 })
  });
  expect(await pruned.json()).toMatchObject({ pruned_count: 2, remaining_count: 2 });

  const body = await metricsBody(host.port);
  expect(seriesLine(body, 'navi_host_rate_limited_total')).toBe('navi_host_rate_limited_total{tenant_id="tenant-alpha"} 1');
  expect(seriesLine(body, 'navi_host_prune_events_total')).toBe('navi_host_prune_events_total 1');
  expect(seriesLine(body, 'navi_host_pruned_records_total')).toBe('navi_host_pruned_records_total 2');
  expect(body).toMatch(/navi_host_active_tenants 1/);
  // The tenant that was never throttled and never pruned has no series of its own.
  expect(body).not.toContain('tenant-beta');
});

test('both transports declare the same shutdown deadline', () => {
  // The number an operator sizes a container stop timeout against has to be one
  // number; a drift here would make the second one unreachable.
  expect(MCP_SHUTDOWN_DEADLINE_MS).toBe(SHUTDOWN_DEADLINE_MS);
  expect(SHUTDOWN_DEADLINE_MS).toBe(5000);
});

test('the store opens in WAL mode and answers checkpoint in both backends', async () => {
  test.skip(!(await sqliteAvailable()), 'this runtime does not provide node:sqlite');
  const file = tempFile('db');
  const store = await createStore(file, { mode: 'sqlite' });
  const specifier = 'node:sqlite';
  const { DatabaseSync } = await import(specifier);
  const db = new DatabaseSync(file);
  // `journal_mode` is recorded in the file, so an independent connection can
  // witness it: the mode is a property of the database, not of the store.
  expect(db.prepare('PRAGMA journal_mode').get().journal_mode).toBe('wal');
  db.close();
  // `synchronous` is a property of one connection and is reported by no other, so
  // it is read from the connection the store is actually writing through.
  expect(store.pragmas?.journal_mode).toBe('wal');
  expect(store.pragmas?.synchronous, 'NORMAL is the pairing for WAL').toBe(1);
  expect(store.pragmas?.auto_vacuum, 'INCREMENTAL, chosen before the first table').toBe(2);
  await store.recordViolation(violation());
  const checkpointed = await store.checkpoint({ truncate: false });
  expect(Object.keys(checkpointed).sort()).toEqual(['busy', 'checkpointed', 'log']);
  for (const value of Object.values(checkpointed)) expect(Number.isFinite(value)).toBe(true);
  await store.close();

  // A log has no journal: the same call, the same shape, nothing thrown.
  const logFile = tempFile('log');
  const logStore = await createStore(logFile, { mode: 'log' });
  await logStore.recordViolation(violation());
  const before = (await stat(logFile)).size;
  expect(await logStore.checkpoint()).toEqual({ busy: 0, log: 0, checkpointed: 0 });
  expect((await stat(logFile)).size).toBe(before);
  await logStore.close();
});

test('a prune truncates the write-ahead log, and a clean close removes its sidecars', async () => {
  test.skip(!(await sqliteAvailable()), 'this runtime does not provide node:sqlite');
  const file = tempFile('db');
  const host = await startHost({ storeFile: file });
  const base = `http://127.0.0.1:${host.port}`;
  for (let index = 0; index < 300; index++) await host.store.recordViolation(violation({ created_at: daysAgo(40) }));
  await host.store.recordViolation(violation({ created_at: daysAgo(1) }));
  const before = (await stat(`${file}-wal`)).size;
  expect(before, 'the write-ahead log should hold uncheckpointed frames before the prune').toBeGreaterThan(0);

  const pruned = await fetch(`${base}/v1/tenants/tenant-alpha/maintenance/prune`, {
    method: 'POST',
    headers: { Authorization: 'Bearer key-alpha' }
  });
  expect(await pruned.json()).toMatchObject({ max_age_days: 30, pruned_count: 300, remaining_count: 1 });
  // The route prunes 300 rows and then checkpoints, so the file an operator
  // measures is the file that actually shrank.
  expect((await stat(`${file}-wal`)).size, 'a non-empty prune must truncate the write-ahead log').toBe(0);

  await host.close();
  await expect(stat(`${file}-wal`), 'a clean close leaves no write-ahead log behind').rejects.toThrow();
  await expect(stat(`${file}-shm`), 'and no shared-memory sidecar either').rejects.toThrow();
});

test('SIGTERM drains the host CLI, checkpoints the store and exits 0', async () => {
  const file = tempFile('db');
  const cli = await startHostCli(file);
  const beacon = { tenant_id: 'tenant-alpha', url_origin: 'https://shop.example.com', actions_indexed: 1, actions_executed: 0, execution_failures: 0 };
  expect((await fetch(`http://127.0.0.1:${cli.port}/v1/telemetry`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer key-alpha' }, body: JSON.stringify(beacon) })).status).toBe(202);

  const startedAt = Date.now();
  cli.child.kill('SIGTERM');
  const code = await cli.exit();
  const elapsed = Date.now() - startedAt;
  expect(code, `the host must exit cleanly, not on a signal; stderr:\n${cli.stderr()}`).toBe(0);
  expect(elapsed).toBeLessThan(SHUTDOWN_DEADLINE_MS);
  expect(cli.stderr()).toContain('SIGTERM received, draining');
  expect(cli.stderr()).not.toMatch(/UnhandledPromiseRejection|unhandled rejection/);
  // No orphaned journal: the teardown checkpointed and closed the store.
  await expect(stat(`${file}-wal`)).rejects.toThrow();
  const reopened = await createStore(file, { mode: 'sqlite' });
  expect((await reopened.summarize()).events, 'the accepted beacon survived the stop').toBe(1);
  await reopened.close();
});

for (const backend of ['sqlite', 'log']) {
  for (const signal of /** @type {const} */ (['SIGTERM', 'SIGINT', 'SIGKILL'])) {
    test(`${backend}: ${signal} is classified from durable lifecycle state on restart`, async () => {
      const file = tempFile(backend === 'log' ? 'log' : 'db');
      const first = await startHostCli(file);
      const boot = Number(seriesLine(await metricsBody(first.port), 'process_start_time_seconds')?.split(' ')[1]);
      expect(boot).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) - 5);
      expect(boot).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
      expect(await metricsBody(first.port)).toContain('# TYPE process_start_time_seconds gauge');
      expect(await metricsBody(first.port)).toContain('navi_host_unclean_shutdowns_total 0');
      if (backend === 'log') {
        // Convert the brand-new empty SQLite store into a fresh JSONL fixture,
        // then start a process that selects log mode from the existing file.
        first.child.kill('SIGTERM');
        expect(await first.exit()).toBe(0);
        await writeFile(file, JSON.stringify({ kind: 'navi_store_meta', violation_sequence: 0 }) + '\n');
      }
      const running = backend === 'log' ? await startHostCli(file) : first;
      if (backend === 'log') expect(running.stderr()).toContain('store: log');
      expect(await metricsBody(running.port)).toContain('navi_host_unclean_shutdowns_total 0');
      await expect(stat(`${file}.clean`)).rejects.toMatchObject({ code: 'ENOENT' });
      running.child.kill(signal);
      expect(await running.exit()).toBe(signal === 'SIGKILL' ? 'signal' : 0);
      if (signal === 'SIGKILL') await expect(stat(`${file}.clean`)).rejects.toMatchObject({ code: 'ENOENT' });
      else expect((await stat(`${file}.clean`)).isFile()).toBe(true);
      const next = await startHostCli(file);
      expect(await metricsBody(next.port)).toContain(`# TYPE navi_host_unclean_shutdowns_total counter`);
      expect(await metricsBody(next.port)).toContain(`navi_host_unclean_shutdowns_total ${signal === 'SIGKILL' ? 1 : 0}`);
      await expect(stat(`${file}.clean`)).rejects.toMatchObject({ code: 'ENOENT' });
      if (signal === 'SIGKILL') {
        // Consecutive crashes must still report 1, not require a prior clean boot.
        next.child.kill('SIGKILL');
        await next.exit();
        const again = await startHostCli(file);
        expect(await metricsBody(again.port)).toContain('navi_host_unclean_shutdowns_total 1');
        again.child.kill('SIGTERM');
        expect(await again.exit()).toBe(0);
      } else {
        next.child.kill('SIGTERM');
        expect(await next.exit()).toBe(0);
      }
      const recovered = await startHostCli(file);
      expect(await metricsBody(recovered.port)).toContain('navi_host_unclean_shutdowns_total 0');
      recovered.child.kill('SIGTERM');
      expect(await recovered.exit()).toBe(0);
    });
  }
}

for (const failure of ['checkpoint', 'busy checkpoint', 'close']) {
  test(`host ${failure} failure never records a clean stop`, async () => {
    const file = tempFile('db');
    const store = await createStore(file);
    const host = await createNaviHostServer({ port: 0, store, retentionDays: 0 });
    const checkpoint = store.checkpoint.bind(store);
    const close = store.close.bind(store);
    if (failure === 'checkpoint') store.checkpoint = async () => { throw new Error('checkpoint failure'); };
    if (failure === 'busy checkpoint') store.checkpoint = async () => ({ busy: 1, log: 1, checkpointed: 0 });
    if (failure === 'close') store.close = async () => { await close(); throw new Error('close failure'); };
    await expect(host.close()).rejects.toThrow(/failure|busy/);
    await expect(host.close(), 'repeat close must join the same failed teardown').rejects.toThrow(/failure|busy/);
    await expect(stat(`${file}.clean`)).rejects.toMatchObject({ code: 'ENOENT' });
    store.checkpoint = checkpoint;
    store.close = close;
    const next = await startHost({ storeFile: file });
    expect(await metricsBody(next.port)).toContain('navi_host_unclean_shutdowns_total 1');
  });
}

/** @param {string} stateFile */
async function startMcpCli(stateFile) {
  const boot = Math.floor(Date.now() / 1000);
  const child = spawn(process.execPath, [binPath, '--transport', 'sse', '--port', '0'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NAVI_MCP_STATE_FILE: stateFile }
  });
  children.push(child);
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  await expect.poll(() => /SSE transport listening on http:\/\/127\.0\.0\.1:\d+/.test(stderr)).toBe(true);
  const port = Number(/SSE transport listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(stderr)?.[1]);
  const body = await metricsBody(port);
  const startTime = Number(seriesLine(body, 'process_start_time_seconds')?.split(' ')[1]);
  expect(startTime).toBeGreaterThanOrEqual(boot);
  expect(startTime).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  expect(body).toContain('# TYPE process_start_time_seconds gauge');
  expect(body).toContain('# TYPE navi_mcp_unclean_shutdowns_total counter');
  return { child, port };
}

test('lifecycle sentinel names are normalized, never double-suffixed', () => {
  // The shipped Compose value already names the successful-teardown marker, so the
  // dirty companion moves beside it instead of the marker growing another `.clean`.
  expect(lifecyclePaths('/var/lib/navi/mcp/state.clean')).toEqual({
    stateFile: '/var/lib/navi/mcp/state.dirty',
    cleanFile: '/var/lib/navi/mcp/state.clean',
    normalized: true
  });
  // An unsuffixed path - the built-in default and the host's store file - keeps the
  // long-standing pairing, so nothing about the existing layouts changes.
  for (const path of ['/tmp/navi-mcp-state', '/data/telemetry.db']) {
    expect(lifecyclePaths(path)).toEqual({ stateFile: path, cleanFile: `${path}.clean`, normalized: false });
  }
});

for (const signal of /** @type {const} */ (['SIGTERM', 'SIGINT', 'SIGKILL'])) {
  test(`MCP ${signal}: first boot, restart, and clean recovery use lifecycle state`, async () => {
    const stateFile = tempFile('mcp-state');
    const first = await startMcpCli(stateFile);
    expect(await metricsBody(first.port)).toContain('navi_mcp_unclean_shutdowns_total 0');
    expect((await stat(stateFile)).isFile()).toBe(true);
    await expect(stat(`${stateFile}.clean`)).rejects.toMatchObject({ code: 'ENOENT' });
    first.child.kill(signal);
    expect(await waitForExit(first.child)).toBe(signal === 'SIGKILL' ? 'signal' : 0);
    if (signal === 'SIGKILL') await expect(stat(`${stateFile}.clean`)).rejects.toMatchObject({ code: 'ENOENT' });
    else expect((await stat(`${stateFile}.clean`)).isFile()).toBe(true);
    const next = await startMcpCli(stateFile);
    expect(await metricsBody(next.port)).toContain(`navi_mcp_unclean_shutdowns_total ${signal === 'SIGKILL' ? 1 : 0}`);
    await expect(stat(`${stateFile}.clean`)).rejects.toMatchObject({ code: 'ENOENT' });
    next.child.kill('SIGTERM');
    expect(await waitForExit(next.child)).toBe(0);
    const recovered = await startMcpCli(stateFile);
    expect(await metricsBody(recovered.port)).toContain('navi_mcp_unclean_shutdowns_total 0');
    recovered.child.kill('SIGTERM');
    expect(await waitForExit(recovered.child)).toBe(0);
  });
}

for (const failure of ['rejection', 'timeout', 'earlier disconnect']) {
  test(`MCP ${failure} during session cleanup leaves lifecycle dirty`, async () => {
    const stateFile = tempFile('mcp-state');
    const remote = await createSseServer({
      port: 0, stateFile, shutdownDeadlineMs: 50,
      createSession: () => ({ close: () => failure === 'timeout' ? new Promise(() => {}) : Promise.reject(new Error('session cleanup failure')) }),
      handleMessage: async () => null
    });
    const stream = await fetch(`http://127.0.0.1:${remote.port}/sse`);
    if (failure === 'earlier disconnect') {
      await stream.body?.cancel();
      await expect.poll(() => remote.sessions.size).toBe(0);
    }
    await expect(remote.close()).rejects.toThrow(/cleanup|finish/);
    await expect(stat(`${stateFile}.clean`)).rejects.toMatchObject({ code: 'ENOENT' });
    const next = await createSseServer({ port: 0, stateFile, createSession: () => ({ close: async () => {} }), handleMessage: async () => null });
    try { expect(await metricsBody(next.port)).toContain('navi_mcp_unclean_shutdowns_total 1'); }
    finally { await next.close(); }
  });
}

test('host clean marker waits for a background prune and concurrent close callers join', async () => {
  const file = tempFile('db');
  const store = await createStore(file);
  let finishPrune = () => {};
  const held = new Promise(resolve => { finishPrune = () => resolve({ pruned_count: 0, remaining_count: 0 }); });
  store.pruneViolations = async () => held;
  const host = await createNaviHostServer({ port: 0, store, retentionDays: 30 });
  const closed = host.close();
  try {
    expect(host.close()).toBe(closed);
    await expect(stat(`${file}.clean`)).rejects.toMatchObject({ code: 'ENOENT' });
    finishPrune();
    await closed;
    expect((await stat(`${file}.clean`)).isFile()).toBe(true);
  } finally { finishPrune(); await closed; }
});

test('a configured .clean path is the marker itself, with dirty evidence beside it', async () => {
  const marker = tempFile('state.clean');
  const dirty = `${marker.slice(0, -'.clean'.length)}.dirty`;
  const first = await startMcpCli(marker);
  expect(await metricsBody(first.port)).toContain('navi_mcp_unclean_shutdowns_total 0');
  // Dirty evidence is the derived sibling, and neither the marker nor the doubled
  // name exists while the process is running.
  expect((await stat(dirty)).isFile()).toBe(true);
  await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(stat(`${marker}.clean`)).rejects.toMatchObject({ code: 'ENOENT' });
  first.child.kill('SIGKILL');
  expect(await waitForExit(first.child)).toBe('signal');
  const crashed = await startMcpCli(marker);
  expect(await metricsBody(crashed.port)).toContain('navi_mcp_unclean_shutdowns_total 1');
  crashed.child.kill('SIGTERM');
  expect(await waitForExit(crashed.child)).toBe(0);
  // A completed shutdown publishes the configured name verbatim.
  expect((await stat(marker)).isFile()).toBe(true);
  await expect(stat(`${marker}.clean`)).rejects.toMatchObject({ code: 'ENOENT' });
  const recovered = await startMcpCli(marker);
  expect(await metricsBody(recovered.port)).toContain('navi_mcp_unclean_shutdowns_total 0');
  await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  recovered.child.kill('SIGTERM');
  expect(await waitForExit(recovered.child)).toBe(0);
});

test('pre-normalization sentinels on an upgraded volume are read once and removed', async () => {
  // What the previous build left behind: its dirty evidence at the configured name,
  // and its real verdict in the doubled marker beside it.
  const migrated = tempFile('state.clean');
  const migratedDirty = `${migrated.slice(0, -'.clean'.length)}.dirty`;
  await writeFile(migrated, '');
  await writeFile(`${migrated}.clean`, 'clean\n');
  const clean = await startMcpCli(migrated);
  expect(await metricsBody(clean.port)).toContain('navi_mcp_unclean_shutdowns_total 0');
  expect((await stat(migratedDirty)).isFile()).toBe(true);
  await expect(stat(`${migrated}.clean`)).rejects.toMatchObject({ code: 'ENOENT' });
  clean.child.kill('SIGTERM');
  expect(await waitForExit(clean.child)).toBe(0);
  expect((await stat(migrated)).isFile()).toBe(true);

  // A residue file with no verdict beside it is ambiguous, and ambiguity has to read
  // as dirty: reporting a clean stop that was never recorded would hide a crash.
  const ambiguous = tempFile('state.clean');
  await writeFile(ambiguous, '');
  const next = await startMcpCli(ambiguous);
  expect(await metricsBody(next.port)).toContain('navi_mcp_unclean_shutdowns_total 1');
  next.child.kill('SIGTERM');
  expect(await waitForExit(next.child)).toBe(0);
});

test('MCP clean marker waits for successful session cleanup', async () => {
  const stateFile = tempFile('mcp-state');
  let finishCleanup = () => {};
  const held = new Promise(resolve => { finishCleanup = () => resolve(undefined); });
  const remote = await createSseServer({ port: 0, stateFile, createSession: () => ({ close: () => held }), handleMessage: async () => null });
  const stream = await fetch(`http://127.0.0.1:${remote.port}/sse`);
  const closed = remote.close();
  try {
    expect(remote.close()).toBe(closed);
    await expect(stat(`${stateFile}.clean`)).rejects.toMatchObject({ code: 'ENOENT' });
    finishCleanup();
    await closed;
    expect((await stat(`${stateFile}.clean`)).isFile()).toBe(true);
  } finally { finishCleanup(); await closed; await stream.body?.cancel(); }
});

test('a stale clean marker cannot turn a first boot into an unclean event', async () => {
  const file = tempFile('db');
  await writeFile(`${file}.clean`, 'clean\n');
  const host = await startHost({ storeFile: file });
  expect(await metricsBody(host.port)).toContain('navi_host_unclean_shutdowns_total 0');
  await expect(stat(`${file}.clean`)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('a request that is never finished cannot hold the shutdown past its deadline', async () => {
  const cli = await startHostCli(tempFile('db'));
  // A socket that sends an incomplete request is neither idle nor finished, so
  // server.close() cannot complete until the deadline destroys it.
  const { connect } = await import('node:net');
  const connection = connect({ host: '127.0.0.1', port: cli.port });
  await new Promise(resolve => connection.once('connect', () => resolve(null)));
  connection.write('GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\n');

  const startedAt = Date.now();
  cli.child.kill('SIGTERM');
  const code = await cli.exit();
  const elapsed = Date.now() - startedAt;
  expect(code, `stderr:\n${cli.stderr()}`).toBe(0);
  expect(elapsed, 'the deadline is what bounds the drain').toBeGreaterThanOrEqual(SHUTDOWN_DEADLINE_MS - 500);
  expect(elapsed, 'and it is still a deadline, not a wait').toBeLessThan(SHUTDOWN_DEADLINE_MS + 3000);
  expect(cli.stderr()).toContain('shutdown deadline');
});

test('SIGTERM over stdio closes the browser and removes its download directory', async () => {
  const fixture = await fixtureServer();
  const before = new Set(await downloadDirectories());
  const child = spawn(process.execPath, [binPath], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NAVI_ALLOW_LOCAL_NETWORK: '1', NAVI_MCP_DEBUG: '1', NAVI_MCP_STATE_FILE: tempFile('mcp-state') }
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', chunk => { stdout += String(chunk); });
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  try {
    const send = (/** @type {Record<string, unknown>} */ message) => child.stdin?.write(`${JSON.stringify(message)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'lifecycle-check', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'navi_navigate', arguments: { url: fixture.url } } });
    await expect.poll(() => stdout.includes('"id":2'), `navigation over stdio never answered; stderr:\n${stderr}`).toBe(true);
    // The browser is up, so there is a download directory for teardown to remove.
    await expect.poll(async () => (await downloadDirectories()).length).toBeGreaterThan(before.size);

    const startedAt = Date.now();
    child.kill('SIGTERM');
    const code = await waitForExit(child);
    expect(code, `the stdio server must exit 0 on SIGTERM; stderr:\n${stderr}`).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(SHUTDOWN_DEADLINE_MS + 5000);
    expect(stderr).toContain('SIGTERM received, session closed');
    await expect.poll(async () => (await downloadDirectories()).filter(name => !before.has(name))).toEqual([]);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await fixture.close();
  }
});

test('SIGTERM over SSE closes the session and removes its download directory', async () => {
  const stateFile = tempFile('mcp-state');
  const fixture = await fixtureServer();
  const before = new Set(await downloadDirectories());
  const port = await new Promise(resolve => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const value = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(value));
    });
  });
  const child = spawn(process.execPath, [binPath, '--transport', 'sse', '--port', String(port)], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NAVI_ALLOW_LOCAL_NETWORK: '1', NAVI_MCP_DEBUG: '1', NAVI_MCP_STATE_FILE: stateFile }
  });
  children.push(child);
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  try {
    await expect.poll(async () => (await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => null))?.ok, `the SSE server never became ready; stderr:\n${stderr}`).toBe(true);
    const stream = await fetch(`http://127.0.0.1:${port}/sse`);
    expect(stream.status).toBe(200);
    const reader = /** @type {ReadableStreamDefaultReader<Uint8Array>} */ (stream.body?.getReader());
    const decoder = new TextDecoder();
    let frames = '';
    /** @returns {Promise<void>} */
    const until = async (/** @type {(text: string) => boolean} */ predicate) => {
      while (!predicate(frames)) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`the stream ended early; frames so far:\n${frames}`);
        frames += decoder.decode(chunk.value, { stream: true });
      }
    };
    await until(text => text.includes('event: endpoint'));
    const sessionId = /data: \/message\?sessionId=([^\s]+)/.exec(frames)?.[1];
    expect(sessionId, `no endpoint frame; frames:\n${frames}`).toBeTruthy();
    /** @param {Record<string, unknown>} message */
    const post = (message) => fetch(`http://127.0.0.1:${port}/message?sessionId=${sessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message)
    });
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'lifecycle-check', version: '1' } } })).status).toBe(202);
    expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    expect((await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'navi_navigate', arguments: { url: fixture.url } } })).status).toBe(202);
    await until(text => text.includes('"id":2'));
    await expect.poll(async () => (await downloadDirectories()).length).toBeGreaterThan(before.size);

    const startedAt = Date.now();
    child.kill('SIGTERM');
    const code = await waitForExit(child);
    expect(code, `the SSE server must exit 0 on SIGTERM; stderr:\n${stderr}`).toBe(0);
    expect((await stat(`${stateFile}.clean`)).isFile()).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(SHUTDOWN_DEADLINE_MS + 5000);
    await expect.poll(async () => (await downloadDirectories()).filter(name => !before.has(name))).toEqual([]);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await fixture.close();
  }
});
