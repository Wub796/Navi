// Navi host service: tenant-keyed script distribution and telemetry ingestion.
//
// Deliberately built on `node:http` with no framework, no middleware chain and
// no runtime dependency, so it can be dropped next to a CDN or run as a sidecar
// without a build step. This file is the composition root: it resolves
// configuration, owns the store/lifecycle and the server, and dispatches to the
// route modules beside it.
//
//   GET  /                              the product landing page (same document as the edge)
//   GET  /v1/navi.js?key=<tenant_key>   serve the shipped browser bundle
//   GET  /v1/loader.js                  serve the tenant embed loader
//   POST /v1/telemetry                  ingest one navigator.sendBeacon payload
//   POST /v1/sitemap/update             ingest a tenant's semantic action map
//   GET  /v1/sitemap/openapi.json       compile that map into OpenAPI 3.1 workflows
//   GET  /v1/telemetry?key=<tenant_key> read that tenant's aggregate
//   POST /v1/telemetry/violations       ingest one containment violation
//   GET  /v1/tenants/<id>/security-audit read that tenant's blocked destinations
//   POST /v1/tenants/<id>/maintenance/prune  prune that tenant's expired records
//   POST /v1/billing/webhook            provision or revoke a tenant from Stripe
//   GET  /v1/billing/session?session_id=cs_...   one-time API-key claim
//   GET  /v1/billing/success?session_id=cs_...   the same claim as a page
//   GET  /healthz                       liveness, store mode and tenant count
//   GET  /metrics                       Prometheus counters for a scraper
//   GET  /.well-known/navi.json         public agent discovery document
//   GET  /v1/source                     names the source of the running version
//
// Every response carries two `Link` relations: `rel="agent-bridge"` on
// `/.well-known/navi.json`, so an agent that can reach any route of this host can
// find the document without knowing its path, and `rel="source"` on this version's
// running version, so a tenant can find the code answering its requests. Both
// relations
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
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beginProcessLifecycle, createStore, DEFAULT_RETENTION_DAYS } from './store.js';
import { loadTenants, tenantIds } from './tenants.js';
import { createBillingRoutes } from './billing.js';
import { createHostMetrics } from './metrics.js';
import { createIngestRoutes } from './ingest.js';
import { createMaintenanceRoutes } from './maintenance.js';
import { createPublicRoutes } from './public-routes.js';
import { createQuota } from './quota.js';
import { RATE_LIMIT_BURST, RATE_LIMIT_PER_MINUTE, createRateLimiter } from './rate-limit.js';
import { sendError } from './http.js';
import {
  AGENT_BRIDGE_LINK, AUDIT_ENDPOINT_PATTERN, BILLING_ENDPOINT_PATH, BILLING_SESSION_ENDPOINT_PATH,
  BILLING_SUCCESS_ENDPOINT_PATH, DEFAULT_MCP_SSE_URL, DISCOVERY_ENDPOINT_PATH, HEALTH_ENDPOINT_PATH,
  LOADER_ENDPOINT_PATH, METRICS_ENDPOINT_PATH, PRUNE_ENDPOINT_PATTERN, SCRIPT_ENDPOINT_PATH,
  SITEMAP_ENDPOINT_PATH, SOURCE_ENDPOINT_PATH, SOURCE_REPOSITORY_URL, TELEMETRY_ENDPOINT_PATH,
  VIOLATION_ENDPOINT_PATH, WORKFLOWS_ENDPOINT_PATH, routeLabel
} from './endpoints.js';

export const DEFAULT_PORT = 8790;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_STORE_FILE = 'server/telemetry.db';
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

// The constants every route and every test shares are defined once in the module
// that owns them; they are re-exported here because `server/index.js` is the host
// service's public surface, and a caller should not have to know the file layout.
export { MAX_PAYLOAD_BYTES } from './http.js';
export {
  AGENT_BRIDGE_LINK, AGENT_CAPABILITIES, AUDIT_ENDPOINT_PATTERN, BILLING_ENDPOINT_PATH,
  BILLING_SESSION_ENDPOINT_PATH, BILLING_SUCCESS_ENDPOINT_PATH, DEFAULT_MCP_SSE_URL,
  DISCOVERY_CACHE_CONTROL, MCP_PROTOCOL_REVISION, NAVI_PROTOCOL_VERSION, PRUNE_ENDPOINT_PATTERN,
  SCRIPT_CACHE_CONTROL, SCRIPT_CORS, SCRIPT_ENDPOINT_PATH, SOURCE_ENDPOINT_PATH, SOURCE_REPOSITORY_URL,
  WORKFLOWS_ENDPOINT_PATH
} from './endpoints.js';
export {
  CHECKOUT_CLAIM_TTL_MS, MAX_BILLING_PAYLOAD_BYTES, PROVISIONING_EVENT_TYPES,
  REVOCATION_EVENT_TYPE, STRIPE_SIGNATURE_TOLERANCE_SECONDS, TENANT_KEY_BYTES,
  metadataInteger, parseAllowedOrigins, parseStripeSignature, verifyStripeSignature
} from './billing.js';
export {
  MAX_COUNTER, MAX_SESSION_ID_CHARS, MAX_VIOLATION_URL_CHARS, TELEMETRY_FIELDS,
  VIOLATION_CATEGORIES, VIOLATION_FIELDS
} from './ingest.js';
export {
  RATE_LIMIT_BURST, RATE_LIMIT_IDLE_MS, RATE_LIMIT_PER_MINUTE, RATE_LIMIT_SWEEP_MS,
  RATE_LIMIT_SWEEP_THRESHOLD, createRateLimiter
} from './rate-limit.js';

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
  GET  /                              product landing page
  GET  /v1/navi.js?key=<tenant_key>
  GET  /v1/loader.js
  GET  /v1/sitemap/openapi.json?key=<tenant_key>
                                      latest stored sitemap as OpenAPI 3.1 workflows
  POST /v1/telemetry
  GET  /v1/telemetry?key=<tenant_key>
  POST /v1/telemetry/violations
  POST /v1/billing/webhook            provision or revoke a tenant from Stripe
  GET  /v1/billing/session?session_id=cs_...
                                      one-time post-checkout API-key claim
  GET  /v1/billing/success?session_id=cs_...
                                      the same claim, rendered as an onboarding page
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
  NAVI_SOURCE_URL  Source offered at /v1/source and advertised as rel="source" on
                   every response. Defaults to https://github.com/Wub796/Navi.
                   Set it to your own repository when serving a modified version:
                   the useful pointer is the source of the version running.
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
  NAVI_MAX_EVENTS_PER_WINDOW
                           Ingest events allowed per quota window, for tenants that
                           do not set their own. Default 0 (unmetered); a request
                           past the ceiling is 429 with Retry-After.
  NAVI_QUOTA_WINDOW_SECONDS
                           Length of that quota window. Default 3600.
  NAVI_STRIPE_WEBHOOK_SECRET
                           Stripe signing secret for POST /v1/billing/webhook.
                           Unset disables the route with 503, because a webhook
                           without a secret cannot tell Stripe from anyone else.
  STRIPE_PAYMENT_LINK_STARTER
  STRIPE_PAYMENT_LINK_PRO  (or the legacy STRIPE_PAYMENT_LINK_URL)
  STRIPE_PAYMENT_LINK_ENTERPRISE
                           Payment Links rendered as each paid card's call to
                           action on GET /. Unset cards are listed but not sold,
                           exactly as on the edge deployment.
  NAVI_METRICS_TOKEN       When set, GET /metrics requires
                           "Authorization: Bearer <token>" and answers 401
                           without it. Unset keeps the scrape unauthenticated,
                           which is what a healthcheck expects.
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
 * The store surface this service depends on, declared structurally so the host
 * does not care which backend ({@link createStore}) resolved to.
 * @typedef {{mode: 'sqlite' | 'log', file: string, append(record: unknown): Promise<void>, summarize(filter?: {tenant_id?: string}): Promise<any>, upsertNavigationMap(siteId: string, url: string, payload: object): Promise<void>, readNavigationMap(siteId: string, url: string): Promise<any>, readLatestNavigationMap(siteId: string): Promise<any>, consumeQuota?(options: {tenant_id: string, max_events_per_window: number, window_seconds?: number}): Promise<{allowed: boolean, count: number, remaining: number, retry_after_seconds: number}>, readQuota?(tenantId: string): Promise<{tenant_id: string, window_start_ms: number, event_count: number} | null>, upsertTenantDefinition(definition: {tenant_id: string, api_key: string, allowed_origins?: string[], max_events_per_window?: number | null, window_seconds?: number, status?: 'active' | 'suspended'}): Promise<{tenant_id: string, api_key: string, allowed_origins: string[], max_events_per_window: number | null, window_seconds: number, status: 'active' | 'suspended', updated_at: string}>, readTenantDefinition(tenantId: string): Promise<{tenant_id: string, api_key: string, allowed_origins: string[], max_events_per_window: number | null, window_seconds: number, status: 'active' | 'suspended', updated_at: string} | null>, readTenantDefinitions(): Promise<{tenant_id: string, api_key: string, allowed_origins: string[], max_events_per_window: number | null, window_seconds: number, status: 'active' | 'suspended', updated_at: string}[]>, recordWebhookEvent?(eventId: string, receivedAtMs?: number): Promise<boolean>, releaseWebhookEvent?(eventId: string): Promise<void>, applyWebhookEvent?(mutation: {event_id?: string | null, received_at_ms?: number, definition?: {tenant_id: string, api_key: string, allowed_origins?: string[], max_events_per_window?: number | null, window_seconds?: number, status?: 'active' | 'suspended'} | null, checkout_claim?: {session_id: string, tenant_id: string, api_key: string, expires_at_ms?: number} | null}): Promise<{duplicate: boolean, record: {tenant_id: string, api_key: string, allowed_origins: string[], max_events_per_window: number | null, window_seconds: number, status: 'active' | 'suspended', updated_at: string} | null}>, recordCheckoutClaim?(claim: {session_id: string, tenant_id: string, api_key: string, expires_at_ms?: number}): Promise<{session_id: string, tenant_id: string, api_key: string, expires_at_ms: number}>, consumeCheckoutClaim?(sessionId: string, nowMs?: number): Promise<{tenant_id: string, api_key: string} | null>, recordViolation(violation: any): Promise<{tenant_id: string, id: number}>, queryViolations(filter: {tenant_id: string, limit?: number, since?: string}): Promise<any[]>, pruneViolations(options: {max_age_days: number, tenant_id?: string}): Promise<{pruned_count: number, remaining_count: number}>, checkpoint(options?: {truncate?: boolean}): Promise<{busy: number, log: number, checkpointed: number}>, reset(): Promise<void>, close(): Promise<void>}} StoreLike
 * @typedef {{host?: string, port?: number, tenants?: import('./tenants.js').TenantRegistry, store?: StoreLike | null, storeFile?: string, sdkPath?: string, loaderPath?: string, integrity?: string | null, mcpSseUrl?: string, sourceUrl?: string, log?: (line: string) => void, retentionDays?: number, retentionIntervalMs?: number, rateLimiter?: import('./rate-limit.js').RateLimiter, maxEventsPerWindow?: number, quotaWindowSeconds?: number, metricsToken?: string, stripeWebhookSecret?: string}} HostOptions
 * @typedef {{server: import('node:http').Server, port: number, host: string, store: StoreLike, tenants: import('./tenants.js').TenantRegistry, limiter: import('./rate-limit.js').RateLimiter, retention: {days: number, intervalMs: number}, close(): Promise<void>}} NaviHost
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
  /**
   * Publish one persisted tenant definition into the live registry. The key is the
   * lookup the ingest routes perform, so this is what makes a provisioned tenant
   * usable on the very next request, and what makes a revocation take effect before
   * the store write has even returned to the caller.
   * @param {{tenant_id: string, api_key: string, allowed_origins: string[], max_events_per_window: number | null, window_seconds: number}} definition
   */
  function registerTenantDefinition(definition) {
    tenants.set(definition.api_key, {
      id: definition.tenant_id,
      allowed_origins: definition.allowed_origins,
      max_events_per_window: definition.max_events_per_window,
      window_seconds: definition.window_seconds
    });
    allowedTenantIds.add(definition.tenant_id);
  }
  // Provisioned tenants are configuration that outlives the process: register every
  // persisted definition into the live registry before the first request, so a key
  // sold last month still authenticates after a restart.
  if (typeof store.readTenantDefinitions === 'function') {
    for (const definition of await store.readTenantDefinitions()) registerTenantDefinition(definition);
  }
  const sourceUrl = options.sourceUrl ?? process.env.NAVI_SOURCE_URL ?? SOURCE_REPOSITORY_URL;
  const retentionDays = options.retentionDays ?? countFromEnv(process.env.NAVI_RETENTION_DAYS, DEFAULT_RETENTION_DAYS);
  const retentionIntervalMs = Math.max(50, options.retentionIntervalMs ?? RETENTION_SWEEP_INTERVAL_MS);
  const defaultMaxEventsPerWindow = options.maxEventsPerWindow ?? countFromEnv(process.env.NAVI_MAX_EVENTS_PER_WINDOW, 0);
  const defaultQuotaWindowSeconds = options.quotaWindowSeconds ?? countFromEnv(process.env.NAVI_QUOTA_WINDOW_SECONDS, 3600);
  // Empty means "no credential": `/metrics` stays reachable the way `/healthz` is,
  // which is what a container healthcheck and a default Prometheus scrape expect.
  // Setting it makes the scrape an operator-only read without changing the route.
  const metricsToken = (options.metricsToken ?? process.env.NAVI_METRICS_TOKEN ?? '').trim();
  // Empty means the billing route is closed: it answers 503 rather than trusting
  // an unsigned body, because a webhook without a secret cannot tell Stripe from
  // anyone who found the URL.
  const stripeWebhookSecret = (options.stripeWebhookSecret ?? process.env.NAVI_STRIPE_WEBHOOK_SECRET ?? '').trim();
  // The limiter is per process, exactly like the store it protects: two replicas
  // behind one address each allow the full rate, so enforcement belongs at the
  // shared edge once there is more than one.
  const limiter = options.rateLimiter ?? createRateLimiter({
    perMinute: countFromEnv(process.env.NAVI_RATE_LIMIT_PER_MINUTE, RATE_LIMIT_PER_MINUTE),
    burst: countFromEnv(process.env.NAVI_RATE_LIMIT_BURST, RATE_LIMIT_BURST)
  });
  /** @type {ReturnType<typeof createHostMetrics>} */
  let metrics;
  const quota = createQuota({
    store,
    tenants,
    maxEventsPerWindow: defaultMaxEventsPerWindow,
    quotaWindowSeconds: defaultQuotaWindowSeconds,
    onExceeded: tenantId => metrics.quotaExceeded(tenantId)
  });
  metrics = createHostMetrics({ store, limiter, lifecycle, quota });
  /**
   * Both relations in one header value, on every response this service emits: the
   * discovery document and the source of the running version. RFC 8288 allows several
   * comma-separated entries, and `agentBridgeLink` in the MCP server already
   * splits them, so the reader that follows `rel="agent-bridge"` is unaffected by
   * the second relation.
   */
  const linkHeader = `${AGENT_BRIDGE_LINK}, <${sourceUrl}>; rel="source"`;

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
    metrics.pruneAttempt();
    const result = await store.pruneViolations(options);
    metrics.prunedRecords(result.pruned_count);
    if (result.pruned_count > 0 && typeof store.checkpoint === 'function') {
      try { await store.checkpoint({ truncate: true }); }
      catch (error) { log(`checkpoint after prune failed: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return result;
  }

  const paymentLinks = {
    starter: process.env.STRIPE_PAYMENT_LINK_STARTER,
    pro: process.env.STRIPE_PAYMENT_LINK_PRO ?? process.env.STRIPE_PAYMENT_LINK_URL,
    enterprise: process.env.STRIPE_PAYMENT_LINK_ENTERPRISE
  };
  const publicRoutes = createPublicRoutes({
    store, tenants, metrics, retentionDays, sdkPath, loaderPath, integrity, mcpSseUrl, sourceUrl, metricsToken, paymentLinks
  });
  const billingRoutes = createBillingRoutes({ store, stripeWebhookSecret, log, registerTenantDefinition });
  const ingestRoutes = createIngestRoutes({ store, tenants, allowedTenantIds, limiter, quota, metrics });
  const maintenanceRoutes = createMaintenanceRoutes({ store, tenants, retentionDays, runPrune });

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (path === '/') return publicRoutes.landing(req, res);
    if (path === '/robots.txt') return publicRoutes.robots(req, res);
    if (path === '/sitemap.xml') return publicRoutes.sitemapXml(req, res);
    if (path === '/favicon.svg') return publicRoutes.favicon(req, res);
    if (path === '/logo.svg') return publicRoutes.logo(req, res);
    if (path === DISCOVERY_ENDPOINT_PATH) return publicRoutes.discovery(req, res);
    if (path === SOURCE_ENDPOINT_PATH) return publicRoutes.source(req, res);
    if (path === HEALTH_ENDPOINT_PATH) return publicRoutes.health(req, res);
    if (path === METRICS_ENDPOINT_PATH) return publicRoutes.scrape(req, res);
    if (path === BILLING_ENDPOINT_PATH) return billingRoutes.webhook(req, res);
    if (path === BILLING_SESSION_ENDPOINT_PATH) return billingRoutes.session(req, res, url);
    if (path === BILLING_SUCCESS_ENDPOINT_PATH) return billingRoutes.success(req, res, url);
    if (path === SITEMAP_ENDPOINT_PATH) return ingestRoutes.sitemap(req, res);
    if (path === WORKFLOWS_ENDPOINT_PATH) return ingestRoutes.workflows(req, res, url);
    if (path === SCRIPT_ENDPOINT_PATH) return publicRoutes.script(req, res, url);
    if (path === LOADER_ENDPOINT_PATH) return publicRoutes.loader(req, res);
    if (path === VIOLATION_ENDPOINT_PATH) return ingestRoutes.violations(req, res, url);
    const auditMatch = AUDIT_ENDPOINT_PATTERN.exec(path);
    if (auditMatch) return maintenanceRoutes.audit(req, res, url, String(auditMatch[1] ?? ''));
    const pruneMatch = PRUNE_ENDPOINT_PATTERN.exec(path);
    if (pruneMatch) return maintenanceRoutes.prune(req, res, String(pruneMatch[1] ?? ''));
    if (path === TELEMETRY_ENDPOINT_PATH) return ingestRoutes.telemetry(req, res, url);
    return sendError(res, 404, 'NOT_FOUND', `No route for ${req.method ?? 'GET'} ${path}.`);
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
    res.on('finish', () => metrics.count(route, res.statusCode));
    track(handle(req, res).catch(error => {
      log(`request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) sendError(res, 500, 'INTERNAL_ERROR', 'The host service failed to handle this request.');
      else res.end();
    }));
  });

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
