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
 * @typedef {{id: string, allowed_origins?: string[], max_events_per_window?: number, window_seconds?: number}} TenantDefinition
 * @typedef {string | TenantDefinition} TenantEntry
 * @typedef {Map<string, TenantEntry>} TenantRegistry key -> tenantId or TenantDefinition
 * @typedef {{[key: string]: string | undefined}} EnvLike
 */

/**
 * Normalize a tenant entry from the registry into a full TenantDefinition.
 * @param {TenantEntry | undefined} entry
 * @returns {TenantDefinition | null}
 */
export function normalizeTenantEntry(entry) {
  if (typeof entry === 'string') {
    return entry.length > 0 ? { id: entry } : null;
  }
  if (entry && typeof entry === 'object' && typeof entry.id === 'string' && entry.id.length > 0) {
    const allowed = Array.isArray(entry.allowed_origins)
      ? entry.allowed_origins.filter((/** @type {unknown} */ item) => typeof item === 'string' && item.trim().length > 0).map(item => item.trim())
      : undefined;
    // A ceiling of `0` is kept rather than dropped: it is how a revoked
    // subscription is represented, and treating it as "unset" would turn a
    // suspended tenant back into an unmetered one.
    const maxEvents = typeof entry.max_events_per_window === 'number' && Number.isInteger(entry.max_events_per_window) && entry.max_events_per_window >= 0
      ? entry.max_events_per_window
      : undefined;
    const windowSeconds = typeof entry.window_seconds === 'number' && Number.isInteger(entry.window_seconds) && entry.window_seconds > 0
      ? entry.window_seconds
      : undefined;
    return {
      id: entry.id,
      ...(allowed && allowed.length > 0 ? { allowed_origins: allowed } : {}),
      ...(maxEvents !== undefined ? { max_events_per_window: maxEvents } : {}),
      ...(windowSeconds !== undefined ? { window_seconds: windowSeconds } : {})
    };
  }
  return null;
}

/**
 * Build the key -> tenantId/TenantDefinition registry.
 * Supports `key:tenantId` or `key:tenantId:origin1|origin2[:maxEvents]` in `NAVI_TENANTS`.
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
    const rest = entry.slice(separator + 1).trim();
    if (!key || !rest) continue;
    const secondSep = rest.indexOf(':');
    if (secondSep === -1) {
      tenants.set(key, rest);
      continue;
    }
    const tenantId = rest.slice(0, secondSep).trim();
    const afterId = rest.slice(secondSep + 1).trim();
    if (!tenantId) continue;
    const [originsPart = '', quotaPart = ''] = afterId.split('@');
    const origins = originsPart.split('|').map(item => item.trim()).filter(Boolean);
    const maxEvents = quotaPart ? Number(quotaPart.trim()) : Number.NaN;
    tenants.set(key, {
      id: tenantId,
      ...(origins.length > 0 ? { allowed_origins: origins } : {}),
      ...(Number.isInteger(maxEvents) && maxEvents > 0 ? { max_events_per_window: maxEvents } : {})
    });
  }
  if (tenants.size === 0) tenants.set(DEV_TENANT_KEY, DEV_TENANT_ID);
  return tenants;
}

/**
 * Resolve a tenant key to its normalized tenant definition.
 * @param {TenantRegistry} tenants
 * @param {unknown} key
 * @returns {TenantDefinition | null}
 */
export function tenantConfigFor(tenants, key) {
  if (typeof key !== 'string' || key.length === 0) return null;
  return normalizeTenantEntry(tenants.get(key));
}

/**
 * Resolve a tenant key to its tenant id.
 * @param {TenantRegistry} tenants
 * @param {unknown} key
 * @returns {string | null}
 */
export function tenantFor(tenants, key) {
  return tenantConfigFor(tenants, key)?.id ?? null;
}

/**
 * Resolve the tenant configuration from a strict `Authorization: Bearer <token>`
 * header. The header is the documented credential on the routes that take one, and
 * a malformed one resolves to null rather than to a partial parse.
 * @param {TenantRegistry} tenants
 * @param {import('node:http').IncomingMessage} req
 * @returns {TenantDefinition | null}
 */
export function bearerTenantConfig(tenants, req) {
  const authorization = req.headers.authorization;
  const match = typeof authorization === 'string' ? /^Bearer ([^\s]+)$/.exec(authorization) : null;
  return match ? tenantConfigFor(tenants, match[1]) : null;
}

/**
 * Check whether an origin is permitted by an `allowed_origins` list.
 * When `allowedOrigins` is absent, empty, or contains `"*"`, all origins are permitted.
 * @param {string[] | null | undefined} allowedOrigins
 * @param {string | null | undefined} targetOrigin
 * @param {string | null | undefined} [headerOrigin]
 * @returns {boolean}
 */
export function isOriginAllowed(allowedOrigins, targetOrigin, headerOrigin) {
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0 || allowedOrigins.includes('*')) {
    return true;
  }
  if (!targetOrigin || !allowedOrigins.includes(targetOrigin)) {
    return false;
  }
  if (typeof headerOrigin === 'string' && headerOrigin.trim().length > 0) {
    let normalizedHeader = '';
    try {
      normalizedHeader = new URL(headerOrigin.trim()).origin;
    } catch {
      return false;
    }
    if (!allowedOrigins.includes(normalizedHeader)) {
      return false;
    }
  }
  return true;
}

/**
 * The set of tenant ids that may appear in a telemetry payload.
 * @param {TenantRegistry} tenants
 * @returns {Set<string>}
 */
export function tenantIds(tenants) {
  /** @type {Set<string>} */
  const ids = new Set();
  for (const value of tenants.values()) {
    const normalized = normalizeTenantEntry(value);
    if (normalized) ids.add(normalized.id);
  }
  return ids;
}
