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
  SCRIPT_CACHE_CONTROL, SCRIPT_CORS, SCRIPT_ENDPOINT_PATH
} from './endpoints.js';
import { sendError, sendJson, sendMetrics } from './http.js';
import { LANDING_PAGE_HEADERS, renderLandingPage } from './landing.js';
import { tenantFor } from './tenants.js';

/** Crawl policy for search engines: allow public root, disallow one-time billing claims. */
export const ROBOTS_TXT = `User-agent: *\nAllow: /\nDisallow: /v1/billing/\nSitemap: https://navi-edge.sysctl.workers.dev/sitemap.xml\n`;

/** XML sitemap listing the canonical edge root for search indexers. */
export const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>https://navi-edge.sysctl.workers.dev/</loc>\n    <changefreq>weekly</changefreq>\n    <priority>1.0</priority>\n  </url>\n</urlset>\n`;

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
    'Content-Type': 'application/javascript; charset=utf-8',
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
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff', 'Content-Length': String(Buffer.byteLength(ROBOTS_TXT)) });
      res.end(req.method === 'HEAD' ? undefined : ROBOTS_TXT);
    },

    /**
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     */
    sitemapXml(req, res) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use GET /sitemap.xml.', { Allow: 'GET, HEAD' });
      res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff', 'Content-Length': String(Buffer.byteLength(SITEMAP_XML)) });
      res.end(req.method === 'HEAD' ? undefined : SITEMAP_XML);
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
     * AGPL-3.0 section 13: a user who interacts with this service over a network
     * must be offered the Corresponding Source of the version answering them, at no
     * charge, through a customary means. A redirect to the repository is that offer,
     * and it is public metadata like the discovery document, so it is cached the same
     * way. It is unauthenticated on purpose: an offer a reader has to identify
     * themselves to receive is not an offer to the users of the service.
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
