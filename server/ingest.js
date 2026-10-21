// Authenticated ingest: one beacon, one containment violation, one action map.
//
// Ingestion stores aggregates only. A payload is exactly the five documented
// fields, is capped at 2 KB, and its `url_origin` must be a canonical origin, so
// page URLs, query strings, credentials and raw DOM text cannot be recorded.
// Each tenant gets an in-memory token bucket on the write routes, so one page or
// one misconfigured forwarder cannot saturate the store.

import { isIP } from 'node:net';
import { validateCrawlerPayload } from '../src/crawler-payload.js';
import {
  MAX_PAYLOAD_BYTES, isCanonicalOrigin, readBody, requestOrigin, sendError, sendJson
} from './http.js';
import { chargeIngest, rateLimitHeaders } from './rate-limit.js';
import { compileOpenApi, synthesizeWorkflows } from './sitemap-workflows.js';
import { bearerTenantConfig, isOriginAllowed, tenantConfigFor, tenantFor } from './tenants.js';

/** Largest counter value accepted; anything bigger is not a plausible page metric. */
export const MAX_COUNTER = 1_000_000;

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

/**
 * Strict payload validation. Only the five documented fields are accepted, the
 * tenant must be registered and match the authenticated Bearer token, and the
 * origin must be canonical.
 * @param {unknown} payload
 * @param {Set<string>} allowedTenantIds
 * @param {string} [authenticatedTenantId]
 * @returns {{ok: true, record: {tenant_id: string, url_origin: string, actions_indexed: number, actions_executed: number, execution_failures: number}} | {ok: false, status: number, code: string, message: string}}
 */
export function validateTelemetry(payload, allowedTenantIds, authenticatedTenantId) {
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
export function validateViolation(payload, allowedTenantIds, keyTenantId) {
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
 * @param {{store: any, tenants: import('./tenants.js').TenantRegistry, allowedTenantIds: Set<string>, limiter: import('./rate-limit.js').RateLimiter, quota: {effective(config: any): {limit: number, window_seconds: number} | null, check(res: any, config: any): Promise<boolean>}, metrics: {rateLimited(tenantId: string): void}}} options
 */
export function createIngestRoutes(options) {
  const { store, tenants, allowedTenantIds, limiter, quota, metrics } = options;

  /** @param {import('node:http').ServerResponse} res @param {string} tenantId */
  const charge = (res, tenantId) => chargeIngest(res, limiter, tenantId, id => metrics.rateLimited(id));

  return {
    /**
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     */
    async sitemap(req, res) {
      if (req.method !== 'POST') return sendJson(res, 404, { error: 'Not found' });
      const tenantConfig = bearerTenantConfig(tenants, req);
      if (!tenantConfig) return sendJson(res, 401, { error: 'Unauthorized' });
      const siteId = tenantConfig.id;
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
        let payloadOrigin = null;
        try { payloadOrigin = new URL(payload.url).origin; } catch { payloadOrigin = null; }
        const headerOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
        if (!isOriginAllowed(tenantConfig.allowed_origins, payloadOrigin, headerOrigin)) {
          sendJson(res, 403, { error: 'Forbidden origin' });
          resolveBody();
          return;
        }
        void (async () => {
          try {
            if (!(await quota.check(res, tenantConfig))) return;
            await store.upsertNavigationMap(siteId, payload.url, payload);
            sendJson(res, 200, { ok: true, url: payload.url, targets: payload.actions.length });
          } catch {
            if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
          } finally {
            resolveBody();
          }
        })();
      }));
    },

    /**
     * The tenant's latest stored sitemap, compiled into an OpenAPI 3.1 document.
     *
     * A read of data that already exists: nothing is synthesized at ingest time, so
     * the stored payload keeps the exact `{url, actions}` shape the write route
     * validates and the compiler stays the only place the grouping lives. The
     * credential is the same tenant key as every other read here, by header or
     * query, because an operator console and a shell one-liner are both callers.
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     * @param {URL} url
     */
    async workflows(req, res, url) {
      if (req.method !== 'GET') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use GET /v1/sitemap/openapi.json.');
      const tenantConfig = bearerTenantConfig(tenants, req) ?? tenantConfigFor(tenants, url.searchParams.get('key'));
      if (!tenantConfig) {
        return sendError(res, 401, 'UNAUTHORIZED', 'A tenant key is required to compile a sitemap: send "Authorization: Bearer <tenant_key>" or ?key=<tenant_key>.');
      }
      const latest = typeof store.readLatestNavigationMap === 'function'
        ? await store.readLatestNavigationMap(tenantConfig.id)
        : null;
      if (!latest) {
        return sendError(res, 404, 'NO_SITEMAP', `No sitemap has been stored for tenant "${tenantConfig.id}" yet: POST one to /v1/sitemap/update first.`);
      }
      const { workflows: synthesized } = synthesizeWorkflows(latest.payload);
      return sendJson(res, 200, compileOpenApi({
        tenantId: tenantConfig.id,
        pageUrl: latest.url,
        // The origin the caller reached, not the loopback the socket is bound to: a
        // document that advertises `http://127.0.0.1` is unusable behind a proxy.
        serverUrl: requestOrigin(req),
        updatedAt: latest.updated_at,
        workflows: synthesized
      }));
    },

    /**
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     * @param {URL} url
     */
    async telemetry(req, res, url) {
      if (req.method === 'GET') {
        // A bearer key and `?key=` name the same tenant; the header is what an
        // operator console uses, and the query parameter stays because it is the
        // documented read and a browser can follow it.
        const tenantConfig = bearerTenantConfig(tenants, req) ?? tenantConfigFor(tenants, url.searchParams.get('key'));
        if (!tenantConfig) {
          return sendError(res, 401, 'UNAUTHORIZED', 'A valid key query parameter is required to read a tenant summary.');
        }
        const limits = quota.effective(tenantConfig);
        const state = limits && typeof store.readQuota === 'function' ? await store.readQuota(tenantConfig.id) : null;
        return sendJson(res, 200, {
          ok: true,
          tenant_id: tenantConfig.id,
          summary: await store.summarize({ tenant_id: tenantConfig.id }),
          // Null rather than zeroes when the tenant is unmetered: a ceiling of 0
          // would read as "nothing allowed" to a consumer that did not know better.
          quota: limits
            ? {
              max_events_per_window: limits.limit,
              window_seconds: limits.window_seconds,
              window_start_ms: state?.window_start_ms ?? null,
              event_count: state?.event_count ?? 0
            }
            : null
        });
      }
      if (req.method !== 'POST') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use POST /v1/telemetry.');

      const tenantConfig = bearerTenantConfig(tenants, req);
      if (!tenantConfig) {
        return sendJson(res, 401, { error: 'Unauthorized' });
      }
      const keyTenantId = tenantConfig.id;

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
          const rawRecord = payload && typeof payload === 'object' && !Array.isArray(payload) ? /** @type {Record<string, unknown>} */ (payload) : null;
          const candidateOriginRaw = typeof rawRecord?.url_origin === 'string'
            ? rawRecord.url_origin
            : (typeof rawRecord?.url === 'string' ? rawRecord.url : null);
          let candidateOrigin = null;
          if (candidateOriginRaw) {
            try {
              const parsedOrigin = new URL(candidateOriginRaw);
              if (parsedOrigin.protocol === 'http:' || parsedOrigin.protocol === 'https:') {
                candidateOrigin = parsedOrigin.origin;
              }
            } catch {
              candidateOrigin = null;
            }
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
          const headerOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
          if (!isOriginAllowed(tenantConfig.allowed_origins, verdict.record.url_origin ?? candidateOrigin, headerOrigin)) {
            sendJson(res, 403, { error: 'Forbidden origin' });
            resolveBody();
            return;
          }
          const chargeVerdict = charge(res, verdict.record.tenant_id);
          if (!chargeVerdict) {
            resolveBody();
            return;
          }
          const record = { ...verdict.record, received_at: new Date().toISOString() };
          void (async () => {
            try {
              if (!(await quota.check(res, tenantConfig))) return;
              await store.append(record);
              sendJson(res, 202, { ok: true, accepted: true, tenant_id: record.tenant_id, url_origin: record.url_origin }, rateLimitHeaders(limiter, chargeVerdict));
            } catch (error) {
              if (!res.headersSent) {
                sendError(res, 500, 'STORE_FAILED', `The aggregate could not be stored: ${error instanceof Error ? error.message : String(error)}`);
              }
            } finally {
              resolveBody();
            }
          })();
        });
      });
    },

    /**
     * The MCP server posts here when it refuses a destination, so a tenant can
     * read back what its agents were stopped from reaching. The reporter's key is
     * checked before the body is read: a caller who cannot name a tenant should
     * not be able to make this service parse anything.
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     * @param {URL} url
     */
    async violations(req, res, url) {
      if (req.method !== 'POST') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use POST /v1/telemetry/violations.');
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
      const keyCharge = keyTenantId ? charge(res, keyTenantId) : null;
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
          const chargeVerdict = keyCharge ?? charge(res, verdict.record.tenant_id);
          if (!chargeVerdict) {
            resolveBody();
            return;
          }
          void store
            .recordViolation(verdict.record)
            .then(/** @param {{tenant_id: string, id: number}} record */ record => sendJson(res, 202, { ok: true, accepted: true, tenant_id: record.tenant_id, id: record.id }, rateLimitHeaders(limiter, chargeVerdict)))
            .catch(/** @param {unknown} error */ error => sendError(res, 500, 'STORE_FAILED', `The violation could not be stored: ${error instanceof Error ? error.message : String(error)}`))
            .finally(() => resolveBody());
        });
      });
    }
  };
}
