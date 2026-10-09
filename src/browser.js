// Shared Playwright session helpers, used by both the agent CLI and the MCP
// server so the two entry points bootstrap a page identically.
import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAVI_PROTOCOL_VERSION } from './adapter.js';

/**
 * Only credential-free http(s) targets are opened, so a stray target can never
 * carry embedded credentials into a request or a log line.
 * @param {string} value
 */
export function isAllowedUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return !url.username && !url.password;
  } catch { return false; }
}

/** Resolve Playwright lazily so callers report a clear error instead of crashing on import. */
export async function resolveChromium() {
  /** @type {string[]} */
  const candidates = ['playwright', 'playwright-core', '@playwright/test'];
  /** @type {string[]} */
  const tried = [];
  for (const name of candidates) {
    try {
      const module = await import(name);
      if (module?.chromium?.launch) return /** @type {any} */ (module.chromium);
      tried.push(`${name} (no chromium export)`);
    } catch { tried.push(name); }
  }
  throw Object.assign(new Error(`Playwright is required. Install it (npm i -D playwright) and run "npx playwright install chromium". Tried: ${tried.join(', ')}`), { code: 'NO_BROWSER' });
}

/** @param {string} [override] */
export function resolveSdkPath(override) {
  if (override) return realpathSync(override);
  const here = dirname(fileURLToPath(import.meta.url));
  /** @type {string[]} */
  const candidates = [resolve(here, 'navi.min.js'), resolve(here, '../dist/navi.min.js')];
  for (const candidate of candidates) if (existsSync(candidate)) return realpathSync(candidate);
  throw Object.assign(new Error('Could not locate navi.min.js; run "npm run build" first'), { code: 'NO_SDK' });
}

/**
 * Ensure the page runs the expected Navi protocol, injecting the SDK if needed.
 * @param {any} page Playwright page
 * @param {string} sdkPath
 * @param {string} [expected]
 */
export async function ensureNavi(page, sdkPath, expected = NAVI_PROTOCOL_VERSION) {
  const installed = await page.evaluate(() => Boolean(/** @type {any} */ (globalThis).Navi));
  if (!installed) await page.addScriptTag({ path: sdkPath });
  const version = await page.evaluate(async (/** @type {string} */ want) => {
    const navi = /** @type {any} */ (globalThis).Navi;
    if (!navi) throw new Error('Navi failed to install');
    if (navi.version !== want) throw new Error(`Navi protocol ${navi.version} does not match the expected ${want}`);
    await navi.ready();
    return navi.version;
  }, expected);
  return { injected: !installed, version: /** @type {string} */ (version) };
}
