import { test, expect } from '@playwright/test';
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

/** @param {RequestInfo | URL} input @param {RequestInit} [init] */
function workerRequest(input, init = {}) {
  return worker.fetch(new Request(input, init), { SUPABASE_URL: 'https://supabase.example', SUPABASE_SERVICE_ROLE_KEY: 'server-secret' });
}

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
    expect(calls[0].url).toContain('/sites?api_key=eq.api-key&active=eq.true&select=id,allowed_origins');
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
