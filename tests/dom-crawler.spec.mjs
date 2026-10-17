import { test, expect } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { build } from 'esbuild';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import worker from '../src/worker.ts';
import { NaviPlaywrightAdapter } from '../src/adapter.js';
import { createNaviHostServer } from '../server/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const endpoint = 'https://worker.example/v1/sitemap/update';
const validPayload = { url: 'https://shop.example/checkout', actions: [{ target_id: '#submit', role: 'button', name: 'Submit', action: 'click', selector: '#submit', disabled: false }] };
let crawlerScript = '';
test.beforeAll(async () => {
  const bundle = await build({ entryPoints: [join(root, 'src/dom-crawler.ts')], bundle: true, write: false, format: 'iife', globalName: 'NaviCrawler', platform: 'browser', target: 'es2022' });
  crawlerScript = bundle.outputFiles[0].text;
});

/** @param {RequestInfo | URL} input @param {RequestInit} [init] @param {Record<string, string>} [env] */
function workerRequest(input, init = {}, env = { SUPABASE_URL: 'https://supabase.example', SUPABASE_SERVICE_ROLE_KEY: 'server-secret' }) {
  return worker.fetch(new Request(input, init), /** @type {any} */ (env));
}

const WEBHOOK_SECRET = 'whsec_worker_test';
const webhookEndpoint = 'https://worker.example/v1/billing/webhook';
const workerEnv = { SUPABASE_URL: 'https://supabase.example', SUPABASE_SERVICE_ROLE_KEY: 'server-secret', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET };
/**
 * Sign a body the way Stripe does: HMAC over `${t}.${body}` with the endpoint secret.
 * @param {string} body @param {number} [timestamp] @param {string} [secret]
 */
const stripeSignature = (body, timestamp = Math.floor(Date.now() / 1000), secret = WEBHOOK_SECRET) =>
  `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
/** @param {string} body @param {string} [signature] @param {Record<string, string>} [env] */
const billingRequest = (body, signature = stripeSignature(body), env = workerEnv) => workerRequest(webhookEndpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(signature ? { 'Stripe-Signature': signature } : {}) },
  body
}, env);

test('DOM crawler maps semantic roles, stable selectors, select options and excludes control values', async ({ page }) => {
  await page.setContent(`<!doctype html><label for="q">Search</label><input id="q" type="search" value="private-current-value"><div role="textbox" aria-label="Notes"></div><div contenteditable="true" aria-label="Editor"></div><a href="/next">Next</a><div role="link" aria-label="Settings"></div><div role="tab" aria-label="Billing"></div><div role="checkbox" aria-label="Agree"></div><div role="switch" aria-label="Enabled"></div><button id="volatile" data-navi-id="navi-stable">Stable</button><select aria-label="Plan"><option value="">Choose one</option><optgroup disabled><option value="hidden">Hidden</option></optgroup><option value="pro">Premium plan</option></select>`);
  await page.addScriptTag({ content: crawlerScript });
  const payload = await page.evaluate(() => /** @type {any} */ (window).NaviCrawler.collectTargets(document));
  /** @param {string} name */
  const byName = name => payload.actions.find((/** @type {{name: string}} */ action) => action.name === name);
  expect(byName('Search')?.action).toBe('type');
  expect(byName('Notes')?.action).toBe('type');
  expect(byName('Editor')?.action).toBe('type');
  expect(byName('Next')).toMatchObject({ role: 'link', action: 'click' });
  expect(byName('Settings')).toMatchObject({ role: 'link', action: 'click' });
  expect(byName('Billing')?.action).toBe('click');
  expect(byName('Agree')?.action).toBe('click');
  expect(byName('Enabled')?.action).toBe('click');
  expect(byName('Stable')?.selector).toBe('[data-navi-id="navi-stable"]');
  expect(byName('Plan')?.options).toEqual(['Choose one=', 'Premium plan=pro']);
  expect(JSON.stringify(payload)).not.toContain('private-current-value');
});

test('adapter discovers and executes with settlement on a page that has no Navi runtime', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent('<button data-testid="go" onclick="window.__clicked = true">Go</button><div role="textbox" contenteditable="true" aria-label="Query">private</div>');

  const pageLike = { url: () => 'https://example.test/', evaluate: (/** @type {any} */ fn, /** @type {any} */ arg) => page.evaluate(fn, arg), mouse: page.mouse, keyboard: page.keyboard };
  const adapter = new NaviPlaywrightAdapter(pageLike);
  const map = await adapter.discover({ viewportOnly: false });
  const button = map.actions.find(action => action.name === 'Go');
  expect(button).toBeTruthy();
  if (!button) throw new Error('Button target not discovered');
  expect(map.actions.find(action => action.name === 'Query')?.suggested_action).toBe('type');
  expect(JSON.stringify(map)).not.toContain('private');
  const clicked = await adapter.execute(button.target_id, 'click', {}, { wait_for: 'mutation_settle', timeout_ms: 1500 });
  expect(clicked.ok).toBe(true);
  expect(clicked.settle?.settled).toBe(true);
  expect(await page.locator('[contenteditable="true"]').textContent()).toBe('private');
  const field = (await adapter.discover({ viewportOnly: false })).actions.find(action => action.role === 'textbox');
  expect(field).toBeTruthy();
  if (!field) throw new Error('Text target not discovered');
  const typed = await adapter.execute(field.target_id, 'type', { text: 'safe text' }, { wait_for: 'mutation_settle', timeout_ms: 1500 });
  expect(typed.ok, JSON.stringify({ typed, target: field, discovered: map.actions })).toBe(true);
  expect(await page.locator('[contenteditable="true"]').textContent()).toBe('safe text');
  await context.close();
});

test('Worker sitemap endpoint enforces route, bearer auth, JSON and schema contracts', async () => {
  const originalFetch = globalThis.fetch;
  /** @type {{url: string, init: RequestInit}[]} */
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    return String(input).includes('/sites?') ? Response.json([{ id: 'site-1' }]) : new Response(null, { status: 201 });
  };
  try {
    let response = await workerRequest('https://worker.example/wrong', { method: 'POST' });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
    response = await workerRequest(endpoint, { method: 'GET' });
    expect(response.status).toBe(404);
    response = await workerRequest(endpoint, { method: 'POST', body: JSON.stringify(validPayload) });
    expect(response.status).toBe(401);
    response = await workerRequest(endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' }, body: '{}' });
    expect(response.status).toBe(401);
    const headers = { Authorization: 'Bearer api-key' };
    response = await workerRequest(endpoint, { method: 'POST', headers, body: '{bad json' });
    expect(response.status).toBe(400);
    response = await workerRequest(endpoint, { method: 'POST', headers, body: JSON.stringify({ ...validPayload, actions: [{ ...validPayload.actions[0], value: 'secret' }] }) });
    expect(response.status).toBe(400);
    response = await workerRequest(endpoint, { method: 'POST', headers, body: JSON.stringify(validPayload) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, url: validPayload.url, targets: 1 });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain('/sites?api_key=eq.api-key&active=eq.true&select=id,allowed_origins,max_events_per_window,window_seconds,window_start_ms,event_count');
    expect(calls[1].url).toContain('/navigation_maps?on_conflict=site_id,url');
    expect(calls[1].init.method).toBe('POST');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Worker sitemap endpoint enforces per-tenant allowed_origins with HTTP 403 and accepts matching or wildcard origins with HTTP 200', async () => {
  const originalFetch = globalThis.fetch;
  /** @type {string[] | undefined} */
  let allowedOrigins = ['https://app.example.com'];
  globalThis.fetch = async input => (String(input).includes('/sites?')
    ? Response.json([{ id: 'site-1', allowed_origins: allowedOrigins }])
    : new Response(null, { status: 201 }));
  try {
    const headers = { Authorization: 'Bearer api-key' };
    // Payload URL outside allowed_origins -> 403
    let response = await workerRequest(endpoint, { method: 'POST', headers, body: JSON.stringify(validPayload) });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Forbidden origin' });

    // Payload URL inside allowed_origins -> 200
    const allowedPayload = { ...validPayload, url: 'https://app.example.com/checkout' };
    response = await workerRequest(endpoint, { method: 'POST', headers, body: JSON.stringify(allowedPayload) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, url: allowedPayload.url, targets: 1 });

    // Mismatched Origin header -> 403
    response = await workerRequest(endpoint, {
      method: 'POST',
      headers: { ...headers, Origin: 'https://evil.example.com' },
      body: JSON.stringify(allowedPayload)
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Forbidden origin' });

    // Wildcard allowed_origins -> 200 for any origin
    allowedOrigins = ['*'];
    response = await workerRequest(endpoint, { method: 'POST', headers, body: JSON.stringify(validPayload) });
    expect(response.status).toBe(200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Worker sitemap endpoint meters a site against max_events_per_window, persists the window and rolls it over', async () => {
  const originalFetch = globalThis.fetch;
  /** @type {{id: string, max_events_per_window: number, window_seconds: number, window_start_ms: number, event_count: number}} */
  const site = { id: 'site-1', max_events_per_window: 2, window_seconds: 60, window_start_ms: Date.now(), event_count: 1 };
  /** @type {{url: string, init: RequestInit}[]} */
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    if (String(input).includes('/sites?')) return Response.json([{ ...site }]);
    return new Response(null, { status: init.method === 'PATCH' ? 204 : 201 });
  };
  /** @param {string} fragment @returns {{url: string, init: RequestInit} | undefined} */
  const call = fragment => calls.find(entry => entry.url.includes(fragment));
  try {
    const headers = { Authorization: 'Bearer api-key' };
    // One event of a ceiling of two: the request is accepted, and the charged
    // state is written back to the site row rather than held in the isolate.
    let response = await workerRequest(endpoint, { method: 'POST', headers, body: JSON.stringify(validPayload) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, url: validPayload.url, targets: 1 });
    const charged = call('/sites?id=eq.site-1');
    expect(charged?.init.method).toBe('PATCH');
    expect(JSON.parse(String(charged?.init.body))).toEqual({ window_start_ms: site.window_start_ms, event_count: 2 });

    // The ceiling is now reached: the next event is refused before the map write.
    site.event_count = 2;
    calls.length = 0;
    response = await workerRequest(endpoint, { method: 'POST', headers, body: JSON.stringify(validPayload) });
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: 'Quota exceeded' });
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(Number(response.headers.get('retry-after'))).toBeLessThanOrEqual(60);
    expect(response.headers.get('x-quota-limit')).toBe('2');
    expect(response.headers.get('x-quota-remaining')).toBe('0');
    expect(call('/navigation_maps')).toBeUndefined();
    expect(call('/sites?id=eq.site-1')).toBeUndefined();

    // The window has expired: the next accepted event opens a fresh one at 1 rather
    // than carrying the exhausted count across the boundary.
    const expiredStart = Date.now() - 120_000;
    site.window_start_ms = expiredStart;
    site.event_count = 2;
    calls.length = 0;
    response = await workerRequest(endpoint, { method: 'POST', headers, body: JSON.stringify(validPayload) });
    expect(response.status).toBe(200);
    const rolled = JSON.parse(String(call('/sites?id=eq.site-1')?.init.body));
    expect(rolled.event_count).toBe(1);
    expect(rolled.window_start_ms).toBeGreaterThan(expiredStart);
    expect(call('/navigation_maps')?.init.method).toBe('POST');

    // An unmetered site (no ceiling at all) still ingests without a quota write.
    site.max_events_per_window = null;
    calls.length = 0;
    response = await workerRequest(endpoint, { method: 'POST', headers, body: JSON.stringify(validPayload) });
    expect(response.status).toBe(200);
    expect(call('/sites?id=eq.site-1')).toBeUndefined();

    // A ceiling of exactly 0 is how a revoked subscription is stored: it is a
    // suspension, not an absence of metering, and it refuses before the map write.
    site.max_events_per_window = 0;
    calls.length = 0;
    response = await workerRequest(endpoint, { method: 'POST', headers, body: JSON.stringify(validPayload) });
    expect(response.status).toBe(429);
    expect(response.headers.get('x-quota-limit')).toBe('0');
    expect(response.headers.get('x-quota-remaining')).toBe('0');
    expect(call('/navigation_maps')).toBeUndefined();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Worker billing webhook verifies the Stripe signature, provisions a site and suspends it on cancellation', async () => {
  const originalFetch = globalThis.fetch;
  /** @type {{url: string, init: RequestInit}[]} */
  const calls = [];
  /** @type {string} */
  let existingApiKey = '';
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    if (String(input).includes('select=id,api_key')) return Response.json(existingApiKey ? [{ id: 'acme', api_key: existingApiKey }] : []);
    if (String(input).includes('on_conflict=id')) return Response.json([{ id: 'acme' }], { status: 201 });
    if (String(input).includes('/sites?id=eq.')) return new Response(null, { status: 204 });
    return new Response(null, { status: 201 });
  };
  const checkout = JSON.stringify({
    id: 'evt_1',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_test', client_reference_id: 'acme', metadata: {
      allowed_origins: 'https://app.example.com|https://admin.example.com',
      max_events_per_window: '50',
      window_seconds: '600'
    } } }
  });
  try {
    // Without a secret the route refuses before it trusts any body.
    let response = await billingRequest(checkout, undefined, { SUPABASE_URL: 'https://supabase.example', SUPABASE_SERVICE_ROLE_KEY: 'server-secret' });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Billing webhook not configured' });

    response = await workerRequest(webhookEndpoint, { method: 'POST', body: checkout }, workerEnv);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Invalid signature' });

    response = await billingRequest(checkout, stripeSignature(checkout, undefined, 'whsec_wrong'));
    expect(response.status).toBe(401);

    // A signature over different bytes than the body that arrived.
    response = await billingRequest(checkout.replace('acme', 'acme-other'), stripeSignature(checkout));
    expect(response.status).toBe(401);

    // Outside the 300-second replay window, in either direction.
    const now = Math.floor(Date.now() / 1000);
    for (const skew of [-301, 301]) {
      response = await billingRequest(checkout, stripeSignature(checkout, now + skew));
      expect(response.status, `a ${skew}s skew must be refused`).toBe(401);
      expect(await response.json()).toEqual({ error: 'Invalid signature' });
    }

    // A valid signature provisions the site and returns the minted key once.
    response = await billingRequest(checkout);
    expect(response.status).toBe(200);
    const provisioned = await response.json();
    expect(provisioned.ok).toBe(true);
    expect(provisioned.tenant_id).toBe('acme');
    expect(provisioned.api_key).toMatch(/^navi_live_[0-9a-f]{64}$/);
    const upsert = calls.find(call => call.url.includes('on_conflict=id'));
    expect(upsert?.init.method).toBe('POST');
    expect(String(/** @type {any} */ (upsert?.init.headers).Prefer)).toContain('resolution=merge-duplicates,return=representation');
    expect(JSON.parse(String(upsert?.init.body))).toEqual({
      id: 'acme',
      api_key: provisioned.api_key,
      allowed_origins: ['https://app.example.com', 'https://admin.example.com'],
      max_events_per_window: 50,
      window_seconds: 600,
      active: true
    });

    // An update that carries no api_key keeps the credential already embedded.
    existingApiKey = provisioned.api_key;
    const update = JSON.stringify({ type: 'customer.subscription.updated', data: { object: { id: 'sub_1', metadata: { tenant_id: 'acme', max_events_per_window: '75' } } } });
    response = await billingRequest(update);
    expect(response.status).toBe(200);
    expect((await response.json()).api_key).toBe(provisioned.api_key);

    // A handled event with no tenant anywhere in it is a caller error, not a 200.
    const missing = JSON.stringify({ type: 'checkout.session.completed', data: { object: { metadata: {} } } });
    response = await billingRequest(missing);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Missing tenant_id' });

    const ignored = JSON.stringify({ type: 'invoice.paid', data: { object: {} } });
    response = await billingRequest(ignored);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ignored: true });

    // Cancellation zeroes the ceiling instead of deleting the row, so ingestion is
    // a deterministic 429 rather than a 401 the tenant would read as a bad key.
    const cancellation = JSON.stringify({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', metadata: { tenant_id: 'acme' } } } });
    calls.length = 0;
    response = await billingRequest(cancellation);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, tenant_id: 'acme', status: 'suspended' });
    const patch = calls.find(call => call.url.includes('/sites?id=eq.acme'));
    expect(patch?.init.method).toBe('PATCH');
    expect(JSON.parse(String(patch?.init.body))).toEqual({ max_events_per_window: 0 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Worker returns a clean 500 without leaking upstream errors', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('server-secret stack trace'); };
  try {
    const response = await workerRequest(endpoint, { method: 'POST', headers: { Authorization: 'Bearer key' }, body: JSON.stringify(validPayload) });
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: 'Internal server error' });
    expect(text).not.toContain('server-secret');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('native host sitemap endpoint mirrors the Worker contract and persists by tenant and URL', async () => {
  const host = await createNaviHostServer({ port: 0, storeFile: join(tmpdir(), `navi-sitemap-${process.pid}-${Date.now()}.db`), tenants: new Map([['api-key', 'site-1']]) });
  const base = `http://127.0.0.1:${host.port}/v1/sitemap/update`;
  try {
    let response = await fetch(`${base}/other`, { method: 'POST' });
    expect(response.status).toBe(404);
    response = await fetch(base, { method: 'GET' });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
    response = await fetch(base, { method: 'POST', body: JSON.stringify(validPayload) });
    expect(response.status).toBe(401);
    response = await fetch(base, { method: 'POST', headers: { Authorization: 'Bearer wrong' }, body: '{}' });
    expect(response.status).toBe(401);
    const headers = { Authorization: 'Bearer api-key' };
    response = await fetch(base, { method: 'POST', headers, body: '{bad json' });
    expect(response.status).toBe(400);
    response = await fetch(base, { method: 'POST', headers, body: JSON.stringify({ ...validPayload, actions: [{ ...validPayload.actions[0], value: 'private' }] }) });
    expect(response.status).toBe(400);
    response = await fetch(base, { method: 'POST', headers, body: JSON.stringify(validPayload) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, url: validPayload.url, targets: 1 });
    expect(await host.store.readNavigationMap('site-1', validPayload.url)).toMatchObject({ site_id: 'site-1', payload: validPayload });
    expect(await host.store.readNavigationMap('site-2', validPayload.url)).toBeNull();
  } finally {
    await host.close();
  }
});

test('native host hides sitemap store errors from callers', async () => {
  const host = await createNaviHostServer({ port: 0, storeFile: join(tmpdir(), `navi-sitemap-error-${process.pid}-${Date.now()}.db`), tenants: new Map([['api-key', 'site-1']]) });
  host.store.upsertNavigationMap = async () => { throw new Error('sqlite secret and stack'); };
  try {
    const response = await fetch(`http://127.0.0.1:${host.port}/v1/sitemap/update`, { method: 'POST', headers: { Authorization: 'Bearer api-key' }, body: JSON.stringify(validPayload) });
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: 'Internal server error' });
    expect(text).not.toContain('sqlite secret');
  } finally {
    await host.close();
  }
});

test('native host sitemap endpoint enforces allowed_origins (HTTP 403 / 200) and persistent SQLite quota metering (HTTP 429)', async () => {
  const storeFile = join(tmpdir(), `navi-sitemap-monetization-${process.pid}-${Date.now()}.db`);
  const tenants = new Map([
    ['key-restricted', { id: 'site-restricted', allowed_origins: ['https://app.example.com'], max_events_per_window: 2, window_seconds: 120 }],
    ['key-wildcard', { id: 'site-wildcard', allowed_origins: ['*'] }]
  ]);
  const host = await createNaviHostServer({ port: 0, storeFile, tenants });
  const base = `http://127.0.0.1:${host.port}/v1/sitemap/update`;
  try {
    // Disallowed origin -> 403 (does not consume quota)
    let response = await fetch(base, {
      method: 'POST',
      headers: { Authorization: 'Bearer key-restricted' },
      body: JSON.stringify(validPayload)
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Forbidden origin' });

    // Disallowed Origin header -> 403
    const allowedPayload = { ...validPayload, url: 'https://app.example.com/dashboard' };
    response = await fetch(base, {
      method: 'POST',
      headers: { Authorization: 'Bearer key-restricted', Origin: 'https://spoof.example.com' },
      body: JSON.stringify(allowedPayload)
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Forbidden origin' });

    // Wildcard tenant accepts any origin -> 200
    response = await fetch(base, {
      method: 'POST',
      headers: { Authorization: 'Bearer key-wildcard' },
      body: JSON.stringify(validPayload)
    });
    expect(response.status).toBe(200);

    // Allowed origin within quota -> 200 (events 1 and 2)
    for (let i = 0; i < 2; i += 1) {
      response = await fetch(base, {
        method: 'POST',
        headers: { Authorization: 'Bearer key-restricted', Origin: 'https://app.example.com' },
        body: JSON.stringify(allowedPayload)
      });
      expect(response.status).toBe(200);
    }

    // 3rd request exceeds max_events_per_window: 2 -> 429 with Retry-After
    response = await fetch(base, {
      method: 'POST',
      headers: { Authorization: 'Bearer key-restricted' },
      body: JSON.stringify(allowedPayload)
    });
    expect(response.status).toBe(429);
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(await response.json()).toEqual({ error: 'Quota exceeded' });
  } finally {
    await host.close();
  }
});
