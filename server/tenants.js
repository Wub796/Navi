// Tenant registry for the Navi host service.
//
// A tenant key is what a customer embeds in their <script src> tag
// (`/v1/navi.js?key=...`) and what the ingestion endpoint checks before it
// stores a beacon. Keys are deployment configuration, never code: they are read
// from the environment so a real key never lives in this repository.
//
// The built-in `dev-tenant-key` below is a local development credential. It is
// deliberately published in this file, is not a secret, and must never be used
// for a real deployment — set NAVI_TENANTS instead.

/** Local-only development key. Not a secret. */
export const DEV_TENANT_KEY = 'dev-tenant-key';
/** Tenant id the development key resolves to. */
export const DEV_TENANT_ID = 'demo-tenant';

/** Format of the NAVI_TENANTS environment variable. */
export const TENANTS_FORMAT = 'key:tenantId,key2:tenantId2';

/**
 * @typedef {Map<string, string>} TenantRegistry key -> tenantId
 * @typedef {{[key: string]: string | undefined}} EnvLike
 */

/**
 * Build the key -> tenantId registry.
 * @param {EnvLike} [env]
 * @returns {TenantRegistry}
 */
export function loadTenants(env = process.env) {
  /** @type {TenantRegistry} */
  const tenants = new Map();
  const raw = typeof env.NAVI_TENANTS === 'string' ? env.NAVI_TENANTS : '';
  for (const entry of raw.split(',')) {
    const separator = entry.indexOf(':');
    if (separator === -1) continue;
    const key = entry.slice(0, separator).trim();
    const tenantId = entry.slice(separator + 1).trim();
    if (!key || !tenantId) continue;
    tenants.set(key, tenantId);
  }
  if (tenants.size === 0) tenants.set(DEV_TENANT_KEY, DEV_TENANT_ID);
  return tenants;
}

/**
 * Resolve a tenant key to its tenant id.
 * @param {TenantRegistry} tenants
 * @param {unknown} key
 * @returns {string | null}
 */
export function tenantFor(tenants, key) {
  if (typeof key !== 'string' || key.length === 0) return null;
  return tenants.get(key) ?? null;
}

/**
 * The set of tenant ids that may appear in a telemetry payload.
 * @param {TenantRegistry} tenants
 * @returns {Set<string>}
 */
export function tenantIds(tenants) {
  return new Set(tenants.values());
}
