import { test, expect } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createNaviHostServer, MAX_PAYLOAD_BYTES, SCRIPT_CACHE_CONTROL } from '../server/index.js';
import { createStore } from '../server/store.js';
import { DEV_TENANT_ID, DEV_TENANT_KEY, isOriginAllowed, loadTenants, tenantConfigFor } from '../server/tenants.js';

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
 * @param {string | null} [key]
 * @returns {Promise<Response>}
 */
const post = (body, contentType = 'application/json', key = DEV_TENANT_KEY) => fetch(`${state.base}/v1/telemetry`, {
  method: 'POST',
  headers: {
    'Content-Type': contentType,
    ...(key === null ? {} : { Authorization: `Bearer ${key}` })
  },
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

test('enforces strict Bearer authentication on POST /v1/telemetry and rejects unauthenticated or mismatched tenant payloads with 401', async () => {
  const host = await createNaviHostServer({
    port: 0,
    storeFile: join(tmpdir(), `navi-telemetry-auth-${process.pid}-${Date.now()}.db`),
    tenants: new Map([['key-alpha', 'tenant-alpha'], ['key-beta', 'tenant-beta']])
  });
  const base = `http://127.0.0.1:${host.port}`;
  try {
    const payload = validPayload({ tenant_id: 'tenant-alpha' });
    // Unauthenticated request supplying only tenant_id in the payload
    let response = await fetch(`${base}/v1/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });

    // Query-string key without Bearer header
    response = await fetch(`${base}/v1/telemetry?key=key-alpha`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });

    // Invalid Bearer token
    response = await fetch(`${base}/v1/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-token' },
      body: JSON.stringify(payload)
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });

    // Cross-tenant token mismatch (Bearer token for tenant-beta, payload for tenant-alpha)
    response = await fetch(`${base}/v1/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer key-beta' },
      body: JSON.stringify(payload)
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });

    // Authorized ingestion with matching Bearer token
    response = await fetch(`${base}/v1/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer key-alpha' },
      body: JSON.stringify(payload)
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ ok: true, accepted: true, tenant_id: 'tenant-alpha' });
  } finally {
    await host.close();
  }
});

test('enforces per-tenant allowed_origins (HTTP 403 / 202) and persistent SQLite WAL quota metering (HTTP 429) on POST /v1/telemetry', async () => {
  // Unit check for loadTenants and isOriginAllowed
  const parsedTenants = loadTenants({ NAVI_TENANTS: 'k1:t1:https://app.example.com|https://admin.example.com@5,k2:t2:*' });
  expect(tenantConfigFor(parsedTenants, 'k1')).toEqual({
    id: 't1',
    allowed_origins: ['https://app.example.com', 'https://admin.example.com'],
    max_events_per_window: 5
  });
  expect(isOriginAllowed(['https://app.example.com'], 'https://app.example.com')).toBe(true);
  expect(isOriginAllowed(['https://app.example.com'], 'https://other.example.com')).toBe(false);
  expect(isOriginAllowed(['*'], 'https://other.example.com')).toBe(true);

  const storeFile = join(tmpdir(), `navi-telemetry-quota-${process.pid}-${Date.now()}.db`);
  const tenants = new Map([
    ['key-locked', { id: 'tenant-locked', allowed_origins: ['https://app.example.com'], max_events_per_window: 2, window_seconds: 300 }],
    ['key-open', { id: 'tenant-open', allowed_origins: ['*'] }]
  ]);
  let host = await createNaviHostServer({ port: 0, storeFile, tenants });
  let base = `http://127.0.0.1:${host.port}`;
  try {
    // Disallowed payload url_origin -> 403 Forbidden origin
    let response = await fetch(`${base}/v1/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer key-locked' },
      body: JSON.stringify(validPayload({ tenant_id: 'tenant-locked', url_origin: 'https://rogue.example.com' }))
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Forbidden origin' });

    // Disallowed HTTP Origin header -> 403 Forbidden origin
    response = await fetch(`${base}/v1/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer key-locked', Origin: 'https://rogue.example.com' },
      body: JSON.stringify(validPayload({ tenant_id: 'tenant-locked', url_origin: 'https://app.example.com' }))
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Forbidden origin' });

    // Wildcard tenant accepts any canonical origin -> 202
    response = await fetch(`${base}/v1/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer key-open' },
      body: JSON.stringify(validPayload({ tenant_id: 'tenant-open', url_origin: 'https://anywhere.example.com' }))
    });
    expect(response.status).toBe(202);

    // Allowed origin within quota -> 202 (event 1 of 2)
    response = await fetch(`${base}/v1/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer key-locked', Origin: 'https://app.example.com' },
      body: JSON.stringify(validPayload({ tenant_id: 'tenant-locked', url_origin: 'https://app.example.com' }))
    });
    expect(response.status).toBe(202);

    // Restart the server against the same SQLite WAL storeFile to prove quota is persisted on disk
    await host.close();
    host = await createNaviHostServer({ port: 0, storeFile, tenants });
    base = `http://127.0.0.1:${host.port}`;

    // Event 2 of 2 succeeds after restart
    response = await fetch(`${base}/v1/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer key-locked' },
      body: JSON.stringify(validPayload({ tenant_id: 'tenant-locked', url_origin: 'https://app.example.com' }))
    });
    expect(response.status).toBe(202);

    // Event 3 exceeds max_events_per_window (2) -> 429 Quota exceeded with Retry-After header
    response = await fetch(`${base}/v1/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer key-locked' },
      body: JSON.stringify(validPayload({ tenant_id: 'tenant-locked', url_origin: 'https://app.example.com' }))
    });
    expect(response.status).toBe(429);
    const retryAfter = Number(response.headers.get('retry-after'));
    expect(Number.isInteger(retryAfter) && retryAfter >= 1).toBe(true);
    expect(await response.json()).toEqual({ error: 'Quota exceeded' });
  } finally {
    await host.close();
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

test('the billing webhook refuses unsigned, mis-signed, tampered and stale events', async () => {
  const storeFile = join(tmpdir(), `navi-billing-guard-${process.pid}-${Date.now()}.db`);
  const secret = 'whsec_guard';
  const host = await createNaviHostServer({ port: 0, storeFile, stripeWebhookSecret: secret });
  const endpoint = `http://127.0.0.1:${host.port}/v1/billing/webhook`;
  const body = JSON.stringify({ type: 'checkout.session.completed', data: { object: { metadata: { tenant_id: 'guard-tenant' } } } });
  /** @param {string} raw @param {number} [timestamp] @param {string} [signingSecret] */
  const sign = (raw, timestamp = Math.floor(Date.now() / 1000), signingSecret = secret) =>
    `t=${timestamp},v1=${createHmac('sha256', signingSecret).update(`${timestamp}.${raw}`).digest('hex')}`;
  /** @param {string} raw @param {string | null} [signature] */
  const send = (raw, signature = sign(raw)) => fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(signature === null ? {} : { 'Stripe-Signature': signature }) },
    body: raw
  });
  try {
    // The suite's shared host configures no secret, so it must not trust a body at all.
    const unconfigured = await fetch(`${state.base}/v1/billing/webhook`, { method: 'POST', body: '{}' });
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.json()).toEqual({ error: 'Billing webhook not configured' });

    let response = await send(body, null);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Invalid signature' });

    response = await send(body, sign(body, undefined, 'whsec_wrong'));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Invalid signature' });

    // A signature over different bytes than the body that arrived.
    response = await send(body.replace('guard-tenant', 'other-tenant'), sign(body));
    expect(response.status).toBe(401);

    // Outside the 300-second replay window, in either direction.
    const now = Math.floor(Date.now() / 1000);
    for (const skew of [-301, 301]) {
      response = await send(body, sign(body, now + skew));
      expect(response.status, `a ${skew}s skew must be refused`).toBe(401);
      expect(await response.json()).toEqual({ error: 'Invalid signature' });
    }

    // A well-formed but unusable signature header is still a 401, not a 500.
    response = await send(body, 'v1=deadbeef');
    expect(response.status).toBe(401);

    // Signed but unparseable is a caller error with its own answer.
    const malformed = '{not json';
    response = await send(malformed, sign(malformed));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid payload' });
  } finally {
    await host.close();
  }
});

test('a signed checkout provisions a tenant that ingests, survives a restart, and is revoked with 429', async () => {
  const storeFile = join(tmpdir(), `navi-billing-provision-${process.pid}-${Date.now()}.db`);
  const secret = 'whsec_provision';
  const start = () => createNaviHostServer({ port: 0, storeFile, stripeWebhookSecret: secret });
  let host = await start();
  const base = () => `http://127.0.0.1:${host.port}`;
  /** @param {string} raw @param {string} [signingSecret] */
  const webhook = (raw, signingSecret = secret) => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', signingSecret).update(`${timestamp}.${raw}`).digest('hex');
    return fetch(`${base()}/v1/billing/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${timestamp},v1=${signature}` },
      body: raw
    });
  };
  const crawl = (/** @type {string} */ key, /** @type {string} */ url) => fetch(`${base()}/v1/sitemap/update`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: JSON.stringify({ url, actions: [{ target_id: '#submit', role: 'button', name: 'Submit', action: 'click', selector: '#submit', disabled: false }] })
  });
  const beacon = (/** @type {string} */ key, /** @type {string} */ origin) => fetch(`${base()}/v1/telemetry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ tenant_id: 'tenant-stripe', url_origin: origin, actions_indexed: 1, actions_executed: 0, execution_failures: 0 })
  });
  try {
    const checkout = JSON.stringify({
      id: 'evt_checkout',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test', client_reference_id: 'tenant-stripe', metadata: {
        allowed_origins: 'https://app.example.com',
        max_events_per_window: '5',
        window_seconds: '600'
      } } }
    });
    let response = await webhook(checkout);
    expect(response.status).toBe(200);
    const provisioned = await response.json();
    expect(provisioned.ok).toBe(true);
    expect(provisioned.tenant_id).toBe('tenant-stripe');
    expect(provisioned.api_key).toMatch(/^navi_live_[0-9a-f]{64}$/);
    const key = provisioned.api_key;

    // Stripe resends a delivery it did not see acknowledged. The same event id is
    // answered without provisioning again, and without handing back - let alone
    // minting - a different credential.
    response = await webhook(checkout);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, duplicate: true });

    // Self-serve post-checkout claim: GET /v1/billing/session?session_id=cs_test
    // returns the provisioned api_key once with Cache-Control: no-store, then 404s.
    response = await fetch(`${base()}/v1/billing/session?session_id=cs_test`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.json()).toEqual({ ok: true, tenant_id: 'tenant-stripe', api_key: key });

    response = await fetch(`${base()}/v1/billing/session?session_id=cs_test`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Session not found or already claimed' });

    response = await fetch(`${base()}/v1/billing/session`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Session not found or already claimed' });

    // The minted key authenticates both ingest routes immediately, and the
    // provisioned origin list is already enforced.
    response = await crawl(key, 'https://app.example.com/checkout');
    expect(response.status).toBe(200);
    response = await crawl(key, 'https://rogue.example.com/checkout');
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Forbidden origin' });
    response = await beacon(key, 'https://app.example.com');
    expect(response.status).toBe(202);

    // A restart is the only way to prove the key is configuration on disk rather
    // than an in-memory registration.
    await host.close();
    host = await start();
    response = await crawl(key, 'https://app.example.com/checkout');
    expect(response.status, 'a provisioned key must survive a restart').toBe(200);

    // An update without an api_key or allowed_origins keeps both the credential
    // and the origin allow-list already handed out.
    const update = JSON.stringify({ id: 'evt_update', type: 'customer.subscription.updated', data: { object: { id: 'sub_1', metadata: { tenant_id: 'tenant-stripe', max_events_per_window: '9' } } } });
    response = await webhook(update);
    expect(response.status).toBe(200);
    expect((await response.json()).api_key).toBe(key);
    response = await crawl(key, 'https://rogue.example.com/checkout');
    expect(response.status, 'subscription update without allowed_origins must not widen the tenant origin restriction').toBe(403);

    const cancellation = JSON.stringify({ id: 'evt_cancel', type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', metadata: { tenant_id: 'tenant-stripe' } } } });
    response = await webhook(cancellation);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, tenant_id: 'tenant-stripe', status: 'suspended' });

    // A redelivered cancellation is a duplicate too, and the ledger is durable:
    // it was written to the same store the definition lives in.
    response = await webhook(cancellation);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, duplicate: true });

    // Suspension is a quota answer, not an authentication one: the key stays valid.
    response = await crawl(key, 'https://app.example.com/checkout');
    expect(response.status).toBe(429);
    expect(response.headers.get('x-quota-limit')).toBe('0');
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await response.json()).toEqual({ error: 'Quota exceeded' });
    response = await beacon(key, 'https://app.example.com');
    expect(response.status).toBe(429);

    // And the suspension is persisted, not a registry-only flag.
    await host.close();
    host = await start();
    response = await crawl(key, 'https://app.example.com/checkout');
    expect(response.status, 'a suspended tenant must stay suspended across a restart').toBe(429);

    // The ledger is durable too: after reopening the store, the redelivered
    // cancellation is still a duplicate rather than a second suspension.
    response = await webhook(cancellation);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, duplicate: true });
  } finally {
    await host.close();
  }
});

test('a standard Payment Link provisions from the customer on the host and its cancellation suspends that tenant', async () => {
  // The same missing-metadata path the Worker handles, exercised against the real
  // SQLite store: a Payment Link session carries `customer` but no tenant metadata,
  // and the later cancellation carries only that customer. Derivation has to agree,
  // or the suspension lands on a tenant nobody bought.
  const storeFile = join(tmpdir(), `navi-billing-payment-link-${process.pid}-${Date.now()}.db`);
  const secret = 'whsec_payment_link';
  const host = await createNaviHostServer({ port: 0, storeFile, stripeWebhookSecret: secret });
  const base = () => `http://127.0.0.1:${host.port}`;
  /** @param {string} raw */
  const webhook = raw => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
    return fetch(`${base()}/v1/billing/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${timestamp},v1=${signature}` },
      body: raw
    });
  };
  const crawl = (/** @type {string} */ key) => fetch(`${base()}/v1/sitemap/update`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: JSON.stringify({ url: 'https://app.example.com/checkout', actions: [{ target_id: '#submit', role: 'button', name: 'Submit', action: 'click', selector: '#submit', disabled: false }] })
  });
  try {
    const checkout = JSON.stringify({
      id: 'evt_link',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_link', customer: 'cus_test_link', metadata: {} } }
    });
    let response = await webhook(checkout);
    expect(response.status).toBe(200);
    const provisioned = await response.json();
    expect(provisioned.ok).toBe(true);
    expect(provisioned.tenant_id).toBe('tenant_cus_test_link');
    expect(provisioned.api_key).toMatch(/^navi_live_[0-9a-f]{64}$/);
    const key = provisioned.api_key;

    // The claim was written in the same transaction as the tenant, so the success
    // URL renders the key once.
    response = await fetch(`${base()}/v1/billing/success?session_id=cs_test_link`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const page = await response.text();
    expect(page).toContain(key);
    expect(page).toContain('tenant_cus_test_link');

    response = await fetch(`${base()}/v1/billing/success?session_id=cs_test_link`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(key);

    // The key authenticates ingest until the subscription ends.
    response = await crawl(key);
    expect(response.status).toBe(200);

    // The cancellation names the customer and no metadata. It must suspend the
    // tenant the checkout created, not answer 400 and leave the sale live.
    const cancellation = JSON.stringify({ id: 'evt_link_cancel', type: 'customer.subscription.deleted', data: { object: { id: 'sub_link', customer: 'cus_test_link' } } });
    response = await webhook(cancellation);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, tenant_id: 'tenant_cus_test_link', status: 'suspended' });

    response = await crawl(key);
    expect(response.status).toBe(429);
    expect(response.headers.get('x-quota-limit')).toBe('0');
    expect(await response.json()).toEqual({ error: 'Quota exceeded' });
  } finally {
    await host.close();
  }
});

test('webhook ledger prunes entries older than 24h and rolls back atomically on write failure', async () => {
  const storeFile = join(tmpdir(), `navi-billing-atomic-${process.pid}-${Date.now()}.db`);
  const store = await createStore(storeFile, { mode: 'sqlite' });
  try {
    // 1. 24-hour TTL pruning during recordWebhookEvent / applyWebhookEvent.
    const expiredMs = Date.now() - (86_400_000 + 5_000);
    expect(await store.recordWebhookEvent('evt_ttl_expired', expiredMs)).toBe(true);
    expect(await store.recordWebhookEvent('evt_ttl_fresh', Date.now())).toBe(true);
    // Recording a new event prunes the expired entry, so evt_ttl_expired can be claimed again.
    expect(await store.recordWebhookEvent('evt_ttl_expired', Date.now())).toBe(true);
    expect(await store.recordWebhookEvent('evt_ttl_fresh', Date.now())).toBe(false);

    // 2. Atomic SQLite transaction rollback: if a write inside applyWebhookEvent fails
    // (for example, a unique-key collision on idx_tenant_definitions_key or an invalid
    // checkout claim after the event-id insert), the BEGIN IMMEDIATE transaction rolls back
    // so the event_id is never left claimed without the tenant state applied.
    await store.applyWebhookEvent({
      event_id: 'evt_seed_owner',
      definition: { tenant_id: 'tenant-owner', api_key: 'navi_live_shared_unique_key' }
    });
    await expect(
      store.applyWebhookEvent({
        event_id: 'evt_must_rollback',
        definition: { tenant_id: 'tenant-colliding', api_key: 'navi_live_shared_unique_key' }
      })
    ).rejects.toThrow();
    expect(await store.readTenantDefinition('tenant-colliding')).toBeNull();
    // Because the transaction rolled back, evt_must_rollback was not left in webhook_events:
    const retry = await store.applyWebhookEvent({
      event_id: 'evt_must_rollback',
      definition: { tenant_id: 'tenant-colliding', api_key: 'navi_live_distinct_key' }
    });
    expect(retry.duplicate).toBe(false);
    expect(retry.record?.api_key).toBe('navi_live_distinct_key');

    // 3. Expired checkout claims are rejected with null.
    await store.recordCheckoutClaim({
      session_id: 'cs_expired_test',
      tenant_id: 'tenant-owner',
      api_key: 'navi_live_shared_unique_key',
      expires_at_ms: Date.now() - 1_000
    });
    expect(await store.consumeCheckoutClaim('cs_expired_test')).toBeNull();
  } finally {
    await store.close();
  }
});

test('the host serves the one-time onboarding page and never repeats a claimed key', async () => {
  const host = await createNaviHostServer({ port: 0, storeFile: join(tmpdir(), `navi-billing-success-${process.pid}-${Date.now()}.db`) });
  const base = `http://127.0.0.1:${host.port}`;
  try {
    expect(typeof host.store.recordCheckoutClaim, 'the store must be able to hold a checkout claim').toBe('function');
    await host.store.recordCheckoutClaim?.({ session_id: 'cs_page', tenant_id: 'tenant-page', api_key: 'navi_live_page_key' });

    // A Checkout `success_url` redirect is opened by a browser, so the answer is a
    // document: the page, with the headers that keep a credential out of caches,
    // referrers and frames.
    let response = await fetch(`${base}/v1/billing/success?session_id=cs_page`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    const page = await response.text();
    expect(page).toContain('navi_live_page_key');
    expect(page).toContain('tenant-page');
    // The snippet is escaped for display, so what a customer copies is the tag the
    // browser would have parsed rather than markup injected into the page.
    expect(page).toContain('data-key=&quot;navi_live_page_key&quot;');
    expect(page).toContain(`src=&quot;${base}/v1/loader.js&quot;`);
    expect(page).toContain('Authorization: Bearer navi_live_page_key');
    expect(page).toMatch(/shown once/i);
    expect(page).toContain('noindex');

    // Rendering the page consumed the claim, so a refresh is an error page and the
    // key is nowhere in it.
    response = await fetch(`${base}/v1/billing/success?session_id=cs_page`);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const errorPage = await response.text();
    expect(errorPage).not.toContain('navi_live_page_key');
    expect(errorPage).toMatch(/expired or already been used/i);

    // Missing and non-checkout ids are the same answer, and claim nothing.
    for (const query of ['', '?session_id=', '?session_id=nope']) {
      response = await fetch(`${base}/v1/billing/success${query}`);
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    }

    // A non-GET is a page too, and it claims nothing.
    await host.store.recordCheckoutClaim?.({ session_id: 'cs_post', tenant_id: 'tenant-page', api_key: 'navi_live_post_key' });
    response = await fetch(`${base}/v1/billing/success?session_id=cs_post`, { method: 'POST' });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET');
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await response.text()).not.toContain('navi_live_post_key');
    // ...and the claim it did not touch is still redeemable over JSON.
    response = await fetch(`${base}/v1/billing/session?session_id=cs_post`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, tenant_id: 'tenant-page', api_key: 'navi_live_post_key' });
  } finally {
    await host.close();
  }
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

test('the host infers the commercial plan from the amount billed and an update upgrades that tenant', async () => {
  // The same zero-metadata path the Worker handles, against the real SQLite store:
  // a standard Payment Link carries no plan metadata, so the amount is the plan.
  const storeFile = join(tmpdir(), `navi-billing-tiers-${process.pid}-${Date.now()}.db`);
  const secret = 'whsec_tiers';
  const host = await createNaviHostServer({ port: 0, storeFile, stripeWebhookSecret: secret });
  const base = () => `http://127.0.0.1:${host.port}`;
  /** @param {string} raw */
  const webhook = raw => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
    return fetch(`${base()}/v1/billing/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${timestamp},v1=${signature}` },
      body: raw
    });
  };
  /** @param {string} type @param {string} eventId @param {any} object */
  const send = async (type, eventId, object) => {
    const response = await webhook(JSON.stringify({ id: eventId, type, data: { object } }));
    expect(response.status).toBe(200);
    return response.json();
  };
  try {
    for (const [id, customer, amount, ceiling] of /** @type {[string, string, number, number][]} */ ([
      ['evt_host_starter', 'cus_host_starter', 2900, 10000],
      ['evt_host_pro', 'cus_host_pro', 4900, 50000],
      ['evt_host_enterprise', 'cus_host_enterprise', 19900, 250000],
    ])) {
      const provisioned = await send('checkout.session.completed', id, { id: `cs_${id}`, customer, amount_total: amount });
      expect(provisioned.tenant_id).toBe(`tenant_${customer}`);
      expect(await host.store.readTenantDefinition(`tenant_${customer}`), `$${amount / 100} buys ${ceiling} events`)
        .toMatchObject({ max_events_per_window: ceiling, window_seconds: 2592000 });
    }

    // A subscription upgrade reports its price on the first line item and lands on
    // the tenant the checkout created.
    await send('customer.subscription.updated', 'evt_host_upgrade', {
      id: 'sub_host', customer: 'cus_host_starter', items: { data: [{ price: { unit_amount: 19900 } }] }
    });
    expect(await host.store.readTenantDefinition('tenant_cus_host_starter')).toMatchObject({ max_events_per_window: 250000 });

    // Explicit metadata still wins over the amount.
    await send('checkout.session.completed', 'evt_host_override', {
      id: 'cs_host_override', customer: 'cus_host_override', amount_total: 19900, metadata: { plan: 'starter' }
    });
    expect(await host.store.readTenantDefinition('tenant_cus_host_override')).toMatchObject({ max_events_per_window: 10000 });

    // No amount at all is the documented Pro default.
    await send('checkout.session.completed', 'evt_host_unknown', { id: 'cs_host_unknown', customer: 'cus_host_unknown' });
    expect(await host.store.readTenantDefinition('tenant_cus_host_unknown')).toMatchObject({ max_events_per_window: 50000 });

    // An unmetered plan is stored as no ceiling, not as a zero that would refuse.
    const unmetered = await send('checkout.session.completed', 'evt_host_unmetered', {
      id: 'cs_host_unmetered', customer: 'cus_host_unmetered', metadata: { unmetered: 'true' }
    });
    expect(await host.store.readTenantDefinition('tenant_cus_host_unmetered')).toMatchObject({ max_events_per_window: null });
    const crawl = await fetch(`${base()}/v1/sitemap/update`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${unmetered.api_key}` },
      body: JSON.stringify({ url: 'https://app.example.com/checkout', actions: [{ target_id: '#submit', role: 'button', name: 'Submit', action: 'click', selector: '#submit', disabled: false }] })
    });
    expect(crawl.status, 'an unmetered tenant is not a suspended one').toBe(200);
  } finally {
    await host.close();
  }
});

test('an older host database is rebuilt once so an unmetered ceiling can be stored', async () => {
  // `tenant_definitions.max_events_per_window` shipped NOT NULL, so NULL (the
  // unmetered plan) could not be stored. SQLite cannot drop a constraint in place,
  // and the rebuild that fixes it must keep every row it copies.
  const storeFile = join(tmpdir(), `navi-billing-migrate-${process.pid}-${Date.now()}.db`);
  const { DatabaseSync } = await import('node:sqlite');
  const legacy = new DatabaseSync(storeFile);
  legacy.exec(`CREATE TABLE tenant_definitions (
    tenant_id TEXT PRIMARY KEY,
    api_key TEXT NOT NULL,
    allowed_origins TEXT NOT NULL,
    max_events_per_window INTEGER NOT NULL,
    window_seconds INTEGER NOT NULL,
    status TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  legacy.prepare('INSERT INTO tenant_definitions (tenant_id, api_key, allowed_origins, max_events_per_window, window_seconds, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('tenant-legacy', 'navi_live_legacy', '["*"]', 1234, 600, 'active', new Date().toISOString());
  legacy.close();

  const store = await createStore(storeFile, { mode: 'sqlite' });
  try {
    expect(await store.readTenantDefinition('tenant-legacy'), 'the rebuild must keep the row and its ceiling')
      .toMatchObject({ max_events_per_window: 1234, window_seconds: 600, allowed_origins: ['*'] });
    const unmetered = await store.upsertTenantDefinition({ tenant_id: 'tenant-legacy', api_key: 'navi_live_legacy', max_events_per_window: null });
    expect(unmetered.max_events_per_window).toBeNull();
    expect(await store.readTenantDefinition('tenant-legacy')).toMatchObject({ max_events_per_window: null });
  } finally {
    await store.close();
  }
});
