import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createNaviHostServer, MAX_PAYLOAD_BYTES, VIOLATION_CATEGORIES } from '../server/index.js';
import { createStore, MAX_VIOLATION_LIMIT, sqliteAvailable } from '../server/store.js';
import { NaviSession } from '../src/mcp/server.js';
import { createSseServer } from '../src/mcp/sse.js';
import { VIOLATION_CATEGORIES as MCP_CATEGORIES, MAX_FORWARD_QUEUE, containmentForwardingMetrics, containmentMetrics, recordContainmentViolation, resetContainmentMetrics } from '../src/mcp/containment.js';

/**
 * Containment persistence, driven over HTTP wherever the contract is the wire
 * one: the ingest validation, the audit read and its pagination are asserted the
 * way the MCP server and a tenant's tooling actually see them. Only the store's
 * two backends are exercised directly, because which one is active is a runtime
 * capability rather than a request property.
 */
let host = /** @type {any} */ (null);
let base = '';

/** @type {string[]} */
const saved = [];
/** @param {string} name @param {string} value */
const setEnv = (name, value) => {
  if (!saved.includes(name)) saved.push(name);
  process.env[name] = value;
};

test.beforeAll(async () => {
  host = await createNaviHostServer({
    port: 0,
    tenants: new Map([['key-alpha', 'tenant-alpha'], ['key-beta', 'tenant-beta']]),
    storeFile: join(tmpdir(), `navi-persistence-${process.pid}-${Date.now()}.db`)
  });
  base = `http://127.0.0.1:${host.port}`;
});

test.afterAll(async () => {
  await host?.close();
});

test.beforeEach(async () => {
  resetContainmentMetrics();
  for (const name of saved.splice(0)) delete process.env[name];
  await host.store.reset();
});

/** @param {any} result */
const body = result => JSON.parse(result.content[0].text);

/** A session whose private-network policy is active, whatever the ambient env holds. */
function containedSession() {
  const before = process.env.NAVI_ALLOW_LOCAL_NETWORK;
  delete process.env.NAVI_ALLOW_LOCAL_NETWORK;
  try { return new NaviSession(); }
  finally {
    if (before === undefined) delete process.env.NAVI_ALLOW_LOCAL_NETWORK;
    else process.env.NAVI_ALLOW_LOCAL_NETWORK = before;
  }
}

/** A violation body: the tenant is normally resolved from the key, so it is
 * omitted unless a case is specifically about naming one.
 * @param {Record<string, unknown>} [overrides] @returns {any} */
const violation = (overrides = {}) => ({
  session_id: 'session-1',
  category: 'metadata_endpoint',
  target_url: 'http://169.254.169.254/latest/meta-data/',
  resolved_ip: '169.254.169.254',
  ...overrides
});

/**
 * @param {unknown} payload
 * @param {{key?: string | null, contentType?: string, query?: string}} [options]
 * @returns {Promise<Response>}
 */
const postViolation = (payload, options = {}) => {
  const { key = 'key-alpha', contentType = 'application/json', query = '?' } = options;
  return fetch(`${base}/v1/telemetry/violations${query}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType, ...(key === null ? {} : { Authorization: `Bearer ${key}` }) },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload)
  });
};

/**
 * @param {string} tenantId
 * @param {{key?: string | null, query?: string}} [options]
 * @returns {Promise<Response>}
 */
const readAudit = (tenantId, options = {}) => {
  const { key = 'key-alpha', query = '' } = options;
  return fetch(`${base}/v1/tenants/${tenantId}/security-audit${query}`, { headers: key === null ? {} : { Authorization: `Bearer ${key}` } });
};

/** A port that was just released, so a connection to it is refused immediately. */
async function closedPort() {
  const server = createServer(() => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(null)));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise(resolve => server.close(() => resolve(null)));
  return port;
}

test('the host taxonomy matches the MCP taxonomy whose violations it persists', () => {
  expect(VIOLATION_CATEGORIES).toEqual([...MCP_CATEGORIES]);
});

test('ingests a violation against the key tenant and returns its row id', async () => {
  const response = await postViolation(violation());
  expect(response.status).toBe(202);
  const accepted = await response.json();
  expect(accepted).toMatchObject({ ok: true, accepted: true, tenant_id: 'tenant-alpha' });
  expect(accepted.id).toBeGreaterThan(0);

  const stored = await (await readAudit('tenant-alpha')).json();
  expect(stored.violations).toHaveLength(1);
  expect(stored.violations[0]).toMatchObject({
    tenant_id: 'tenant-alpha',
    session_id: 'session-1',
    category: 'metadata_endpoint',
    target_url: 'http://169.254.169.254/latest/meta-data/',
    resolved_ip: '169.254.169.254'
  });
  expect(Number.isNaN(Date.parse(stored.violations[0].created_at))).toBe(false);
});

test('refuses an unregistered or absent tenant, and a body that names another one', async () => {
  const badKey = await postViolation(violation(), { key: 'not-a-key' });
  expect(badKey.status).toBe(401);
  expect((await badKey.json()).error.code).toBe('UNKNOWN_TENANT');

  const noKey = await postViolation({ category: 'metadata_endpoint', target_url: 'http://169.254.169.254/' }, { key: null });
  expect(noKey.status).toBe(401);
  expect((await noKey.json()).error.code).toBe('UNKNOWN_TENANT');

  const otherTenant = await postViolation(violation({ tenant_id: 'tenant-beta' }));
  expect(otherTenant.status).toBe(401);
  expect((await otherTenant.json()).error.code).toBe('UNKNOWN_TENANT');

  const unregistered = await postViolation(violation({ tenant_id: 'nobody' }));
  expect(unregistered.status).toBe(401);

  // A query-string key is accepted here for parity with the beacon route, and is
  // still checked the same way.
  const queryKey = await postViolation(violation(), { key: null, query: '?key=key-beta' });
  expect(queryKey.status).toBe(202);
  expect((await queryKey.json()).tenant_id).toBe('tenant-beta');

  const nothing = await (await readAudit('tenant-alpha')).json();
  expect(nothing.violations, 'a refused report must not be stored').toHaveLength(0);
});

test('refuses a payload that is not a sanitized violation, with a named code', async () => {
  /** @type {{name: string, payload: unknown, status: number, code: string, contentType?: string}[]} */
  const cases = [
    { name: 'unknown field', payload: { ...violation(), user_agent: 'curl' }, status: 400, code: 'INVALID_PAYLOAD' },
    { name: 'missing category', payload: { target_url: 'http://169.254.169.254/' }, status: 400, code: 'INVALID_PAYLOAD' },
    { name: 'unlisted category', payload: violation({ category: 'unclassified' }), status: 400, code: 'INVALID_PAYLOAD' },
    { name: 'query string in target', payload: violation({ target_url: 'http://169.254.169.254/latest/meta-data/?ami-id=secret' }), status: 400, code: 'INVALID_PAYLOAD' },
    { name: 'fragment in target', payload: violation({ target_url: 'http://169.254.169.254/#x' }), status: 400, code: 'INVALID_PAYLOAD' },
    { name: 'credentials in target', payload: violation({ target_url: 'http://user:pass@169.254.169.254/' }), status: 400, code: 'INVALID_PAYLOAD' },
    { name: 'bare origin without a path', payload: violation({ target_url: 'http://169.254.169.254' }), status: 400, code: 'INVALID_PAYLOAD' },
    { name: 'non-http scheme', payload: violation({ target_url: 'file:///etc/passwd' }), status: 400, code: 'INVALID_PAYLOAD' },
    { name: 'relative target', payload: violation({ target_url: '/latest/meta-data/' }), status: 400, code: 'INVALID_PAYLOAD' },
    { name: 'oversized session id', payload: violation({ session_id: 'x'.repeat(200) }), status: 400, code: 'INVALID_PAYLOAD' },
    { name: 'session id with markup', payload: violation({ session_id: '<script>' }), status: 400, code: 'INVALID_PAYLOAD' },
    { name: 'non-literal resolved ip', payload: violation({ resolved_ip: 'metadata.google.internal' }), status: 400, code: 'INVALID_PAYLOAD' },
    { name: 'unsupported media type', payload: JSON.stringify(violation()), contentType: 'text/plain', status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' }
  ];
  for (const testCase of cases) {
    const response = await postViolation(testCase.payload, { contentType: testCase.contentType });
    expect(response.status, testCase.name).toBe(testCase.status);
    const parsed = await response.json();
    expect(parsed.error.code, testCase.name).toBe(testCase.code);
    expect(parsed.error.message.length, testCase.name).toBeGreaterThan(10);
  }

  const malformed = await postViolation('{not json');
  expect(malformed.status).toBe(400);
  expect((await malformed.json()).error.code).toBe('INVALID_PAYLOAD');

  // The cap is decided before parsing, so a well-formed body is refused too.
  const padded = `${JSON.stringify(violation())}${' '.repeat(MAX_PAYLOAD_BYTES)}`;
  const oversized = await postViolation(padded);
  expect(oversized.status).toBe(413);
  expect((await oversized.json()).error.code).toBe('PAYLOAD_TOO_LARGE');

  const stored = await (await readAudit('tenant-alpha')).json();
  expect(stored.violations, 'nothing in that list may have been persisted').toHaveLength(0);
  expect(JSON.stringify(stored)).not.toContain('ami-id');
});

test('the audit read paginates, filters by time and cannot cross tenants', async () => {
  await postViolation(violation({ category: 'metadata_endpoint', target_url: 'http://169.254.169.254/' }));
  await postViolation(violation({ category: 'private_ipv4', target_url: 'http://10.0.0.5/health', resolved_ip: '10.0.0.5', session_id: 'session-2' }));
  await postViolation(violation({ category: 'loopback_or_local', target_url: 'http://127.0.0.1:3001/healthz', resolved_ip: '127.0.0.1' }), { key: 'key-beta' });

  const all = await readAudit('tenant-alpha');
  expect(all.status).toBe(200);
  expect(all.headers.get('cache-control'), 'an audit read is never reusable from a shared cache').toBe('no-store, private');
  const payload = await all.json();
  expect(payload).toMatchObject({ ok: true, tenant_id: 'tenant-alpha', count: 2, limit: 50 });
  expect(payload.violations.map(/** @param {any} row */ row => row.category).sort()).toEqual(['metadata_endpoint', 'private_ipv4']);
  expect(JSON.stringify(payload)).not.toContain('tenant-beta');

  const limited = await (await readAudit('tenant-alpha', { query: '?limit=1' })).json();
  expect(limited.count).toBe(1);
  expect(limited.limit).toBe(1);

  const since = await (await readAudit('tenant-alpha', { query: `?since=${encodeURIComponent(new Date(Date.now() + 60000).toISOString())}` })).json();
  expect(since.count, 'a since in the future selects nothing').toBe(0);

  const other = await (await readAudit('tenant-beta', { key: 'key-beta' })).json();
  expect(other.violations).toHaveLength(1);
  expect(other.violations[0].category).toBe('loopback_or_local');

  for (const query of ['?limit=0', `?limit=${MAX_VIOLATION_LIMIT + 1}`, '?limit=abc', '?since=not-a-date']) {
    const refused = await readAudit('tenant-alpha', { query });
    expect(refused.status, query).toBe(400);
    expect((await refused.json()).error.code, query).toBe('INVALID_PAYLOAD');
  }

  const anonymous = await readAudit('tenant-alpha', { key: null });
  expect(anonymous.status).toBe(401);
  expect((await anonymous.json()).error.code).toBe('UNAUTHORIZED');

  const badKey = await readAudit('tenant-alpha', { key: 'not-a-key' });
  expect(badKey.status).toBe(401);

  const queryKey = await readAudit('tenant-alpha', { key: null, query: '?key=key-alpha' });
  expect(queryKey.status, 'an audit key must not travel in a URL').toBe(401);

  const crossTenant = await readAudit('tenant-beta');
  expect(crossTenant.status).toBe(403);
  expect((await crossTenant.json()).error.code).toBe('FORBIDDEN');
});

test('the JSONL fallback records violations without corrupting aggregates', async () => {
  const file = join(tmpdir(), `navi-violations-log-${process.pid}-${Date.now()}.log`);
  const store = await createStore(file, { mode: 'log' });
  expect(store.mode).toBe('log');

  const first = await store.recordViolation(violation({ tenant_id: 'tenant-alpha' }));
  expect(first.id).toBe(1);
  const second = await store.recordViolation(violation({ tenant_id: 'tenant-beta', category: 'private_ipv4', target_url: 'http://10.0.0.5/', resolved_ip: '10.0.0.5', session_id: null }));
  expect(second.id).toBe(2);

  // The line is the durable write, and it is typed so the two record kinds that
  // share this file can never be confused for one another.
  const lines = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatchObject({ kind: 'containment_violation', tenant_id: 'tenant-alpha', category: 'metadata_endpoint' });

  await store.append({ tenant_id: 'tenant-alpha', url_origin: 'https://a.example.com', actions_indexed: 4, actions_executed: 2, execution_failures: 0, received_at: new Date().toISOString() });
  const summary = await store.summarize();
  expect(summary.events, 'a violation is not a beacon').toBe(1);
  expect(summary.totals).toEqual({ actions_indexed: 4, actions_executed: 2, execution_failures: 0 });

  expect((await store.queryViolations({ tenant_id: 'tenant-alpha' })).map(/** @param {any} row */ row => row.id)).toEqual([1]);
  expect((await store.queryViolations({ tenant_id: 'tenant-alpha', limit: 1 })).length).toBe(1);
  expect(await store.queryViolations({ tenant_id: 'tenant-alpha', since: new Date(Date.now() + 60000).toISOString() })).toEqual([]);
  expect(await store.queryViolations({ tenant_id: 'nobody' })).toEqual([]);

  await store.reset();
  expect(await store.queryViolations({ tenant_id: 'tenant-alpha' })).toEqual([]);
  expect((await store.summarize()).events).toBe(0);
  await store.close();
});

test('a file written by an earlier version still summarizes correctly', async () => {
  const file = join(tmpdir(), `navi-violations-mixed-${process.pid}-${Date.now()}.log`);
  // One aggregate line in the original shape, one violation line beside it.
  await writeFile(file, [
    JSON.stringify({ tenant_id: 'tenant-alpha', url_origin: 'https://a.example.com', actions_indexed: 1, actions_executed: 0, execution_failures: 0, received_at: '2026-10-11T00:00:00.000Z' }),
    JSON.stringify({ kind: 'containment_violation', tenant_id: 'tenant-alpha', session_id: null, category: 'metadata_endpoint', target_url: 'http://169.254.169.254/', resolved_ip: '169.254.169.254', created_at: '2026-10-11T00:00:01.000Z' })
  ].join('\n') + '\n', 'utf8');
  const store = await createStore(file, { mode: 'log' });
  expect((await store.summarize()).events).toBe(1);
  const violations = await store.queryViolations({ tenant_id: 'tenant-alpha' });
  expect(violations).toHaveLength(1);
  expect(violations[0]).toMatchObject({ id: 1, category: 'metadata_endpoint', created_at: '2026-10-11T00:00:01.000Z' });
  // A new write continues the file's numbering rather than reusing it.
  const appended = await store.recordViolation(violation({ tenant_id: 'tenant-alpha' }));
  expect(appended.id).toBe(2);
  await store.close();
});

test('the sqlite backend creates the table, the index and durable rows', async () => {
  test.skip(!(await sqliteAvailable()), 'this runtime does not provide node:sqlite');
  const file = join(tmpdir(), `navi-violations-sqlite-${process.pid}-${Date.now()}.db`);
  const store = await createStore(file, { mode: 'sqlite' });
  expect(store.mode).toBe('sqlite');
  await store.recordViolation(violation({ tenant_id: 'tenant-alpha' }));
  await store.recordViolation(violation({ tenant_id: 'tenant-alpha', category: 'cgnat_or_multicast', target_url: 'http://100.64.0.1/', resolved_ip: '100.64.0.1' }));
  await store.recordViolation(violation({ tenant_id: 'tenant-beta', category: 'ipv6_special', target_url: 'http://[fc00::1]/', resolved_ip: 'fc00::1' }));
  await store.close();

  const specifier = 'node:sqlite';
  const { DatabaseSync } = await import(specifier);
  const db = new DatabaseSync(file);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(/** @param {any} row */ row => row.name);
  expect(tables).toContain('containment_violations');
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_violations_tenant_created'").all();
  expect(indexes).toHaveLength(1);
  const rows = db.prepare('SELECT id, tenant_id, category, resolved_ip, created_at FROM containment_violations ORDER BY id').all();
  expect(rows).toHaveLength(3);
  expect(rows.map(/** @param {any} row */ row => row.id)).toEqual([1, 2, 3]);
  expect(rows[0].resolved_ip).toBe('169.254.169.254');
  expect(Number.isNaN(Date.parse(String(rows[0].created_at)))).toBe(false);
  db.close();

  // Reopening sees what was written, which is the whole point of the table.
  const reopened = await createStore(file, { mode: 'sqlite' });
  const listed = await reopened.queryViolations({ tenant_id: 'tenant-alpha' });
  expect(listed.map(/** @param {any} row */ row => row.category).sort()).toEqual(['cgnat_or_multicast', 'metadata_endpoint']);
  expect((await reopened.queryViolations({ tenant_id: 'tenant-alpha', limit: 1 })).length).toBe(1);
  expect(await reopened.queryViolations({ tenant_id: 'tenant-alpha', since: new Date(Date.now() + 60000).toISOString() })).toEqual([]);
  await reopened.reset();
  expect(await reopened.queryViolations({ tenant_id: 'tenant-alpha' })).toEqual([]);
  await reopened.close();
});

test('a refusal is persisted for its tenant through the forwarder, with the destination sanitized', async () => {
  setEnv('NAVI_TELEMETRY_ENDPOINT', base);
  setEnv('NAVI_TENANT_KEY', 'key-alpha');
  const s = containedSession();
  try {
    expect(containmentForwardingMetrics().configured).toBe(true);
    const result = body(await s.navigate({ url: 'http://169.254.169.254/latest/meta-data/?ami-id=i-1234#creds' }));
    expect(result.error.code).toBe('ERR_BLOCKED_BY_CONTAINMENT');

    await expect.poll(async () => (await (await readAudit('tenant-alpha')).json()).count).toBe(1);
    const payload = await (await readAudit('tenant-alpha')).json();
    expect(payload.violations[0]).toMatchObject({
      tenant_id: 'tenant-alpha',
      session_id: s.sessionId,
      category: 'metadata_endpoint',
      target_url: 'http://169.254.169.254/latest/meta-data/',
      resolved_ip: '169.254.169.254'
    });
    expect(JSON.stringify(payload)).not.toContain('ami-id');
    await expect.poll(() => containmentForwardingMetrics().forwarded).toBe(1);
    expect(containmentForwardingMetrics()).toMatchObject({ failed: 0, dropped: 0, queued: 0 });
  } finally {
    await s.close();
  }
});

test('a telemetry host that is down cannot delay, change or unblock a refusal', async () => {
  setEnv('NAVI_TELEMETRY_ENDPOINT', `http://127.0.0.1:${await closedPort()}`);
  setEnv('NAVI_TENANT_KEY', 'key-alpha');
  const s = containedSession();
  try {
    const started = Date.now();
    const result = body(await s.navigate({ url: 'http://169.254.169.254/' }));
    const elapsed = Date.now() - started;
    expect(result.error.code).toBe('ERR_BLOCKED_BY_CONTAINMENT');
    expect(elapsed, 'the refusal must not wait for telemetry').toBeLessThan(1000);
    expect(containmentMetrics().containment.violations_by_category.metadata_endpoint).toBe(1);
    await expect.poll(() => containmentForwardingMetrics().failed).toBe(1);
    expect(containmentForwardingMetrics()).toMatchObject({ forwarded: 0, dropped: 0, queued: 0 });
    // The audit line is still the local record even when the host is gone.
    expect(containmentMetrics().containment.violations_total).toBe(1);
  } finally {
    await s.close();
  }
});

test('a telemetry host that never answers cannot delay a refusal either', async () => {
  // A dead port refuses the connection immediately, which is the easy case. A
  // host that accepts and then hangs is the one that would block a naive
  // forwarder, so the refusal is timed against it rather than asserted loosely.
  const hung = createServer(() => { /* accept and never answer */ });
  await new Promise(resolve => hung.listen(0, '127.0.0.1', () => resolve(null)));
  const address = hung.address();
  setEnv('NAVI_TELEMETRY_ENDPOINT', `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`);
  setEnv('NAVI_TENANT_KEY', 'key-alpha');
  const s = containedSession();
  try {
    const started = Date.now();
    const result = body(await s.navigate({ url: 'http://169.254.169.254/' }));
    const elapsed = Date.now() - started;
    expect(result.error.code).toBe('ERR_BLOCKED_BY_CONTAINMENT');
    expect(elapsed, `the refusal waited ${elapsed}ms on telemetry`).toBeLessThan(1000);
    // The attempt is still outstanding, which is exactly the point: it is off the
    // path of the request it describes.
    expect(containmentForwardingMetrics()).toMatchObject({ configured: true, forwarded: 0, failed: 0, dropped: 0, queued: 1 });
    expect(containmentMetrics().containment.violations_by_category.metadata_endpoint).toBe(1);
  } finally {
    hung.closeAllConnections();
    await new Promise(resolve => hung.close(() => resolve(null)));
    await s.close();
  }
});

test('the forward queue is bounded and drops the overflow rather than growing', async () => {
  setEnv('NAVI_TELEMETRY_ENDPOINT', `http://127.0.0.1:${await closedPort()}`);
  setEnv('NAVI_TENANT_KEY', 'key-alpha');
  // Synchronous on purpose: this fills the queue before the first drain can run,
  // which is the only way the cap is observable rather than racy.
  for (let index = 0; index < MAX_FORWARD_QUEUE + 10; index++) {
    recordContainmentViolation({ category: 'private_ipv4', target: 'http://10.0.0.1/', resolvedIp: '10.0.0.1', sessionId: null });
  }
  const saturated = containmentForwardingMetrics();
  // Every refusal is in exactly one bucket, and the queue never holds more than
  // the cap plus the one attempt the drain had already taken.
  expect(saturated.forwarded + saturated.failed + saturated.dropped + saturated.queued).toBe(MAX_FORWARD_QUEUE + 10);
  expect(saturated.queued).toBeLessThanOrEqual(MAX_FORWARD_QUEUE + 1);
  expect(saturated.dropped, 'the overflow must be reported rather than queued').toBeGreaterThan(0);
  expect(containmentMetrics().containment.violations_total).toBe(MAX_FORWARD_QUEUE + 10);
  await expect.poll(() => containmentForwardingMetrics().queued, { timeout: 20000 }).toBe(0);
  const drained = containmentForwardingMetrics();
  expect(drained.forwarded).toBe(0);
  expect(drained.failed + drained.dropped).toBe(MAX_FORWARD_QUEUE + 10);
});

test('nothing is forwarded while the endpoint or the tenant key is unset', async () => {
  expect(containmentForwardingMetrics()).toMatchObject({ configured: false, forwarded: 0, failed: 0, dropped: 0, queued: 0 });
  recordContainmentViolation({ category: 'private_ipv4', target: 'http://10.0.0.1/', resolvedIp: '10.0.0.1', sessionId: null });
  setEnv('NAVI_TELEMETRY_ENDPOINT', base);
  expect(containmentForwardingMetrics().configured, 'an endpoint without a key cannot authenticate').toBe(false);
  setEnv('NAVI_TENANT_KEY', 'key-alpha');
  expect(containmentForwardingMetrics().configured).toBe(true);
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(containmentForwardingMetrics()).toMatchObject({ forwarded: 0, failed: 0, dropped: 0, queued: 0 });
});

test('the MCP server publishes forwarder state on /healthz and /metrics', async () => {
  const server = await createSseServer({ port: 0, createSession: () => ({ close: async () => {} }), handleMessage: async () => null });
  try {
    const health = await (await fetch(`http://127.0.0.1:${server.port}/healthz`)).json();
    expect(health.containmentForwarding).toMatchObject({ configured: false, forwarded: 0, failed: 0, dropped: 0, queued: 0 });
    const text = await (await fetch(`http://127.0.0.1:${server.port}/metrics`)).text();
    expect(text).toContain('navi_containment_forward_failed_total 0');
    expect(text).toContain('navi_containment_forward_dropped_total 0');
  } finally {
    await server.close();
  }
});
