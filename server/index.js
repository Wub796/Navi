// Navi host service: tenant-keyed script distribution and telemetry ingestion.
//
// Deliberately built on `node:http` with no framework, no middleware chain and
// no runtime dependency, so it can be dropped next to a CDN or run as a sidecar
// without a build step:
//
//   GET  /v1/navi.js?key=<tenant_key>   serve the shipped browser bundle
//   GET  /v1/loader.js                  serve the tenant embed loader
//   POST /v1/telemetry                  ingest one navigator.sendBeacon payload
//   POST /v1/sitemap/update             ingest a tenant's semantic action map
//   GET  /v1/telemetry?key=<tenant_key> read that tenant's aggregate
//   POST /v1/telemetry/violations       ingest one containment violation
//   GET  /v1/tenants/<id>/security-audit read that tenant's blocked destinations
//   POST /v1/tenants/<id>/maintenance/prune  prune that tenant's expired records
//   GET  /healthz                       liveness, store mode and tenant count
//   GET  /metrics                       Prometheus counters for a scraper
//   GET  /.well-known/navi.json         public agent discovery document
//   GET  /v1/source                     offer of the Corresponding Source (AGPL-3.0 §13)
//
// Every response carries two `Link` relations: `rel="agent-bridge"` on
// `/.well-known/navi.json`, so an agent that can reach any route of this host can
// find the document without knowing its path, and `rel="source"` on this version's
// Corresponding Source, which is what AGPL-3.0 section 13 obliges a service like
// this one to offer the users who interact with it over a network. Both relations
// are set once, on the response object, rather than route by route, so a route
// added later cannot forget either of them. Nothing here depends on the client
// runtime: the document is a few literals plus the configured endpoints.
//
// Ingestion stores aggregates only. A payload is exactly the five documented
// fields, is capped at 2 KB, and its `url_origin` must be a canonical origin, so
// page URLs, query strings, credentials and raw DOM text cannot be recorded.
//
// Two bounds keep that intake from becoming the operator's problem. Each tenant
// gets an in-memory token bucket on the two ingest routes, so one page or one
// misconfigured forwarder cannot saturate the store; and expired violations are
// pruned on a schedule, so the audit trail does not grow without bound. Neither
// touches distribution: serving the bundle never consults the limiter or the
// store.

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beginProcessLifecycle, createStore, DEFAULT_RETENTION_DAYS, DEFAULT_VIOLATION_LIMIT, MAX_RETENTION_DAYS, MAX_VIOLATION_LIMIT } from './store.js';
import { loadTenants, tenantFor, tenantIds } from './tenants.js';
import { validateCrawlerPayload } from '../src/crawler-payload.js';

/** Process boot timestamp, shared by every listener in this process. */
const START_TIME_SECONDS = Math.floor(Date.now() / 1000);

/** Hard cap for one telemetry beacon body. */
export const MAX_PAYLOAD_BYTES = 2048;
/** Cache policy for the distributed scripts; the SRI hash is the ETag. */
export const SCRIPT_CACHE_CONTROL = 'public, max-age=3600, stale-while-revalidate=86400';
/**
 * Both scripts are served with `Access-Control-Allow-Origin: *`, because the
 * supported embed uses `crossorigin="anonymous"` plus an `integrity` hash: the
 * browser then fetches the script in CORS mode and verifies it before executing.
 * The bytes are public and tenant-keyed, so the wildcard exposes nothing that a
 * plain <script> tag did not already expose.
 */
export const SCRIPT_CORS = '*';
/** Largest counter value accepted; anything bigger is not a plausible page metric. */
export const MAX_COUNTER = 1_000_000;
export const DEFAULT_PORT = 8790;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_STORE_FILE = 'server/telemetry.db';
/** Cache policy for the discovery document: public, and cheap enough to re-read. */
export const DISCOVERY_CACHE_CONTROL = 'public, max-age=300, stale-while-revalidate=3600';
/** The relation every response advertises, so the document is reachable without a hard-coded path. */
export const AGENT_BRIDGE_LINK = '</.well-known/navi.json>; rel="agent-bridge"';
/**
 * Where the Corresponding Source for the running version lives, and the default
 * target of `GET /v1/source`.
 *
 * Normative rather than decorative: AGPL-3.0 section 13 obliges a service like
 * this one to offer its Corresponding Source to the users interacting with it over
 * a network, so changing this to a vanity URL would make the service non-compliant.
 * Override it with `NAVI_SOURCE_URL` when hosting a modified version, because the
 * obligation attaches to the source of the version actually answering requests —
 * upstream's repository does not discharge it for a fork.
 */
export const SOURCE_REPOSITORY_URL = 'https://github.com/Wub796/Navi';
/** Path that offers the Corresponding Source by redirecting to it. */
export const SOURCE_ENDPOINT_PATH = '/v1/source';
/** Public path this host distributes the browser bundle on, as advertised to agents. */
export const SCRIPT_ENDPOINT_PATH = '/v1/navi.js';
/**
 * Tenant-scoped routes whose tenant id is a path segment, so the route itself
 * cannot be a fixed string. Declared once and used both for routing and for the
 * metric label: two literals would be two chances to disagree about which path
 * was answered.
 */
export const AUDIT_ENDPOINT_PATTERN = /^\/v1\/tenants\/([^/]+)\/security-audit$/;
export const PRUNE_ENDPOINT_PATTERN = /^\/v1\/tenants\/([^/]+)\/maintenance\/prune$/;
/** Everything the browser bundle can be asked to do, advertised verbatim. */
export const AGENT_CAPABILITIES = ['viewport_indexing', 'differential_actions', 'settlement_receipts'];
/**
 * MCP protocol revision the paired MCP server speaks. Deliberately a literal and
 * not an import: this service is dependency-free by design, and a host must not
 * have to load the agent runtime to answer a discovery request.
 * `tests/auto-discovery.spec.mjs` asserts it equals `PROTOCOL_VERSION` in
 * `src/mcp/server.js`.
 */
export const MCP_PROTOCOL_REVISION = '2025-11-25';
/**
 * Navi protocol version this document advertises. The number is a literal in three
 * places, because the SDK cannot import anything: `src/navi.js` (the browser
 * bundle), `src/adapter.js`, and here. `tests/auto-discovery.spec.mjs` asserts all
 * three agree, so a bump that misses one fails the suite rather than shipping.
 */
export const NAVI_PROTOCOL_VERSION = '0.3.0';
/** Default advertised MCP SSE endpoint: loopback, on the port the paired server binds. */
export const DEFAULT_MCP_SSE_URL = 'http://127.0.0.1:3001/sse';
/** The complete, exact set of accepted telemetry keys. */
export const TELEMETRY_FIELDS = ['tenant_id', 'url_origin', 'actions_indexed', 'actions_executed', 'execution_failures'];
/**
 * The complete, exact set of accepted violation fields. The destination arrives
 * already sanitized by the MCP server, so no page URL, query string or credential
 * is representable here — this route cannot become a second ingestion path for
 * page data.
 */
export const VIOLATION_FIELDS = ['tenant_id', 'session_id', 'category', 'target_url', 'resolved_ip'];
/**
 * Categories a violation may be filed under. Duplicated from the MCP server's
 * taxonomy rather than imported: this service is dependency-free and must not
 * load the agent runtime to answer a request, and `tests/containment-persistence
 * .spec.mjs` asserts the two lists agree so the copy cannot drift silently.
 */
export const VIOLATION_CATEGORIES = ['metadata_endpoint', 'private_ipv4', 'loopback_or_local', 'cgnat_or_multicast', 'ipv6_special', 'dns_rebinding_rejected'];
/** Longest sanitized destination accepted, matching the MCP server's log cap. */
export const MAX_VIOLATION_URL_CHARS = 512;
/** Longest session identifier accepted. */
export const MAX_SESSION_ID_CHARS = 128;
/** Ingestion ceiling per tenant: requests per minute, replenished continuously. */
export const RATE_LIMIT_PER_MINUTE = 120;
/** How many requests a tenant may send back to back before that ceiling applies. */
export const RATE_LIMIT_BURST = 30;
/** How long an untouched tenant bucket is remembered, in milliseconds. */
export const RATE_LIMIT_IDLE_MS = 10 * 60 * 1000;
/** Sweep cadence for idle buckets, in milliseconds. */
export const RATE_LIMIT_SWEEP_MS = 60 * 1000;
/**
 * Bucket count that triggers a sweep on the next request. The timer alone is not
 * enough: a flood of distinct tenant ids would otherwise grow the map for a full
 * sweep interval before anything removed the entries.
 */
export const RATE_LIMIT_SWEEP_THRESHOLD = 1000;
/** How often the automatic retention sweep runs, in milliseconds. */
export const RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
/**
 * Hard deadline for a graceful stop, in milliseconds: the point after which open
 * connections are cut off rather than waited for. The MCP transport declares the
 * same number for its own teardown, because a container's stop timeout is sized
 * against one number rather than two; `tests/host-metrics-lifecycle.spec.mjs`
 * asserts the two agree so they cannot drift apart.
 */
export const SHUTDOWN_DEADLINE_MS = 5000;

/**
 * @typedef {{allowed: boolean, remaining: number, retryAfterSeconds: number}} RateVerdict
 * @typedef {{enabled: boolean, perMinute: number, burst: number, size: number, take(key: string): RateVerdict, sweep(at?: number): number, reset(): void, close(): void}} RateLimiter
 */

/**
 * A token bucket per tenant, held in this process and nowhere else.
 *
 * Bounded memory is the whole reason this is a class of its own: a bucket is
 * created on first use, refilled continuously at `perMinute`, and forgotten once
 * it has been untouched for `idleMs`, so the map is a function of how many
 * tenants are active right now rather than of how many have ever been seen.
 * `perMinute` or `burst` of `0` disables limiting entirely.
 * @param {{perMinute?: number, burst?: number, idleMs?: number, sweepIntervalMs?: number, now?: () => number, timer?: boolean}} [options]
 * @returns {RateLimiter}
 */
export function createRateLimiter(options = {}) {
  const perMinute = options.perMinute ?? RATE_LIMIT_PER_MINUTE;
  const burst = options.burst ?? RATE_LIMIT_BURST;
  const idleMs = options.idleMs ?? RATE_LIMIT_IDLE_MS;
  const enabled = perMinute > 0 && burst > 0;
  const now = options.now ?? (() => Date.now());
  /** Tokens added per millisecond: a minute's allowance spread across the minute. */
  const refillPerMs = perMinute / 60000;
  /** @type {Map<string, {tokens: number, at: number}>} */
  const buckets = new Map();
  /** @param {number} [at] @returns {number} buckets removed */
  const sweep = (at = now()) => {
    let removed = 0;
    for (const [key, bucket] of buckets) {
      if (at - bucket.at >= idleMs) {
        buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  };
  let timer = /** @type {ReturnType<typeof setInterval> | null} */ (null);
  if (enabled && options.timer !== false) {
    timer = setInterval(() => sweep(), options.sweepIntervalMs ?? RATE_LIMIT_SWEEP_MS);
    // Never hold the process open, and never a reason for a test to hang.
    timer.unref?.();
  }
  return {
    enabled,
    perMinute,
    burst,
    get size() { return buckets.size; },
    /** @param {string} key @returns {RateVerdict} */
    take(key) {
      if (!enabled) return { allowed: true, remaining: 0, retryAfterSeconds: 0 };
      const at = now();
      let bucket = buckets.get(key);
      if (!bucket) {
        if (buckets.size >= RATE_LIMIT_SWEEP_THRESHOLD) sweep(at);
        bucket = { tokens: burst, at };
        buckets.set(key, bucket);
      } else {
        // Refill by elapsed time, capped at the burst allowance, so an idle tenant
        // banks nothing beyond it.
        bucket.tokens = Math.min(burst, bucket.tokens + (at - bucket.at) * refillPerMs);
        bucket.at = at;
      }
      if (bucket.tokens < 1) {
        const missing = 1 - bucket.tokens;
        return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil(missing / refillPerMs / 1000)) };
      }
      bucket.tokens -= 1;
      return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterSeconds: 0 };
    },
    sweep,
    reset() { buckets.clear(); },
    close() { if (timer) clearInterval(timer); timer = null; }
  };
}

/**
 * Read a non-negative integer from the environment, falling back when it is
 * absent or unparseable. `0` is a value, not an absence: it means "off".
 * @param {string | undefined} value @param {number} fallback @returns {number}
 */
function countFromEnv(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : fallback;
}

const USAGE = `navi-host · script distribution and telemetry ingestion

Usage
  node server/index.js [--host 127.0.0.1] [--port 8790] [--store server/telemetry.db]

Endpoints
  GET  /v1/navi.js?key=<tenant_key>
  GET  /v1/loader.js
  POST /v1/telemetry
  GET  /v1/telemetry?key=<tenant_key>
  POST /v1/telemetry/violations
  GET  /v1/tenants/<tenant_id>/security-audit
  POST /v1/tenants/<tenant_id>/maintenance/prune
  GET  /healthz
  GET  /metrics
  GET  /.well-known/navi.json
  GET  /v1/source

Shutdown
  SIGTERM/SIGINT stop accepting, drain in-flight requests for up to 5 seconds,
  checkpoint the store and exit 0.

Environment
  NAVI_TENANTS     Comma-separated key:tenantId pairs. Defaults to the local
                   development key, which must not be used in production.
  (The MCP server persists its refusals here when NAVI_TELEMETRY_ENDPOINT and
   NAVI_TENANT_KEY are set on that process; see docs/BACKEND.md.)
  NAVI_MCP_SSE_URL MCP SSE endpoint published in the discovery document. Defaults
                   to http://127.0.0.1:3001/sse. Point this at your own bridge
                   only if you intend to publish it.
  NAVI_SOURCE_URL  Corresponding Source offered at /v1/source and advertised as
                   rel="source" on every response. Defaults to
                   https://github.com/Wub796/Navi. Set it to your own repository
                   when serving a modified version: AGPL-3.0 section 13 requires
                   the source of the version that is actually running.
  NAVI_RETENTION_DAYS      Days of containment violations to keep. Default 30;
                           0 disables the automatic sweep, and the maintenance
                           route keeps working with an explicit max_age_days.
  NAVI_RATE_LIMIT_PER_MINUTE
                           Ingestion requests per minute per tenant. Default 120;
                           0 disables limiting. Raise it for a tenant whose
                           refusal rate exceeds the default, because a rate-limited
                           forward is an audit record the MCP server counts as
                           failed rather than retrying.
  NAVI_RATE_LIMIT_BURST    Burst allowance above that rate. Default 30; 0 disables
                           limiting.
`;

const here = dirname(fileURLToPath(import.meta.url));

/** @returns {string} */
function defaultSdkPath() {
  return resolve(here, '../dist/navi.min.js');
}

/** @returns {string} */
function defaultLoaderPath() {
  return resolve(here, '../dist/loader.min.js');
}

/** @returns {Promise<string | null>} */
async function defaultIntegrity() {
  try {
    const value = (await readFile(resolve(here, '../dist/sri.txt'), 'utf8')).trim();
    return value || null;
  } catch {
    return null;
  }
}

/**
 * The `Link` relations are not set here: they are set on the response before
 * routing, so every route carries them without restating them.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {Record<string, unknown>} body
 * @param {Record<string, string>} [extraHeaders]
 */
function sendJson(res, status, body, extraHeaders = {}) {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'X-Content-Type-Options': 'nosniff',
    // Every JSON response here is either tenant-scoped or an error, so nothing
    // on this service is safe for a shared cache to keep. The one exception is the
    // discovery document, which passes its own public policy in extraHeaders.
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(payload);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @param {Record<string, string>} [extraHeaders]
 */
function sendError(res, status, code, message, extraHeaders = {}) {
  sendJson(res, status, { ok: false, error: { code, message } }, extraHeaders);
}

/**
 * Prometheus text. Unauthenticated like `/healthz`, and aggregate-only: a scrape
 * carries counters and one `tenant_id` per throttled tenant, never a URL, a
 * session identifier or a key. `/metrics` never consults the limiter.
 * @param {import('node:http').ServerResponse} res
 * @param {string} text
 */
function sendMetrics(res, text) {
  res.writeHead(200, {
    'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store'
  });
  res.end(text);
}

/**
 * The closed set of route labels the host metrics expose. Anything unmatched is
 * `other`: a label that came from the request path would let a scanner mint a
 * series per path it tried.
 * @param {string} path @returns {string}
 */
function routeLabel(path) {
  if (path === SCRIPT_ENDPOINT_PATH) return 'navi.js';
  if (path === '/v1/loader.js') return 'loader.js';
  if (path === '/v1/telemetry') return 'telemetry';
  if (path === '/v1/telemetry/violations') return 'telemetry_violations';
  if (path === '/healthz') return 'healthz';
  if (path === '/metrics') return 'metrics';
  if (path === '/.well-known/navi.json') return 'discovery';
  if (path === SOURCE_ENDPOINT_PATH) return 'source';
  if (AUDIT_ENDPOINT_PATTERN.test(path)) return 'security_audit';
  if (PRUNE_ENDPOINT_PATTERN.test(path)) return 'maintenance_prune';
  return 'other';
}

/**
 * Read a request body up to `limit` bytes. `done` runs exactly once, as soon as
 * the size limit is breached or the stream ends, so the caller never awaits a
 * body it has already decided to reject.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit
 * @param {(result: {tooLarge: boolean, raw: string | null}) => void} done
 */
function readBody(req, limit, done) {
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  let finished = false;
  /** @param {{tooLarge: boolean, raw: string | null}} result */
  const finish = result => {
    if (finished) return;
    finished = true;
    done(result);
  };
  req.on('data', chunk => {
    if (tooLarge) return;
    const buffer = /** @type {Buffer} */ (chunk);
    size += buffer.length;
    if (size > limit) {
      tooLarge = true;
      chunks.length = 0;
      finish({ tooLarge: true, raw: null });
      return;
    }
    chunks.push(buffer);
  });
  req.on('end', () => finish(tooLarge ? { tooLarge: true, raw: null } : { tooLarge: false, raw: Buffer.concat(chunks).toString('utf8') }));
  req.on('error', () => finish({ tooLarge: false, raw: null }));
}

/**
 * A canonical origin is its own URL, which rejects paths, query strings,
 * fragments, trailing slashes and embedded credentials in one check.
 * @param {unknown} value
 * @returns {boolean}
 */
function isCanonicalOrigin(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return url.origin === value;
  } catch {
    return false;
  }
}

/**
 * Strict payload validation. Only the five documented fields are accepted, the
 * tenant must be registered and match the authenticated Bearer token, and the
 * origin must be canonical.
 * @param {unknown} payload
 * @param {Set<string>} allowedTenantIds
 * @param {string} [authenticatedTenantId]
 * @returns {{ok: true, record: {tenant_id: string, url_origin: string, actions_indexed: number, actions_executed: number, execution_failures: number}} | {ok: false, status: number, code: string, message: string}}
 */
function validateTelemetry(payload, allowedTenantIds, authenticatedTenantId) {
  const invalid = (/** @type {string} */ message) => /** @type {{ok: false, status: number, code: string, message: string}} */ ({ ok: false, status: 400, code: 'INVALID_PAYLOAD', message });
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return invalid('The body must be a JSON object with tenant_id, url_origin, actions_indexed, actions_executed and execution_failures.');
  }
  const record = /** @type {Record<string, unknown>} */ (payload);
  const unknown = Object.keys(record).filter(key => !TELEMETRY_FIELDS.includes(key));
  if (unknown.length) {
    return invalid(`Unknown field(s): ${unknown.join(', ')}. Accepted fields are exactly ${TELEMETRY_FIELDS.join(', ')}; raw DOM text and page URLs are not accepted.`);
  }
  const tenantId = record.tenant_id;
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    return invalid('tenant_id must be a non-empty string naming a registered tenant.');
  }
  if (!allowedTenantIds.has(tenantId)) {
    return { ok: false, status: 401, code: 'UNKNOWN_TENANT', message: `tenant_id "${tenantId}" is not a registered tenant. Check the tenant key used to serve the script.` };
  }
  if (authenticatedTenantId && tenantId !== authenticatedTenantId) {
    return { ok: false, status: 401, code: 'UNAUTHORIZED', message: `The body names tenant "${tenantId}" while the presented Bearer token resolves to "${authenticatedTenantId}".` };
  }
  if (!isCanonicalOrigin(record.url_origin)) {
    return invalid('url_origin must be a canonical origin such as "https://shop.example.com": no path, query string, fragment, trailing slash or embedded credentials.');
  }
  /** @type {Record<string, number>} */
  const counters = {};
  for (const field of ['actions_indexed', 'actions_executed', 'execution_failures']) {
    const value = record[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_COUNTER) {
      return invalid(`${field} must be an integer between 0 and ${MAX_COUNTER}.`);
    }
    counters[field] = value;
  }
  return {
    ok: true,
    record: {
      tenant_id: tenantId,
      url_origin: /** @type {string} */ (record.url_origin),
      actions_indexed: counters.actions_indexed ?? 0,
      actions_executed: counters.actions_executed ?? 0,
      execution_failures: counters.execution_failures ?? 0
    }
  };
}

/**
 * Strict validation for one containment violation.
 *
 * The tenant comes from the caller's key when one is presented, and a body that
 * names a different tenant is refused rather than rewritten: an audit record has
 * to be the record the reporter meant, filed against the tenant its key resolves
 * to. `target_url` must already be sanitized — origin plus path — so this route
 * cannot become a second ingestion path for page data.
 * @param {unknown} payload
 * @param {Set<string>} allowedTenantIds
 * @param {string | null} keyTenantId tenant the presented key resolved to, if any
 * @returns {{ok: true, record: {tenant_id: string, session_id: string | null, category: string, target_url: string, resolved_ip: string | null}} | {ok: false, status: number, code: string, message: string}}
 */
function validateViolation(payload, allowedTenantIds, keyTenantId) {
  /** @param {string} message @returns {{ok: false, status: number, code: string, message: string}} */
  const invalid = message => ({ ok: false, status: 400, code: 'INVALID_PAYLOAD', message });
  /** @param {string} message @returns {{ok: false, status: number, code: string, message: string}} */
  const unknownTenant = message => ({ ok: false, status: 401, code: 'UNKNOWN_TENANT', message });
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return invalid('The body must be a JSON object with category and target_url, and optionally tenant_id, session_id and resolved_ip.');
  }
  const record = /** @type {Record<string, unknown>} */ (payload);
  const unknown = Object.keys(record).filter(field => !VIOLATION_FIELDS.includes(field));
  if (unknown.length) {
    return invalid(`Unknown field(s): ${unknown.join(', ')}. Accepted fields are exactly ${VIOLATION_FIELDS.join(', ')}; the destination is a sanitized origin plus path and nothing else.`);
  }
  const declared = record.tenant_id;
  if (declared !== undefined) {
    if (typeof declared !== 'string' || !allowedTenantIds.has(declared)) {
      return unknownTenant(`tenant_id "${String(declared)}" is not a registered tenant. Present the tenant key on the request, or name the tenant it resolves to.`);
    }
    if (keyTenantId && declared !== keyTenantId) {
      return unknownTenant(`The body names tenant "${declared}" while the presented key resolves to "${keyTenantId}"; a record cannot be filed against another tenant.`);
    }
  }
  const tenantId = typeof declared === 'string' ? declared : keyTenantId;
  if (!tenantId) return unknownTenant('A tenant key is required: send "Authorization: Bearer <tenant_key>" (or ?key=<tenant_key>), or name a registered tenant_id.');
  const category = record.category;
  if (typeof category !== 'string' || !VIOLATION_CATEGORIES.includes(category)) {
    return invalid(`category must be one of ${VIOLATION_CATEGORIES.join(', ')}.`);
  }
  const session = record.session_id;
  if (session !== undefined && session !== null) {
    if (typeof session !== 'string' || session.length === 0 || session.length > MAX_SESSION_ID_CHARS || !/^[A-Za-z0-9._:-]+$/.test(session)) {
      return invalid(`session_id must be 1 to ${MAX_SESSION_ID_CHARS} characters of letters, digits, dot, underscore, colon or hyphen.`);
    }
  }
  const target = record.target_url;
  if (typeof target !== 'string' || target.length === 0 || target.length > MAX_VIOLATION_URL_CHARS) {
    return invalid(`target_url must be a sanitized absolute URL of at most ${MAX_VIOLATION_URL_CHARS} characters.`);
  }
  /** @type {URL} */
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return invalid('target_url must be an absolute http(s) URL such as "http://169.254.169.254/latest/meta-data/".');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return invalid('target_url must use http or https.');
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return invalid('target_url must be sanitized: no credentials, query string or fragment.');
  }
  if (`${parsed.origin}${parsed.pathname}` !== target) {
    return invalid('target_url must be exactly origin plus path, which is what the MCP server records.');
  }
  const ip = record.resolved_ip;
  if (ip !== undefined && ip !== null && (typeof ip !== 'string' || isIP(ip) === 0)) {
    return invalid('resolved_ip must be an IP literal or null.');
  }
  return {
    ok: true,
    record: {
      tenant_id: tenantId,
      session_id: typeof session === 'string' ? session : null,
      category,
      target_url: target,
      resolved_ip: typeof ip === 'string' ? ip : null
    }
  };
}

/**
 * The store surface this service depends on, declared structurally so the host
 * does not care which backend ({@link createStore}) resolved to.
 * @typedef {{mode: 'sqlite' | 'log', file: string, append(record: unknown): Promise<void>, summarize(filter?: {tenant_id?: string}): Promise<any>, upsertNavigationMap(siteId: string, url: string, payload: object): Promise<void>, readNavigationMap(siteId: string, url: string): Promise<any>, recordViolation(violation: any): Promise<{tenant_id: string, id: number}>, queryViolations(filter: {tenant_id: string, limit?: number, since?: string}): Promise<any[]>, pruneViolations(options: {max_age_days: number, tenant_id?: string}): Promise<{pruned_count: number, remaining_count: number}>, checkpoint(options?: {truncate?: boolean}): Promise<{busy: number, log: number, checkpointed: number}>, reset(): Promise<void>, close(): Promise<void>}} StoreLike
 * @typedef {{host?: string, port?: number, tenants?: Map<string, string>, store?: StoreLike | null, storeFile?: string, sdkPath?: string, loaderPath?: string, integrity?: string | null, mcpSseUrl?: string, sourceUrl?: string, log?: (line: string) => void, retentionDays?: number, retentionIntervalMs?: number, rateLimiter?: RateLimiter}} HostOptions
 * @typedef {{server: import('node:http').Server, port: number, host: string, store: StoreLike, tenants: Map<string, string>, limiter: RateLimiter, retention: {days: number, intervalMs: number}, close(): Promise<void>}} NaviHost
 */

/**
 * Start the host service and resolve once it is listening.
 * @param {HostOptions} [options]
 * @returns {Promise<NaviHost>}
 */
export async function createNaviHostServer(options = {}) {
  const host = options.host ?? DEFAULT_HOST;
  const requestedPort = options.port ?? DEFAULT_PORT;
  const tenants = options.tenants ?? loadTenants();
  const storeFile = options.store?.file ?? options.storeFile ?? resolve(DEFAULT_STORE_FILE);
  const lifecycle = await beginProcessLifecycle(storeFile);
  const store = options.store ?? (await createStore(storeFile));
  /** Requests and background writers must finish before the final checkpoint. */
  const activeTasks = new Set();
  /** @param {Promise<void>} task */
  const track = task => {
    activeTasks.add(task);
    void task.finally(() => activeTasks.delete(task)).catch(() => {});
  };
  const sdkPath = options.sdkPath ?? defaultSdkPath();
  const loaderPath = options.loaderPath ?? defaultLoaderPath();
  const integrity = options.integrity === undefined ? await defaultIntegrity() : options.integrity;
  const mcpSseUrl = options.mcpSseUrl ?? process.env.NAVI_MCP_SSE_URL ?? DEFAULT_MCP_SSE_URL;
  const log = options.log ?? (() => {});
  const allowedTenantIds = tenantIds(tenants);
  const sourceUrl = options.sourceUrl ?? process.env.NAVI_SOURCE_URL ?? SOURCE_REPOSITORY_URL;
  const retentionDays = options.retentionDays ?? countFromEnv(process.env.NAVI_RETENTION_DAYS, DEFAULT_RETENTION_DAYS);
  const retentionIntervalMs = Math.max(50, options.retentionIntervalMs ?? RETENTION_SWEEP_INTERVAL_MS);
  // The limiter is per process, exactly like the store it protects: two replicas
  // behind one address each allow the full rate, so enforcement belongs at the
  // shared edge once there is more than one.
  const limiter = options.rateLimiter ?? createRateLimiter({
    perMinute: countFromEnv(process.env.NAVI_RATE_LIMIT_PER_MINUTE, RATE_LIMIT_PER_MINUTE),
    burst: countFromEnv(process.env.NAVI_RATE_LIMIT_BURST, RATE_LIMIT_BURST)
  });
  /**
   * Metrics state, held per host rather than per process: two hosts in one process
   * must not report each other's traffic, and a test that starts a second host
   * should see a fresh scrape. Request keys are `route|status`, built only from the
   * closed route set, so no label can come from a request path.
   * @type {Map<string, number>}
   */
  const requestCounts = new Map();
  /** @type {Map<string, number>} */
  const rateLimitedByTenant = new Map();
  let pruneEvents = 0;
  let prunedRecords = 0;
  /**
   * Both relations in one header value, on every response this service emits: the
   * discovery document and the Corresponding Source. RFC 8288 allows several
   * comma-separated entries, and `agentBridgeLink` in the MCP server already
   * splits them, so the reader that follows `rel="agent-bridge"` is unaffected by
   * the second relation.
   */
  const linkHeader = `${AGENT_BRIDGE_LINK}, <${sourceUrl}>; rel="source"`;

  /**
   * The discovery document an agent reads to find this host's runtime. It is a
   * pure function of the configured endpoints plus whether the distributables are
   * actually on disk, so `status` is a verdict and not a decoration: a host that
   * cannot serve the bundle reports `degraded` instead of promising `ready`.
   * @returns {Promise<Record<string, unknown>>}
   */
  async function discoveryDocument() {
    let status = 'ready';
    try {
      await Promise.all([stat(sdkPath), stat(loaderPath)]);
    } catch {
      status = 'degraded';
    }
    return {
      version: NAVI_PROTOCOL_VERSION,
      protocol: MCP_PROTOCOL_REVISION,
      status,
      capabilities: [...AGENT_CAPABILITIES],
      endpoints: { mcp_sse: mcpSseUrl, script: SCRIPT_ENDPOINT_PATH },
      // Section 13 makes the source offer part of the published metadata and not
      // only a response header, so an agent reading the document alone can find it.
      source: sourceUrl
    };
  }

  /** Cached file bytes, keyed on the file's identity so a rebuild is picked up. */
  const cachedFile = (/** @type {string} */ file) => {
    let cached = { mtimeMs: 0, size: 0, bytes: /** @type {Buffer | null} */ (null) };
    return async () => {
      const info = await stat(file);
      if (cached.bytes && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.bytes;
      const bytes = await readFile(file);
      cached = { mtimeMs: info.mtimeMs, size: info.size, bytes };
      return bytes;
    };
  };
  const readSdk = cachedFile(sdkPath);
  const readLoader = cachedFile(loaderPath);

  /** Headers every distributable script carries; callers add length/cache specifics. @returns {Record<string, string>} */
  const scriptHeaders = () => ({
    'Content-Type': 'application/javascript; charset=utf-8',
    'Cache-Control': SCRIPT_CACHE_CONTROL,
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': SCRIPT_CORS,
    Vary: 'Accept-Encoding'
  });

  /** A Prometheus label value escapes backslash, quote and newline: a tenant id is
   * operator-supplied text, and one unescaped quote would corrupt the exposition.
   * @param {string} value @returns {string} */
  function escapeLabel(value) {
    const backslash = String.fromCharCode(92);
    return String(value).split(backslash).join(backslash + backslash).split('"').join(backslash + '"').split('\n').join(backslash + 'n');
  }

  /**
   * Size of the active store file. A missing file is zero rather than an error:
   * nothing has been written yet, which is a state and not a fault.
   * @returns {Promise<number>}
   */
  async function storeBytes() {
    try {
      return (await stat(store.file)).size;
    } catch {
      return 0;
    }
  }

  /**
   * The Prometheus exposition. Labeled series appear once they have been observed,
   * while the label-free aggregates and the gauges are always present, so a scrape
   * of a freshly started host is a valid document rather than an empty one.
   * @returns {Promise<string>}
   */
  async function renderMetrics() {
    const lines = [
      '# HELP navi_host_requests_total HTTP requests answered, by route and status.',
      '# TYPE navi_host_requests_total counter'
    ];
    for (const key of [...requestCounts.keys()].sort()) {
      const [route, status] = key.split('|');
      lines.push(`navi_host_requests_total{route="${route}",status="${status}"} ${requestCounts.get(key)}`);
    }
    lines.push(
      '# HELP navi_host_rate_limited_total Ingest requests refused by the per-tenant token bucket.',
      '# TYPE navi_host_rate_limited_total counter'
    );
    for (const tenant of [...rateLimitedByTenant.keys()].sort()) {
      lines.push(`navi_host_rate_limited_total{tenant_id="${escapeLabel(tenant)}"} ${rateLimitedByTenant.get(tenant)}`);
    }
    lines.push(
      '# HELP process_start_time_seconds Process start time in Unix seconds.',
      '# TYPE process_start_time_seconds gauge',
      `process_start_time_seconds ${START_TIME_SECONDS}`,
      '# HELP navi_host_unclean_shutdowns_total Previous store owner did not complete graceful teardown (0 or 1 per boot).',
      '# TYPE navi_host_unclean_shutdowns_total counter',
      `navi_host_unclean_shutdowns_total ${lifecycle.uncleanShutdowns}`,
      '# HELP navi_host_prune_events_total Retention prunes executed, scheduled and on demand.',
      '# TYPE navi_host_prune_events_total counter',
      `navi_host_prune_events_total ${pruneEvents}`,
      '# HELP navi_host_pruned_records_total Expired violation records removed by those prunes.',
      '# TYPE navi_host_pruned_records_total counter',
      `navi_host_pruned_records_total ${prunedRecords}`,
      '# HELP navi_host_active_tenants Tenants currently holding a rate-limit bucket.',
      '# TYPE navi_host_active_tenants gauge',
      `navi_host_active_tenants ${limiter.size}`,
      '# HELP navi_host_store_bytes Size of the active store file on disk, in bytes.',
      '# TYPE navi_host_store_bytes gauge',
      `navi_host_store_bytes ${await storeBytes()}`
    );
    return `${lines.join('\n')}\n`;
  }

  /**
   * Charge one ingest request against its tenant's bucket. Returns the verdict the
   * request proceeds under, or null after answering `429` — in which case the
   * caller must send nothing further. `Retry-After` is whole seconds with a floor
   * of one, because a header asking a client to retry in zero seconds is a loop.
   * @param {import('node:http').ServerResponse} res
   * @param {string} tenantId
   * @returns {RateVerdict | null}
   */
  function chargeIngest(res, tenantId) {
    if (!limiter.enabled) return { allowed: true, remaining: 0, retryAfterSeconds: 0 };
    const verdict = limiter.take(tenantId);
    if (verdict.allowed) return verdict;
    rateLimitedByTenant.set(tenantId, (rateLimitedByTenant.get(tenantId) ?? 0) + 1);
    sendError(res, 429, 'RATE_LIMITED', `Tenant "${tenantId}" has used its ${limiter.perMinute} ingestion requests per minute (burst ${limiter.burst}). Retry after ${verdict.retryAfterSeconds}s; raise NAVI_RATE_LIMIT_PER_MINUTE if this tenant legitimately reports more.`, {
      'Retry-After': String(verdict.retryAfterSeconds),
      'X-RateLimit-Limit': String(limiter.perMinute),
      'X-RateLimit-Remaining': '0'
    });
    return null;
  }

  /** The same counters on an accepted response, so a client can pace itself.
   * @param {RateVerdict} verdict @returns {Record<string, string>} */
  function rateLimitHeaders(verdict) {
    return limiter.enabled ? { 'X-RateLimit-Limit': String(limiter.perMinute), 'X-RateLimit-Remaining': String(verdict.remaining) } : {};
  }

  /**
   * Drop violations past the retention window, for every tenant at once, off the
   * request path. A sweep that fails is reported and retried on the next tick
   * rather than thrown: ingestion is unaffected by a prune that did not happen,
   * and a background timer that can crash the process is worse than a late prune.
   * @returns {Promise<void>}
   */
  async function sweepRetention() {
    if (!(retentionDays > 0) || typeof store.pruneViolations !== 'function') return;
    try {
      const result = await runPrune({ max_age_days: retentionDays });
      if (result.pruned_count > 0) log(`retention: pruned ${result.pruned_count} violation(s) older than ${retentionDays} day(s)`);
    } catch (error) {
      log(`retention sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * One prune, counted once. The scheduled sweep and the maintenance route both
   * come through here so the counters cannot report two different numbers for the
   * same work, and a prune that removed something checkpoints the write-ahead log
   * so the file an operator measures is the file that actually shrank. The
   * checkpoint is best effort: the delete is already durable, and a checkpoint that
   * cannot run must not turn a successful prune into a failure.
   * @param {{max_age_days: number, tenant_id?: string}} options
   * @returns {Promise<{pruned_count: number, remaining_count: number}>}
   */
  async function runPrune(options) {
    pruneEvents += 1;
    const result = await store.pruneViolations(options);
    prunedRecords += result.pruned_count;
    if (result.pruned_count > 0 && typeof store.checkpoint === 'function') {
      try { await store.checkpoint({ truncate: true }); }
      catch (error) { log(`checkpoint after prune failed: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return result;
  }

  const server = createServer((req, res) => {
    // Every response, including errors, 304s and redirects, advertises both
    // relations. Setting it here rather than inside each route is what makes
    // "every response" true by construction instead of by review - including for
    // a route a fork adds later.
    res.setHeader('Link', linkHeader);
    // Every answered request is counted, refusals included: a metric that only
    // counts what the service liked is the one an operator cannot use. The label
    // comes from the closed route set, never from the path that was requested.
    const route = routeLabel(new URL(req.url ?? '/', 'http://localhost').pathname);
    res.on('finish', () => {
      const key = `${route}|${res.statusCode}`;
      requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1);
    });
    track(handle(req, res).catch(error => {
      log(`request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) sendError(res, 500, 'INTERNAL_ERROR', 'The host service failed to handle this request.');
      else res.end();
    }));
  });

  /**
   * Resolve the tenant id from a strict `Authorization: Bearer <token>` header.
   * @param {import('node:http').IncomingMessage} req
   * @returns {string | null}
   */
  function bearerTenant(req) {
    const authorization = req.headers.authorization;
    const match = typeof authorization === 'string' ? /^Bearer ([^\s]+)$/.exec(authorization) : null;
    return match ? tenantFor(tenants, match[1]) : null;
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // Public by design and deliberately unauthenticated: it names the script path
    // every tenant already fetches and the SSE endpoint an operator chose to
    // advertise. A host that overrides NAVI_MCP_SSE_URL is publishing that URL on
    // purpose, and the default is loopback.
    if (path === '/.well-known/navi.json') {
      if (method !== 'GET') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use GET /.well-known/navi.json.');
      const document = await discoveryDocument();
      const etag = `"${createHash('sha256').update(JSON.stringify(document)).digest('base64url')}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag, 'Cache-Control': DISCOVERY_CACHE_CONTROL });
        res.end();
        return;
      }
      return sendJson(res, 200, document, { 'Cache-Control': DISCOVERY_CACHE_CONTROL, ETag: etag });
    }

    // AGPL-3.0 section 13: a user who interacts with this service over a network
    // must be offered the Corresponding Source of the version answering them, at
    // no charge, through a customary means. A redirect to the repository is that
    // offer, and it is public metadata like the discovery document, so it is
    // cached the same way. It is unauthenticated on purpose: an offer a reader has
    // to identify themselves to receive is not an offer to the users of the
    // service.
    if (path === SOURCE_ENDPOINT_PATH) {
      if (method !== 'GET' && method !== 'HEAD') return sendError(res, 405, 'METHOD_NOT_ALLOWED', `Use GET ${SOURCE_ENDPOINT_PATH}.`);
      res.writeHead(302, { Location: sourceUrl, 'Cache-Control': DISCOVERY_CACHE_CONTROL });
      res.end();
      return;
    }

    if (path === '/healthz') {
      if (method !== 'GET') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use GET /healthz.');
      // `retention_days` is configuration rather than health, and it is published
      // here because 0 means "nothing is being pruned": an operator should be able
      // to see that from the same endpoint they use to check the store is up.
      return sendJson(res, 200, { ok: true, mode: store.mode, tenants: tenants.size, retention_days: retentionDays });
    }

    if (path === '/metrics') {
      if (method !== 'GET') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use GET /metrics.');
      return sendMetrics(res, await renderMetrics());
    }

    if (path === '/v1/sitemap/update') {
      if (method !== 'POST') return sendJson(res, 404, { error: 'Not found' });
      const siteId = bearerTenant(req);
      if (!siteId) return sendJson(res, 401, { error: 'Unauthorized' });
      await new Promise(/** @param {(value?: void) => void} resolveBody */ resolveBody => readBody(req, 2 * 1024 * 1024, result => {
        if (result.tooLarge || result.raw === null) {
          sendJson(res, 400, { error: 'Invalid payload' });
          resolveBody();
          return;
        }
        let payload;
        try { payload = JSON.parse(result.raw); }
        catch {
          sendJson(res, 400, { error: 'Invalid payload' });
          resolveBody();
          return;
        }
        if (!validateCrawlerPayload(payload)) {
          sendJson(res, 400, { error: 'Invalid payload' });
          resolveBody();
          return;
        }
        void store.upsertNavigationMap(siteId, payload.url, payload)
          .then(() => sendJson(res, 200, { ok: true, url: payload.url, targets: payload.actions.length }))
          .catch(() => sendJson(res, 500, { error: 'Internal server error' }))
          .finally(() => resolveBody());
      }));
      return;
    }

    if (path === '/v1/navi.js') {
      if (method !== 'GET') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use GET /v1/navi.js?key=<tenant_key>.');
      const tenantId = tenantFor(tenants, url.searchParams.get('key'));
      if (!tenantId) {
        return sendError(res, 401, 'UNAUTHORIZED', 'A valid key query parameter is required. Append ?key=<your tenant key> to the script src; keys are configured with the NAVI_TENANTS environment variable.');
      }
      let bytes;
      try {
        bytes = await readSdk();
      } catch {
        return sendError(res, 503, 'SCRIPT_UNAVAILABLE', 'The browser bundle is not available on this host. Build it with "npm run build" and restart the service.');
      }
      const headers = scriptHeaders();
      if (integrity) {
        const etag = `"${integrity}"`;
        headers.ETag = etag;
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304, headers);
          res.end();
          return;
        }
      }
      headers['Content-Length'] = String(bytes.length);
      res.writeHead(200, headers);
      res.end(bytes);
      return;
    }

    if (path === '/v1/loader.js') {
      if (method !== 'GET') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use GET /v1/loader.js.');
      // The loader carries no tenant key of its own: it reads data-key from the
      // embed tag and appends it to the bundle request, where it is checked.
      let bytes;
      try {
        bytes = await readLoader();
      } catch {
        return sendError(res, 503, 'SCRIPT_UNAVAILABLE', 'The tenant loader is not available on this host. Build it with "npm run build" and restart the service.');
      }
      const headers = scriptHeaders();
      headers['Content-Length'] = String(bytes.length);
      res.writeHead(200, headers);
      res.end(bytes);
      return;
    }

    // The MCP server posts here when it refuses a destination, so a tenant can
    // read back what its agents were stopped from reaching. The reporter's key is
    // checked before the body is read: a caller who cannot name a tenant should
    // not be able to make this service parse anything.
    if (path === '/v1/telemetry/violations') {
      if (method !== 'POST') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use POST /v1/telemetry/violations.');
      const violationType = String(req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
      if (violationType !== 'application/json') {
        return sendError(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Send a violation as application/json. This route is machine-to-machine: page code has no reason to call it.');
      }
      const violationLength = Number(req.headers['content-length'] ?? '');
      if (Number.isFinite(violationLength) && violationLength > MAX_PAYLOAD_BYTES) {
        req.resume();
        return sendError(res, 413, 'PAYLOAD_TOO_LARGE', `Violation bodies are limited to ${MAX_PAYLOAD_BYTES} bytes.`, { Connection: 'close' });
      }
      const authorization = req.headers.authorization;
      let presented = url.searchParams.get('key');
      if (typeof authorization === 'string') {
        if (!authorization.startsWith('Bearer ')) {
          return sendError(res, 401, 'UNAUTHORIZED', 'Use "Authorization: Bearer <tenant_key>", or omit the header and send ?key=<tenant_key>.');
        }
        presented = authorization.slice('Bearer '.length).trim();
      }
      const keyTenantId = presented ? tenantFor(tenants, presented) : null;
      if (presented && !keyTenantId) return sendError(res, 401, 'UNKNOWN_TENANT', 'The presented tenant key is not registered.');
      // A presented key names the tenant before the body is read, so the quota is
      // charged now: a caller over its ceiling cannot make this service parse or
      // store anything at all. Without a key the tenant arrives in the payload, and
      // the charge waits for validation so a malformed body is still a 400.
      const keyCharge = keyTenantId ? chargeIngest(res, keyTenantId) : null;
      if (keyTenantId && !keyCharge) return;

      await new Promise(/** @param {(value?: void) => void} resolveBody */ resolveBody => {
        readBody(req, MAX_PAYLOAD_BYTES, result => {
          if (result.tooLarge) {
            sendError(res, 413, 'PAYLOAD_TOO_LARGE', `Violation bodies are limited to ${MAX_PAYLOAD_BYTES} bytes.`, { Connection: 'close' });
            resolveBody();
            return;
          }
          if (result.raw === null) {
            sendError(res, 400, 'INVALID_PAYLOAD', 'The request body could not be read.');
            resolveBody();
            return;
          }
          /** @type {unknown} */
          let payload;
          try {
            payload = JSON.parse(result.raw);
          } catch {
            sendError(res, 400, 'INVALID_PAYLOAD', 'The body must be valid JSON.');
            resolveBody();
            return;
          }
          const verdict = validateViolation(payload, allowedTenantIds, keyTenantId);
          if (!verdict.ok) {
            sendError(res, verdict.status, verdict.code, verdict.message);
            resolveBody();
            return;
          }
          const charge = keyCharge ?? chargeIngest(res, verdict.record.tenant_id);
          if (!charge) {
            resolveBody();
            return;
          }
          void store
            .recordViolation(verdict.record)
            .then(record => sendJson(res, 202, { ok: true, accepted: true, tenant_id: record.tenant_id, id: record.id }, rateLimitHeaders(charge)))
            .catch(error => sendError(res, 500, 'STORE_FAILED', `The violation could not be stored: ${error instanceof Error ? error.message : String(error)}`))
            .finally(() => resolveBody());
        });
      });
      return;
    }

    // The audit read is keyed on a Bearer token rather than a query parameter,
    // because a query string is the one part of a request that lands in URLs,
    // referrers and proxy logs. A key is checked before the tenant in the path is
    // compared, so an unauthenticated caller cannot probe which tenants exist.
    const auditMatch = AUDIT_ENDPOINT_PATTERN.exec(path);
    if (auditMatch) {
      if (method !== 'GET') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use GET /v1/tenants/<tenant_id>/security-audit.');
      const authorization = req.headers.authorization;
      const token = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';
      const tenantId = tenantFor(tenants, token);
      if (!tenantId) {
        return sendError(res, 401, 'UNAUTHORIZED', 'An audit read requires "Authorization: Bearer <tenant_key>"; query-string keys are not accepted on this route.');
      }
      let requested = '';
      try {
        requested = decodeURIComponent(String(auditMatch[1] ?? ''));
      } catch {
        return sendError(res, 400, 'INVALID_PAYLOAD', 'The tenant id in the path is not valid percent-encoding.');
      }
      if (requested !== tenantId) {
        return sendError(res, 403, 'FORBIDDEN', `The presented key resolves to "${tenantId}", not "${requested}". An audit read is confined to its own tenant.`);
      }
      const limitRaw = url.searchParams.get('limit');
      const limit = limitRaw === null ? DEFAULT_VIOLATION_LIMIT : Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_VIOLATION_LIMIT) {
        return sendError(res, 400, 'INVALID_PAYLOAD', `limit must be an integer between 1 and ${MAX_VIOLATION_LIMIT}.`);
      }
      const since = url.searchParams.get('since');
      if (since !== null && Number.isNaN(Date.parse(since))) {
        return sendError(res, 400, 'INVALID_PAYLOAD', 'since must be an ISO-8601 timestamp such as 2026-10-11T00:00:00.000Z.');
      }
      const violations = await store.queryViolations(since === null ? { tenant_id: tenantId, limit } : { tenant_id: tenantId, limit, since });
      return sendJson(res, 200, { ok: true, tenant_id: tenantId, count: violations.length, limit, since, violations }, { 'Cache-Control': 'no-store, private' });
    }

    // Maintenance is a tenant-scoped write, so it is authenticated exactly as the
    // audit read is: a Bearer key, never a query string, and never another tenant's
    // records. Deleting by tenant is the one thing this route can do, and the
    // tenant it deletes for is the key's, not the path's.
    const pruneMatch = PRUNE_ENDPOINT_PATTERN.exec(path);
    if (pruneMatch) {
      if (method !== 'POST') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use POST /v1/tenants/<tenant_id>/maintenance/prune.');
      const authorization = req.headers.authorization;
      const token = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';
      const tenantId = tenantFor(tenants, token);
      if (!tenantId) {
        return sendError(res, 401, 'UNAUTHORIZED', 'A prune requires "Authorization: Bearer <tenant_key>"; query-string keys are not accepted on this route.');
      }
      let requested = '';
      try {
        requested = decodeURIComponent(String(pruneMatch[1] ?? ''));
      } catch {
        return sendError(res, 400, 'INVALID_PAYLOAD', 'The tenant id in the path is not valid percent-encoding.');
      }
      if (requested !== tenantId) {
        return sendError(res, 403, 'FORBIDDEN', `The presented key resolves to "${tenantId}", not "${requested}". A prune is confined to its own tenant.`);
      }
      // A disabled sweep is not a disabled route: an explicit window still works,
      // and its default is the configured retention — never the value that means
      // "do not sweep", which would read as "prune nothing" and delete nothing.
      const defaultDays = retentionDays > 0 ? retentionDays : DEFAULT_RETENTION_DAYS;
      const pruneType = String(req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
      const pruneLength = Number(req.headers['content-length'] ?? '');
      if (Number.isFinite(pruneLength) && pruneLength > MAX_PAYLOAD_BYTES) {
        req.resume();
        return sendError(res, 413, 'PAYLOAD_TOO_LARGE', `Prune bodies are limited to ${MAX_PAYLOAD_BYTES} bytes.`, { Connection: 'close' });
      }
      await new Promise(/** @param {(value?: void) => void} resolvePrune */ resolvePrune => {
        readBody(req, MAX_PAYLOAD_BYTES, result => {
          if (result.tooLarge) {
            sendError(res, 413, 'PAYLOAD_TOO_LARGE', `Prune bodies are limited to ${MAX_PAYLOAD_BYTES} bytes.`, { Connection: 'close' });
            resolvePrune();
            return;
          }
          const raw = (result.raw ?? '').trim();
          /** @type {Record<string, unknown>} */
          let payload = {};
          if (raw) {
            if (pruneType !== 'application/json') {
              sendError(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Send a prune window as application/json, or omit the body to use the configured retention.');
              resolvePrune();
              return;
            }
            /** @type {unknown} */
            let parsed;
            try {
              parsed = JSON.parse(raw);
            } catch {
              sendError(res, 400, 'INVALID_PAYLOAD', 'The body must be valid JSON.');
              resolvePrune();
              return;
            }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
              sendError(res, 400, 'INVALID_PAYLOAD', 'The body must be a JSON object such as {"max_age_days": 30}, or absent.');
              resolvePrune();
              return;
            }
            payload = /** @type {Record<string, unknown>} */ (parsed);
          }
          const unknown = Object.keys(payload).filter(key => key !== 'max_age_days');
          if (unknown.length) {
            sendError(res, 400, 'INVALID_PAYLOAD', `Unknown field(s): ${unknown.join(', ')}. The only accepted field is max_age_days.`);
            resolvePrune();
            return;
          }
          const days = payload.max_age_days === undefined ? defaultDays : payload.max_age_days;
          // Strictly a number: a numeric string is a different client contract, and
          // accepting one here would quietly make `"0"` mean something.
          if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MAX_RETENTION_DAYS) {
            sendError(res, 400, 'INVALID_PAYLOAD', `max_age_days must be an integer between 1 and ${MAX_RETENTION_DAYS}.`);
            resolvePrune();
            return;
          }
          void runPrune({ max_age_days: days, tenant_id: tenantId })
            .then(result => sendJson(res, 200, { ok: true, tenant_id: tenantId, max_age_days: days, pruned_count: result.pruned_count, remaining_count: result.remaining_count }))
            .catch(error => sendError(res, 500, 'STORE_FAILED', `The prune failed: ${error instanceof Error ? error.message : String(error)}`))
            .finally(() => resolvePrune());
        });
      });
      return;
    }

    if (path === '/v1/telemetry') {
      if (method === 'GET') {
        const tenantId = tenantFor(tenants, url.searchParams.get('key'));
        if (!tenantId) {
          return sendError(res, 401, 'UNAUTHORIZED', 'A valid key query parameter is required to read a tenant summary.');
        }
        return sendJson(res, 200, { ok: true, tenant_id: tenantId, summary: await store.summarize({ tenant_id: tenantId }) });
      }
      if (method !== 'POST') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use POST /v1/telemetry.');

      const keyTenantId = bearerTenant(req);
      if (!keyTenantId) {
        return sendJson(res, 401, { error: 'Unauthorized' });
      }

      const contentType = String(req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
      if (contentType !== 'application/json' && contentType !== 'text/plain') {
        return sendError(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the beacon as application/json, or as a text/plain JSON string the way navigator.sendBeacon does by default.');
      }
      const declaredLength = Number(req.headers['content-length'] ?? '');
      if (Number.isFinite(declaredLength) && declaredLength > MAX_PAYLOAD_BYTES) {
        req.resume();
        return sendError(res, 413, 'PAYLOAD_TOO_LARGE', `Telemetry bodies are limited to ${MAX_PAYLOAD_BYTES} bytes.`, { Connection: 'close' });
      }

      await new Promise(/** @param {(value?: void) => void} resolveBody */ resolveBody => {
        readBody(req, MAX_PAYLOAD_BYTES, result => {
          if (result.tooLarge) {
            sendError(res, 413, 'PAYLOAD_TOO_LARGE', `Telemetry bodies are limited to ${MAX_PAYLOAD_BYTES} bytes.`, { Connection: 'close' });
            resolveBody();
            return;
          }
          if (result.raw === null) {
            sendError(res, 400, 'INVALID_PAYLOAD', 'The request body could not be read.');
            resolveBody();
            return;
          }
          /** @type {unknown} */
          let payload;
          try {
            payload = JSON.parse(result.raw);
          } catch {
            sendError(res, 400, 'INVALID_PAYLOAD', 'The body must be valid JSON. Raw DOM or HTML text is not accepted.');
            resolveBody();
            return;
          }
          const verdict = validateTelemetry(payload, allowedTenantIds, keyTenantId);
          if (!verdict.ok) {
            if (verdict.status === 401 && verdict.code === 'UNAUTHORIZED') {
              sendJson(res, 401, { error: 'Unauthorized' });
            } else {
              sendError(res, verdict.status, verdict.code, verdict.message);
            }
            resolveBody();
            return;
          }
          const charge = chargeIngest(res, verdict.record.tenant_id);
          if (!charge) {
            resolveBody();
            return;
          }
          const record = { ...verdict.record, received_at: new Date().toISOString() };
          void store
            .append(record)
            .then(() => sendJson(res, 202, { ok: true, accepted: true, tenant_id: record.tenant_id, url_origin: record.url_origin }, rateLimitHeaders(charge)))
            .catch(error => sendError(res, 500, 'STORE_FAILED', `The aggregate could not be stored: ${error instanceof Error ? error.message : String(error)}`))
            .finally(() => resolveBody());
        });
      });
      return;
    }

    return sendError(res, 404, 'NOT_FOUND', `No route for ${method} ${path}.`);
  }

  await new Promise(/** @param {(value?: void) => void} resolveListen @param {(reason?: unknown) => void} rejectListen */ (resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(requestedPort, host, () => {
      server.removeListener('error', rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : requestedPort;
  // A restart is exactly when an unattended store needs a sweep, so the first one
  // runs now and the interval only has to cover a process that stays up. The timer
  // is unref'd: it must never be the reason a process is still alive.
  const retentionTimer = retentionDays > 0 && typeof store.pruneViolations === 'function'
    ? (() => {
      const timer = setInterval(() => { track(sweepRetention()); }, retentionIntervalMs);
      timer.unref?.();
      return timer;
    })()
    : null;
  track(sweepRetention());
  log(`listening on http://${host}:${boundPort} (store: ${store.mode}, tenants: ${tenants.size}, retention: ${retentionDays > 0 ? `${retentionDays}d` : 'off'}, rate limit: ${limiter.enabled ? `${limiter.perMinute}/min burst ${limiter.burst}` : 'off'})`);

  /** @type {Promise<void> | null} */
  let closePromise = null;
  return {
    server,
    port: boundPort,
    host,
    store,
    tenants,
    limiter,
    retention: { days: retentionDays, intervalMs: retentionIntervalMs },
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        if (retentionTimer) clearInterval(retentionTimer);
        limiter.close();
        // Stop accepting, then give in-flight requests a bounded chance to finish. A
        // connection that is neither idle nor finished - a client that opened a
        // socket and stopped mid-request - is destroyed when the deadline passes: a
        // shutdown one peer can hold open forever is not a shutdown.
        let timer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
        const deadline = new Promise(/** @param {(value: string) => void} resolveDeadline */ resolveDeadline => {
          timer = setTimeout(() => {
            server.closeAllConnections();
            resolveDeadline('deadline');
          }, SHUTDOWN_DEADLINE_MS);
          timer.unref?.();
        });
        const drained = new Promise(/** @param {(value: string) => void} resolveDrained */ resolveDrained => server.close(() => resolveDrained('drained')));
        const outcome = await Promise.race([drained, deadline]);
        if (timer) clearTimeout(timer);
        if (outcome === 'deadline') log(`shutdown deadline of ${SHUTDOWN_DEADLINE_MS}ms passed with connections still open; they were closed`);
        // HTTP close alone does not join handlers already awaiting a store write,
        // or the scheduled prune. Neither may write behind the final checkpoint.
        await drained;
        await Promise.all([...activeTasks]);
        // Always release the store, even on checkpoint failure, but never write a
        // clean marker for a failed or busy final checkpoint.
        try {
          if (typeof store.checkpoint === 'function') {
            const checkpoint = await store.checkpoint({ truncate: true });
            if (checkpoint.busy !== 0) throw new Error('final checkpoint was busy');
          }
        } finally {
          await store.close();
        }
        await lifecycle.markClean();
      })();
      return closePromise;
    }
  };
}

/** @param {string[]} argv @param {string} flag @returns {string | null} */
function option(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? null : argv[index + 1] ?? null;
}

/**
 * CLI entry point.
 * @param {string[]} [argv]
 * @returns {Promise<number>} process exit code
 */
export async function main(argv = []) {
  if (argv.includes('--help')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const host = option(argv, '--host') ?? DEFAULT_HOST;
  const portFlag = Number(option(argv, '--port') ?? DEFAULT_PORT);
  const port = Number.isInteger(portFlag) && portFlag >= 0 ? portFlag : DEFAULT_PORT;
  const storeFile = option(argv, '--store') ?? resolve(DEFAULT_STORE_FILE);
  // Diagnostics go to stderr through the host's own logger rather than nowhere:
  // a drained shutdown, a failed request and a retention sweep are exactly the
  // events an operator reads the log for, and stdout stays the readiness line.
  const naviHost = await createNaviHostServer({ host, port, storeFile, log: line => process.stderr.write(`navi-host: ${line}\n`) });
  process.stdout.write(`navi-host: http://${host}:${naviHost.port} (tenants: ${naviHost.tenants.size}, store: ${naviHost.store.mode})\n`);
  /** @type {string | null} */
  let signalled = null;
  await new Promise(/** @param {(value?: void) => void} resolveSignal */ resolveSignal => {
    /** @type {Record<string, () => void>} */
    const handlers = {};
    for (const signal of ['SIGINT', 'SIGTERM']) {
      handlers[signal] = () => {
        signalled = signal;
        // Both listeners are removed, so a second signal reaches the default
        // action: an operator who insists stops the process instead of waiting out
        // a drain that is already stuck.
        for (const [name, handler] of Object.entries(handlers)) process.removeListener(name, handler);
        resolveSignal();
      };
      process.on(signal, handlers[signal]);
    }
  });
  process.stderr.write(`navi-host: ${signalled} received, draining for up to ${SHUTDOWN_DEADLINE_MS / 1000}s\n`);
  await naviHost.close();
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    process.stderr.write(`navi-host: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
