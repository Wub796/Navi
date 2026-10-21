// Route identity for the Navi host service.
//
// The literal paths, cache policies and advertised protocol names live here, apart
// from the handlers that answer them, because two modules need the same literal:
// the route that serves `/v1/navi.js` and the metric label that counts it. One
// definition is one chance to disagree, where two is two.

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

export const DISCOVERY_ENDPOINT_PATH = '/.well-known/navi.json';
export const SCRIPT_ENDPOINT_PATH = '/v1/navi.js';
export const LOADER_ENDPOINT_PATH = '/v1/loader.js';
export const TELEMETRY_ENDPOINT_PATH = '/v1/telemetry';
export const VIOLATION_ENDPOINT_PATH = '/v1/telemetry/violations';
export const SITEMAP_ENDPOINT_PATH = '/v1/sitemap/update';
/**
 * The compiled workflow surface for a tenant's latest stored sitemap. A read, so
 * it sits beside the write it is derived from rather than becoming a second write.
 */
export const WORKFLOWS_ENDPOINT_PATH = '/v1/sitemap/openapi.json';
export const HEALTH_ENDPOINT_PATH = '/healthz';
export const METRICS_ENDPOINT_PATH = '/metrics';

/** Path that offers the Corresponding Source by redirecting to it. */
export const SOURCE_ENDPOINT_PATH = '/v1/source';
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

/**
 * Tenant-scoped routes whose tenant id is a path segment, so the route itself
 * cannot be a fixed string. Declared once and used both for routing and for the
 * metric label: two literals would be two chances to disagree about which path
 * was answered.
 */
export const AUDIT_ENDPOINT_PATTERN = /^\/v1\/tenants\/([^/]+)\/security-audit$/;
export const PRUNE_ENDPOINT_PATTERN = /^\/v1\/tenants\/([^/]+)\/maintenance\/prune$/;

/** Path that receives Stripe billing events and provisions tenants from them. */
export const BILLING_ENDPOINT_PATH = '/v1/billing/webhook';
/** Path that lets a post-checkout customer claim their provisioned key once. */
export const BILLING_SESSION_ENDPOINT_PATH = '/v1/billing/session';
/** Path a Checkout `success_url` redirects to, rendering the key as a page once. */
export const BILLING_SUCCESS_ENDPOINT_PATH = '/v1/billing/success';

/** Cache policy for the discovery document: public, and cheap enough to re-read. */
export const DISCOVERY_CACHE_CONTROL = 'public, max-age=300, stale-while-revalidate=3600';
/** The relation every response advertises, so the document is reachable without a hard-coded path. */
export const AGENT_BRIDGE_LINK = '</.well-known/navi.json>; rel="agent-bridge"';

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

/**
 * The closed set of route labels the host metrics expose. Anything unmatched is
 * `other`: a label that came from the request path would let a scanner mint a
 * series per path it tried.
 * @param {string} path @returns {string}
 */
export function routeLabel(path) {
  if (path === SCRIPT_ENDPOINT_PATH) return 'navi.js';
  if (path === LOADER_ENDPOINT_PATH) return 'loader.js';
  if (path === WORKFLOWS_ENDPOINT_PATH) return 'workflows';
  if (path === TELEMETRY_ENDPOINT_PATH) return 'telemetry';
  if (path === VIOLATION_ENDPOINT_PATH) return 'telemetry_violations';
  if (path === BILLING_ENDPOINT_PATH) return 'billing_webhook';
  if (path === BILLING_SESSION_ENDPOINT_PATH) return 'billing_session';
  if (path === BILLING_SUCCESS_ENDPOINT_PATH) return 'billing_success';
  if (path === HEALTH_ENDPOINT_PATH) return 'healthz';
  if (path === METRICS_ENDPOINT_PATH) return 'metrics';
  if (path === DISCOVERY_ENDPOINT_PATH) return 'discovery';
  if (path === SOURCE_ENDPOINT_PATH) return 'source';
  if (AUDIT_ENDPOINT_PATTERN.test(path)) return 'security_audit';
  if (PRUNE_ENDPOINT_PATTERN.test(path)) return 'maintenance_prune';
  return 'other';
}
