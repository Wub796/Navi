// Navi host service: tenant-keyed script distribution and telemetry ingestion.
//
// Deliberately built on `node:http` with no framework, no middleware chain and
// no runtime dependency, so it can be dropped next to a CDN or run as a sidecar
// without a build step:
//
//   GET  /v1/navi.js?key=<tenant_key>   serve the shipped browser bundle
//   GET  /v1/loader.js                  serve the tenant embed loader
//   POST /v1/telemetry                  ingest one navigator.sendBeacon payload
//   GET  /v1/telemetry?key=<tenant_key> read that tenant's aggregate
//   GET  /healthz                       liveness, store mode and tenant count
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

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStore } from './store.js';
import { loadTenants, tenantFor, tenantIds } from './tenants.js';

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

const USAGE = `navi-host · script distribution and telemetry ingestion

Usage
  node server/index.js [--host 127.0.0.1] [--port 8790] [--store server/telemetry.db]

Endpoints
  GET  /v1/navi.js?key=<tenant_key>
  GET  /v1/loader.js
  POST /v1/telemetry
  GET  /v1/telemetry?key=<tenant_key>
  GET  /healthz
  GET  /.well-known/navi.json
  GET  /v1/source

Environment
  NAVI_TENANTS     Comma-separated key:tenantId pairs. Defaults to the local
                   development key, which must not be used in production.
  NAVI_MCP_SSE_URL MCP SSE endpoint published in the discovery document. Defaults
                   to http://127.0.0.1:3001/sse. Point this at your own bridge
                   only if you intend to publish it.
  NAVI_SOURCE_URL  Corresponding Source offered at /v1/source and advertised as
                   rel="source" on every response. Defaults to
                   https://github.com/Wub796/Navi. Set it to your own repository
                   when serving a modified version: AGPL-3.0 section 13 requires
                   the source of the version that is actually running.
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
 * tenant must be registered, and the origin must be canonical.
 * @param {unknown} payload
 * @param {Set<string>} allowedTenantIds
 * @returns {{ok: true, record: {tenant_id: string, url_origin: string, actions_indexed: number, actions_executed: number, execution_failures: number}} | {ok: false, status: number, code: string, message: string}}
 */
function validateTelemetry(payload, allowedTenantIds) {
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
 * The store surface this service depends on, declared structurally so the host
 * does not care which backend ({@link createStore}) resolved to.
 * @typedef {{mode: 'sqlite' | 'log', file: string, append(record: unknown): Promise<void>, summarize(filter?: {tenant_id?: string}): Promise<any>, reset(): Promise<void>, close(): Promise<void>}} StoreLike
 * @typedef {{host?: string, port?: number, tenants?: Map<string, string>, store?: StoreLike | null, storeFile?: string, sdkPath?: string, loaderPath?: string, integrity?: string | null, mcpSseUrl?: string, sourceUrl?: string, log?: (line: string) => void}} HostOptions
 * @typedef {{server: import('node:http').Server, port: number, host: string, store: StoreLike, tenants: Map<string, string>, close(): Promise<void>}} NaviHost
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
  const store = options.store ?? (await createStore(options.storeFile ?? resolve(DEFAULT_STORE_FILE)));
  const sdkPath = options.sdkPath ?? defaultSdkPath();
  const loaderPath = options.loaderPath ?? defaultLoaderPath();
  const integrity = options.integrity === undefined ? await defaultIntegrity() : options.integrity;
  const mcpSseUrl = options.mcpSseUrl ?? process.env.NAVI_MCP_SSE_URL ?? DEFAULT_MCP_SSE_URL;
  const log = options.log ?? (() => {});
  const allowedTenantIds = tenantIds(tenants);
  const sourceUrl = options.sourceUrl ?? process.env.NAVI_SOURCE_URL ?? SOURCE_REPOSITORY_URL;
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

  const server = createServer((req, res) => {
    // Every response, including errors, 304s and redirects, advertises both
    // relations. Setting it here rather than inside each route is what makes
    // "every response" true by construction instead of by review - including for
    // a route a fork adds later.
    res.setHeader('Link', linkHeader);
    void handle(req, res).catch(error => {
      log(`request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) sendError(res, 500, 'INTERNAL_ERROR', 'The host service failed to handle this request.');
      else res.end();
    });
  });

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
      return sendJson(res, 200, { ok: true, mode: store.mode, tenants: tenants.size });
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

    if (path === '/v1/telemetry') {
      if (method === 'GET') {
        const tenantId = tenantFor(tenants, url.searchParams.get('key'));
        if (!tenantId) {
          return sendError(res, 401, 'UNAUTHORIZED', 'A valid key query parameter is required to read a tenant summary.');
        }
        return sendJson(res, 200, { ok: true, tenant_id: tenantId, summary: await store.summarize({ tenant_id: tenantId }) });
      }
      if (method !== 'POST') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use POST /v1/telemetry.');

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
          const verdict = validateTelemetry(payload, allowedTenantIds);
          if (!verdict.ok) {
            sendError(res, verdict.status, verdict.code, verdict.message);
            resolveBody();
            return;
          }
          const record = { ...verdict.record, received_at: new Date().toISOString() };
          void store
            .append(record)
            .then(() => sendJson(res, 202, { ok: true, accepted: true, tenant_id: record.tenant_id, url_origin: record.url_origin }))
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
  log(`listening on http://${host}:${boundPort} (store: ${store.mode}, tenants: ${tenants.size})`);

  let closed = false;
  return {
    server,
    port: boundPort,
    host,
    store,
    tenants,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise(/** @param {(value?: void) => void} resolveClose */ resolveClose => server.close(() => resolveClose()));
      await store.close();
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
  const naviHost = await createNaviHostServer({ host, port, storeFile });
  process.stdout.write(`navi-host: http://${host}:${naviHost.port} (tenants: ${naviHost.tenants.size}, store: ${naviHost.store.mode})\n`);
  await new Promise(/** @param {(value?: void) => void} resolveSignal */ resolveSignal => {
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => resolveSignal());
  });
  await naviHost.close();
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    process.stderr.write(`navi-host: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
