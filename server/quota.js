// Per-tenant ingest quota policy.
//
// The limiter bounds one page or one misconfigured forwarder. This bounds a plan:
// a tenant's ceiling and window live in the store, so the count survives a restart
// and one customer's plan can differ from the deployment default. The policy is
// separate from the routes that charge it because the scrape publishes the same
// numbers the ingest path enforces.

import { normalizeTenantEntry } from './tenants.js';
import { sendJson } from './http.js';

/**
 * The ceiling a tenant's ingest is metered against, or null when it is unmetered.
 * A tenant-level ceiling wins over the process default, so one customer's plan can
 * differ from the deployment's baseline without a second configuration surface.
 * @param {import('./tenants.js').TenantDefinition} tenantConfig
 * @param {{maxEventsPerWindow: number, quotaWindowSeconds: number}} defaults
 * @returns {{limit: number, window_seconds: number} | null}
 */
function effectiveQuota(tenantConfig, defaults) {
  const windowSeconds = tenantConfig.window_seconds ?? (defaults.quotaWindowSeconds > 0 ? defaults.quotaWindowSeconds : 3600);
  const declared = tenantConfig.max_events_per_window;
  // An explicit null is the unmetered plan a purchase can grant; it is not the
  // same as an unset ceiling, which falls through to the deployment default.
  if (declared === null) return null;
  // A declared ceiling is authoritative even when it is zero: zero is how a
  // revoked subscription is stored, and reading it as "unset" would hand the
  // tenant the deployment default instead of a refusal.
  if (typeof declared === 'number' && Number.isInteger(declared) && declared >= 0) {
    return { limit: declared, window_seconds: windowSeconds };
  }
  if (defaults.maxEventsPerWindow > 0) return { limit: defaults.maxEventsPerWindow, window_seconds: windowSeconds };
  return null;
}

/**
 * The metered tenants, in a stable order. Only a tenant with a positive ceiling
 * has a window to report: emitting a zero series for everyone else would be a
 * label per tenant that says nothing.
 * @param {import('./tenants.js').TenantRegistry} tenants
 * @param {{maxEventsPerWindow: number, quotaWindowSeconds: number}} defaults
 * @returns {{config: import('./tenants.js').TenantDefinition, quota: {limit: number, window_seconds: number}}[]}
 */
function meteredTenants(tenants, defaults) {
  /** @type {{config: import('./tenants.js').TenantDefinition, quota: {limit: number, window_seconds: number}}[]} */
  const metered = [];
  for (const value of tenants.values()) {
    const config = normalizeTenantEntry(value);
    const quota = config ? effectiveQuota(config, defaults) : null;
    if (config && quota) metered.push({ config, quota });
  }
  return metered.sort((left, right) => left.config.id.localeCompare(right.config.id));
}

/**
 * Bind the policy to one host's store and defaults, so a route charges exactly the
 * ceiling the scrape publishes.
 * @param {{store: any, tenants: import('./tenants.js').TenantRegistry, maxEventsPerWindow: number, quotaWindowSeconds: number, onExceeded: (tenantId: string) => void}} options
 */
export function createQuota(options) {
  const defaults = { maxEventsPerWindow: options.maxEventsPerWindow, quotaWindowSeconds: options.quotaWindowSeconds };
  return {
    /** @param {import('./tenants.js').TenantDefinition} tenantConfig */
    effective: tenantConfig => effectiveQuota(tenantConfig, defaults),
    meteredTenants: () => meteredTenants(options.tenants, defaults),
    /** @param {import('node:http').ServerResponse} res @param {import('./tenants.js').TenantDefinition} tenantConfig */
    check: (res, tenantConfig) => checkTenantQuota(res, tenantConfig, {
      store: options.store,
      quota: effectiveQuota(tenantConfig, defaults),
      onExceeded: options.onExceeded
    })
  };
}

/**
 * Charge one event against the tenant's persistent quota if configured.
 * Answers `HTTP 429 {"error":"Quota exceeded"}` with `Retry-After` when exceeded.
 * @param {import('node:http').ServerResponse} res
 * @param {import('./tenants.js').TenantDefinition} tenantConfig
 * @param {{store: any, quota: {limit: number, window_seconds: number} | null, onExceeded: (tenantId: string) => void}} context
 * @returns {Promise<boolean>}
 */
async function checkTenantQuota(res, tenantConfig, context) {
  const { store, quota, onExceeded } = context;
  if (!quota) return true;
  // A suspended tenant keeps its record and its key, and is refused here rather
  // than at authentication: `401` would read as "wrong key" to a client whose key
  // is right, and would invite it to retry with another one.
  if (quota.limit === 0) {
    onExceeded(tenantConfig.id);
    sendJson(res, 429, { error: 'Quota exceeded' }, {
      'Retry-After': String(quota.window_seconds),
      'X-Quota-Limit': '0',
      'X-Quota-Remaining': '0'
    });
    return false;
  }
  if (typeof store.consumeQuota !== 'function') return true;
  const verdict = await store.consumeQuota({
    tenant_id: tenantConfig.id,
    max_events_per_window: quota.limit,
    window_seconds: quota.window_seconds
  });
  if (verdict.allowed) return true;
  onExceeded(tenantConfig.id);
  sendJson(res, 429, { error: 'Quota exceeded' }, {
    'Retry-After': String(verdict.retry_after_seconds),
    'X-Quota-Limit': String(quota.limit),
    'X-Quota-Remaining': '0'
  });
  return false;
}
