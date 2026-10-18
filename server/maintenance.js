// Tenant-scoped maintenance: the containment audit read and the retention prune.
//
// Both are authenticated with a Bearer key rather than a query parameter, because
// a query string is the one part of a request that lands in URLs, referrers and
// proxy logs, and both are confined to the tenant the key resolves to — never the
// tenant named in the path.

import { DEFAULT_RETENTION_DAYS, DEFAULT_VIOLATION_LIMIT, MAX_RETENTION_DAYS, MAX_VIOLATION_LIMIT } from './store.js';
import { MAX_PAYLOAD_BYTES, readBody, sendError, sendJson } from './http.js';
import { tenantFor } from './tenants.js';

/**
 * @param {{store: any, tenants: import('./tenants.js').TenantRegistry, retentionDays: number, runPrune(options: {max_age_days: number, tenant_id?: string}): Promise<{pruned_count: number, remaining_count: number}>}} options
 */
export function createMaintenanceRoutes(options) {
  const { store, tenants, retentionDays, runPrune } = options;

  return {
    /**
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     * @param {URL} url
     * @param {string} requestedPathSegment raw tenant id segment from the path
     */
    async audit(req, res, url, requestedPathSegment) {
      if (req.method !== 'GET') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use GET /v1/tenants/<tenant_id>/security-audit.');
      const authorization = req.headers.authorization;
      const token = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';
      const tenantId = tenantFor(tenants, token);
      if (!tenantId) {
        return sendError(res, 401, 'UNAUTHORIZED', 'An audit read requires "Authorization: Bearer <tenant_key>"; query-string keys are not accepted on this route.');
      }
      let requested = '';
      try {
        requested = decodeURIComponent(requestedPathSegment);
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
    },

    /**
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     * @param {string} requestedPathSegment raw tenant id segment from the path
     */
    async prune(req, res, requestedPathSegment) {
      if (req.method !== 'POST') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use POST /v1/tenants/<tenant_id>/maintenance/prune.');
      const authorization = req.headers.authorization;
      const token = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';
      const tenantId = tenantFor(tenants, token);
      if (!tenantId) {
        return sendError(res, 401, 'UNAUTHORIZED', 'A prune requires "Authorization: Bearer <tenant_key>"; query-string keys are not accepted on this route.');
      }
      let requested = '';
      try {
        requested = decodeURIComponent(requestedPathSegment);
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
    }
  };
}
