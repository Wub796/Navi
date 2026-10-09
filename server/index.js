// Navi host service: tenant-keyed script distribution and telemetry ingestion.
//
// Deliberately built on `node:http` with no framework, no middleware chain and
// no runtime dependency, so it can be dropped next to a CDN or run as a sidecar
// without a build step:
//
//   GET  /v1/navi.js?key=<tenant_key>   serve the shipped browser bundle
//   POST /v1/telemetry                  ingest one navigator.sendBeacon payload
//   GET  /v1/telemetry?key=<tenant_key> read that tenant's aggregate
//   GET  /healthz                       liveness, store mode and tenant count
//
// Ingestion stores aggregates only. A payload is exactly the five documented
// fields, is capped at 2 KB, and its `url_origin` must be a canonical origin, so
// page URLs, query strings, credentials and raw DOM text cannot be recorded.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStore } from './store.js';
import { loadTenants, tenantFor, tenantIds } from './tenants.js';

/** Hard cap for one telemetry beacon body. */
export const MAX_PAYLOAD_BYTES = 2048;
/** Cache policy for the distributed script; the SRI hash is the ETag. */
export const SCRIPT_CACHE_CONTROL = 'public, max-age=3600, stale-while-revalidate=86400';
/** Largest counter value accepted; anything bigger is not a plausible page metric. */
export const MAX_COUNTER = 1_000_000;
export const DEFAULT_PORT = 8790;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_STORE_FILE = 'server/telemetry.db';
/** The complete, exact set of accepted telemetry keys. */
export const TELEMETRY_FIELDS = ['tenant_id', 'url_origin', 'actions_indexed', 'actions_executed', 'execution_failures'];

const USAGE = `navi-host · script distribution and telemetry ingestion

Usage
  node server/index.js [--host 127.0.0.1] [--port 8790] [--store server/telemetry.db]

Endpoints
  GET  /v1/navi.js?key=<tenant_key>
  POST /v1/telemetry
  GET  /v1/telemetry?key=<tenant_key>
  GET  /healthz

Environment
  NAVI_TENANTS   Comma-separated key:tenantId pairs. Defaults to the local
                 development key, which must not be used in production.
`;

const here = dirname(fileURLToPath(import.meta.url));

/** @returns {string} */
function defaultSdkPath() {
  return resolve(here, '../dist/navi.min.js');
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
    // on this service is safe for a shared cache to keep.
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
 * @typedef {{host?: string, port?: number, tenants?: Map<string, string>, store?: StoreLike | null, storeFile?: string, sdkPath?: string, integrity?: string | null, log?: (line: string) => void}} HostOptions
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
  const integrity = options.integrity === undefined ? await defaultIntegrity() : options.integrity;
  const log = options.log ?? (() => {});
  const allowedTenantIds = tenantIds(tenants);

  /** Cached bundle bytes, keyed on the file's identity so a rebuild is picked up. */
  let cached = { mtimeMs: 0, size: 0, bytes: /** @type {Buffer | null} */ (null) };
  const readSdk = async () => {
    const info = await stat(sdkPath);
    if (cached.bytes && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.bytes;
    const bytes = await readFile(sdkPath);
    cached = { mtimeMs: info.mtimeMs, size: info.size, bytes };
    return bytes;
  };

  const server = createServer((req, res) => {
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
      /** @type {Record<string, string>} */
      const headers = {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': SCRIPT_CACHE_CONTROL,
        'X-Content-Type-Options': 'nosniff',
        Vary: 'Accept-Encoding'
      };
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
