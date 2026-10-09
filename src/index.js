// Distribution entry: browser SDK install helper plus the Playwright adapter and
// flow runner. Bundled to dist/index.mjs (ESM) and dist/index.cjs (CommonJS).
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export { NaviPlaywrightAdapter, naviAdapter, NAVI_PROTOCOL_VERSION } from './adapter.js';
export { validateFlow, runFlow } from './flow.js';

export const NAVI_SDK_FILE = 'navi.min.js';

/** Absolute path of the bundled browser SDK that ships next to this module. */
export function naviSdkPath() {
  return fileURLToPath(new URL(NAVI_SDK_FILE, import.meta.url));
}

/**
 * Inject the Navi browser SDK into an already-navigated page.
 *
 * Strategies:
 * - `tag` inserts a `<script>` element. Fastest, but a page with a strict
 *   `script-src` (no `unsafe-inline` and no matching nonce) blocks it.
 * - `evaluate` evaluates the bundle through the driver, which is not subject to
 *   the document's CSP, so protected pages can still be automated.
 * - `auto` tries `tag`, then `evaluate`, and reports which one worked.
 *
 * @param {any} page Playwright page
 * @param {{scriptPath?: string, inline?: boolean, strategy?: 'tag' | 'evaluate' | 'auto', timeoutMs?: number}} [options]
 * @returns {Promise<string>} the resolved SDK path
 */
export async function installNavi(page, options = {}) {
  const scriptPath = options.scriptPath || naviSdkPath();
  const timeoutMs = options.timeoutMs ?? 5000;
  const inline = options.inline === true;
  const requested = options.strategy ?? (inline ? 'evaluate' : 'auto');
  const attempts = requested === 'auto' ? ['tag', 'evaluate'] : [requested];
  /** @type {string[]} */
  const failures = [];
  for (const attempt of attempts) {
    try {
      if (attempt === 'tag') {
        if (inline) await page.addScriptTag({ content: await readFile(scriptPath, 'utf8') });
        else await page.addScriptTag({ path: scriptPath });
      } else {
        await page.evaluate(await readFile(scriptPath, 'utf8'));
      }
      await page.waitForFunction(() => Boolean(/** @type {any} */ (globalThis).Navi), undefined, { timeout: timeoutMs });
      return scriptPath;
    } catch (error) {
      failures.push(`${attempt}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    }
  }
  throw Object.assign(new Error(
    `Could not install the Navi SDK on ${typeof page.url === 'function' ? page.url() : 'the page'} (${failures.join('; ')}). ` +
    'A page whose Content-Security-Policy blocks inline scripts rejects <script> injection; serve navi.min.js from the page origin, add a matching nonce, or use strategy "evaluate".'
  ), { code: 'NAVI_INSTALL_FAILED' });
}

/**
 * One-call setup: verify the origin, inject Navi if needed, wait for indexing and
 * return a ready adapter.
 * @param {any} page Playwright page
 * @param {{scriptPath?: string, inline?: boolean, protocolVersion?: string, fallback?: boolean, maxFallbackAgeMs?: number, requireIndexed?: boolean}} [options]
 */
export async function connectNavi(page, options = {}) {
  const { NaviPlaywrightAdapter: Adapter } = await import('./adapter.js');
  const installed = await page.evaluate(() => Boolean(/** @type {any} */ (globalThis).Navi)).catch(() => false);
  const sdkPath = installed ? null : await installNavi(page, options);
  const adapter = new Adapter(page, options);
  if (options.requireIndexed !== false) {
    await page.evaluate(async () => {
      await /** @type {any} */ (globalThis).Navi?.ready();
    });
  }
  return { adapter, sdkPath };
}
