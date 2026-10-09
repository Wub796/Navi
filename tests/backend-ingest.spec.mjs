import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createNaviHostServer, MAX_PAYLOAD_BYTES, SCRIPT_CACHE_CONTROL } from '../server/index.js';
import { DEV_TENANT_ID, DEV_TENANT_KEY } from '../server/tenants.js';

/**
 * Host service checks, driven entirely over HTTP: the test never calls an
 * internal handler, so the routing, headers, validation and persistence it
 * asserts are the wire contract a customer's page and CDN actually see.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const sdkPath = join(root, 'dist/navi.min.js');

/** @type {{host: any, base: string, sdk: Buffer, integrity: string}} */
const state = { host: null, base: '', sdk: Buffer.alloc(0), integrity: '' };

test.beforeAll(async () => {
  state.sdk = await readFile(sdkPath);
  state.integrity = (await readFile(join(root, 'dist/sri.txt'), 'utf8')).trim();
  state.host = await createNaviHostServer({ port: 0, storeFile: join(tmpdir(), `navi-telemetry-${process.pid}-${Date.now()}.db`) });
  state.base = `http://127.0.0.1:${state.host.port}`;
});

test.afterAll(async () => {
  await state.host?.close();
});

/** @param {Record<string, unknown>} [overrides] @returns {Record<string, unknown>} */
const validPayload = (overrides = {}) => ({
  tenant_id: DEV_TENANT_ID,
  url_origin: 'https://shop.example.com',
  actions_indexed: 3,
  actions_executed: 2,
  execution_failures: 0,
  ...overrides
});

/**
 * @param {unknown} body
 * @param {string} [contentType]
 * @returns {Promise<Response>}
 */
const post = (body, contentType = 'application/json') => fetch(`${state.base}/v1/telemetry`, {
  method: 'POST',
  headers: { 'Content-Type': contentType },
  body: typeof body === 'string' ? body : JSON.stringify(body)
});

/** @returns {Promise<any>} */
const summary = async () => {
  const response = await fetch(`${state.base}/v1/telemetry?key=${DEV_TENANT_KEY}`);
  expect(response.status, 'tenant summary must be readable with a valid key').toBe(200);
  return (await response.json()).summary;
};

/** Cache-Control on the tenant summary, which is what a CDN or proxy would honour. @returns {Promise<string | null>} */
const summaryHeaders = async () => (await fetch(`${state.base}/v1/telemetry?key=${DEV_TENANT_KEY}`)).headers.get('cache-control');

test('serves the shipped bundle to a tenant key with cache, ETag and content type', async () => {
  const response = await fetch(`${state.base}/v1/navi.js?key=${DEV_TENANT_KEY}`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/javascript');
  expect(response.headers.get('cache-control')).toBe(SCRIPT_CACHE_CONTROL);
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  // The ETag is the published SRI hash, so a customer tag cannot pin a hash that
  // does not describe the bytes this host just served.
  expect(state.integrity).toMatch(/^sha384-[A-Za-z0-9+/]+=*$/);
  expect(response.headers.get('etag')).toBe(`"${state.integrity}"`);
  const body = Buffer.from(await response.arrayBuffer());
  expect(body.length).toBe(state.sdk.length);
  expect(body.equals(state.sdk), 'served bytes must be the built artifact byte for byte').toBe(true);
  expect(body.toString('utf8')).toContain('Navi');
});

test('answers 304 when the client already holds the current ETag', async () => {
  const etag = `"${state.integrity}"`;
  const response = await fetch(`${state.base}/v1/navi.js?key=${DEV_TENANT_KEY}`, { headers: { 'If-None-Match': etag } });
  expect(response.status).toBe(304);
  expect((await response.text()).length).toBe(0);
});

test('refuses to distribute the bundle without a valid tenant key', async () => {
  for (const key of ['', 'not-a-tenant-key']) {
    const response = await fetch(`${state.base}/v1/navi.js${key ? `?key=${key}` : ''}`);
    expect(response.status, `key ${JSON.stringify(key)} must be rejected`).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(body.error.message).toContain('key');
  }
});

test('accepts a sendBeacon-shaped telemetry post and reflects it in the tenant summary', async () => {
  const before = await summary();
  // navigator.sendBeacon(string) sends text/plain, which is the shape the client
  // actually produces; the service must accept it without a preflight.
  const response = await post(JSON.stringify(validPayload()), 'text/plain');
  expect(response.status).toBe(202);
  const accepted = await response.json();
  expect(accepted.accepted).toBe(true);
  expect(accepted.tenant_id).toBe(DEV_TENANT_ID);

  const after = await summary();
  expect(after.events).toBe(before.events + 1);
  // Tenant-scoped data must never be reusable from a shared cache.
  expect(await summaryHeaders()).toBe('no-store');
  expect(after.totals.actions_indexed).toBe(before.totals.actions_indexed + 3);
  expect(after.totals.actions_executed).toBe(before.totals.actions_executed + 2);
  expect(after.totals.execution_failures).toBe(before.totals.execution_failures);
});

test('aggregates totals and origins deterministically', async () => {
  await state.host.store.reset();
  await post(validPayload({ url_origin: 'https://a.example.com', actions_indexed: 1 }));
  await post(validPayload({ url_origin: 'https://a.example.com', actions_indexed: 4, execution_failures: 1 }));
  await post(validPayload({ url_origin: 'https://b.example.com', actions_indexed: 10, actions_executed: 7 }));

  const aggregate = await summary();
  expect(aggregate.events).toBe(3);
  expect(aggregate.totals).toEqual({ actions_indexed: 15, actions_executed: 11, execution_failures: 1 });
  expect(aggregate.byOrigin).toEqual([
    { url_origin: 'https://a.example.com', events: 2 },
    { url_origin: 'https://b.example.com', events: 1 }
  ]);
  expect(aggregate.byTenant).toHaveLength(1);
  expect(aggregate.byTenant[0]).toEqual({ tenant_id: DEV_TENANT_ID, events: 3, actions_indexed: 15, actions_executed: 11, execution_failures: 1 });
});

test('rejects malformed, misplaced and non-canonical payloads with a named code', async () => {
  /** @type {{name: string, body: unknown, status: number, code: string, contentType?: string}[]} */
  const cases = [
    { name: 'wrong field type', body: validPayload({ actions_indexed: '3' }), status: 400, code: 'INVALID_PAYLOAD' },
    { name: 'extra unknown key', body: { ...validPayload(), selector: '#checkout' }, status: 400, code: 'INVALID_PAYLOAD' },
    { name: 'negative counter', body: validPayload({ actions_executed: -1 }), status: 400, code: 'INVALID_PAYLOAD' },
    { name: 'non-integer counter', body: validPayload({ actions_executed: 1.5 }), status: 400, code: 'INVALID_PAYLOAD' },
    { name: 'query string in origin', body: validPayload({ url_origin: 'https://shop.example.com/?q=1' }), status: 400, code: 'INVALID_PAYLOAD' },
    { name: 'credentials in origin', body: validPayload({ url_origin: 'https://user:pass@shop.example.com' }), status: 400, code: 'INVALID_PAYLOAD' },
    { name: 'trailing slash in origin', body: validPayload({ url_origin: 'https://shop.example.com/' }), status: 400, code: 'INVALID_PAYLOAD' },
    { name: 'unregistered tenant', body: validPayload({ tenant_id: 'other-tenant' }), status: 401, code: 'UNKNOWN_TENANT' },
    { name: 'unsupported media type', body: JSON.stringify(validPayload()), contentType: 'application/x-www-form-urlencoded', status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' }
  ];
  for (const testCase of cases) {
    const response = await post(testCase.body, testCase.contentType);
    expect(response.status, testCase.name).toBe(testCase.status);
    const parsed = await response.json();
    expect(parsed.ok, testCase.name).toBe(false);
    expect(parsed.error.code, testCase.name).toBe(testCase.code);
    expect(parsed.error.message.length, testCase.name).toBeGreaterThan(10);
  }

  const malformed = await post('{not json');
  expect(malformed.status).toBe(400);
  expect((await malformed.json()).error.code).toBe('INVALID_PAYLOAD');

  // Oversize is decided before parsing, so even a well-formed body is refused.
  const padded = `${JSON.stringify(validPayload())}${' '.repeat(MAX_PAYLOAD_BYTES)}`;
  const oversized = await post(padded);
  expect(oversized.status).toBe(413);
  expect((await oversized.json()).error.code).toBe('PAYLOAD_TOO_LARGE');
});

test('never stores raw DOM or HTML text', async () => {
  const before = await summary();
  const response = await post('<div onclick="steal()">Checkout</div>');
  expect(response.status).toBe(400);
  expect((await response.json()).error.code).toBe('INVALID_PAYLOAD');
  const after = await summary();
  expect(after.events, 'a rejected payload must not be persisted').toBe(before.events);
  expect(JSON.stringify(after)).not.toContain('onclick');
});

test('reports health and refuses unknown routes', async () => {
  const health = await fetch(`${state.base}/healthz`);
  expect(health.status).toBe(200);
  expect(health.headers.get('cache-control'), 'health and tenant data are uncacheable').toBe('no-store');
  const body = await health.json();
  expect(body.ok).toBe(true);
  expect(['sqlite', 'log']).toContain(body.mode);
  expect(body.mode).toBe(state.host.store.mode);
  expect(body.tenants).toBe(state.host.tenants.size);

  const missing = await fetch(`${state.base}/nope`);
  expect(missing.status).toBe(404);
  const missingBody = await missing.json();
  expect(missingBody.error.code).toBe('NOT_FOUND');

  const wrongMethod = await fetch(`${state.base}/v1/navi.js?key=${DEV_TENANT_KEY}`, { method: 'POST' });
  expect(wrongMethod.status).toBe(405);
  expect((await wrongMethod.json()).error.code).toBe('METHOD_NOT_ALLOWED');
});
