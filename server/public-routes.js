// Public, unauthenticated reads: discovery, the source offer, health, metrics and
// the two distributable scripts.
//
// These are the routes a caller reaches before it has a key, so each one is
// deliberately read-only and names nothing a tenant owns. They live together
// because they share exactly that property; the authenticated writes are in
// `ingest.js`, `maintenance.js` and `billing.js`.

import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import {
  AGENT_CAPABILITIES, DISCOVERY_CACHE_CONTROL, MCP_PROTOCOL_REVISION, NAVI_PROTOCOL_VERSION,
  SCRIPT_CACHE_CONTROL, SCRIPT_CONTENT_TYPE, SCRIPT_CORS, SCRIPT_ENDPOINT_PATH
} from './endpoints.js';
import { sendError, sendJson, sendMetrics } from './http.js';
import { LANDING_PAGE_HEADERS, renderLandingPage } from './landing.js';
import { tenantFor } from './tenants.js';

/** Crawl policy for search engines: allow public root, disallow one-time billing claims. */
export const ROBOTS_TXT = `User-agent: *\nAllow: /\nDisallow: /v1/billing/\nSitemap: https://navi-edge.sysctl.workers.dev/sitemap.xml\n`;

/** Type and cache policy every inline-vector brand asset is served with. */
const SVG_TYPE = 'image/svg+xml; charset=utf-8';
const SVG_CACHE = 'public, max-age=86400';

/**
 * Answer a public, non-tenant asset: the method guard, the declared type, the cache
 * policy and `nosniff`, with `HEAD` answered from the same headers and no body. Every
 * static surface here — crawl policy, sitemap, brand assets — differs only in those
 * four values, so one function keeps them from drifting apart.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} body
 * @param {{type: string, cache: string, csp?: string}} policy
 */
function sendStatic(req, res, body, policy) {
  const head = req.method === 'HEAD';
  /** @type {Record<string, string>} */
  const headers = {
    'Content-Type': policy.type,
    'Cache-Control': policy.cache,
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': String(Buffer.byteLength(body)),
  };
  if (policy.csp) headers['Content-Security-Policy'] = policy.csp;
  res.writeHead(200, headers);
  res.end(head ? undefined : body);
}

/** XML sitemap listing the canonical edge root for search indexers. */
export const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>https://navi-edge.sysctl.workers.dev/</loc>\n    <changefreq>weekly</changefreq>\n    <priority>1.0</priority>\n  </url>\n</urlset>\n`;

/** Standalone 64x64 vector favicon: three-plane isometric stack + sodium-yellow N monogram. */
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
  <rect width="64" height="64" rx="12" fill="#0b0b0b"/>
  <rect x="6" y="6" width="52" height="52" rx="8" stroke="#f2f0ea" stroke-opacity="0.16"/>
  <path d="M16 42L32 50L48 42L32 34L16 42Z" fill="#161614" stroke="#f2f0ea" stroke-opacity="0.34" stroke-width="1.5"/>
  <path d="M16 32L32 40L48 32L32 24L16 32Z" fill="#ffd600" fill-opacity="0.12" stroke="#ffd600" stroke-opacity="0.55" stroke-width="1.5"/>
  <path d="M16 22L32 30L48 22L32 14L16 22Z" fill="#ffd600" stroke="#ffd600" stroke-width="1.5"/>
  <path d="M27 19.5V24.5L35 19.5V24.5" stroke="#101010" stroke-width="2.4" stroke-linecap="square" stroke-linejoin="miter"/>
  <circle cx="48" cy="16" r="3" fill="#ffd600"/>
</svg>\n`;

/** Full horizontal brand logo SVG: three-plane isometric emblem + wordmark + protocol badge. */
export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 280 64" fill="none" role="img" aria-label="Navi Interaction Bridge logo">
  <rect width="280" height="64" rx="8" fill="#0b0b0b"/>
  <rect x="1" y="1" width="278" height="62" rx="7" stroke="#f2f0ea" stroke-opacity="0.16"/>
  <g transform="translate(8, 0)">
    <path d="M12 43L28 51L44 43L28 35L12 43Z" fill="#161614" stroke="#f2f0ea" stroke-opacity="0.34" stroke-width="1.5"/>
    <path d="M12 32L28 40L44 32L28 24L12 32Z" fill="#ffd600" fill-opacity="0.12" stroke="#ffd600" stroke-opacity="0.55" stroke-width="1.5"/>
    <path d="M12 21L28 29L44 21L28 13L12 21Z" fill="#ffd600" stroke="#ffd600" stroke-width="1.5"/>
    <path d="M23.5 18.5V23.5L31.5 18.5V23.5" stroke="#101010" stroke-width="2.2" stroke-linecap="square"/>
    <circle cx="44" cy="15" r="2.75" fill="#ffd600"/>
  </g>
  <text x="68" y="38" fill="#f2f0ea" font-family="-apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, sans-serif" font-size="28" font-weight="700" letter-spacing="-1.2">navi</text>
  <rect x="136" y="21" width="124" height="22" rx="2" fill="#ffd600"/>
  <text x="145" y="35.5" fill="#101010" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="10.5" font-weight="700" letter-spacing="1.4">MCP BRIDGE 0.3</text>
</svg>\n`;

/**
 * @param {{store: {mode: string}, tenants: import('./tenants.js').TenantRegistry, metrics: {render(): Promise<string>}, retentionDays: number, sdkPath: string, loaderPath: string, integrity: string | null, mcpSseUrl: string, sourceUrl: string, metricsToken: string, paymentLinks?: {starter?: string, pro?: string, enterprise?: string}}} options
 */
export function createPublicRoutes(options) {
  const { store, tenants, metrics, retentionDays, sdkPath, loaderPath, integrity, mcpSseUrl, sourceUrl, metricsToken, paymentLinks } = options;

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
    // Shared with the edge's `server/edge-assets.js`, so the two servers cannot
    // disagree about the type a browser is told it is executing.
    'Content-Type': SCRIPT_CONTENT_TYPE,
    'Cache-Control': SCRIPT_CACHE_CONTROL,
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': SCRIPT_CORS,
    Vary: 'Accept-Encoding'
  });

  /**
   * Constant-time comparison against the configured scrape credential. A length
   * mismatch short-circuits, which leaks only the token's length, and the header
   * must be a well-formed `Bearer <token>` like every other authenticated route.
   * @param {import('node:http').IncomingMessage} req @returns {boolean}
   */
  function metricsAuthorized(req) {
    if (!metricsToken) return true;
    const authorization = req.headers.authorization;
    const match = typeof authorization === 'string' ? /^Bearer ([^\s]+)$/.exec(authorization) : null;
    if (!match) return false;
    const presented = Buffer.from(match[1]);
    const expected = Buffer.from(metricsToken);
    return presented.length === expected.length && timingSafeEqual(presented, expected);
  }

  return {
    /**
     * The same landing document the edge Worker serves at its root, so a
     * self-hosted deployment is not a bare API with an unlisted route table. The
     * page is rendered by the one shared module, and the only difference is the
     * links: a host knows its own origin per request, so it leaves the page's
     * relative defaults in place rather than trusting a `Host` header.
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     */
    landing(req, res) {
      if (req.method !== 'GET') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use GET /.');
      const body = renderLandingPage({ paymentLinks });
      res.writeHead(200, { ...LANDING_PAGE_HEADERS, 'Content-Length': String(Buffer.byteLength(body)) });
      res.end(body);
    },

    /**
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     */
    robots(req, res) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use GET /robots.txt.', { Allow: 'GET, HEAD' });
      sendStatic(req, res, ROBOTS_TXT, { type: 'text/plain; charset=utf-8', cache: 'public, max-age=3600' });
    },

    /**
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     */
    sitemapXml(req, res) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use GET /sitemap.xml.', { Allow: 'GET, HEAD' });
      sendStatic(req, res, SITEMAP_XML, { type: 'application/xml; charset=utf-8', cache: 'public, max-age=3600' });
    },

    /**
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     */
    favicon(req, res) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use GET /favicon.svg.', { Allow: 'GET, HEAD' });
      sendStatic(req, res, FAVICON_SVG, { type: SVG_TYPE, cache: SVG_CACHE, csp: "default-src 'none'" });
    },

    /**
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     */
    logo(req, res) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use GET /logo.svg.', { Allow: 'GET, HEAD' });
      sendStatic(req, res, LOGO_SVG, { type: SVG_TYPE, cache: SVG_CACHE, csp: "default-src 'none'" });
    },

    /**
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     */
    async discovery(req, res) {
      if (req.method !== 'GET') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use GET /.well-known/navi.json.');
      const document = await discoveryDocument();
      const etag = `"${createHash('sha256').update(JSON.stringify(document)).digest('base64url')}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag, 'Cache-Control': DISCOVERY_CACHE_CONTROL });
        res.end();
        return;
      }
      return sendJson(res, 200, document, { 'Cache-Control': DISCOVERY_CACHE_CONTROL, ETag: etag });
    },

    /**
     * Names the source of the version answering a request. MIT asks this of
     * nobody, which is why the endpoint is worth keeping: a tenant running on the
     * hosted service can read exactly what it is trusting, at no charge. A redirect
     * to the repository is that answer, and it is public metadata like the discovery
     * document, so it is cached the same way. It is unauthenticated on purpose: an
     * answer a reader has to identify themselves to receive is not an answer to the
     * users of the service.
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     */
    source(req, res) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use GET /v1/source.');
      res.writeHead(302, { Location: sourceUrl, 'Cache-Control': DISCOVERY_CACHE_CONTROL });
      res.end();
    },

    /**
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     */
    health(req, res) {
      if (req.method !== 'GET') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use GET /healthz.');
      // `retention_days` is configuration rather than health, and it is published
      // here because 0 means "nothing is being pruned": an operator should be able
      // to see that from the same endpoint they use to check the store is up.
      return sendJson(res, 200, { ok: true, mode: store.mode, tenants: tenants.size, retention_days: retentionDays });
    },

    /**
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     */
    async scrape(req, res) {
      if (req.method !== 'GET') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use GET /metrics.');
      if (!metricsAuthorized(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      return sendMetrics(res, await metrics.render());
    },

    /**
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     * @param {URL} url
     */
    async script(req, res, url) {
      if (req.method !== 'GET') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use GET /v1/navi.js?key=<tenant_key>.');
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
    },

    /**
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     */
    async loader(req, res) {
      if (req.method !== 'GET') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use GET /v1/loader.js.');
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
    }
  };
}
