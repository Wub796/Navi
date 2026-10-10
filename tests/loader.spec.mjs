import { test, expect } from '@playwright/test';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createNaviHostServer } from '../server/index.js';
import { DEV_TENANT_KEY } from '../server/tenants.js';

/**
 * Tenant loader checks, driven through the real distribution path.
 *
 * The page is served from its own loopback origin while both the loader and the
 * bundle come from the host service, so the browser performs a genuine
 * cross-origin, CORS-mode, integrity-verified script fetch: the exact embed a
 * tenant ships. The origin has to be loopback rather than a fabricated hostname,
 * because Chromium's Private Network Access policy refuses a request from a
 * non-local origin to a loopback address, which would fail the fetch before any
 * of this could be observed. Nothing here calls the loader's internals: the
 * assertions read the DOM and `window.Navi` the way the tenant's own code would.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const loaderPath = join(root, 'dist', 'loader.min.js');
const sdkPath = join(root, 'dist', 'navi.min.js');

/** @type {{host: any, fixture: import('node:http').Server | null, pageBase: string, base: string, sri: string, sdk: Buffer, html: string}} */
const state = { host: null, fixture: null, pageBase: '', base: '', sri: '', sdk: Buffer.alloc(0), html: '' };

test.beforeAll(async () => {
  state.sdk = await readFile(sdkPath);
  state.sri = (await readFile(join(root, 'dist', 'sri.txt'), 'utf8')).trim();
  state.host = await createNaviHostServer({ port: 0, storeFile: join(tmpdir(), `navi-loader-${process.pid}-${Date.now()}.db`) });
  state.base = `http://127.0.0.1:${state.host.port}`;
  state.fixture = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(state.html);
  });
  await new Promise(/** @param {(value?: void) => void} resolve */ resolve => state.fixture?.listen(0, '127.0.0.1', () => resolve()));
  const address = state.fixture?.address();
  state.pageBase = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

test.afterAll(async () => {
  await state.host?.close();
  await new Promise(/** @param {(value?: void) => void} resolve */ resolve => state.fixture?.close(() => resolve()) ?? resolve());
});

/** Publish one fixture document, then open it. @param {any} page @param {string} html */
async function serveFixture(page, html) {
  state.html = html;
  await page.goto(`${state.pageBase}/`);
}

/**
 * The tenant embed, with the early calls written *above* the SDK on purpose:
 * they are exactly what the stub has to defer. The rejection branch records the
 * failure so a refused key is observable instead of a hung promise.
 * @param {string} dataKey
 */
const fixture = dataKey => `<!doctype html>
<html lang="en">
<head>
  <title>Navi loader lab</title>
  <script src="${state.base}/v1/loader.js" data-key="${dataKey}" data-sri="${state.sri}"></script>
  <script>
    window.__stubVersion = window.Navi.version;
    window.__calls = window.Navi.actions({ limit: 20 }).then(
      map => map.actions.map(action => action.target_id),
      () => 'rejected'
    );
    window.__ready = window.Navi.ready().then(() => window.Navi.version, () => 'rejected');
  </script>
</head>
<body><button data-agent-target="probe">Probe</button></body>
</html>`;

test('the loader injects the tenant bundle with integrity and replays early calls', async ({ page }) => {
  const size = (await stat(loaderPath)).size;
  expect(size, 'the shipped snippet must stay under 700 bytes').toBeLessThan(700);

  /** @type {Error[]} */
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error));
  await serveFixture(page, fixture(DEV_TENANT_KEY));

  // The injected tag carries the published hash and the CORS attribute, and asks
  // for the tenant key.
  await page.waitForFunction(() => Boolean(document.querySelector('script[src*="/v1/navi.js"]')));
  const injected = await page.evaluate(() => {
    const element = /** @type {HTMLScriptElement} */ (document.querySelector('script[src*="/v1/navi.js"]'));
    return { src: element.src, integrity: element.integrity, crossOrigin: element.crossOrigin, async: element.async };
  });
  expect(injected.src).toBe(`${state.base}/v1/navi.js?key=${DEV_TENANT_KEY}`);
  expect(injected.integrity).toBe(state.sri);
  expect(injected.crossOrigin).toBe('anonymous');
  expect(injected.async, 'the bundle must not block the tenant page').toBe(true);

  // The stub advertised itself, then the real SDK replaced it after the browser
  // verified the bytes against the published hash.
  await page.waitForFunction(() => /** @type {any} */ (window).Navi?.version === '0.3.0');
  expect(await page.evaluate(() => /** @type {any} */ (window).__stubVersion)).toBe('0.0.0');
  expect(await page.evaluate(() => /** @type {any} */ (window).__ready)).toBe('0.3.0');
  expect(await page.evaluate(() => /** @type {any} */ (window).__calls)).toContain('probe');

  // The loader also publishes the machine-readable marker agents auto-discover on.
  // `data-version` is read from the SDK that actually executed, so it is the
  // protocol the page is running and not a second literal that could drift.
  const marker = await page.evaluate(() => {
    const element = /** @type {HTMLMetaElement | null} */ (document.querySelector('meta[name="agent-bridge"]'));
    return element ? { name: element.name, content: element.getAttribute('content'), version: element.getAttribute('data-version') } : null;
  });
  expect(marker).toEqual({ name: 'agent-bridge', content: 'active', version: '0.3.0' });

  // The same endpoint fetched the way the bundle was: cross-origin and CORS-mode.
  // The fetch can only resolve at all because the host answered with
  // Access-Control-Allow-Origin; the header itself is deliberately not asserted
  // here, because it is not a CORS-safelisted response header and script cannot
  // read it back. The raw header contract is asserted below from the driver.
  const fetched = await page.evaluate(async (/** @type {string} */ url) => {
    const response = await fetch(url, { mode: 'cors' });
    return { ok: response.ok, type: response.type, bytes: (await response.arrayBuffer()).byteLength };
  }, `${state.base}/v1/navi.js?key=${DEV_TENANT_KEY}`);
  expect(fetched.type).toBe('cors');
  expect(fetched.ok).toBe(true);
  expect(fetched.bytes).toBe(state.sdk.length);

  // The wire contract a CDN or proxy has to reproduce, read from the driver where
  // no CORS filtering applies: the wildcard origin and the SRI ETag.
  const raw = await fetch(`${state.base}/v1/navi.js?key=${DEV_TENANT_KEY}`, { headers: { Origin: 'http://127.0.0.1:1' } });
  expect(raw.headers.get('access-control-allow-origin')).toBe('*');
  expect(raw.headers.get('etag')).toBe(`"${state.sri}"`);
  const rawLoader = await fetch(`${state.base}/v1/loader.js`);
  expect(rawLoader.headers.get('access-control-allow-origin')).toBe('*');
  expect(pageErrors, `the tenant page must run without errors: ${pageErrors.map(error => error.message).join('; ')}`).toEqual([]);
});

test('a refused tenant key rejects the queued calls instead of leaving them pending', async ({ page }) => {
  await serveFixture(page, fixture('not-a-tenant-key'));
  await page.waitForFunction(() => /** @type {any} */ (window).__calls !== undefined);
  // Each promise is awaited on its own: a promise nested inside a returned
  // object is not what Playwright resolves, it serializes it as `{}`.
  expect(await page.evaluate(() => /** @type {any} */ (window).__calls)).toBe('rejected');
  expect(await page.evaluate(() => /** @type {any} */ (window).__ready)).toBe('rejected');
  // The host answered 401, so the script never executed and the stub remains. The
  // marker is still injected, with no version: it claims instrumentation the loader
  // could not complete, which is exactly the case `navi_navigate` answers by reading
  // the host's manifest (or reporting MANIFEST_UNREACHABLE) rather than trusting it.
  expect(await page.evaluate(() => /** @type {any} */ (window).Navi.version)).toBe('0.0.0');
  expect(await page.evaluate(() => document.querySelector('meta[name="agent-bridge"]')?.getAttribute('data-version'))).toBe('');
});

test('the loader leaves an already-installed SDK alone', async ({ page }) => {
  const html = `<!doctype html>
<html lang="en">
<head>
  <title>Navi loader lab · preinstalled</title>
  <script src="${state.base}/v1/navi.js?key=${DEV_TENANT_KEY}"></script>
  <script src="${state.base}/v1/loader.js" data-key="${DEV_TENANT_KEY}" data-sri="${state.sri}"></script>
</head>
<body><button data-agent-target="probe">Probe</button></body>
</html>`;
  await serveFixture(page, html);
  await page.waitForFunction(() => /** @type {any} */ (window).Navi?.version === '0.3.0');
  const tags = await page.evaluate(() => document.querySelectorAll('script[src*="/v1/navi.js"]').length);
  expect(tags, 'a second bundle must not be injected over a live SDK').toBe(1);
});
