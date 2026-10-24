import { test, expect } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { build } from 'esbuild';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import worker from '../src/worker.ts';
import { bundleIntegrity, bundleSource } from '../src/edge-assets/source.js';
import { NaviPlaywrightAdapter } from '../src/adapter.js';
import { createNaviHostServer } from '../server/index.js';
import { LANDING_PAGE_HEADERS } from '../server/landing.js';
import { BILLING_PAGE_HEADERS, renderBillingSuccessPage } from '../server/billing-success.js';

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

/**
 * A stand-in for PostgREST's `/rest/v1/rpc` surface, holding the same contract the
 * schema's three functions implement: a duplicate event id changes nothing, a
 * quota charge is decided against the row, and a claim is consumed once. The SQL
 * itself is executed against a real PostgreSQL cluster in
 * `supabase-schema.spec.mjs`; this exists so the Worker's own status-code mapping is
 * testable without a database, and it is deliberately small rather than clever.
 * @param {{sites?: any[]}} [options]
 */
function fakeSupabase(options = {}) {
  /** @type {Map<string, any>} */
  const sites = new Map((options.sites ?? []).map(site => [site.id, { allowed_origins: ['*'], max_events_per_window: null, window_seconds: null, window_start_ms: null, event_count: 0, active: true, ...site }]));
  /** @type {Set<string>} */
  const events = new Set();
  /** @type {Map<string, {tenant_id: string, api_key: string, expires_at: number}>} */
  const claims = new Map();
  /** The stored maps, keyed `siteId|url`, so a test can see what a call persisted. */
  const maps = new Map();
  /** @type {{url: string, init: RequestInit}[]} */
  const calls = [];
  /** Set to make the webhook function answer 500, which is a transaction that aborted. */
  const failApply = { value: false };
  /** Set to make the ingest's map write fail, which must roll its charge back. */
  const failStorage = { value: false };

  /** @param {any} body */
  const consumeQuota = body => {
    const site = [...sites.values()].find(candidate => candidate.api_key === body.p_api_key && candidate.active !== false);
    if (!site) return { found: false };
    const allowed = site.allowed_origins ?? ['*'];
    const headerRefused = body.p_header_origin !== null && body.p_header_origin !== undefined && !allowed.includes(body.p_header_origin);
    if (!allowed.includes('*') && (!body.p_origin || !allowed.includes(body.p_origin) || headerRefused)) {
      return { found: true, id: site.id, forbidden: true, allowed: false, allowed_origins: allowed };
    }
    // Every effect below is undone if the map write fails, which is what the real
    // function gets from running in one transaction.
    const snapshot = { window_start_ms: site.window_start_ms, event_count: site.event_count };
    let limit = null;
    let remaining = null;
    if (site.max_events_per_window !== null && site.max_events_per_window !== undefined) {
      limit = site.max_events_per_window;
      const windowSeconds = site.window_seconds || 3600;
      const windowMs = windowSeconds * 1000;
      if (limit === 0) return { found: true, id: site.id, forbidden: false, allowed: false, limit: 0, remaining: 0, retry_after_seconds: windowSeconds, allowed_origins: allowed };
      const active = Number.isFinite(site.window_start_ms) && site.window_start_ms > 0 && body.p_now_ms - site.window_start_ms < windowMs;
      const windowStart = active ? site.window_start_ms : body.p_now_ms;
      const consumed = active ? site.event_count : 0;
      if (consumed >= limit) {
        return { found: true, id: site.id, forbidden: false, allowed: false, limit, remaining: 0, retry_after_seconds: Math.max(1, Math.ceil((windowStart + windowMs - body.p_now_ms) / 1000)), allowed_origins: allowed };
      }
      site.window_start_ms = windowStart;
      site.event_count = consumed + 1;
      remaining = Math.max(limit - (consumed + 1), 0);
    }

    if (body.p_url && body.p_payload) {
      if (failStorage.value) {
        site.window_start_ms = snapshot.window_start_ms;
        site.event_count = snapshot.event_count;
        throw new Error('navigation_maps insert failed');
      }
      maps.set(`${site.id}|${body.p_url}`, body.p_payload);
    }

    return { found: true, id: site.id, forbidden: false, allowed: true, limit, remaining, retry_after_seconds: 0, allowed_origins: allowed };
  };

  /** @param {any} body */
  const applyWebhook = body => {
    if (body.p_event_id) {
      if (events.has(body.p_event_id)) return { duplicate: true };
      events.add(body.p_event_id);
    }
    if (!body.p_site_id) return { duplicate: false, ignored: true };
    const existing = sites.get(body.p_site_id);
    if (!existing && !body.p_api_key && !body.p_candidate_api_key) return { duplicate: false, tenant_id: body.p_site_id, missing: true, api_key: null };
    // The candidate is for the insert branch only; an existing row keeps its key
    // unless the event itself names one, exactly as the SQL's `do update` does.
    const site = existing ?? { id: body.p_site_id, api_key: body.p_api_key ?? body.p_candidate_api_key, allowed_origins: ['*'], max_events_per_window: null, window_seconds: null, window_start_ms: null, event_count: 0, active: true };
    if (body.p_api_key) site.api_key = body.p_api_key;
    if (body.p_allowed_origins) site.allowed_origins = body.p_allowed_origins;
    if (body.p_max_events_per_window !== null && body.p_max_events_per_window !== undefined) {
      site.max_events_per_window = body.p_max_events_per_window;
    } else if (body.p_window_seconds !== null && body.p_window_seconds !== undefined) {
      site.max_events_per_window = null;
    }
    if (body.p_window_seconds !== null && body.p_window_seconds !== undefined) site.window_seconds = body.p_window_seconds;
    if (body.p_active !== null && body.p_active !== undefined) site.active = body.p_active;
    sites.set(site.id, site);
    if (body.p_session_id && body.p_claim_expires_at) {
      claims.set(body.p_session_id, { tenant_id: site.id, api_key: site.api_key, expires_at: Date.parse(body.p_claim_expires_at) });
    }
    return { duplicate: false, tenant_id: site.id, api_key: site.api_key };
  };

  /** @param {any} body */
  const claimSession = body => {
    const found = claims.get(body.p_session_id);
    claims.delete(body.p_session_id);
    if (!found || found.expires_at <= Date.now()) return { ok: false };
    return { ok: true, tenant_id: found.tenant_id, api_key: found.api_key };
  };

  /**
   * The compiled-workflow read: the tenant's most recently stored map, or null
   * payload when it has stored nothing. Insertion order in `maps` is write order,
   * which is what the real function's `updated_at desc` selects.
   * @param {any} body
   */
  const readSiteMap = body => {
    const site = [...sites.values()].find(candidate => candidate.api_key === body.p_api_key && candidate.active !== false);
    if (!site) return { found: false };
    const latest = [...maps.entries()].filter(([key]) => key.startsWith(`${site.id}|`)).map(([, payload]) => payload).pop();
    if (!latest) return { found: true, id: site.id, payload: null };
    return { found: true, id: site.id, url: latest.url, payload: latest, updated_at: '2026-10-20T00:00:00.000Z' };
  };

  const handlers = { apply_stripe_webhook: applyWebhook, consume_site_quota: consumeQuota, claim_checkout_session: claimSession, read_site_map: readSiteMap };

  /** @type {typeof fetch} */
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const rpc = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url);
    if (rpc) {
      if (rpc[1] === 'apply_stripe_webhook' && failApply.value) return new Response('transaction aborted', { status: 500 });
      const handler = /** @type {Record<string, (body: any) => any>} */ (handlers)[rpc[1]];
      return Response.json(handler(JSON.parse(String(init.body))));
    }
    if (url.includes('select=id,api_key')) throw new Error(`provisioning must not read the tenant first: ${url}`);
    return new Response(null, { status: 201 });
  };

  return {
    sites,
    events,
    claims,
    maps,
    calls,
    failApply,
    failStorage,
    fetch: fetchImpl,
    /** @param {string} id */
    site: id => sites.get(id)
  };
}

/**
 * A PostgREST surface that answers one staged way, so a deployment-order failure can
 * be exercised without a database.
 * @param {(name: string) => Response} answer
 * @returns {typeof fetch}
 */
function rpcStub(answer) {
  return async input => {
    const name = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input))?.[1] ?? '';
    return answer(name);
  };
}

/**
 * The exact answer PostgREST gives for a function that is not in its schema cache.
 * @param {string} name @returns {Response}
 */
const pgrstMissingFunction = name => Response.json({
  code: 'PGRST202',
  details: 'Search Path: public',
  hint: null,
  message: `Could not find the function public.${name} in the schema cache`
}, { status: 404 });

const SCHEMA_OUT_OF_DATE = { error: 'Database schema out of date: apply deploy/supabase-schema.sql' };

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
  const supabase = fakeSupabase({ sites: [{ id: 'site-1', api_key: 'api-key' }] });
  const calls = supabase.calls;
  globalThis.fetch = supabase.fetch;
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
    // One round trip. The charge, the origin decision and the map write are one
    // statement, so a request cannot be charged and then lose its map to a second
    // call that fails.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/rest/v1/rpc/consume_site_quota');
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      p_api_key: 'api-key',
      p_origin: 'https://shop.example',
      p_header_origin: null,
      p_url: validPayload.url
    });
    expect(supabase.maps.has(`site-1|${validPayload.url}`)).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Worker sitemap endpoint enforces per-tenant allowed_origins with HTTP 403 and accepts matching or wildcard origins with HTTP 200', async () => {
  const originalFetch = globalThis.fetch;
  const supabase = fakeSupabase({ sites: [{ id: 'site-1', api_key: 'api-key', allowed_origins: ['https://app.example.com'] }] });
  const site = supabase.site('site-1');
  if (!site) throw new Error('fixture site missing');
  globalThis.fetch = supabase.fetch;
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
    site.allowed_origins = ['*'];
    response = await workerRequest(endpoint, { method: 'POST', headers, body: JSON.stringify(validPayload) });
    expect(response.status).toBe(200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Worker sitemap endpoint meters a site against max_events_per_window, persists the window and rolls it over', async () => {
  const originalFetch = globalThis.fetch;
  const supabase = fakeSupabase({ sites: [{ id: 'site-1', api_key: 'api-key', max_events_per_window: 2, window_seconds: 60, window_start_ms: Date.now(), event_count: 1 }] });
  const site = supabase.site('site-1');
  if (!site) throw new Error('fixture site missing');
  const calls = supabase.calls;
  globalThis.fetch = supabase.fetch;
  try {
    const headers = { Authorization: 'Bearer api-key' };
    // One event of a ceiling of two: the charge happens inside the function, under
    // a row lock, so the isolate holds no counter it could lose to another one.
    let response = await workerRequest(endpoint, { method: 'POST', headers, body: JSON.stringify(validPayload) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, url: validPayload.url, targets: 1 });
    expect(calls.filter(entry => entry.url.includes('/rpc/consume_site_quota'))).toHaveLength(1);
    expect(site.event_count).toBe(2);

    // The ceiling is now reached: the next event is refused before the map write,
    // and the refusal carries the window the database is holding the site in.
    calls.length = 0;
    response = await workerRequest(endpoint, { method: 'POST', headers, body: JSON.stringify(validPayload) });
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: 'Quota exceeded' });
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(Number(response.headers.get('retry-after'))).toBeLessThanOrEqual(60);
    expect(response.headers.get('x-quota-limit')).toBe('2');
    expect(response.headers.get('x-quota-remaining')).toBe('0');
    // The refusal is the only request: no second call was made to store anything.
    expect(calls).toHaveLength(1);

    // The window has expired: the next accepted event opens a fresh one at 1 rather
    // than carrying the exhausted count across the boundary.
    const expiredStart = Date.now() - 120_000;
    site.window_start_ms = expiredStart;
    site.event_count = 2;
    calls.length = 0;
    response = await workerRequest(endpoint, { method: 'POST', headers, body: JSON.stringify(validPayload) });
    expect(response.status).toBe(200);
    expect(site.event_count).toBe(1);
    expect(site.window_start_ms).toBeGreaterThan(expiredStart);
    expect(supabase.maps.has(`site-1|${validPayload.url}`)).toBe(true);

    // An unmetered site (no ceiling at all) still ingests, and the function leaves
    // its window untouched because there is nothing to charge.
    site.max_events_per_window = null;
    site.event_count = 0;
    calls.length = 0;
    response = await workerRequest(endpoint, { method: 'POST', headers, body: JSON.stringify(validPayload) });
    expect(response.status).toBe(200);
    expect(site.event_count).toBe(0);
    // Unmetered still stores: the map write is not conditioned on a ceiling.
    expect(supabase.maps.has(`site-1|${validPayload.url}`)).toBe(true);

    // A ceiling of exactly 0 is how a revoked subscription is stored: it is a
    // suspension, not an absence of metering, and it refuses before the map write.
    site.max_events_per_window = 0;
    calls.length = 0;
    response = await workerRequest(endpoint, { method: 'POST', headers, body: JSON.stringify(validPayload) });
    expect(response.status).toBe(429);
    expect(response.headers.get('x-quota-limit')).toBe('0');
    expect(response.headers.get('x-quota-remaining')).toBe('0');
    expect(calls).toHaveLength(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Worker fails the ingest when the map write aborts and does not keep the charge', async () => {
  const originalFetch = globalThis.fetch;
  const supabase = fakeSupabase({ sites: [{ id: 'site-1', api_key: 'api-key', max_events_per_window: 5, window_seconds: 60, window_start_ms: Date.now(), event_count: 1 }] });
  const site = supabase.site('site-1');
  if (!site) throw new Error('fixture site missing');
  globalThis.fetch = supabase.fetch;
  try {
    const headers = { Authorization: 'Bearer api-key' };
    supabase.failStorage.value = true;
    let response = await workerRequest(endpoint, { method: 'POST', headers, body: JSON.stringify(validPayload) });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
    expect(site.event_count, 'a failed map write must not leave the event charged').toBe(1);
    expect(supabase.maps.size).toBe(0);

    // The same request succeeds once storage recovers, so nothing is left wedged.
    supabase.failStorage.value = false;
    response = await workerRequest(endpoint, { method: 'POST', headers, body: JSON.stringify(validPayload) });
    expect(response.status).toBe(200);
    expect(site.event_count).toBe(2);
    expect(supabase.maps.has(`site-1|${validPayload.url}`)).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Worker renders the one-time onboarding page and refuses a second visit', async () => {
  const originalFetch = globalThis.fetch;
  const supabase = fakeSupabase();
  supabase.claims.set('cs_page', { tenant_id: 'acme', api_key: 'navi_live_page', expires_at: Date.now() + 900_000 });
  globalThis.fetch = supabase.fetch;
  const pageUrl = 'https://worker.example/v1/billing/success?session_id=cs_page';
  try {
    const page = await workerRequest(pageUrl);
    expect(page.status).toBe(200);
    // A browser renders this, so the answer is a document with the headers that keep
    // a credential out of caches, referrers and frames.
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    const body = await page.text();
    expect(body).toContain('navi_live_page');
    expect(body).toContain('acme');
    // The snippet is escaped for display, so what the customer copies is the tag the
    // browser would have parsed rather than markup injected into the page.
    expect(body).toContain('data-key=&quot;navi_live_page&quot;');
    expect(body).toContain('https://worker.example/v1/loader.js');
    expect(body).toContain('This basic snippet does not enable Subresource Integrity');
    expect(body).not.toContain('data-sri=&quot;sha384-…&quot;');
    expect(body).toContain('Authorization: Bearer navi_live_page');
    expect(body).toContain('type="radio" name="onboard-tab"');
    expect(body).toContain('1 · Embed Browser Loader');
    expect(body).toContain('2 · Call Hosted Edge API');
    expect(body).toContain('3 · CLI &amp; MCP Env');
    expect(body).toMatch(/shown once/i);
    expect(body).toContain('noindex');

    // The claim is consumed by rendering it, so a refresh is an error page that
    // never repeats the key.
    const again = await workerRequest(pageUrl);
    expect(again.status).toBe(404);
    expect(again.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(again.headers.get('cache-control')).toBe('no-store');
    const errorBody = await again.text();
    expect(errorBody).not.toContain('navi_live_page');
    expect(errorBody).toMatch(/expired or already been used/i);

    // Nothing is claimed for a value that cannot be a Checkout Session id.
    for (const query of ['', '?session_id=', '?session_id=nope']) {
      const response = await workerRequest(`https://worker.example/v1/billing/success${query}`);
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    }

    // A browser opens this with GET; anything else is a page too, not JSON.
    const post = await workerRequest(pageUrl, { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET');
    expect(post.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await post.text()).not.toContain('navi_live_page');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the edge root serves the landing page and /healthz, and unknown paths stay 404', async () => {
  // The deployed Worker answered its own root with `404 {"error":"Not found"}`, which
  // told a visiting developer nothing about the service or the API. These are the
  // three surfaces that fix it: the document, the liveness probe, and the 404 that
  // has to survive for everything else.
  const root = await workerRequest('https://worker.example/');
  expect(root.status).toBe(200);
  expect(root.headers.get('content-type')).toBe('text/html; charset=utf-8');
  // `img-src 'self'` is the one image source the page needs: its own favicon. The
  // icon is blocked under a bare `default-src 'none'`, so the policy names it rather
  // than dropping the icon.
  expect(root.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src 'self'");
  expect(root.headers.get('x-content-type-options')).toBe('nosniff');
  expect(root.headers.get('x-frame-options')).toBe('DENY');
  expect(root.headers.get('referrer-policy')).toBe('no-referrer');
  expect(root.headers.get('cache-control')).toBe('no-store');
  const body = await root.text();
  expect(body).toContain('npm i --save-dev navi-interaction-bridge playwright');
  // The embed snippet is escaped for display, so what a developer copies is the tag
  // the browser would have parsed.
  expect(body).toContain('data-key=&quot;navi_live_YOUR_KEY&quot;');
  expect(body).toContain('https://worker.example/v1/loader.js');
  expect(body).toContain('https://worker.example/v1/sitemap/update');
  for (const path of ['/v1/loader.js', '/v1/navi.js', '/v1/sitemap/update', '/v1/billing/webhook', '/v1/billing/session', '/v1/billing/success', '/healthz']) {
    expect(body, `the endpoint table must list ${path}`).toContain(path);
  }
  // The public snippet does not claim SRI verification without supplying the bundle hash.
  expect(body).toContain('&lt;script src=&quot;https://worker.example/v1/loader.js&quot;');
  expect(body).not.toContain('sha384-…');
  // No Payment Link is configured here: the page shows all four plans so a visitor
  // can compare them, without subscription links. The free quickstart is always available.
  expect(body).toContain('No hosted API key or payment is needed');
  expect(body).not.toContain('Subscribe');
  for (const tier of ['Community', 'Starter', 'Pro', 'Enterprise']) {
    expect(body, `the pricing grid must name ${tier}`).toContain(`<h3>${tier}</h3>`);
  }
  for (const price of ['$0', '$29', '$49', '$199']) expect(body).toContain(price);
  expect(body).toContain('10,000 quota units / 30 days');
  expect(body).toContain('50,000 quota units / 30 days');
  expect(body).toContain('250,000 quota units / 30 days');
  // Hosted bundle serves and accepted sitemap writes share one enforced ceiling.
  expect(body).toContain('Each authorized browser-bundle serve');
  expect(body).toContain('each accepted sitemap write consumes one quota unit');
  expect(body).toContain('no automatic overage billing is applied');
  expect(body).toContain('The quota is shared by those two operations');
  expect(body).toContain('Each bundle request uses one unit from the shared hosted quota');
  // Backup behavior is explicit and does not overstate persistence as protection.
  expect(body).toContain('Navi does not create backups or guarantee replication or point-in-time recovery');
  // The promo and explanation sections give a visitor the protocol numbers, the
  // before/after DOM comparison, the animated SVG data-flow pipeline, the pure-CSS
  // 3-tab integration guide, the 3-step self-serve billing flow, and the FAQ.
  for (const item of [
    '5.9 kB gzip',
    '14,929 B',
    '689 B',
    'Browser suite',
    '10 paired trials',
    'Without Navi · Raw DOM scraping',
    'With Navi · Deterministic protocol',
    '<svg class="pipeline-svg"',
    'type="radio" name="integration-tab"',
    '1 · Browser Script Loader',
    '2 · Edge API (POST /v1/sitemap/update)',
    '3 · Local MCP Server',
    'Step 1 · Stripe Checkout',
    'Step 2 · /v1/billing/webhook',
    'Step 3 · /v1/billing/success',
    'How self-serve provisioning works',
    'Navi does not create backups or guarantee replication or point-in-time recovery',
    'Replace <code>YOUR_BUILD_HASH</code> with the exact SHA-384 from the build output',
    'The self-hosted',
    'Commercial license',
    'Operational FAQ',
    // The 3D stage: camera presets, depth toggles, the tilt sensor, and the four
    // targets the receipt inspector can pin.
    'transform-style: preserve-3d',
    'perspective: 1200px',
    'type="radio" name="camera-view"',
    'type="checkbox" id="toggle-explode"',
    'type="checkbox" id="toggle-xray"',
    'Isometric Exploded',
    'Front UI Surface',
    'Agent Matrix Overhead',
    'type="radio" name="inspect-node"',
    // The hero and stage are each a pure-CSS state machine: a radio per plane the
    // hero can isolate, a radio per Z plane the stage can solo, and one checkbox
    // that simulates a deploy mutating the page underneath the agent.
    'type="radio" name="hero-plane"',
    'hero-plane-3',
    '#hero-plane-2:checked ~ .hero-scene .slab-2',
    'type="radio" name="stage-plane"',
    '#plane-focus-3:checked ~ .stage-viewport .plane-3',
    'type="checkbox" id="toggle-ui-drift"',
    '#toggle-ui-drift:checked ~ .inspector .inspect-drift',
    'resolveTarget',
    'confidence',
    'x-navi-risk-level',
    'act_pay_01',
    'act_shadow_02',
    'act_pii_03',
    'act_pager_04',
    'navi_execute_action({ target_id: "act_pay_01", action_type: "click",',
    'translateZ(70px)',
    'translateZ(140px)',
    'Check the result against your workflow',
    '1,025.7',
    '2,890.2',
    '1.968 s',
    '1.772 s',
    'No LLM planner was used.',
    'Illustrative map entry and tool input',

  ]) {
    expect(body, `landing page must include promo/explanation content "${item}"`).toContain(item);
  }
  expect(body.indexOf('id="start"')).toBeLessThan(body.indexOf('id="pricing"'));
  for (const unsupported of ['sha384 receipt', 'cryptographic settlement receipt', 'The loader\'s generated bundle must pass its SHA-384 integrity check', 'Navi backs up your data', 'automatic backups', 'point-in-time recovery included', '~650 tokens', 'Most popular', 'Save $3,991.50']) {
    expect(body).not.toContain(unsupported);
  }
  // Every interaction is form state: a document that shipped a script would be
  // blocked by its own policy, so the assertion is that none exists at all.
  expect(body, 'the landing page must carry no script element').not.toContain('<script');
  // Single <h1>, hierarchical <h2>/<h3> sections, meta description, canonical URL, and Open Graph tags.
  expect(body.match(/<h1\b/g) ?? []).toHaveLength(1);
  expect((body.match(/<h2\b/g) ?? []).length).toBeGreaterThanOrEqual(8);
  expect((body.match(/<h3\b/g) ?? []).length).toBeGreaterThanOrEqual(8);
  expect(body).not.toContain('sha384-…');
  expect(body).toContain('<meta name="description" content="Navi is the AI browser agent SDK and Model Context Protocol (MCP) browser bridge turning live DOM and closed Shadow DOM into structured JSON action maps for browser workflow builders.">');
  expect(body).toContain('<link rel="canonical" href="https://navi-edge.sysctl.workers.dev/">');
  expect(body).toContain('<meta property="og:title" content="Navi — AI Browser Agent SDK &amp; Deterministic MCP Bridge">');
  expect(body).toContain('<meta property="og:description"');
  expect(body).toContain('<meta property="og:type" content="website">');
  expect(body).toContain('<meta property="og:url" content="https://navi-edge.sysctl.workers.dev/">');
  expect(body).toContain('<meta property="og:image" content="https://navi-edge.sysctl.workers.dev/logo.svg">');
  expect(body).toContain('<meta name="twitter:card" content="summary_large_image">');
  expect(body).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg">');
  expect(body).toContain('<span class="brand-mark" aria-hidden="true"><svg');
  // The only script-shaped text is the escaped embed snippet a developer copies.
  expect(body).toContain('&lt;script src=&quot;https://worker.example/v1/loader.js&quot;');
  // The stage's selectors actually drive the scene rather than merely naming it.
  expect(body).toContain('#cam-front:checked ~ .stage-viewport .stage-3d');
  expect(body).toContain('#toggle-explode:checked ~ .stage-viewport .stage-3d');
  expect(body).toContain(':has(.pad-9:is(:hover, :active)) .stage-tilt');
  expect(body).toContain('@media (prefers-reduced-motion: reduce)');

  // Each tier's own Payment Link becomes that card's call to action. The legacy
  // `STRIPE_PAYMENT_LINK_URL` is still the Pro link, so a deployment that only ever
  // set it keeps the Pro call to action it had.
  const baseEnv = { SUPABASE_URL: 'https://supabase.example', SUPABASE_SERVICE_ROLE_KEY: 'server-secret' };
  const configuredEnv = {
    ...baseEnv,
    STRIPE_PAYMENT_LINK_STARTER: 'https://buy.stripe.com/test_starter',
    STRIPE_PAYMENT_LINK_URL: 'https://buy.stripe.com/test_abc123',
    STRIPE_PAYMENT_LINK_ENTERPRISE: 'https://buy.stripe.com/test_enterprise',
  };
  const configured = await workerRequest('https://worker.example/', {}, configuredEnv);
  expect(configured.status).toBe(200);
  const configuredBody = await configured.text();
  expect(configuredBody).toContain('href="https://buy.stripe.com/test_starter"');
  expect(configuredBody).toContain('href="https://buy.stripe.com/test_abc123"');
  expect(configuredBody).toContain('href="https://buy.stripe.com/test_enterprise"');
  expect(configuredBody.match(/Subscribe &rarr;/g) ?? []).toHaveLength(3);
  expect(configuredBody).toContain('No hosted API key or payment is needed');

  // A partial configuration shows only the cards it can actually sell.
  const starterOnly = await workerRequest('https://worker.example/', {}, { ...baseEnv, STRIPE_PAYMENT_LINK_STARTER: 'https://buy.stripe.com/test_starter' });
  const starterBody = await starterOnly.text();
  expect(starterBody.match(/Subscribe &rarr;/g) ?? []).toHaveLength(1);
  expect(starterBody).not.toContain('href="https://buy.stripe.com/test_abc123"');

  const proOnly = await workerRequest('https://worker.example/', {}, { ...baseEnv, STRIPE_PAYMENT_LINK_PRO: 'https://buy.stripe.com/test_pro' });
  const proBody = await proOnly.text();
  expect(proBody).toContain('href="https://buy.stripe.com/test_pro"');
  expect(proBody.match(/Subscribe &rarr;/g) ?? []).toHaveLength(1);

  // Anything that is not an absolute https URL is configuration the page refuses to
  // publish, so a typo or an injected scheme degrades to the quickstart.
  for (const paymentLink of ['javascript:alert(1)', 'http://buy.stripe.com/test_abc123', 'not a url', '']) {
    const fallback = await workerRequest('https://worker.example/', {}, { ...baseEnv, STRIPE_PAYMENT_LINK_URL: paymentLink });
    const fallbackBody = await fallback.text();
    expect(fallbackBody, `STRIPE_PAYMENT_LINK_URL=${paymentLink} must not be rendered`).not.toContain('href="javascript:');
    expect(fallbackBody).not.toContain('Subscribe');
    expect(fallbackBody).toContain('No hosted API key or payment is needed');
  }

  // The URL parser normalizes the characters that would close the attribute, so a
  // configured value cannot become markup even though it is operator input.
  const hostile = await workerRequest('https://worker.example/', {}, {
    ...baseEnv,
    STRIPE_PAYMENT_LINK_URL: 'https://buy.stripe.com/x"><script>',
  });
  expect(await hostile.text()).not.toContain('"><script>');

  const health = await workerRequest('https://worker.example/healthz');
  expect(health.status).toBe(200);
  expect(health.headers.get('cache-control')).toBe('no-store');
  expect(await health.json()).toEqual({ ok: true, service: 'navi-edge' });

  const notGet = await workerRequest('https://worker.example/healthz', { method: 'POST' });
  expect(notGet.status).toBe(405);
  expect(notGet.headers.get('allow')).toBe('GET');

  // Search Console proves ownership by fetching the exact file it issued, without
  // a credential, so the response has to be the token byte for byte.
  const verification = await workerRequest('https://worker.example/google4456f053766efe68.html');
  expect(verification.status).toBe(200);
  expect(verification.headers.get('content-type')).toBe('text/html; charset=utf-8');
  expect(verification.headers.get('cache-control')).toBe('no-store');
  expect(await verification.text()).toBe('google-site-verification: google4456f053766efe68.html');
  const verificationPost = await workerRequest('https://worker.example/google4456f053766efe68.html', { method: 'POST' });
  expect(verificationPost.status).toBe(405);
  expect(verificationPost.headers.get('allow')).toBe('GET, HEAD');

  // Crawlability surfaces: GET /robots.txt (200 text/plain) and GET /sitemap.xml (200 application/xml).
  const robots = await workerRequest('https://worker.example/robots.txt');
  expect(robots.status).toBe(200);
  expect(robots.headers.get('content-type')).toBe('text/plain; charset=utf-8');
  const robotsText = await robots.text();
  expect(robotsText).toContain('Allow: /');
  expect(robotsText).toContain('Disallow: /v1/billing/');
  expect(robotsText).toContain('Sitemap: https://navi-edge.sysctl.workers.dev/sitemap.xml');
  const robotsPost = await workerRequest('https://worker.example/robots.txt', { method: 'POST' });
  expect(robotsPost.status).toBe(405);

  const sitemap = await workerRequest('https://worker.example/sitemap.xml');
  expect(sitemap.status).toBe(200);
  expect(sitemap.headers.get('content-type')).toBe('application/xml; charset=utf-8');
  expect(await sitemap.text()).toContain('<loc>https://navi-edge.sysctl.workers.dev/</loc>');
  const sitemapPost = await workerRequest('https://worker.example/sitemap.xml', { method: 'POST' });
  expect(sitemapPost.status).toBe(405);

  for (const iconPath of ['/favicon.svg', '/logo.svg']) {
    const icon = await workerRequest(`https://worker.example${iconPath}`);
    expect(icon.status).toBe(200);
    expect(icon.headers.get('content-type')).toBe('image/svg+xml; charset=utf-8');
    expect(icon.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(await icon.text()).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    const iconPost = await workerRequest(`https://worker.example${iconPath}`, { method: 'POST' });
    expect(iconPost.status).toBe(405);
  }

  for (const path of ['/unknown', '/v1/unknown']) {
    const missing = await workerRequest(`https://worker.example${path}`);
    expect(missing.status, `${path} must stay a 404`).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Not found' });
  }
});

test('the edge serves the quickstart loader and charges every bundle serve from hosted-site quota', async () => {
  // The landing page told a customer to embed `/v1/loader.js` on a Worker that
  // answered 404 for it, so a paying tenant's snippet fetched nothing and the metered
  // path was unreachable. This drives the real routes end to end: the loader is
  // anonymous, the bundle is keyed and charged, and a suspended tenant gets bytes
  // from neither.
  const originalFetch = globalThis.fetch;
  const supabase = fakeSupabase({ sites: [{ id: 'site-1', api_key: 'navi_live_edge', max_events_per_window: 2, window_seconds: 60 }] });
  const site = supabase.site('site-1');
  if (!site) throw new Error('fixture site missing');
  globalThis.fetch = supabase.fetch;
  const bundleUrl = 'https://worker.example/v1/navi.js?key=navi_live_edge';
  try {
    const loader = await workerRequest('https://worker.example/v1/loader.js');
    expect(loader.status).toBe(200);
    expect(loader.headers.get('access-control-allow-origin')).toBe('*');
    expect(loader.headers.get('cache-control')).toContain('public');
    // The snippet is the real 689-byte loader: it resolves the bundle beside itself
    // and appends the key from its own tag.
    expect(await loader.text()).toContain('/v1/navi.js');
    expect(site.event_count, 'the loader carries no key, so it cannot consume the window').toBe(0);

    // No key: refused before the database is asked anything.
    const anonymous = await workerRequest('https://worker.example/v1/navi.js');
    expect(anonymous.status).toBe(401);
    expect(site.event_count).toBe(0);

    const first = await workerRequest(bundleUrl, { headers: { origin: 'https://shop.example' } });
    expect(first.status).toBe(200);
    expect(first.headers.get('etag')).toBe(`"${bundleIntegrity}"`);
    expect(first.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
    expect(first.headers.get('x-quota-remaining')).toBe('1');
    // The bytes served are the bytes the build measured and hashed, not a copy.
    expect(await first.text()).toBe(bundleSource);
    expect(site.event_count, 'one bundle serve consumes one hosted-site quota unit').toBe(1);

    // A revalidation is still a quota unit: the page is using the SDK even though the
    // bytes come from its own cache.
    const revalidated = await workerRequest(bundleUrl, { headers: { origin: 'https://shop.example', 'if-none-match': `"${bundleIntegrity}"` } });
    expect(revalidated.status).toBe(304);
    expect(await revalidated.text()).toBe('');
    expect(site.event_count).toBe(2);

    // The ceiling is spent: the third load is refused and, crucially, no bytes are
    // served, so a suspended tenant cannot obtain the runtime at all.
    const over = await workerRequest(bundleUrl, { headers: { origin: 'https://shop.example' } });
    expect(over.status).toBe(429);
    expect(over.headers.get('x-quota-limit')).toBe('2');
    expect(await over.text()).not.toContain('Navi');
    expect(site.event_count).toBe(2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Worker billing webhook verifies the Stripe signature, provisions a site and suspends it on cancellation', async () => {
  const originalFetch = globalThis.fetch;
  const supabase = fakeSupabase();
  const calls = supabase.calls;
  globalThis.fetch = supabase.fetch;
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
    // One call, not two: the tenant row, its minted key and the checkout claim commit
    // in one statement, so a key handed to a page always belongs to a tenant that exists.
    const apply = calls.find(call => call.url.includes('/rpc/apply_stripe_webhook'));
    expect(apply?.init.method).toBe('POST');
    expect(calls.filter(call => call.url.includes('/rest/v1/sites')), 'a new tenant needs no read first').toHaveLength(0);
    const applyBody = JSON.parse(String(apply?.init.body));
    expect(applyBody).toMatchObject({
      p_event_id: 'evt_1',
      p_site_id: 'acme',
      p_api_key: null,
      p_allowed_origins: ['https://app.example.com', 'https://admin.example.com'],
      p_max_events_per_window: 50,
      p_window_seconds: 600,
      p_active: true,
      p_session_id: 'cs_test'
    });
    // The minted key travels as the candidate, so the function can insert it without
    // a second request, and the row's key is what the response reports.
    expect(applyBody.p_candidate_api_key).toMatch(/^navi_live_[0-9a-f]{64}$/);
    expect(applyBody.p_candidate_api_key).toBe(provisioned.api_key);
    // The claim is 15 minutes out, and it is written by the same statement as the
    // tenant, so a handed-out key always belongs to a site that exists.
    const claimTtl = Date.parse(applyBody.p_claim_expires_at) - Date.now();
    expect(claimTtl).toBeGreaterThan(840_000);
    expect(claimTtl).toBeLessThanOrEqual(900_000);
    expect(supabase.sites.size).toBe(1);

    // Self-serve post-checkout claim: first GET /v1/billing/session?session_id=cs_test
    // returns 200 with Cache-Control: no-store and the provisioned api_key; second returns 404.
    const firstClaim = await workerRequest('https://worker.example/v1/billing/session?session_id=cs_test', { method: 'GET' }, workerEnv);
    expect(firstClaim.status).toBe(200);
    expect(firstClaim.headers.get('cache-control')).toContain('no-store');
    expect(await firstClaim.json()).toEqual({ ok: true, tenant_id: 'acme', api_key: provisioned.api_key });

    const secondClaim = await workerRequest('https://worker.example/v1/billing/session?session_id=cs_test', { method: 'GET' }, workerEnv);
    expect(secondClaim.status).toBe(404);
    expect(await secondClaim.json()).toEqual({ error: 'Session not found or already claimed' });

    const missingClaim = await workerRequest('https://worker.example/v1/billing/session', { method: 'GET' }, workerEnv);
    expect(missingClaim.status).toBe(404);
    expect(await missingClaim.json()).toEqual({ error: 'Session not found or already claimed' });

    // Stripe resends a delivery it did not see acknowledged. The same event id is
    // answered as a duplicate and must not upsert the site a second time.
    calls.length = 0;
    response = await billingRequest(checkout);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, duplicate: true });
    expect(calls.filter(call => call.url.includes('/rpc/apply_stripe_webhook'))).toHaveLength(1);
    expect(supabase.sites.size, 'a duplicate must not create a second tenant').toBe(1);

    // A delivery that failed is one Stripe will resend. Because the claim and the
    // tenant write are one transaction, the failure rolled the claim back: there is
    // nothing to withdraw, and the retry is processed rather than swallowed.
    supabase.failApply.value = true;
    const retry = JSON.stringify({ id: 'evt_retry', type: 'checkout.session.completed', data: { object: { id: 'cs_retry', client_reference_id: 'acme', metadata: {} } } });
    calls.length = 0;
    response = await billingRequest(retry);
    expect(response.status).toBe(500);
    expect(supabase.events.has('evt_retry'), 'a rolled-back delivery must not leave its event id claimed').toBe(false);
    expect(calls.some(call => call.url.includes('/rest/v1/webhook_events')), 'no separate ledger request remains to withdraw').toBe(false);
    supabase.failApply.value = false;
    response = await billingRequest(retry);
    expect(response.status, 'the resend must be processed, not treated as a duplicate').toBe(200);
    expect((await response.json()).ok).toBe(true);

    // An update that carries no api_key keeps the credential already embedded. It is
    // one call: the candidate the Worker generates is refused by the `do update`, so
    // nothing has to be read back to know the key survived.
    const update = JSON.stringify({ type: 'customer.subscription.updated', data: { object: { id: 'sub_1', metadata: { tenant_id: 'acme', max_events_per_window: '75' } } } });
    calls.length = 0;
    response = await billingRequest(update);
    expect(response.status).toBe(200);
    expect((await response.json()).api_key).toBe(provisioned.api_key);
    const updateCall = calls.find(call => call.url.includes('/rpc/apply_stripe_webhook'));
    expect(calls, 'provisioning is one request, in both directions').toHaveLength(1);
    expect(JSON.parse(String(updateCall?.init.body))).toMatchObject({ p_site_id: 'acme', p_api_key: null, p_allowed_origins: null });
    expect(supabase.site('acme')?.api_key).toBe(provisioned.api_key);
    expect(supabase.site('acme')?.allowed_origins, 'omitting allowed_origins on an update must keep the tenant origin allow-list').toEqual([
      'https://app.example.com',
      'https://admin.example.com'
    ]);

    // A delivery the function refuses is a 500 with no compensating write, and the
    // credential is untouched: there is no fall-through path left to mint from.
    supabase.failApply.value = true;
    calls.length = 0;
    response = await billingRequest(update.replace('sub_1', 'sub_2'));
    expect(response.status).toBe(500);
    expect(calls).toHaveLength(1);
    expect(supabase.site('acme')?.api_key).toBe(provisioned.api_key);
    supabase.failApply.value = false;

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
    const cancellation = JSON.stringify({ id: 'evt_suspend', type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', metadata: { tenant_id: 'acme' } } } });
    calls.length = 0;
    response = await billingRequest(cancellation);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, tenant_id: 'acme', status: 'suspended' });
    // The cancellation carries no key and no origin list: the function preserves
    // both and only zeroes the ceiling, so the embedded credential keeps working.
    const suspension = JSON.parse(String(calls.find(call => call.url.includes('/rpc/apply_stripe_webhook'))?.init.body));
    expect(suspension).toMatchObject({ p_event_id: 'evt_suspend', p_site_id: 'acme', p_api_key: null, p_allowed_origins: null, p_max_events_per_window: 0 });
    expect(supabase.site('acme')?.api_key).toBe(provisioned.api_key);
    expect(supabase.site('acme')?.max_events_per_window).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a standard Payment Link provisions from the customer, and its cancellation suspends that same tenant', async () => {
  // A Payment Link buyer never passes through an integration, so `metadata.tenant_id`
  // and `client_reference_id` are both unset. Stripe still sends `customer`, and the
  // cancellation that arrives later carries the same `cus_...` and nothing else. If
  // the two resolve differently, the sale provisions one tenant while the cancellation
  // answers 400 against another, and the subscription stays live forever.
  const originalFetch = globalThis.fetch;
  const supabase = fakeSupabase();
  globalThis.fetch = supabase.fetch;
  try {
    const checkout = JSON.stringify({
      id: 'evt_link',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_link', customer: 'cus_test_link', metadata: {} } }
    });
    let response = await billingRequest(checkout);
    expect(response.status).toBe(200);
    const provisioned = await response.json();
    // No metadata and no reference: the customer is the only identifier, so it is
    // what the tenant is derived from.
    expect(provisioned.tenant_id).toBe('tenant_cus_test_link');
    expect(provisioned.api_key).toMatch(/^navi_live_[0-9a-f]{64}$/);

    // The claim is keyed by the session, so a Payment Link's success URL still
    // renders the key once even though nothing in the session named a tenant.
    const page = await workerRequest('https://worker.example/v1/billing/success?session_id=cs_test_link');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const body = await page.text();
    expect(body).toContain(provisioned.api_key);
    expect(body).toContain('tenant_cus_test_link');

    // The minted key is real: it authenticates the ingest path it was sold for.
    const headers = { Authorization: `Bearer ${provisioned.api_key}` };
    response = await workerRequest(endpoint, { method: 'POST', headers, body: JSON.stringify(validPayload) });
    expect(response.status).toBe(200);

    // A subscription event names the customer and no metadata. It must update the
    // tenant the checkout created rather than mint a second one from `sub_...`.
    const update = JSON.stringify({ id: 'evt_link_update', type: 'customer.subscription.updated', data: { object: { id: 'sub_link', customer: 'cus_test_link' } } });
    response = await billingRequest(update);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, tenant_id: 'tenant_cus_test_link' });

    const cancellation = JSON.stringify({ id: 'evt_link_cancel', type: 'customer.subscription.deleted', data: { object: { id: 'sub_link', customer: 'cus_test_link' } } });
    response = await billingRequest(cancellation);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, tenant_id: 'tenant_cus_test_link', status: 'suspended' });
    expect([...supabase.sites.keys()], 'the purchase and its cancellation must name one tenant').toEqual(['tenant_cus_test_link']);

    // Suspension is a quota answer, not an authentication one: the key stays valid
    // and the ingest is a deterministic 429.
    expect(supabase.site('tenant_cus_test_link')?.max_events_per_window).toBe(0);
    response = await workerRequest(endpoint, { method: 'POST', headers, body: JSON.stringify(validPayload) });
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: 'Quota exceeded' });

    // The four fields are consulted in order: metadata, then the reference, then the
    // customer, then the session id on the completed checkout only.
    const priority = [
      [{ id: 'cs_priority_1', customer: 'cus_low', client_reference_id: 'ref_wins', metadata: { tenant_id: 'meta_wins' } }, 'meta_wins'],
      [{ id: 'cs_priority_2', customer: 'cus_low', client_reference_id: 'ref_wins', metadata: {} }, 'ref_wins'],
      [{ id: 'cs_priority_3', customer: 'cus_low', metadata: {} }, 'tenant_cus_low'],
      [{ id: 'cs_priority_4', metadata: {} }, 'tenant_cs_priority_4'],
    ];
    for (const [index, [object, tenantId]] of priority.entries()) {
      const event = JSON.stringify({ id: `evt_priority_${index}`, type: 'checkout.session.completed', data: { object } });
      response = await billingRequest(event);
      expect(response.status).toBe(200);
      expect((await response.json()).tenant_id, `priority level ${index + 1}`).toBe(tenantId);
    }

    // The session id is not a customer: a subscription event that carries only `id`
    // has no tenant to name, so it is a caller error rather than a new tenant.
    const orphan = JSON.stringify({ id: 'evt_orphan', type: 'customer.subscription.updated', data: { object: { id: 'sub_orphan' } } });
    response = await billingRequest(orphan);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Missing tenant_id' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Worker infers the commercial plan from the amount billed when a Payment Link carries no metadata', async () => {
  // Stripe's Payment Link editor has no metadata field, so a standard link arrives
  // with `metadata: {}`. The amount is then the only plan signal: inferring it here
  // is what makes a $49 purchase a Pro tenant without an integration step.
  const originalFetch = globalThis.fetch;
  const supabase = fakeSupabase();
  globalThis.fetch = supabase.fetch;
  /** @param {string} id @param {string} eventId @param {any} object */
  const send = async (id, eventId, object) => {
    const body = JSON.stringify({ id: eventId, type: id, data: { object } });
    const response = await billingRequest(body);
    expect(response.status).toBe(200);
    return response.json();
  };
  try {
    // The three price points, each on its own customer and with nothing else to go on.
    for (const [id, customer, amount, ceiling] of /** @type {[string, string, number, number][]} */ ([
      ['evt_tier_starter', 'cus_tier_starter', 2900, 10000],
      ['evt_tier_pro', 'cus_tier_pro', 4900, 50000],
      ['evt_tier_enterprise', 'cus_tier_enterprise', 19900, 250000],
    ])) {
      const provisioned = await send('checkout.session.completed', id, { id: `cs_${id}`, customer, amount_total: amount });
      expect(provisioned.tenant_id).toBe(`tenant_${customer}`);
      expect(supabase.site(`tenant_${customer}`)?.max_events_per_window, `$${amount / 100} buys ${ceiling} events`).toBe(ceiling);
      expect(supabase.site(`tenant_${customer}`)?.window_seconds).toBe(2592000);
    }

    // A subscription sends its price on the first line item, and an update upgrades
    // the tenant the purchase created rather than minting a second one.
    await send('customer.subscription.updated', 'evt_tier_upgrade', {
      id: 'sub_tier_starter', customer: 'cus_tier_starter', items: { data: [{ price: { unit_amount: 19900 } }] }
    });
    expect(supabase.site('tenant_cus_tier_starter')?.max_events_per_window).toBe(250000);

    // Explicit metadata still wins over the amount: the same $199 charge named as
    // the Starter plan is metered as Starter.
    await send('checkout.session.completed', 'evt_tier_override', {
      id: 'cs_tier_override', customer: 'cus_tier_override', amount_total: 19900, metadata: { tier: 'starter' }
    });
    expect(supabase.site('tenant_cus_tier_override')?.max_events_per_window).toBe(10000);

    // An amount this deployment cannot see is the documented Pro default, not an
    // unmetered sale.
    await send('checkout.session.completed', 'evt_tier_unknown', { id: 'cs_tier_unknown', customer: 'cus_tier_unknown', metadata: {} });
    expect(supabase.site('tenant_cus_tier_unknown')?.max_events_per_window).toBe(50000);

    // And an explicit unmetered purchase or subscription upgrade carries no ceiling at all.
    await send('checkout.session.completed', 'evt_tier_unmetered', {
      id: 'cs_tier_unmetered', customer: 'cus_tier_unmetered', metadata: { unmetered: 'true' }
    });
    expect(supabase.site('tenant_cus_tier_unmetered')?.max_events_per_window).toBeNull();
    await send('customer.subscription.updated', 'evt_tier_upgrade_unmetered', {
      id: 'sub_tier_pro', customer: 'cus_tier_pro', metadata: { unmetered: 'true' }
    });
    expect(supabase.site('tenant_cus_tier_pro')?.max_events_per_window).toBeNull();
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

test('Worker answers an unapplied or older Supabase schema with a self-diagnosing 503', async () => {
  const originalFetch = globalThis.fetch;
  try {
    // 1. Unapplied schema: PostgREST has no consume_site_quota to resolve, so the
    //    sitemap call is a 404 PGRST202 and must not read as a generic server fault.
    globalThis.fetch = rpcStub(name => pgrstMissingFunction(name));
    let response = await workerRequest(endpoint, { method: 'POST', headers: { Authorization: 'Bearer key' }, body: JSON.stringify(validPayload) });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(SCHEMA_OUT_OF_DATE);

    // 2. The same deployment gap on the webhook, which calls apply_stripe_webhook.
    const checkout = JSON.stringify({ id: 'evt_schema', type: 'checkout.session.completed', data: { object: { id: 'cs_schema', client_reference_id: 'acme' } } });
    response = await billingRequest(checkout);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(SCHEMA_OUT_OF_DATE);

    // 3. Legacy nine-argument signature: the function resolves, but the insert branch
    //    has no candidate key parameter, so it answers without api_key. That is an
    //    outdated schema, and a 200 with a key that authenticates nothing is the one
    //    answer that must never be returned.
    globalThis.fetch = rpcStub(name => name === 'apply_stripe_webhook'
      ? Response.json({ duplicate: false, tenant_id: 'acme', missing: true, api_key: null })
      : pgrstMissingFunction(name));
    response = await billingRequest(checkout);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(SCHEMA_OUT_OF_DATE);

    // 4. The claim routes share the contract: a claim that exists always carries both
    //    fields, so a bare { ok: true } is the database, not a used link.
    globalThis.fetch = rpcStub(() => Response.json({ ok: true }));
    response = await workerRequest('https://worker.example/v1/billing/session?session_id=cs_schema');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(SCHEMA_OUT_OF_DATE);

    // The onboarding page is opened by a browser, so its diagnostic keeps the page
    // shape while naming the same missing migration.
    response = await workerRequest('https://worker.example/v1/billing/success?session_id=cs_schema');
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const page = await response.text();
    expect(page).toContain('Database schema out of date');
    expect(page).toContain('deploy/supabase-schema.sql');
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

test('the edge compiles a stored sitemap into OpenAPI 3.1 workflows, and names the missing migration when it cannot', async () => {
  const originalFetch = globalThis.fetch;
  const supabase = fakeSupabase({ sites: [{ id: 'site-1', api_key: 'api-key' }] });
  globalThis.fetch = supabase.fetch;
  const openapiEndpoint = 'https://worker.example/v1/sitemap/openapi.json';
  try {
    // A provisioned tenant that has not crawled a page yet is a 404 that names the
    // ingest route, not an authentication failure: the key itself is valid.
    let response = await workerRequest(openapiEndpoint, { headers: { Authorization: 'Bearer api-key' } });
    expect(response.status).toBe(404);
    expect((await response.json()).error).toContain('/v1/sitemap/update');

    response = await workerRequest(openapiEndpoint);
    expect(response.status).toBe(401);
    response = await workerRequest(openapiEndpoint, { headers: { Authorization: 'Bearer not-a-key' } });
    expect(response.status).toBe(401);
    response = await workerRequest(openapiEndpoint, { method: 'POST', headers: { Authorization: 'Bearer api-key' } });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET');

    const sitemap = {
      url: 'https://shop.example/account',
      actions: [
        { target_id: 't0', role: 'textbox', name: 'Email', action: 'type', selector: '#login > input:nth-of-type(1)', input_type: 'email', required: true, disabled: false },
        { target_id: 't1', role: 'button', name: 'Sign in', action: 'click', selector: '#login > button:nth-of-type(1)', disabled: false },
        { target_id: 't2', role: 'button', name: 'Delete account', action: 'click', selector: '#danger > button:nth-of-type(1)', disabled: false }
      ]
    };
    response = await workerRequest(endpoint, { method: 'POST', headers: { Authorization: 'Bearer api-key' }, body: JSON.stringify(sitemap) });
    expect(response.status).toBe(200);

    response = await workerRequest(openapiEndpoint, { headers: { Authorization: 'Bearer api-key' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const doc = await response.json();
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.servers[0].url).toBe('https://worker.example');
    expect(doc['x-navi']).toMatchObject({
      tenant_id: 'site-1',
      source_url: sitemap.url,
      source_indexed_at: '2026-10-20T00:00:00.000Z',
      workflow_count: 2
    });
    expect(Object.keys(doc.paths).sort()).toEqual(['/workflows/login', '/workflows/submit_form']);
    const login = doc.paths['/workflows/login'].post;
    expect(login['x-navi-risk-level']).toBe('write');
    expect(login.requestBody.content['application/json'].schema.required).toEqual(['email']);
    expect(doc.paths['/workflows/submit_form'].post['x-navi-risk-level']).toBe('destructive');

    // The credential travels in the RPC body, never a query string a proxy or an
    // access log would keep. Three lookups: the missing map, the unknown key (the
    // database is what decides a key is unknown) and the compiled read.
    const reads = supabase.calls.filter(call => call.url.includes('/rpc/read_site_map'));
    expect(reads).toHaveLength(3);
    expect(JSON.parse(String(reads[0].init.body))).toEqual({ p_api_key: 'api-key' });
    expect(JSON.parse(String(reads[1].init.body))).toEqual({ p_api_key: 'not-a-key' });
    for (const read of reads) expect(String(read.url)).not.toContain('api-key');
  } finally {
    globalThis.fetch = originalFetch;
  }

  // A database older than this Worker is the one answer that must name its fix.
  globalThis.fetch = rpcStub(() => pgrstMissingFunction('read_site_map'));
  try {
    const response = await workerRequest(openapiEndpoint, { headers: { Authorization: 'Bearer api-key' } });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(SCHEMA_OUT_OF_DATE);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the 3D surfaces reflow without sideways scroll and change state from the keyboard', async ({ page }) => {
  // The reference rule is the document-level one the design skills state: at every
  // required width `scrollWidth <= clientWidth`. It is asserted in a real browser
  // because the 3D stage is exactly the kind of transform-scaled scene that looks
  // fine in source and pushes a label past the right edge at 320px.
  //
  // Both documents are served from a routed origin rather than `setContent`, so the
  // CSP header each page ships with is applied to the navigation. `default-src
  // 'none'` would otherwise be untested by the layout assertions that follow.
  const origin = 'http://localhost';
  const landingHtml = await (await workerRequest(`${origin}/`)).text();
  const billingHtml = renderBillingSuccessPage({
    tenant_id: 'tenant-viewport',
    api_key: 'navi_live_viewport_key',
    loader_url: `${origin}/v1/navi.js`
  });
  /** @type {string[]} */
  const errors = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', error => errors.push(String(error)));
  const icon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><path d="M0 0h8v8H0z"/></svg>';
  await page.route(`${origin}/**`, route => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/') return route.fulfill({ status: 200, headers: LANDING_PAGE_HEADERS, body: landingHtml });
    if (pathname === '/v1/billing/success') return route.fulfill({ status: 200, headers: BILLING_PAGE_HEADERS, body: billingHtml });
    if (pathname.endsWith('.svg')) return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: icon });
    return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
  });

  /** Tab until the element with this id has focus. @param {string} id @returns {Promise<boolean>} */
  const tabTo = async id => {
    for (let press = 0; press < 40; press += 1) {
      await page.keyboard.press('Tab');
      if (await page.evaluate(() => document.activeElement?.id) === id) return true;
    }
    return false;
  };
  /** @param {string} selector @returns {Promise<{outlineStyle: string, outlineWidth: string, outlineColor: string}>} */
  const outlineOf = selector => page.evaluate(css => {
    const style = getComputedStyle(/** @type {Element} */ (document.querySelector(css)));
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, outlineColor: style.outlineColor };
  }, selector);

  const viewports = [
    { width: 320, height: 568 },
    { width: 375, height: 812 },
    { width: 768, height: 1024 },
    { width: 1024, height: 768 },
    { width: 1440, height: 900 }
  ];
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    for (const path of ['/', '/v1/billing/success']) {
      await page.goto(origin + path);
      const measured = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        // No visually-hidden control may be `display: none`, which would take it out
        // of the tab order and leave the label it drives unreachable.
        hidden: [...document.querySelectorAll('input[type=radio], input[type=checkbox]')].map(candidate => {
          const input = /** @type {HTMLInputElement} */ (candidate);
          return {
            id: input.id,
            display: getComputedStyle(input).display,
            tabbable: input.tabIndex >= 0 && !input.disabled,
            clip: getComputedStyle(input).clipPath
          };
        }),
        // Every metric, byte budget and receipt figure is set in tabular figures so
        // a number does not shift width when it changes.
        untabbed: [...document.querySelectorAll('.stat-value, .slab-meta, .inspect-json, .hud, .vault-telemetry, .tier-price')]
          .filter(node => getComputedStyle(node).fontVariantNumeric !== 'tabular-nums').length
      }));
      expect(measured.scrollWidth, `${path} at ${viewport.width}px must not scroll sideways`).toBeLessThanOrEqual(measured.clientWidth);
      for (const input of measured.hidden) {
        expect(input.display, `${path} ${input.id} must not use display:none`).not.toBe('none');
        expect(input.tabbable, `${path} ${input.id} must stay in the tab order`).toBe(true);
        expect(input.clip, `${path} ${input.id} must be visually hidden, not removed`).toContain('inset(50%)');
      }
      expect(measured.untabbed, `${path} at ${viewport.width}px must use tabular figures`).toBe(0);
    }
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(origin + '/');

  // Hero: Tab to the checked plane, confirm the label draws a focus ring, then move
  // the selection with ArrowRight. The sculpture has to actually change, not merely
  // report a new radio value.
  expect(await tabTo('hero-plane-all'), 'the hero radio group must be reachable by Tab').toBe(true);
  const heroRing = await outlineOf('label[for="hero-plane-all"]');
  expect(heroRing).toMatchObject({ outlineStyle: 'solid', outlineWidth: '2px', outlineColor: 'rgb(255, 214, 0)' });
  const slabBefore = await page.evaluate(() => getComputedStyle(/** @type {Element} */ (document.querySelector('.slab-2'))).opacity);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#hero-plane-1')).toBeChecked();
  await page.waitForTimeout(350);
  expect(Number(await page.evaluate(() => getComputedStyle(/** @type {Element} */ (document.querySelector('.slab-2'))).opacity)), 'isolating plane 01 must dim the mesh plane').toBeLessThan(Number(slabBefore));

  // Stage: the camera preset and the drift simulation are keyboard state machines.
  expect(await tabTo('cam-iso'), 'the camera presets must be reachable by Tab').toBe(true);
  const cameraRing = await outlineOf('label[for="cam-iso"]');
  expect(cameraRing).toMatchObject({ outlineStyle: 'solid', outlineWidth: '2px' });
  const transformBefore = await page.evaluate(() => getComputedStyle(/** @type {Element} */ (document.querySelector('.stage-3d'))).transform);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#cam-front')).toBeChecked();
  await page.waitForTimeout(350);
  expect(await page.evaluate(() => getComputedStyle(/** @type {Element} */ (document.querySelector('.stage-3d'))).transform)).not.toBe(transformBefore);

  expect(await tabTo('toggle-ui-drift'), 'the drift simulation must be reachable by Tab').toBe(true);
  await page.keyboard.press('Space');
  await expect(page.locator('#toggle-ui-drift')).toBeChecked();
  await page.waitForTimeout(350);
  expect(await page.evaluate(() => getComputedStyle(/** @type {Element} */ (document.querySelector('.wire-cta'))).borderColor)).toBe('rgb(183, 241, 113)');
  expect(await page.evaluate(() => getComputedStyle(/** @type {Element} */ (document.querySelector('.inspect-drift'))).display)).toBe('block');

  // Billing: the fourth integration tab and the vault's inspection modes are the
  // same kind of radio state, and they must work without a pointer.
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${origin}/v1/billing/success`);
  expect(await tabTo('vault-view-iso'), 'the vault modes must be reachable by Tab').toBe(true);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#vault-view-flat')).toBeChecked();
  await page.waitForTimeout(350);
  expect(await page.evaluate(() => getComputedStyle(/** @type {Element} */ (document.querySelector('.vault-card'))).transform)).toContain('matrix');

  expect(await tabTo('onboard-loader'), 'the integration tabs must be reachable by Tab').toBe(true);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#onboard-openapi')).toBeChecked();
  await expect(page.locator('#panel-onboard-openapi')).toBeVisible();
  await expect(page.locator('#panel-onboard-openapi')).toContainText('x-navi-risk-level');

  expect(errors, `the CSP must not be violated: ${errors.join(' | ')}`).toEqual([]);
});
