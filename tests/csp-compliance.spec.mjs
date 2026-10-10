import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/**
 * Content-Security-Policy compliance.
 *
 * The fixture pages are served by scripts/dev.mjs with a real strict policy:
 * `default-src 'self'; script-src 'self' 'nonce-naviCspNonce'; style-src 'self';
 * object-src 'none'; base-uri 'none'` — no `unsafe-inline`, no `unsafe-eval`.
 * Every assertion is checked against a header verified present on the response,
 * so the suite cannot pass against an unprotected page.
 */
const STRICT_PAGE = '/csp.html';
const NO_SCRIPT_PAGE = '/csp-none.html';
const REQUIRED_HEADER = "default-src 'self'; script-src 'self' 'nonce-naviCspNonce'; style-src 'self'";

/** @typedef {{directive: string, blockedURI: string}} Violation */

/** @param {import('@playwright/test').Page} page */
const violations = page => page.evaluate(() => /** @type {Violation[]} */ (/** @type {any} */ (window).__naviCspViolations ?? []));

/** Record policy violations before any page script runs. @param {import('@playwright/test').Page} page */
async function watchViolations(page) {
  await page.addInitScript(() => {
    const state = /** @type {any} */ (window);
    state.__naviCspViolations = [];
    document.addEventListener('securitypolicyviolation', event => {
      state.__naviCspViolations.push({ directive: event.violatedDirective, blockedURI: event.blockedURI });
    });
  });
}

/** Collect console output that indicates a policy refusal. @param {import('@playwright/test').Page} page */
function watchConsole(page) {
  /** @type {string[]} */
  const refusals = [];
  page.on('console', message => {
    const text = message.text();
    if (/Content Security Policy|Refused to (load|execute|apply)/i.test(text)) refusals.push(text.slice(0, 200));
  });
  return refusals;
}

/** @returns {Promise<{NaviPlaywrightAdapter: any, installNavi: any}>} */
const loadDist = () => import(new URL('../dist/index.mjs', import.meta.url).href);

test('the shipped SDK boots and executes a full flow under a strict CSP with zero violations', async ({ page }) => {
  const refusals = watchConsole(page);
  await watchViolations(page);
  const response = await page.goto(STRICT_PAGE, { waitUntil: 'load' });
  const header = response?.headers()['content-security-policy'] ?? '';
  expect(header, 'the fixture must actually be served with the strict policy').toContain(REQUIRED_HEADER);
  expect(header).not.toContain('unsafe-inline');
  expect(header).not.toContain('unsafe-eval');

  // The page loads the bundle from its own origin, which `script-src 'self'` allows.
  expect(await page.evaluate(() => window.Navi?.version)).toBe('0.3.0');
  await page.evaluate(async () => { await window.Navi?.ready(); });

  const { NaviPlaywrightAdapter } = await loadDist();
  /** @type {import('../types/index.js').NaviPlaywrightAdapter} */
  const tools = new NaviPlaywrightAdapter(page);
  const map = await tools.discover({ limit: 200 });
  const ids = map.actions.map(action => action.target_id);
  for (const id of ['csp-name', 'csp-email', 'csp-submit', 'csp-trusted']) expect(ids, `discovered ${id}`).toContain(id);

  // A real transaction, entirely through the protocol, on a policy-protected page.
  expect((await tools.execute('csp-name', 'type', { text: 'Ada Lovelace' })).ok).toBe(true);
  expect((await tools.execute('csp-email', 'type', { text: 'ada@example.com' })).ok).toBe(true);
  const submitted = await tools.execute('csp-submit', 'click');
  expect(submitted.ok).toBe(true);
  expect(submitted.mode).toBe('synthetic');
  await expect(page.locator('#csp-status')).toHaveText('submitted:Ada Lovelace:ada@example.com');

  // A data-navi-trusted control refuses synthetic dispatch and falls back to
  // trusted native input at live coordinates, under the same strict policy.
  const trusted = await tools.execute('csp-trusted', 'click');
  expect(trusted.ok).toBe(true);
  expect(trusted.mode).toBe('native-driver');
  await expect(page.locator('#csp-trusted-status')).toHaveText('trusted-fired');

  expect(await violations(page)).toEqual([]);
  expect(refusals).toEqual([]);
});

test('the published bundle matches its SRI and contains no CSP-forbidden construct', async ({ request }) => {
  const response = await request.get('/navi.min.js');
  expect(response.ok()).toBe(true);
  const body = await response.body();
  const source = body.toString('utf8');

  // The same rules scripts/build.mjs enforces, re-checked against the served bytes.
  /** @type {[RegExp, string][]} */
  const forbidden = [
    [/\beval\s*\(/, 'eval()'],
    [/\bFunction\s*\(/, 'the Function constructor'],
    [/\.cssText\b/, 'cssText assignment'],
    [/insertAdjacentHTML\s*\(/, 'insertAdjacentHTML'],
    [/document\s*\.\s*write\s*\(/, 'document.write'],
    [/createElement\s*\(\s*["']style["']/, 'a <style> element'],
    [/setAttribute\s*\(\s*["']style["']/, 'a style attribute']
  ];
  for (const [pattern, label] of forbidden) expect(source, `bundle must not use ${label}`).not.toMatch(pattern);

  // dist/sri.txt is what an enterprise tag pins; it must describe these exact bytes.
  const sri = (await readFile('dist/sri.txt', 'utf8')).trim();
  expect(sri).toMatch(/^sha384-[A-Za-z0-9+/]+=*$/);
  expect(sri).toBe(`sha384-${createHash('sha384').update(body).digest('base64')}`);
  const report = JSON.parse(await readFile('reports/build.json', 'utf8'));
  expect(report.integrity).toBe(sri);
  expect(body.length).toBe(report.rawBytes);
  expect(body.length).toBeLessThan(15000);
});

test('a strict CSP genuinely blocks script-tag injection, and the CSP-safe strategy still installs the SDK', async ({ page }) => {
  const { installNavi, NaviPlaywrightAdapter } = await loadDist();
  await watchViolations(page);
  const response = await page.goto(NO_SCRIPT_PAGE, { waitUntil: 'load' });
  expect(response?.headers()['content-security-policy'] ?? '').toContain(REQUIRED_HEADER);

  // The policy is real: an injected inline <script> is refused.
  await expect(installNavi(page, { strategy: 'tag', timeoutMs: 1500 })).rejects.toThrow(/Could not install the Navi SDK/);
  expect(await page.evaluate(() => Boolean(window.Navi))).toBe(false);
  const blocked = await violations(page);
  expect(blocked.length, 'the refusal must be observable, proving the policy is enforced').toBeGreaterThan(0);
  expect(blocked.some(entry => entry.directive.startsWith('script-src'))).toBe(true);

  // Driver evaluation is not subject to the document's CSP, so protected pages
  // stay automatable without weakening the page's own policy.
  await expect(installNavi(page, { strategy: 'evaluate' })).resolves.toContain('navi.min.js');
  expect(await page.evaluate(() => window.Navi?.version)).toBe('0.3.0');

  /** @type {import('../types/index.js').NaviPlaywrightAdapter} */
  const tools = new NaviPlaywrightAdapter(page);
  const map = await tools.discover({ limit: 100 });
  expect(map.actions.map(action => action.target_id)).toContain('csp-plain');
  expect((await tools.execute('csp-plain', 'click')).ok).toBe(true);

  // The successful install adds no further violations.
  expect((await violations(page)).length).toBe(blocked.length);
});
