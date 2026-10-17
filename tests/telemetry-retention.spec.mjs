import { test, expect } from '@playwright/test';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createNaviHostServer,
  createRateLimiter,
  MAX_PAYLOAD_BYTES,
  RATE_LIMIT_BURST,
  RATE_LIMIT_PER_MINUTE
} from '../server/index.js';
import {
  createStore,
  DEFAULT_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
  STORE_META_KIND,
  VIOLATION_KIND,
  sqliteAvailable
} from '../server/store.js';

/**
 * Retention, compaction and ingestion throttling.
 *
 * The store's two backends are exercised directly where the behaviour is a store
 * property (which rows a window removes, what a rewrite leaves behind), and over
 * HTTP where it is a contract an operator or the MCP forwarder actually sees (the
 * maintenance route, the `429` and its headers). Every host-level assertion is
 * backend-agnostic on purpose: this file must mean the same thing on a runtime
 * that provides `node:sqlite` and on one that falls back to the log.
 */

/** Hosts a test started, closed after it finishes so no limiter outlives its test. */
/** @type {any[]} */
const started = [];

/** @param {string} [suffix] @returns {string} */
const tempFile = suffix => join(tmpdir(), `navi-retention-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.${suffix}`);

/**
 * @param {any} [options] host options that override the shared defaults
 * @returns {Promise<any>}
 */
async function startHost(options = {}) {
  const host = await createNaviHostServer({
    port: 0,
    tenants: new Map([['key-alpha', 'tenant-alpha'], ['key-beta', 'tenant-beta']]),
    storeFile: tempFile('db'),
    ...options
  });
  started.push(host);
  return host;
}

test.afterEach(async () => {
  for (const host of started.splice(0)) await host.close();
});

/** @param {number} days @returns {string} */
const daysAgo = days => new Date(Date.now() - days * 86400000).toISOString();
/** @param {number} minutes @returns {string} */
const minutesAgo = minutes => new Date(Date.now() - minutes * 60000).toISOString();

/** @param {Record<string, unknown>} [overrides] @returns {any} */
const violation = (overrides = {}) => ({
  tenant_id: 'tenant-alpha',
  session_id: 'session-1',
  category: 'private_ipv4',
  target_url: 'http://10.0.0.1/',
  resolved_ip: '10.0.0.1',
  ...overrides
});

/**
 * @param {string} base @param {string} tenantId
 * @param {{key?: string | null, body?: unknown, query?: string, contentType?: string, method?: string}} [options]
 * @returns {Promise<Response>}
 */
const prune = (base, tenantId, options = {}) => {
  const { key = 'key-alpha', body, query = '', contentType = 'application/json', method = 'POST' } = options;
  return fetch(`${base}/v1/tenants/${tenantId}/maintenance/prune${query}`, {
    method,
    headers: {
      ...(key === null ? {} : { Authorization: `Bearer ${key}` }),
      ...(body === undefined ? {} : { 'Content-Type': contentType })
    },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) })
  });
};

/**
 * @param {string} base @param {string} key
 * @param {Record<string, unknown>} [payload]
 * @returns {Promise<Response>}
 */
const postViolation = (base, key, payload = violation()) => fetch(`${base}/v1/telemetry/violations`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
  body: JSON.stringify(payload)
});

/**
 * @param {string} base @param {string} key @param {Record<string, unknown>} [payload]
 * @returns {Promise<Response>}
 */
const postBeacon = (base, key, payload = { tenant_id: 'tenant-alpha', url_origin: 'https://shop.example.com', actions_indexed: 1, actions_executed: 0, execution_failures: 0 }) => fetch(`${base}/v1/telemetry`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
  body: JSON.stringify(payload)
});

/**
 * @param {string} base @param {string} tenantId @param {string} key
 * @returns {Promise<any>}
 */
const audit = async (base, tenantId, key) => {
  const response = await fetch(`${base}/v1/tenants/${tenantId}/security-audit`, { headers: { Authorization: `Bearer ${key}` } });
  expect(response.status, 'the audit read must succeed for its own tenant').toBe(200);
  return response.json();
};

/** @param {string[]} lines @param {string} file @returns {Promise<void>} */
const writeLog = async (lines, file) => { await writeFile(file, `${lines.join('\n')}\n`, 'utf8'); };

/** @param {string} file @returns {Promise<string[]>} */
const logLines = async (file) => (await readFile(file, 'utf8')).split('\n').filter(line => line.trim());

test('the sqlite store prunes by age on one tenant, then on all of them', async () => {
  test.skip(!(await sqliteAvailable()), 'this runtime does not provide node:sqlite');
  const store = await createStore(tempFile('db'), { mode: 'sqlite' });
  try {
    // Five minutes inside the thirty-day boundary is the case a text comparison
    // against SQLite's own `datetime()` output would get wrong: the stored value
    // carries a `T` where that form has a space, and `T` sorts above it.
    await store.recordViolation(violation({ created_at: daysAgo(40), category: 'metadata_endpoint' }));
    await store.recordViolation(violation({ created_at: minutesAgo(30 * 24 * 60 + 5), category: 'loopback_or_local' }));
    await store.recordViolation(violation({ created_at: daysAgo(29), category: 'cgnat_or_multicast' }));
    await store.recordViolation(violation({ created_at: daysAgo(0), category: 'ipv6_special' }));
    await store.recordViolation(violation({ tenant_id: 'tenant-beta', created_at: daysAgo(40), category: 'private_ipv4' }));
    await store.recordViolation(violation({ tenant_id: 'tenant-beta', created_at: daysAgo(1), category: 'private_ipv4' }));

    const scoped = await store.pruneViolations({ max_age_days: 30, tenant_id: 'tenant-alpha' });
    expect(scoped).toEqual({ pruned_count: 2, remaining_count: 2 });
    const alpha = await store.queryViolations({ tenant_id: 'tenant-alpha' });
    expect(alpha.map(/** @param {any} row */ row => row.category).sort()).toEqual(['cgnat_or_multicast', 'ipv6_special']);
    expect((await store.queryViolations({ tenant_id: 'tenant-beta' })), 'another tenant is untouched').toHaveLength(2);

    // The same window across every tenant, which is what the scheduled sweep runs.
    expect(await store.pruneViolations({ max_age_days: 30 })).toEqual({ pruned_count: 1, remaining_count: 3 });
    expect((await store.queryViolations({ tenant_id: 'tenant-beta' })).map(/** @param {any} row */ row => row.category)).toEqual(['private_ipv4']);

    // A window inside the boundary removes what is outside it, in the same table.
    expect(await store.pruneViolations({ max_age_days: 0.5 })).toEqual({ pruned_count: 2, remaining_count: 1 });
  } finally {
    await store.close();
  }
});

test('a window that would delete everything, or overflow the date modifier, is refused', async () => {
  const store = await createStore(tempFile('log'), { mode: 'log' });
  try {
    await store.recordViolation(violation({ created_at: daysAgo(40) }));
    for (const max_age_days of [0, -1, Number.NaN, MAX_RETENTION_DAYS + 1]) {
      await expect(store.pruneViolations({ max_age_days }), `max_age_days ${max_age_days}`).rejects.toThrow(/max_age_days|at most/);
    }
    // Refused means nothing was deleted, not that something was.
    expect(await store.queryViolations({ tenant_id: 'tenant-alpha' })).toHaveLength(1);
  } finally {
    await store.close();
  }
});

test('log compaction drops expired violations, keeps aggregates, and does not renumber', async () => {
  const file = tempFile('log');
  await writeLog([
    JSON.stringify({ tenant_id: 'tenant-alpha', url_origin: 'https://a.example.com', actions_indexed: 2, actions_executed: 1, execution_failures: 0, received_at: daysAgo(40) }),
    JSON.stringify({ kind: VIOLATION_KIND, tenant_id: 'tenant-alpha', session_id: null, category: 'metadata_endpoint', target_url: 'http://169.254.169.254/', resolved_ip: '169.254.169.254', created_at: daysAgo(40) }),
    JSON.stringify({ kind: VIOLATION_KIND, tenant_id: 'tenant-beta', session_id: null, category: 'private_ipv4', target_url: 'http://10.0.0.1/', resolved_ip: '10.0.0.1', created_at: daysAgo(40) }),
    JSON.stringify({ kind: VIOLATION_KIND, tenant_id: 'tenant-alpha', session_id: null, category: 'private_ipv4', target_url: 'http://10.0.0.2/', resolved_ip: '10.0.0.2', created_at: daysAgo(1) }),
    JSON.stringify({ tenant_id: 'tenant-alpha', url_origin: 'https://b.example.com', actions_indexed: 5, actions_executed: 2, execution_failures: 1, received_at: daysAgo(1) }),
    // A crash mid-append leaves a torn final line; compaction is where it goes.
    '{"kind":"containment'
  ], file);
  const store = await createStore(file, { mode: 'log' });
  try {
    expect(await store.pruneViolations({ max_age_days: 30, tenant_id: 'tenant-alpha' })).toEqual({ pruned_count: 1, remaining_count: 1 });

    // Aggregates are copied, not recomputed: compaction prunes violations only.
    const summary = await store.summarize();
    expect(summary.events).toBe(2);
    expect(summary.totals).toEqual({ actions_indexed: 7, actions_executed: 3, execution_failures: 1 });

    // The rows that survive keep the id a reader already held for them: the third
    // line was violation 3 before the rewrite and is violation 3 after it.
    const kept = await store.queryViolations({ tenant_id: 'tenant-alpha' });
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ id: 3, category: 'private_ipv4', target_url: 'http://10.0.0.2/' });
    expect((await store.queryViolations({ tenant_id: 'tenant-beta' })).map(/** @param {any} row */ row => row.id)).toEqual([2]);

    // The file carries the mark of every id it has ever held, and nothing else new.
    const lines = await logLines(file);
    expect(lines).toHaveLength(5);
    const meta = /** @type {any} */ (JSON.parse(lines[lines.length - 1]));
    expect(meta).toEqual({ kind: STORE_META_KIND, violation_sequence: 3 });
    expect(lines.filter(line => line.includes(VIOLATION_KIND)).map(line => JSON.parse(line).id)).toEqual([2, 3]);

    // The sweep calls the same method with no tenant at all, so that shape is
    // asserted against this backend too: it removes beta's expired row and reports
    // every surviving row, not one tenant's.
    expect(await store.pruneViolations({ max_age_days: 30 })).toEqual({ pruned_count: 1, remaining_count: 1 });
    expect(await store.queryViolations({ tenant_id: 'tenant-beta' }), 'the other tenant is pruned by the same sweep').toEqual([]);
    expect((await store.queryViolations({ tenant_id: 'tenant-alpha' })).map(/** @param {any} row */ row => row.id)).toEqual([3]);

    // An id is never reused, in this process or the next one.
    expect((await store.recordViolation(violation({ tenant_id: 'tenant-alpha' }))).id).toBe(4);
    await store.close();
    const reopened = await createStore(file, { mode: 'log' });
    expect((await reopened.recordViolation(violation({ tenant_id: 'tenant-alpha' }))).id).toBe(5);
    expect(await reopened.summarize()).toMatchObject({ events: 2 });
    await reopened.close();
  } finally {
    await store.close();
  }
});

test('the log backend carries a provisioned tenant through compaction and a reopen', async () => {
  const file = tempFile('log');
  await writeLog([
    JSON.stringify({ tenant_id: 'tenant-alpha', url_origin: 'https://a.example.com', actions_indexed: 1, actions_executed: 0, execution_failures: 0, received_at: daysAgo(40) }),
    JSON.stringify({ kind: VIOLATION_KIND, tenant_id: 'tenant-alpha', session_id: null, category: 'private_ipv4', target_url: 'http://10.0.0.1/', resolved_ip: '10.0.0.1', created_at: daysAgo(40) })
  ], file);
  const store = await createStore(file, { mode: 'log' });
  try {
    const created = await store.upsertTenantDefinition({ tenant_id: 'log-tenant', api_key: 'navi_live_log', allowed_origins: ['https://log.example.com'], max_events_per_window: 5, window_seconds: 600 });
    expect(created).toMatchObject({ tenant_id: 'log-tenant', api_key: 'navi_live_log', max_events_per_window: 5, window_seconds: 600, status: 'active' });
    // The rewrite that drops an expired violation must copy the definition line,
    // or a webhook-provisioned tenant would vanish on the next scheduled sweep.
    expect(await store.pruneViolations({ max_age_days: 30 })).toEqual({ pruned_count: 1, remaining_count: 0 });
    await store.close();

    const reopened = await createStore(file, { mode: 'log' });
    try {
      expect(await reopened.readTenantDefinition('log-tenant')).toMatchObject({ api_key: 'navi_live_log', allowed_origins: ['https://log.example.com'] });
      // Suspension is an ordinary update, not a delete: the key survives it.
      const suspended = await reopened.upsertTenantDefinition({ tenant_id: 'log-tenant', api_key: 'navi_live_log', allowed_origins: ['https://log.example.com'], max_events_per_window: 0, window_seconds: 600, status: 'suspended' });
      expect(suspended).toMatchObject({ max_events_per_window: 0, status: 'suspended' });
      expect((await reopened.readTenantDefinitions()).map(/** @param {any} d */ d => [d.tenant_id, d.max_events_per_window])).toEqual([['log-tenant', 0]]);
    } finally {
      await reopened.close();
    }
  } finally {
    await store.close();
  }
});

test('compaction is atomic: a reader sees the old file or the new one, and an append survives it', async () => {
  const file = tempFile('log');
  /** @type {string[]} */
  const lines = [];
  for (let index = 0; index < 40; index++) {
    lines.push(JSON.stringify({ tenant_id: 'tenant-alpha', url_origin: `https://shop-${index}.example.com`, actions_indexed: 1, actions_executed: 0, execution_failures: 0, received_at: daysAgo(2) }));
  }
  let alphaOld = 0;
  let alphaFresh = 0;
  for (let index = 0; index < 100; index++) {
    const old = index % 2 === 1;
    if (old) alphaOld += 1;
    else alphaFresh += 1;
    lines.push(JSON.stringify({ kind: VIOLATION_KIND, tenant_id: 'tenant-alpha', session_id: null, category: 'private_ipv4', target_url: `http://10.0.0.${index}/`, resolved_ip: '10.0.0.1', created_at: old ? daysAgo(40) : daysAgo(1) }));
  }
  for (let index = 0; index < 200; index++) {
    lines.push(JSON.stringify({ kind: VIOLATION_KIND, tenant_id: 'tenant-beta', session_id: null, category: 'cgnat_or_multicast', target_url: `http://100.64.0.${index % 200}/`, resolved_ip: '100.64.0.1', created_at: daysAgo(40) }));
  }
  await writeLog(lines, file);
  const store = await createStore(file, { mode: 'log' });
  try {
    // The prune is started and left in flight: every read below samples the file
    // while the rewrite is streaming, and every write below has to be queued behind
    // the rename rather than written into the file the rename discards.
    const pruning = store.pruneViolations({ max_age_days: 30, tenant_id: 'tenant-alpha' });
    /** @type {number[]} */
    const samples = [];
    for (let index = 0; index < 6; index++) {
      samples.push((await store.queryViolations({ tenant_id: 'tenant-alpha', limit: 200 })).length);
    }
    const writes = await Promise.all([
      ...Array.from({ length: 5 }, () => store.append({ tenant_id: 'tenant-alpha', url_origin: 'https://late.example.com', actions_indexed: 3, actions_executed: 1, execution_failures: 0, received_at: daysAgo(0) })),
      ...Array.from({ length: 5 }, () => store.recordViolation(violation({ created_at: daysAgo(0) })))
    ]);
    const result = await pruning;
    expect(result).toEqual({ pruned_count: alphaOld, remaining_count: alphaFresh });

    // Half-written states are the failure being ruled out: a truncating rewrite
    // would let a sample fall between these two counts, or throw on a torn line.
    // Which of the two a given sample sees depends on where the rename landed, so
    // neither is required to appear — being one of them, always, is the property.
    expect(samples).toHaveLength(6);
    expect(samples.filter(count => count !== alphaFresh && count !== alphaOld + alphaFresh), 'a sample saw a state between the two files').toEqual([]);

    // Nothing was lost, duplicated or torn, and no temporary was left behind.
    const kept = await store.queryViolations({ tenant_id: 'tenant-alpha', limit: 200 });
    expect(kept).toHaveLength(alphaFresh + 5);
    expect(kept.every(/** @param {any} row */ row => row.created_at >= daysAgo(30))).toBe(true);
    expect((await store.queryViolations({ tenant_id: 'tenant-beta', limit: 200 }))).toHaveLength(200);
    expect((await store.summarize()).events).toBe(45);
    for (const record of /** @type {any[]} */ (writes.slice(5))) expect(record.id).toBeGreaterThan(alphaOld + alphaFresh + 200);
    const raw = await logLines(file);
    for (const line of raw) expect(() => JSON.parse(line), line.slice(0, 60)).not.toThrow();
    expect(raw.filter(line => JSON.parse(line).kind === STORE_META_KIND)).toHaveLength(1);
    await expect(stat(`${file}.compacting`)).rejects.toThrow();
  } finally {
    await store.close();
  }
});

test('the maintenance route prunes its own tenant and answers both counts', async () => {
  const host = await startHost({ retentionDays: 30 });
  const base = `http://127.0.0.1:${host.port}`;
  await host.store.recordViolation(violation({ created_at: daysAgo(40) }));
  await host.store.recordViolation(violation({ created_at: daysAgo(31) }));
  await host.store.recordViolation(violation({ created_at: daysAgo(1) }));
  await host.store.recordViolation(violation({ tenant_id: 'tenant-beta', created_at: daysAgo(40) }));

  const response = await prune(base, 'tenant-alpha');
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ ok: true, tenant_id: 'tenant-alpha', max_age_days: 30, pruned_count: 2, remaining_count: 1 });
  expect((await audit(base, 'tenant-alpha', 'key-alpha')).violations).toHaveLength(1);
  // Pruning one tenant never touches another's records.
  expect((await audit(base, 'tenant-beta', 'key-beta')).violations).toHaveLength(1);

  // An explicit window wins over the configured one.
  const explicit = await prune(base, 'tenant-alpha', { body: { max_age_days: 1 } });
  expect(explicit.status).toBe(200);
  expect(await explicit.json()).toEqual({ ok: true, tenant_id: 'tenant-alpha', max_age_days: 1, pruned_count: 1, remaining_count: 0 });
  expect((await audit(base, 'tenant-beta', 'key-beta')).violations, 'the second tenant is still intact').toHaveLength(1);
});

test('the maintenance route is authenticated, tenant-scoped and strict about its body', async () => {
  const host = await startHost({ retentionDays: 30 });
  const base = `http://127.0.0.1:${host.port}`;
  await host.store.recordViolation(violation({ created_at: daysAgo(40) }));

  const unauthenticated = await prune(base, 'tenant-alpha', { key: null });
  expect(unauthenticated.status).toBe(401);
  expect((await unauthenticated.json()).error.code).toBe('UNAUTHORIZED');

  const queryKey = await prune(base, 'tenant-alpha', { key: null, query: '?key=key-alpha' });
  expect(queryKey.status, 'a key in a URL is a key in a log').toBe(401);

  const wrongTenant = await prune(base, 'tenant-alpha', { key: 'key-beta' });
  expect(wrongTenant.status).toBe(403);
  expect((await wrongTenant.json()).error.code).toBe('FORBIDDEN');

  const wrongMethod = await prune(base, 'tenant-alpha', { method: 'GET' });
  expect(wrongMethod.status).toBe(405);

  /** @type {{name: string, options: Record<string, unknown>, status: number, code: string}[]} */
  const cases = [
    { name: 'zero', options: { body: { max_age_days: 0 } }, status: 400, code: 'INVALID_PAYLOAD' },
    { name: 'negative', options: { body: { max_age_days: -30 } }, status: 400, code: 'INVALID_PAYLOAD' },
    { name: 'fractional', options: { body: { max_age_days: 1.5 } }, status: 400, code: 'INVALID_PAYLOAD' },
    { name: 'numeric string', options: { body: { max_age_days: '30' } }, status: 400, code: 'INVALID_PAYLOAD' },
    { name: 'beyond the ceiling', options: { body: { max_age_days: MAX_RETENTION_DAYS + 1 } }, status: 400, code: 'INVALID_PAYLOAD' },
    { name: 'unknown field', options: { body: { max_age_days: 30, tenant_id: 'tenant-beta' } }, status: 400, code: 'INVALID_PAYLOAD' },
    { name: 'array body', options: { body: [30] }, status: 400, code: 'INVALID_PAYLOAD' },
    { name: 'malformed json', options: { body: '{not json' }, status: 400, code: 'INVALID_PAYLOAD' },
    { name: 'wrong media type', options: { body: '{"max_age_days":30}', contentType: 'text/plain' }, status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' },
    { name: 'oversized body', options: { body: `${JSON.stringify({ max_age_days: 30 })}${' '.repeat(MAX_PAYLOAD_BYTES)}` }, status: 413, code: 'PAYLOAD_TOO_LARGE' }
  ];
  for (const testCase of cases) {
    const response = await prune(base, 'tenant-alpha', testCase.options);
    expect(response.status, testCase.name).toBe(testCase.status);
    const parsed = await response.json();
    expect(parsed.ok, testCase.name).toBe(false);
    expect(parsed.error.code, testCase.name).toBe(testCase.code);
    expect(parsed.error.message.length, testCase.name).toBeGreaterThan(10);
  }
  // Every refusal above left the record alone: a prune is never a side effect of
  // a bad request.
  expect((await audit(base, 'tenant-alpha', 'key-alpha')).violations).toHaveLength(1);
});

test('a disabled sweep is not a disabled route, and the window defaults to the configured retention', async () => {
  const host = await startHost({ retentionDays: 7 });
  const base = `http://127.0.0.1:${host.port}`;
  expect((await (await fetch(`${base}/healthz`)).json()).retention_days).toBe(7);
  await host.store.recordViolation(violation({ created_at: daysAgo(8) }));
  await host.store.recordViolation(violation({ created_at: daysAgo(1) }));
  const response = await prune(base, 'tenant-alpha');
  expect(await response.json()).toMatchObject({ max_age_days: 7, pruned_count: 1, remaining_count: 1 });

  // With the sweep off, the route still prunes — and never with a window of zero,
  // which would delete nothing while looking like it deleted everything.
  const off = await startHost({ retentionDays: 0 });
  const offBase = `http://127.0.0.1:${off.port}`;
  expect((await (await fetch(`${offBase}/healthz`)).json()).retention_days).toBe(0);
  await off.store.recordViolation(violation({ created_at: daysAgo(40) }));
  const explicit = await prune(offBase, 'tenant-alpha');
  // The default window is the retention default, not the configured 0: the route
  // prunes what 30 days means even while no sweep is scheduled.
  expect(await explicit.json()).toMatchObject({ max_age_days: DEFAULT_RETENTION_DAYS, pruned_count: 1, remaining_count: 0 });
});

test('the scheduled sweep prunes on its interval, and stops when retention is off', async () => {
  const host = await startHost({ retentionDays: 30, retentionIntervalMs: 60 });
  await host.store.recordViolation(violation({ created_at: daysAgo(40) }));
  await host.store.recordViolation(violation({ created_at: daysAgo(1) }));
  await host.store.recordViolation(violation({ tenant_id: 'tenant-beta', created_at: daysAgo(40) }));
  // The first sweep runs at startup, before these rows existed; this one can only
  // come from the timer.
  await expect.poll(
    async () => (await host.store.queryViolations({ tenant_id: 'tenant-alpha' })).length,
    { timeout: 10000 }
  ).toBe(1);
  await expect.poll(
    async () => (await host.store.queryViolations({ tenant_id: 'tenant-beta' })).length,
    { timeout: 10000 }
  ).toBe(0);

  const disabled = await startHost({ retentionDays: 0, retentionIntervalMs: 30 });
  await disabled.store.recordViolation(violation({ created_at: daysAgo(400) }));
  await new Promise(resolve => setTimeout(resolve, 250));
  expect((await disabled.store.queryViolations({ tenant_id: 'tenant-alpha' })), 'retention 0 means nothing is pruned automatically').toHaveLength(1);
});

test('an ingest burst is capped per tenant, on both ingest routes', async () => {
  const host = await startHost();
  const base = `http://127.0.0.1:${host.port}`;

  const first = await postViolation(base, 'key-alpha');
  expect(first.status).toBe(202);
  expect(first.headers.get('x-ratelimit-limit')).toBe(String(RATE_LIMIT_PER_MINUTE));
  expect(first.headers.get('x-ratelimit-remaining')).toBe(String(RATE_LIMIT_BURST - 1));

  for (let index = 1; index < RATE_LIMIT_BURST; index++) {
    expect((await postViolation(base, 'key-alpha')).status, `request ${index + 1} within the burst`).toBe(202);
  }

  const refused = await postViolation(base, 'key-alpha');
  expect(refused.status).toBe(429);
  expect(refused.headers.get('x-ratelimit-limit')).toBe(String(RATE_LIMIT_PER_MINUTE));
  expect(refused.headers.get('x-ratelimit-remaining')).toBe('0');
  expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
  const refusedBody = await refused.json();
  expect(refusedBody.ok).toBe(false);
  expect(refusedBody.error.code).toBe('RATE_LIMITED');
  // The refused record was not stored, and the ceiling is shared by both ingest
  // routes rather than counted per route.
  expect((await audit(base, 'tenant-alpha', 'key-alpha')).violations).toHaveLength(RATE_LIMIT_BURST);
  const beacon = await postBeacon(base, 'key-alpha');
  expect(beacon.status).toBe(429);
  expect((await beacon.json()).error.code).toBe('RATE_LIMITED');

  // Another tenant has its own bucket, so one noisy page cannot silence the rest.
  const other = await postViolation(base, 'key-beta', violation({ tenant_id: 'tenant-beta' }));
  expect(other.status).toBe(202);
  expect((await postBeacon(base, 'key-beta', { tenant_id: 'tenant-beta', url_origin: 'https://other.example.com', actions_indexed: 1, actions_executed: 0, execution_failures: 0 })).status).toBe(202);
});

test('an authenticated beacon is charged to the tenant it names, after validation', async () => {
  const host = await startHost({ rateLimiter: createRateLimiter({ perMinute: 120, burst: 2, timer: false }) });
  const base = `http://127.0.0.1:${host.port}`;

  // An unauthenticated request is rejected before validation or rate-limit charging.
  const unauthenticated = await fetch(`${base}/v1/telemetry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenant_id: 'tenant-alpha' }) });
  expect(unauthenticated.status).toBe(401);
  expect(await unauthenticated.json()).toEqual({ error: 'Unauthorized' });

  // A malformed payload is still a payload error, not a quota answer.
  const malformed = await fetch(`${base}/v1/telemetry`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer key-alpha' }, body: JSON.stringify({ tenant_id: 'tenant-alpha' }) });
  expect(malformed.status).toBe(400);
  expect((await malformed.json()).error.code).toBe('INVALID_PAYLOAD');

  expect((await postBeacon(base, 'key-alpha')).status).toBe(202);
  expect((await postBeacon(base, 'key-alpha')).status).toBe(202);
  const refused = await postBeacon(base, 'key-alpha');
  expect(refused.status).toBe(429);
  expect(refused.headers.get('retry-after')).toBe('1');
  // The same tenant's violation route shares the bucket, so a caller cannot
  // escape its tenant's ceiling by switching routes.
  const violationResponse = await postViolation(base, 'key-alpha');
  expect(violationResponse.status).toBe(429);
  expect((await postViolation(base, 'key-beta', violation({ tenant_id: 'tenant-beta' }))).status).toBe(202);
});

test('the token bucket refills at its rate, banks no more than its burst, and forgets idle tenants', async () => {
  let clock = 1_000_000;
  const limiter = createRateLimiter({ perMinute: 120, burst: 30, idleMs: 60000, now: () => clock, timer: false });
  const allowed = () => limiter.take('tenant-alpha').allowed;

  expect(limiter.enabled).toBe(true);
  for (let index = 0; index < 30; index++) expect(allowed(), `burst token ${index + 1}`).toBe(true);
  const refused = limiter.take('tenant-alpha');
  expect(refused).toMatchObject({ allowed: false, remaining: 0 });
  expect(refused.retryAfterSeconds, 'two requests per second refill one token in half a second').toBe(1);

  // 120 per minute is two per second: half a second buys exactly one request.
  clock += 500;
  expect(allowed()).toBe(true);
  expect(allowed(), 'and only one').toBe(false);

  clock += 10000;
  for (let index = 0; index < 20; index++) expect(allowed(), `refilled token ${index + 1}`).toBe(true);
  expect(allowed()).toBe(false);

  // Half a minute of silence cannot bank more than the burst allowance.
  clock += 30000;
  expect(limiter.take('tenant-alpha').remaining).toBe(29);
  let spent = 1;
  while (allowed()) spent += 1;
  expect(spent).toBe(30);

  // Idle buckets are what keeps this from growing with the number of tenants ever
  // seen: after the idle window the entry is gone.
  clock += 60000;
  expect(limiter.sweep()).toBe(1);
  expect(limiter.size).toBe(0);
  expect(limiter.take('tenant-alpha').remaining).toBe(29);

  // The timer sweeps on its own, without a request to trigger it. This one runs on
  // the wall clock, because a frozen clock would never age a bucket out.
  const ticking = createRateLimiter({ perMinute: 120, burst: 30, idleMs: 10, sweepIntervalMs: 20 });
  expect(ticking.take('tenant-alpha').allowed).toBe(true);
  expect(ticking.size).toBe(1);
  await expect.poll(() => ticking.size, { timeout: 5000 }).toBe(0);
  ticking.close();

  const off = createRateLimiter({ perMinute: 0, burst: 0, timer: false });
  expect(off.enabled).toBe(false);
  for (let index = 0; index < 50; index++) expect(off.take('tenant-alpha').allowed).toBe(true);
  expect(off.size, 'a disabled limiter remembers nothing').toBe(0);
});

test('the retention window and the ceilings come from the environment', async () => {
  /** @type {Record<string, string | undefined>} */
  const saved = {};
  /** @param {Record<string, string>} values */
  const setEnv = values => {
    for (const [name, value] of Object.entries(values)) {
      if (!(name in saved)) saved[name] = process.env[name];
      process.env[name] = value;
    }
  };
  try {
    setEnv({ NAVI_RETENTION_DAYS: '7', NAVI_RATE_LIMIT_PER_MINUTE: '5', NAVI_RATE_LIMIT_BURST: '2' });
    const host = await startHost();
    const base = `http://127.0.0.1:${host.port}`;
    expect((await (await fetch(`${base}/healthz`)).json()).retention_days).toBe(7);
    expect(host.limiter).toMatchObject({ perMinute: 5, burst: 2, enabled: true });
    expect(host.retention.days).toBe(7);
    expect((await postViolation(base, 'key-alpha')).status).toBe(202);
    expect((await postViolation(base, 'key-alpha')).status).toBe(202);
    const refused = await postViolation(base, 'key-alpha');
    expect(refused.status).toBe(429);
    expect(refused.headers.get('x-ratelimit-limit')).toBe('5');
    await host.close();

    // An unparseable or negative value falls back to the documented default rather
    // than to zero, which would silently disable a bound the operator wanted.
    setEnv({ NAVI_RETENTION_DAYS: 'soon', NAVI_RATE_LIMIT_PER_MINUTE: '-5' });
    const fallback = await startHost();
    expect(fallback.limiter).toMatchObject({ perMinute: RATE_LIMIT_PER_MINUTE, enabled: true });
    expect(fallback.retention.days).toBe(DEFAULT_RETENTION_DAYS);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
