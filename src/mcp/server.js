// Navi MCP server: a standalone Model Context Protocol server over stdio.
//
// Deliberately dependency-free. The transport is newline-delimited JSON-RPC 2.0,
// which is the whole of what stdio MCP requires, so this ships without pulling
// a web framework, a validation library and a token library into an agent
// runtime. Conformance is verified in tests against the official
// @modelcontextprotocol/sdk Client, which is a development-only dependency.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { NaviPlaywrightAdapter, NAVI_PROTOCOL_VERSION } from '../adapter.js';
import { DEFAULT_SETTLE_TIMEOUT_MS, MAX_SETTLE_TIMEOUT_MS, SETTLE_MODES } from '../settle.js';
import { ensureNavi, isAllowedUrl, resolveChromium, resolveSdkPath } from '../browser.js';
import { installNavi } from '../index.js';
// sse.js deliberately does not import this module back: the message handler is
// passed in, so there is no import cycle between the transports.
import { createSseServer, DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_MAX_SESSIONS, DEFAULT_SSE_PORT } from './sse.js';

export const SERVER_NAME = 'navi-mcp-server';
// Read the version from the package manifest so the advertised server version can
// never drift from the published one. Works both bundled (dist/mcp.mjs) and
// unbundled (src/mcp/server.js).
export const SERVER_VERSION = (() => {
  for (const candidate of ['../package.json', '../../package.json']) {
    try {
      const version = JSON.parse(readFileSync(new URL(candidate, import.meta.url), 'utf8')).version;
      if (typeof version === 'string') return version;
    } catch { /* try the next candidate */ }
  }
  return '0.0.0';
})();
/** Newest protocol this server implements. */
export const PROTOCOL_VERSION = '2025-11-25';
/** Versions the server will echo back when a client requests them. */
export const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];

const DEFAULT_VIEWPORT = { width: 1360, height: 900 };
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_ACTIONS = 5000;

/**
 * Actionable guidance for every failure mode the adapter and SDK can report.
 * An agent that only sees "false" cannot recover; an agent that sees which of
 * occluded / disabled / missing happened can.
 * @type {Record<string, string>}
 */
const GUIDANCE = {
  NOT_FOUND: 'The target_id is not in the action map. Call navi_get_actions and use a target_id from that response; ids change when the page re-renders.',
  AMBIGUOUS: 'The target_id matched more than one element. Re-read the action map; the page has duplicate or unstable identities.',
  UNAVAILABLE: 'The element exists but is not actionable: hidden, disabled, off-screen or covered. Scroll it into view, wait for it to become enabled, or dismiss the overlay first.',
  TARGET_UNAVAILABLE: 'The element was not visible, enabled, in-viewport and unoccluded at execution time. Re-read the action map and retry once the element has settled.',
  INVALID_PAYLOAD: 'The payload does not match the action. "type" takes {text}, "select" takes {value}, "click" takes no payload.',
  INVALID_SETTLE: 'The settle request is not valid. Use timeout_ms between 1 and 30000 and wait_for one of mutation_settle, navigation, target_hidden.',
  INVALID_SESSION: 'The session payload is not a usable storage state. Pass an inline { cookies, origins } object or a path to a Playwright storageState.json file; every cookie needs name and value plus url or domain+path, and every origin needs a bare origin plus localStorage entries.',
  INVALID_ACTION: 'The action type is not valid for this element. Use the suggested_action from navi_get_actions.',
  BUSY: 'Another execution is already in flight on this page. Wait for it to finish, then retry.',
  CANCELED: 'The page canceled the synthesized event, so the control may be protected. Mark it data-navi-trusted="true" to use trusted native input instead.',
  STOPPED: 'The SDK was stopped on this page (window.Navi.stop()). Call navi_navigate again to reinstall it.',
  FALLBACK_DISABLED: 'This control requires trusted input and fallback is disabled for this session. Restart the server without --no-fallback, or drive the control with a real browser tool.',
  FALLBACK_UNSUPPORTED: 'Trusted native fallback supports click and type only. Use a click or type control for trusted actions.',
  STALE_COORDINATES: 'The fallback action map was too old to act on safely. Retry; nothing was dispatched.',
  EXECUTION_FAILED: 'The page reported a failed action. Nothing further is retried automatically because the action may already have applied.',
  EXECUTION_ERROR: 'The action failed inside the page. Read the action map again before retrying.',
  NAVI_INSTALL_FAILED: 'The SDK could not be installed on this page. A strict Content-Security-Policy blocks <script> injection, so serve navi.min.js from the page origin, add a matching nonce, or allow the evaluate strategy.',
  NO_BROWSER: 'Playwright is not installed. Install it with "npm i -D playwright" and run "npx playwright install chromium".',
  NO_SDK: 'The built browser bundle was not found. Run "npm run build" first.',
  NO_PAGE: 'No page is open. Call navi_navigate with a URL first.',
  PAGE_ORIGIN_CHANGED: 'The page navigated to a different origin, so the previous action map is void. Call navi_navigate again.'
};

/** @param {string} code @param {string} message */
function guidance(code, message) {
  const hint = GUIDANCE[code];
  if (!hint) return message;
  if (!message) return hint;
  // Some callers already say what the guidance says; do not repeat it twice.
  return hint.includes(message) ? hint : `${message} ${hint}`;
}

/**
 * Any URL echoed back to a client is redacted first: an error message about a
 * rejected credential-bearing URL must not put those credentials into the
 * model context or a log.
 * @param {string} value
 */
function redactUrl(value) {
  return value.replace(/\/\/[^/@\s]*@/, '//[redacted]@');
}

/** @param {unknown} error */
function errorCode(error) {
  const code = /** @type {{code?: unknown}} */ (error)?.code;
  return typeof code === 'string' && code ? code : 'EXECUTION_ERROR';
}

/**
 * Structured MCP error envelope. `isError` marks a failed tool call; the text
 * payload is always JSON so a model can parse the code and the guidance.
 * @param {string} code @param {string} message @param {Record<string, unknown>} [extra]
 */
export function toolError(code, message, extra = {}) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code, message: guidance(code, message) }, ...extra }, null, 2) }],
    isError: true
  };
}

/** @param {unknown} result */
export function toolResult(result) {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, .../** @type {Record<string, unknown>} */ (result) }, null, 2) }], isError: false };
}

export const TOOLS = [
  {
    name: 'navi_navigate',
    title: 'Navigate and initialize Navi',
    description: `Open an http(s) URL in the controlled browser, install or detect the Navi browser SDK (protocol ${NAVI_PROTOCOL_VERSION}), wait for indexing, and return the page title with the number of actionable controls. Only credential-free http(s) URLs are accepted.`,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL to open.' },
        width: { type: 'number', description: `Viewport width in CSS pixels. Default ${DEFAULT_VIEWPORT.width}.` },
        height: { type: 'number', description: `Viewport height in CSS pixels. Default ${DEFAULT_VIEWPORT.height}.` },
        timeoutMs: { type: 'number', description: `Navigation timeout in milliseconds. Default ${DEFAULT_TIMEOUT_MS}.` }
      },
      required: ['url'],
      additionalProperties: false
    }
  },
  {
    name: 'navi_get_actions',
    title: 'Read the Navi action map',
    description: 'Return the current NaviActionMap: target_id, role, accessible name, live visible/enabled/in-viewport/occluded state, CSS-pixel coordinates and the suggested action for each interactive control. Viewport-only by default; pass all=true for the whole document, including off-screen controls.',
    inputSchema: {
      type: 'object',
      properties: {
        since_version: { type: 'integer', minimum: 0, description: 'Document-scoped cursor from the previous map. Returns changed targets/removal tombstones; reset:true means replace the cache with this full snapshot. Expired, differently filtered, negative or malformed cursors reset instead of failing.' },
        all: { type: 'boolean', description: 'Return every indexed control instead of only those in the viewport. Default false.' },
        limit: { type: 'number', description: `Maximum controls to return, 1-${MAX_ACTIONS}. Default 500.` }
      },
      additionalProperties: false
    }
  },
  {
    name: 'navi_execute_action',
    title: 'Execute an action on a target',
    description: 'Run click, type or select on a target_id from the action map. Uses the guarded synthetic path first; controls marked data-navi-trusted="true" automatically fall back to trusted native driver input at the target\'s live coordinates. Failed actions are never retried automatically, because they may already have applied. Pass settle to wait deterministically for the action\'s effect before this call returns; the receipt reports whether the requested condition held.',
    inputSchema: {
      type: 'object',
      properties: {
        target_id: { type: 'string', description: 'target_id from navi_get_actions.' },
        action_type: { type: 'string', enum: ['click', 'type', 'select'], description: 'Action to perform.' },
        payload: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Text for action_type "type".' },
            value: { type: 'string', description: 'Option value for action_type "select".' }
          },
          additionalProperties: false
        },
        settle: {
          type: 'object',
          description: 'Optional deterministic settlement. mutation_settle waits for DOM silence (>=100ms with no mutation, including open shadow roots and same-origin frames); navigation waits for a URL change or document reload; target_hidden waits for the target to be removed, invisible or occluded. A timeout reports settled:false and never re-runs the action.',
          properties: {
            timeout_ms: { type: 'number', description: `Settlement deadline in milliseconds, 1-${MAX_SETTLE_TIMEOUT_MS}. Default ${DEFAULT_SETTLE_TIMEOUT_MS}.` },
            wait_for: { type: 'string', enum: [...SETTLE_MODES], description: 'Which condition to wait for. Default "mutation_settle".' }
          },
          additionalProperties: false
        }
      },
      required: ['target_id', 'action_type'],
      additionalProperties: false
    }
  },
  {
    name: 'navi_assert_state',
    title: 'Assert a target\'s state',
    description: 'Check that a target_id exists and optionally that it is visible, enabled, in the viewport, and matches an expected accessible name. Returns the observed state and whether every requested expectation held.',
    inputSchema: {
      type: 'object',
      properties: {
        target_id: { type: 'string', description: 'target_id to check.' },
        exists: { type: 'boolean', description: 'Require the target to be present in the action map. Default true.' },
        visible: { type: 'boolean', description: 'Require is_visible to match this value.' },
        enabled: { type: 'boolean', description: 'Require is_enabled to match this value.' },
        in_viewport: { type: 'boolean', description: 'Require is_in_viewport to match this value.' },
        name: { type: 'string', description: 'Require the accessible name to equal this string.' },
        name_contains: { type: 'string', description: 'Require the accessible name to contain this substring.' }
      },
      required: ['target_id'],
      additionalProperties: false
    }
  },
  {
    name: 'navi_set_session',
    title: 'Hydrate an authenticated session',
    description: 'Seed the browser context with cookies and localStorage before navigating, so navi_navigate opens a pre-authenticated page instead of a sign-in screen. Accepts an inline { cookies, origins } payload or a path to a Playwright storageState.json file. Hydration rebuilds the context, so it must be called before navi_navigate; passing url hydrates and opens the page in one step. Cookie values are never echoed back.',
    inputSchema: {
      type: 'object',
      properties: {
        cookies: {
          type: 'array',
          description: 'Playwright cookies. Each entry needs name, value and either url or domain+path.',
          items: { type: 'object' }
        },
        origins: {
          type: 'array',
          description: 'Local storage per origin: [{ origin, localStorage: [{ name, value }] }].',
          items: { type: 'object' }
        },
        storage_state: {
          description: 'A path to a storageState.json file, or an inline { cookies, origins } object. Takes precedence over cookies/origins.',
          anyOf: [{ type: 'string' }, { type: 'object' }]
        },
        url: { type: 'string', description: 'Optional http(s) URL to open immediately after hydrating, using the hydrated context.' }
      },
      additionalProperties: false
    }
  }
];

/** A bare, canonical http(s) origin: no path, query, credentials or trailing slash. @param {string} value */
function isCanonicalOrigin(value) {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
  } catch { return false; }
}

/**
 * Normalize inline session state or a storageState path into the shape Playwright
 * accepts at context creation. Returns `{ state, summary }` or `{ error }` — it
 * never throws, because the caller has to turn a bad session into an actionable
 * tool error rather than a crash.
 * @param {unknown} input
 * @returns {{state: {cookies: any[], origins: any[]}, summary: {cookies: number, origins: number, localStorage: number}} | {error: string}}
 */
export function normalizeStorageState(input) {
  let raw = input;
  if (typeof raw === 'string') {
    const path = raw;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      return { error: `Could not read storageState file "${path}": ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'Session state must be an object holding cookies and/or origins, or a path to a storageState JSON file.' };
  }
  const state = /** @type {Record<string, unknown>} */ (raw);
  const unknown = Object.keys(state).filter(key => key !== 'cookies' && key !== 'origins');
  if (unknown.length) return { error: `Unknown session key(s) ${unknown.join(', ')}; a storage state holds only cookies and origins.` };
  const cookies = state.cookies ?? [];
  const origins = state.origins ?? [];
  if (!Array.isArray(cookies)) return { error: 'cookies must be an array.' };
  if (!Array.isArray(origins)) return { error: 'origins must be an array.' };

  for (const cookie of cookies) {
    if (!cookie || typeof cookie !== 'object') return { error: 'Every cookie must be an object.' };
    const entry = /** @type {Record<string, unknown>} */ (cookie);
    if (typeof entry.name !== 'string' || !entry.name) return { error: 'Every cookie needs a non-empty name.' };
    if (typeof entry.value !== 'string') return { error: `Cookie "${entry.name}" needs a string value.` };
    const scoped = (typeof entry.url === 'string' && entry.url) || (typeof entry.domain === 'string' && typeof entry.path === 'string');
    if (!scoped) return { error: `Cookie "${entry.name}" needs either url or both domain and path.` };
  }
  let entries = 0;
  for (const origin of origins) {
    if (!origin || typeof origin !== 'object') return { error: 'Every origin entry must be an object.' };
    const entry = /** @type {Record<string, unknown>} */ (origin);
    if (typeof entry.origin !== 'string' || !isCanonicalOrigin(entry.origin)) {
      return { error: `Origin "${String(entry.origin)}" must be a bare http(s) origin such as https://app.example.com, without a path, query or trailing slash.` };
    }
    if (!Array.isArray(entry.localStorage)) return { error: `Origin ${entry.origin} needs a localStorage array; it may be empty.` };
    for (const item of entry.localStorage) {
      if (!item || typeof item !== 'object' || typeof (/** @type {Record<string, unknown>} */ (item)).name !== 'string' || typeof (/** @type {Record<string, unknown>} */ (item)).value !== 'string') {
        return { error: `Every localStorage entry for ${entry.origin} needs string name and value.` };
      }
      entries++;
    }
  }
  // An origin entry with an empty localStorage hydrates nothing, so a state that
  // carries neither cookies nor entries is refused rather than accepted as a
  // silent no-op the caller would mistake for a working session.
  if (!cookies.length && !entries) return { error: 'Nothing to hydrate: the session carries no cookies and no localStorage entries.' };
  return { state: { cookies, origins }, summary: { cookies: cookies.length, origins: origins.length, localStorage: entries } };
}

/**
 * Owns one browser, one page and the current adapter for the process lifetime.
 * A new adapter per navigation keeps the origin check honest: the adapter
 * refuses to act when the page's origin no longer matches the map it produced.
 */
export class NaviSession {
  /** @param {{viewport?: {width: number, height: number}, headless?: boolean, fallback?: boolean, log?: (line: string) => void}} [options] */
  constructor(options = {}) {
    this.viewport = options.viewport ?? DEFAULT_VIEWPORT;
    this.headless = options.headless !== false;
    this.fallback = options.fallback !== false;
    this.log = options.log ?? (() => {});
    this.browser = null;
    /** @type {any} */
    this.page = null;
    /** @type {NaviPlaywrightAdapter | null} */
    this.adapter = null;
    this.sdkStrategy = null;
    /** @type {{cookies: any[], origins: any[]} | null} */
    this.storageState = null;
  }

  async #ensurePage() {
    if (this.page) return this.page;
    const chromium = await resolveChromium();
    this.browser = await chromium.launch({ headless: this.headless, chromiumSandbox: true });
    const context = await this.browser.newContext(this.storageState ? { viewport: this.viewport, storageState: this.storageState } : { viewport: this.viewport });
    this.page = await context.newPage();
    this.log(`browser launched (${this.viewport.width}x${this.viewport.height}, headless=${this.headless})`);
    return this.page;
  }

  /** @param {Record<string, unknown>} args */
  async navigate(args) {
    const url = typeof args.url === 'string' ? args.url : '';
    if (!isAllowedUrl(url)) return toolError('INVALID_URL', `Refusing to open "${redactUrl(url)}": only absolute credential-free http(s) URLs are allowed.`);
    const safe = url;
    const width = Number.isFinite(args.width) ? Number(args.width) : this.viewport.width;
    const height = Number.isFinite(args.height) ? Number(args.height) : this.viewport.height;
    const timeout = Number.isFinite(args.timeoutMs) ? Number(args.timeoutMs) : DEFAULT_TIMEOUT_MS;
    try {
      const page = await this.#ensurePage();
      await page.setViewportSize({ width, height });
      const response = await page.goto(safe, { waitUntil: 'load', timeout });
      const status = response ? response.status() : null;
      const installed = await page.evaluate(() => Boolean(/** @type {any} */ (globalThis).Navi));
      const sdkPath = resolveSdkPath();
      let strategy = installed ? 'already-present' : 'tag';
      if (!installed) {
        try {
          await installNavi(page, { scriptPath: sdkPath, strategy: 'tag' });
        } catch {
          // A strict script-src blocks <script> injection; the driver evaluation
          // path is not subject to the document's CSP.
          await installNavi(page, { scriptPath: sdkPath, strategy: 'evaluate' });
          strategy = 'evaluate';
        }
      }
      const { version } = await ensureNavi(page, sdkPath);
      this.adapter = new NaviPlaywrightAdapter(page, { fallback: this.fallback });
      const map = await this.adapter.discover({ limit: MAX_ACTIONS });
      this.sdkStrategy = strategy;
      this.log(`navigated to ${page.url()} (HTTP ${status}, SDK ${strategy}, ${map.actions.length} controls)`);
      return toolResult({
        url: page.url(),
        title: await page.title(),
        status,
        protocolVersion: version,
        sdk: { strategy, injected: !installed },
        viewport: { width, height },
        actions: map.actions.length,
        truncated: map.truncated
      });
    } catch (error) {
      const code = errorCode(error);
      return toolError(code === 'EXECUTION_ERROR' ? 'NAVIGATION_FAILED' : code, error instanceof Error ? error.message : String(error), { url: safe });
    }
  }

  #requireAdapter() {
    if (this.adapter) return this.adapter;
    return null;
  }

  /**
   * Rebuild the browser context around a storage state. Cookies and localStorage
   * cannot be applied to a live document portably — localStorage only takes
   * effect at document start — so hydration replaces the session instead of
   * patching it, and the next navigation opens authenticated.
   * @param {{cookies: any[], origins: any[]}} state
   */
  async hydrate(state) {
    this.storageState = state;
    this.page = null;
    this.adapter = null;
    if (!this.browser) return;
    for (const context of this.browser.contexts()) {
      try { await context.close(); } catch { /* already gone */ }
    }
  }

  /** @param {Record<string, unknown>} args */
  async setSession(args) {
    const url = typeof args.url === 'string' ? args.url : '';
    if (url && !isAllowedUrl(url)) return toolError('INVALID_URL', `Refusing to open "${redactUrl(url)}": only absolute credential-free http(s) URLs are allowed.`);
    const inline = args.cookies !== undefined || args.origins !== undefined ? { cookies: args.cookies ?? [], origins: args.origins ?? [] } : undefined;
    const input = args.storage_state !== undefined ? args.storage_state : inline;
    if (input === undefined) return toolError('INVALID_SESSION', 'Provide storage_state, or cookies and/or origins.');
    const normalized = normalizeStorageState(input);
    if ('error' in normalized) return toolError('INVALID_SESSION', normalized.error);
    try {
      await this.hydrate(normalized.state);
      this.log(`hydrated session: ${normalized.summary.cookies} cookie(s), ${normalized.summary.origins} origin(s), ${normalized.summary.localStorage} localStorage entr(ies)`);
      // Opening the page immediately is the useful case: the action map in the
      // reply is itself the evidence that restricted controls are reachable.
      if (url) return await this.navigate({ url });
      return toolResult({
        hydrated: normalized.summary,
        applies_to: 'the next navi_navigate call',
        note: 'Called without url, so no page is open yet; the next navigation starts inside this session.'
      });
    } catch (error) {
      return toolError(errorCode(error), error instanceof Error ? error.message : String(error));
    }
  }

  /** @param {Record<string, unknown>} args */
  async getActions(args) {
    const adapter = this.#requireAdapter();
    if (!adapter) return toolError('NO_PAGE', 'No page is open.');
    const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(MAX_ACTIONS, Math.floor(Number(args.limit)))) : 500;
    try {
      // An unusable cursor is not a tool error: the SDK answers with reset:true
      // and a full snapshot, so a caller that lost or corrupted its cursor
      // recovers in one call rather than being unable to proceed.
      const cursor = Number.isSafeInteger(args.since_version) && Number(args.since_version) >= 0 ? Number(args.since_version) : undefined;
      const options = { viewportOnly: args.all !== true, limit };
      const map = cursor === undefined ? await adapter.discover(options) : await adapter.discover({ ...options, since_version: cursor });
      return toolResult({ ...map, viewportOnly: args.all !== true, url: adapter.page.url() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Incomplete action map/.test(message)) {
        return toolError('MAP_TRUNCATED', 'The page holds more controls than the requested limit. Raise limit or narrow the page with a smaller viewport.');
      }
      return toolError(errorCode(error), message);
    }
  }

  /** @param {Record<string, unknown>} args */
  async executeAction(args) {
    const adapter = this.#requireAdapter();
    if (!adapter) return toolError('NO_PAGE', 'No page is open.');
    const targetId = typeof args.target_id === 'string' ? args.target_id : '';
    const actionType = typeof args.action_type === 'string' ? args.action_type : '';
    if (!targetId || !['click', 'type', 'select'].includes(actionType)) {
      return toolError('INVALID_ACTION', 'target_id is required and action_type must be click, type or select.');
    }
    const payload = /** @type {{text?: string, value?: string}} */ (args.payload && typeof args.payload === 'object' ? args.payload : {});
    try {
      const result = await adapter.execute(targetId, actionType, payload, args.settle);
      if (!result.ok) {
        const code = result.error?.code ?? 'EXECUTION_ERROR';
        return toolError(code, result.error?.message ?? 'The action failed.', { target_id: targetId, action_type: actionType });
      }
      const settle = result.settle;
      return toolResult({
        executed: true,
        target_id: targetId,
        action_type: actionType,
        mode: result.mode,
        trusted_fallback: result.mode === 'native-driver',
        dispatched: result.result?.dispatched === true,
        url: adapter.page.url(),
        // The receipt is present only when the caller asked for settlement, so
        // an unconfigured call cannot be mistaken for a verified one.
        ...(settle ? {
          settled: settle.settled,
          elapsed_ms: settle.elapsed_ms,
          final_url: settle.final_url,
          settle: settle.mode,
          ...(settle.reason ? { settle_reason: settle.reason } : {})
        } : {})
      });
    } catch (error) {
      // Transport failures propagate from the adapter: the action may already have applied.
      return toolError(errorCode(error), error instanceof Error ? error.message : String(error), { target_id: targetId, action_type: actionType, may_have_applied: true });
    }
  }

  /** @param {Record<string, unknown>} args */
  async assertState(args) {
    const adapter = this.#requireAdapter();
    if (!adapter) return toolError('NO_PAGE', 'No page is open.');
    const targetId = typeof args.target_id === 'string' ? args.target_id : '';
    if (!targetId) return toolError('INVALID_ACTION', 'target_id is required.');
    try {
      const map = await adapter.discover({ limit: MAX_ACTIONS });
      const matches = map.actions.filter(action => action.target_id === targetId);
      const action = matches.length === 1 ? matches[0] : null;
      const expectExists = args.exists !== false;
      /** @type {{label: string, expected: unknown, observed: unknown, ok: boolean}[]} */
      const checks = [];
      const add = (/** @type {string} */ label, /** @type {unknown} */ expected, /** @type {unknown} */ observed, /** @type {boolean} */ ok) => checks.push({ label, expected, observed, ok });
      add('exists', expectExists, matches.length === 1, (matches.length === 1) === expectExists);
      add('unique', true, matches.length <= 1, matches.length <= 1);
      if (action) {
        /** @type {[string, unknown, boolean][]} */
        const stateChecks = [
          ['visible', args.visible, action.state.is_visible],
          ['enabled', args.enabled, action.state.is_enabled],
          ['in_viewport', args.in_viewport, action.state.is_in_viewport]
        ];
        for (const [label, expected, observed] of stateChecks) {
          if (typeof expected === 'boolean') add(label, expected, observed, observed === expected);
        }
        if (typeof args.name === 'string') add('name', args.name, action.name, action.name === args.name);
        if (typeof args.name_contains === 'string') add('name_contains', args.name_contains, action.name, action.name.includes(args.name_contains));
      }
      return toolResult({
        target_id: targetId,
        passed: checks.every(check => check.ok),
        matches: matches.length,
        observed: action ? { role: action.role, name: action.name, suggested_action: action.suggested_action, state: action.state, coordinates: action.coordinates } : null,
        checks
      });
    } catch (error) {
      return toolError(errorCode(error), error instanceof Error ? error.message : String(error));
    }
  }

  async close() {
    const browser = this.browser;
    this.browser = null;
    this.page = null;
    this.adapter = null;
    if (browser) {
      try { await browser.close(); } catch { /* already gone */ }
    }
  }
}

/**
 * Handle one JSON-RPC message. Returns the response body, or null for
 * notifications, which by protocol must not be answered.
 * @param {Record<string, any>} message
 * @param {{session: NaviSession, initialized: {value: boolean}, log: (line: string) => void}} state
 */
export async function handleMessage(message, state) {
  const { session, initialized } = state;
  const id = message?.id;
  const isNotification = id === undefined || id === null;
  /** @param {unknown} result */
  const reply = (/** @type {unknown} */ result) => (isNotification ? null : { jsonrpc: '2.0', id, result });
  /** @param {number} code @param {string} message_ @param {unknown} [data] */
  const fail = (code, message_, data) => (isNotification ? null : { jsonrpc: '2.0', id, error: { code, message: message_, ...(data === undefined ? {} : { data }) } });
  const method = message?.method;

  if (typeof method !== 'string') return fail(-32600, 'Invalid Request: method must be a string');
  if (isNotification) {
    if (method === 'notifications/initialized') initialized.value = true;
    if (method === 'notifications/cancelled') state.log('client cancelled a request');
    return null;
  }
  if (method === 'initialize') {
    const requested = /** @type {{protocolVersion?: unknown}} */ (message.params)?.protocolVersion;
    const negotiated = typeof requested === 'string' && SUPPORTED_PROTOCOLS.includes(requested) ? requested : PROTOCOL_VERSION;
    initialized.value = true;
    return reply({
      protocolVersion: negotiated,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: 'Navi exposes a validated action map and guarded execution. Call navi_navigate first, then navi_get_actions, then navi_execute_action with a current target_id.'
    });
  }
  if (!initialized.value) return fail(-32002, 'Server not initialized: send initialize first');
  if (method === 'ping') return reply({});
  if (method === 'tools/list') return reply({ tools: TOOLS });
  if (method === 'tools/call') {
    const params = /** @type {{name?: unknown, arguments?: unknown}} */ (message.params);
    const name = typeof params?.name === 'string' ? params.name : '';
    const args = /** @type {Record<string, unknown>} */ (params?.arguments && typeof params.arguments === 'object' ? params.arguments : {});
    state.log(`tools/call ${name}`);
    if (name === 'navi_navigate') return reply(await session.navigate(args));
    if (name === 'navi_get_actions') return reply(await session.getActions(args));
    if (name === 'navi_execute_action') return reply(await session.executeAction(args));
    if (name === 'navi_assert_state') return reply(await session.assertState(args));
    if (name === 'navi_set_session') return reply(await session.setSession(args));
    return reply(toolError('UNKNOWN_TOOL', `Unknown tool "${name}". Available tools: ${TOOLS.map(tool => tool.name).join(', ')}.`));
  }
  return fail(-32601, `Method not found: ${method}`);
}

/**
 * Run the stdio server until stdin closes.
 * @param {{input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream, log?: (line: string) => void, session?: NaviSession}} [options]
 * @returns {Promise<void>}
 */
export async function runStdioServer(options = {}) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const log = options.log ?? ((/** @type {string} */ line) => process.stderr.write(`[navi-mcp] ${line}\n`));
  const session = options.session ?? new NaviSession({ log });
  const initialized = { value: false };
  const send = (/** @type {unknown} */ body) => { if (body) output.write(`${JSON.stringify(body)}\n`); };
  // Tool calls are serialized: one browser, one action at a time.
  let queue = Promise.resolve();
  const reader = createInterface({ input, crlfDelay: Infinity });

  reader.on('line', line => {
    const text = line.trim();
    if (!text) return;
    /** @type {Record<string, any>} */
    let message;
    try {
      message = JSON.parse(text);
    } catch (error) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `Parse error: ${/** @type {Error} */ (error).message}` } });
      return;
    }
    queue = queue.then(async () => {
      try {
        send(await handleMessage(message, { session, initialized, log }));
      } catch (error) {
        send({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32603, message: `Internal error: ${error instanceof Error ? error.message : String(error)}` } });
      }
    });
  });

  await new Promise(/** @param {(value?: void) => void} resolve */ resolve => {
    const finish = () => resolve();
    reader.on('close', finish);
    input.on?.('end', finish);
  });
  await queue;
  await session.close();
  log('stdin closed, session closed');
}

/** Read `--flag value` from argv, falling back when absent. @param {string[]} argv @param {string} flag @param {string} fallback */
function option(argv, flag, fallback) {
  const index = argv.indexOf(flag);
  return index === -1 ? fallback : argv[index + 1] ?? fallback;
}

/**
 * Is this a host an unauthenticated browser driver may be served on?
 * `0.0.0.0` and `::` are deliberately not loopback: they expose every
 * interface, which is the case the auth requirement exists to catch.
 * @param {string} host
 */
function isLoopbackHost(host) {
  const bare = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  return bare === 'localhost' || bare === '::1' || bare === '0:0:0:0:0:0:0:1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

/** @param {string[]} [argv] @returns {Promise<number>} */
export async function main(argv = []) {
  if (argv.includes('--help')) {
    process.stdout.write(`navi-mcp · MCP server for the Navi protocol\n\nUsage\n  navi-mcp                        Speak MCP over stdio (default)\n  navi-mcp --transport sse        Serve the remote SSE transport instead\n  navi-mcp --transport sse --port 3001 --host 127.0.0.1\n                                  Port defaults to 3001, host to 127.0.0.1\n  navi-mcp --transport sse --auth-token <token>\n                                  Require \"Authorization: Bearer <token>\" on /sse\n                                  and /message (or set NAVI_MCP_TOKEN). Mandatory\n                                  for any --host that is not loopback\n  navi-mcp --transport sse --max-sessions 10\n                                  Concurrent event streams; beyond the ceiling is\n                                  503. Default 10\n  navi-mcp --transport sse --idle-timeout 300\n                                  Reap a session idle this many seconds, closing its\n                                  browser. Default 300; 0 disables\n  navi-mcp --no-fallback          Refuse trusted native input; synthetic dispatch only\n  navi-mcp --version              Print the server and protocol version\n  navi-mcp --help                 Print this help\n\nSSE endpoints\n  GET  /sse                       Event stream; the first frame carries the POST URL\n  POST /message?sessionId=<id>    One JSON-RPC message per request\n  GET  /healthz                   Liveness, open-session count, transport posture\n\nSecurity\n  An open SSE port is an open browser: whoever can reach it can drive a real\n  Chromium. Only loopback is served without a bearer token, and a non-loopback\n  --host without one is refused rather than warned about.\n\nEnvironment\n  NAVI_MCP_TOKEN=<token>          Bearer token, same as --auth-token\n  NAVI_MCP_DEBUG=1                Log every tool call to stderr\n`);
    return 0;
  }
  if (argv.includes('--version')) {
    process.stdout.write(`${SERVER_VERSION} (protocol ${PROTOCOL_VERSION}, navi ${NAVI_PROTOCOL_VERSION})\n`);
    return 0;
  }
  const debug = process.env.NAVI_MCP_DEBUG === '1';
  const fallback = !argv.includes('--no-fallback');
  const log = (/** @type {string} */ line) => { if (debug) process.stderr.write(`[navi-mcp] ${line}\n`); };
  const transport = option(argv, '--transport', 'stdio');

  if (transport === 'sse') {
    const port = Number(option(argv, '--port', String(DEFAULT_SSE_PORT)));
    const host = option(argv, '--host', '127.0.0.1');
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      process.stderr.write(`navi-mcp: --port must be an integer between 0 and 65535, got "${option(argv, '--port', '')}"\n`);
      return 2;
    }
    // An empty or flag-looking host would otherwise reach listen(), where Node
    // treats "" as every interface — which is the very case the token rule below
    // exists to catch, so it is a usage error rather than a binding.
    if (!host || host.startsWith('-')) {
      process.stderr.write(`navi-mcp: --host needs a host name or address, got "${host}" (use 127.0.0.1 for loopback)\n`);
      return 2;
    }
    // The token may come from either place; the flag wins so a shell alias can
    // override an inherited environment variable.
    const flagToken = option(argv, '--auth-token', '');
    if (argv.includes('--auth-token') && (!flagToken || flagToken.startsWith('-'))) {
      process.stderr.write('navi-mcp: --auth-token needs a value, e.g. --auth-token "$NAVI_MCP_TOKEN"\n');
      return 2;
    }
    const authToken = flagToken || (typeof process.env.NAVI_MCP_TOKEN === 'string' ? process.env.NAVI_MCP_TOKEN : '');
    const maxSessions = Number(option(argv, '--max-sessions', String(DEFAULT_MAX_SESSIONS)));
    if (!Number.isInteger(maxSessions) || maxSessions < 1) {
      process.stderr.write(`navi-mcp: --max-sessions must be a positive integer, got "${option(argv, '--max-sessions', '')}"\n`);
      return 2;
    }
    const idleSeconds = Number(option(argv, '--idle-timeout', String(DEFAULT_IDLE_TIMEOUT_MS / 1000)));
    if (!Number.isFinite(idleSeconds) || idleSeconds < 0) {
      process.stderr.write(`navi-mcp: --idle-timeout must be a non-negative number of seconds, got "${option(argv, '--idle-timeout', '')}"\n`);
      return 2;
    }
    // Fail closed. A browser driver on a public interface is a remote-control
    // endpoint for whoever finds it, so this is refused, not warned about.
    if (!isLoopbackHost(host) && !authToken) {
      process.stderr.write(`navi-mcp: refusing to bind ${host} without an auth token, which would expose a browser driver to every host that can reach it. Pass --auth-token <token> (or set NAVI_MCP_TOKEN), or bind 127.0.0.1.\n`);
      return 2;
    }
    const remote = await createSseServer({
      host,
      port,
      log,
      handleMessage,
      authToken,
      maxSessions,
      idleTimeoutMs: Math.round(idleSeconds * 1000),
      createSession: () => new NaviSession({ fallback, log })
    });
    // stderr, not stdout: stdout must stay free of anything that is not protocol
    // output on every transport.
    process.stderr.write(`navi-mcp: SSE transport listening on http://${host}:${remote.port}/sse (endpoint POST /message?sessionId=<id>; auth ${authToken ? 'bearer' : 'none, loopback only'}, max-sessions ${maxSessions}, idle-timeout ${idleSeconds}s)\n`);
    await new Promise(/** @param {(value?: void) => void} resolve */ resolve => {
      const stop = () => resolve();
      for (const signal of /** @type {const} */ (['SIGTERM', 'SIGINT'])) process.once(signal, stop);
    });
    await remote.close();
    log('remote transport closed');
    return 0;
  }

  if (transport !== 'stdio') {
    process.stderr.write(`navi-mcp: unknown --transport "${transport}"; use stdio or sse\n`);
    return 2;
  }

  await runStdioServer({
    session: new NaviSession({ fallback, log }),
    log
  });
  return 0;
}
