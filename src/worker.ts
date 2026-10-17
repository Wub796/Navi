import { validateCrawlerPayload } from './crawler-payload.js';
import type { CrawlerPayload } from './dom-crawler.js';

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  STRIPE_WEBHOOK_SECRET?: string;
}

/**
 * The `sites` row the ingestion path needs. `allowed_origins` and the quota
 * columns are optional because a deployment may predate them: an absent list
 * means "any origin" and an absent ceiling means "unmetered", which is the
 * behaviour this endpoint had before either feature existed. A ceiling of exactly
 * `0` is not absent — it is how a revoked subscription is stored, and it refuses.
 */
export interface SiteRecord {
  id: string;
  api_key?: string | null;
  allowed_origins?: string[] | null;
  max_events_per_window?: number | null;
  window_seconds?: number | null;
  window_start_ms?: number | null;
  event_count?: number | null;
}

/** Window length when a site sets a ceiling but no window. Matches the host's default. */
const DEFAULT_WINDOW_SECONDS = 3600;
/** Ceiling a provisioned site gets when Stripe metadata omits one. */
const DEFAULT_MAX_EVENTS_PER_WINDOW = 10000;
/** Window a provisioned site gets when Stripe metadata omits one: 30 days. */
const DEFAULT_PROVISION_WINDOW_SECONDS = 2592000;
/** Replay window enforced around a Stripe signature timestamp, in seconds. */
const SIGNATURE_TOLERANCE_SECONDS = 300;
/** Random bytes in a generated `navi_live_` key. */
const TENANT_KEY_BYTES = 32;

interface QuotaVerdict {
  allowed: boolean;
  limit: number;
  count: number;
  window_start_ms: number;
  retry_after_seconds: number;
}

const PROVISIONING_EVENT_TYPES = new Set(['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated']);

const json = (status: number, body: Record<string, unknown>, extraHeaders: Record<string, string> = {}): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders },
});

function extractOrigin(urlValue: string): string | null {
  try {
    const parsed = new URL(urlValue);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function originAllowed(allowedOrigins: unknown, payloadOrigin: string | null, headerOrigin: string | null): boolean {
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) return true;
  const list = allowedOrigins.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim());
  if (list.length === 0 || list.includes('*')) return true;
  if (!payloadOrigin || !list.includes(payloadOrigin)) return false;
  if (headerOrigin && headerOrigin.trim().length > 0) {
    const normalizedHeader = extractOrigin(headerOrigin.trim());
    if (!normalizedHeader || !list.includes(normalizedHeader)) return false;
  }
  return true;
}

/**
 * Parse a `Stripe-Signature` header: `t=<unix seconds>,v1=<hex hmac>`, with any
 * number of `v1` entries. A header missing either field is not partially trusted.
 * @param {string | null} header
 * @returns {{timestamp: number, signatures: string[]} | null}
 */
function parseStripeSignature(header: string | null): { timestamp: number; signatures: string[] } | null {
  if (typeof header !== 'string' || header.trim().length === 0) return null;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key === 't' && /^\d+$/.test(value)) timestamp = Number(value);
    else if (key === 'v1' && /^[0-9a-fA-F]{64}$/.test(value)) signatures.push(value.toLowerCase());
  }
  return timestamp === null || signatures.length === 0 ? null : { timestamp, signatures };
}

/**
 * Verify a Stripe signature over the exact bytes that arrived, using Web Crypto
 * so the Worker keeps its zero-dependency property. The timestamp is inside the
 * signed string and is checked against a 300-second window first; the comparison
 * itself is a fixed-length XOR over every byte, with no early return.
 * @param {string} rawBody @param {string | null} header @param {string} secret
 * @param {number} nowSeconds
 * @returns {Promise<boolean>}
 */
export async function verifyStripeSignature(rawBody: string, header: string | null, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (!secret) return false;
  const parsed = parseStripeSignature(header);
  if (!parsed) return false;
  if (Math.abs(nowSeconds - parsed.timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${parsed.timestamp}.${rawBody}`)));
  return parsed.signatures.some(signature => {
    if (signature.length !== expected.length * 2) return false;
    let difference = 0;
    for (let index = 0; index < expected.length; index += 1) {
      difference |= Number.parseInt(signature.slice(index * 2, index * 2 + 2), 16) ^ expected[index];
    }
    return difference === 0;
  });
}

/**
 * Read an optional integer out of Stripe metadata, whose values are strings.
 * @param {unknown} value @param {number} fallback @param {number} minimum
 * @returns {number}
 */
function metadataInteger(value: unknown, fallback: number, minimum: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum ? number : fallback;
}

/**
 * Read `allowed_origins` metadata: a JSON array, a comma- or pipe-separated list,
 * or one origin. Entries are reduced to their origin so a trailing slash cannot
 * make a legitimate pixel fail the check; `*` is preserved as the wildcard.
 * @param {unknown} value
 * @returns {string[]}
 */
function parseAllowedOrigins(value: unknown): string[] {
  let items: unknown[] = [];
  if (Array.isArray(value)) {
    items = value;
  } else if (typeof value === 'string' && value.trim().length > 0) {
    const text = value.trim();
    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) items = parsed;
      } catch { /* fall through to the separated form */ }
    }
    if (items.length === 0) items = text.split(/[|,]/);
  }
  const origins = items
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map(item => item.trim())
    .map(origin => {
      if (origin === '*') return '*';
      try { return new URL(origin).origin; }
      catch { return origin; }
    });
  return origins.length > 0 ? [...new Set(origins)] : ['*'];
}

/** A cryptographically random tenant credential, minted once per tenant. */
function randomTenantKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TENANT_KEY_BYTES));
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return `navi_live_${hex}`;
}

function supabaseBase(env: Env): string {
  return env.SUPABASE_URL.replace(/\/$/, '');
}

function supabaseHeaders(env: Env): Record<string, string> {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'content-type': 'application/json',
  };
}

/**
 * @param {any} object
 * @returns {string}
 */
function billingTenantId(object: any): string {
  const metadata = object?.metadata && typeof object.metadata === 'object' ? object.metadata : {};
  if (typeof metadata.tenant_id === 'string' && metadata.tenant_id.trim().length > 0) return metadata.tenant_id.trim();
  return typeof object?.client_reference_id === 'string' ? object.client_reference_id.trim() : '';
}

/** @param {Env} env @param {any} object @returns {Promise<Response>} */
async function provisionSite(env: Env, object: any): Promise<Response> {
  const tenantId = billingTenantId(object);
  if (!tenantId) return json(400, { error: 'Missing tenant_id' });
  const metadata = object?.metadata && typeof object.metadata === 'object' ? object.metadata : {};
  try {
    const base = supabaseBase(env);
    const headers = supabaseHeaders(env);
    const explicitKey = typeof metadata.api_key === 'string' ? metadata.api_key.trim() : '';
    let apiKey = explicitKey;
    if (!apiKey) {
      // Reuse the key this site already has: an update event without metadata must
      // not rotate the credential a tenant page is already embedding.
      const existing = await fetch(`${base}/rest/v1/sites?id=eq.${encodeURIComponent(tenantId)}&select=id,api_key`, { headers });
      if (existing.ok) {
        const rows: unknown = await existing.json();
        if (Array.isArray(rows) && rows[0] && typeof rows[0].api_key === 'string' && rows[0].api_key.length > 0) apiKey = rows[0].api_key;
      }
    }
    if (!apiKey) apiKey = randomTenantKey();
    const upsert = await fetch(`${base}/rest/v1/sites?on_conflict=id`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({
        id: tenantId,
        api_key: apiKey,
        allowed_origins: parseAllowedOrigins(metadata.allowed_origins),
        max_events_per_window: metadataInteger(metadata.max_events_per_window, DEFAULT_MAX_EVENTS_PER_WINDOW, 0),
        window_seconds: metadataInteger(metadata.window_seconds, DEFAULT_PROVISION_WINDOW_SECONDS, 1),
        active: true,
      }),
    });
    if (!upsert.ok) return json(500, { error: 'Internal server error' });
    return json(200, { ok: true, tenant_id: tenantId, api_key: apiKey });
  } catch {
    return json(500, { error: 'Internal server error' });
  }
}

/** @param {Env} env @param {any} object @returns {Promise<Response>} */
async function suspendSite(env: Env, object: any): Promise<Response> {
  const tenantId = billingTenantId(object);
  if (!tenantId) return json(400, { error: 'Missing tenant_id' });
  try {
    const patch = await fetch(`${supabaseBase(env)}/rest/v1/sites?id=eq.${encodeURIComponent(tenantId)}`, {
      method: 'PATCH',
      headers: { ...supabaseHeaders(env), Prefer: 'return=minimal' },
      body: JSON.stringify({ max_events_per_window: 0 }),
    });
    if (!patch.ok) return json(500, { error: 'Internal server error' });
    return json(200, { ok: true, tenant_id: tenantId, status: 'suspended' });
  } catch {
    return json(500, { error: 'Internal server error' });
  }
}

/** @param {Request} request @param {Env} env @returns {Promise<Response>} */
async function handleBilling(request: Request, env: Env): Promise<Response> {
  const secret = (env.STRIPE_WEBHOOK_SECRET ?? '').trim();
  // Fail closed: with no secret, every caller is indistinguishable from Stripe.
  if (!secret) return json(503, { error: 'Billing webhook not configured' });
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return json(400, { error: 'Invalid payload' });
  }
  if (!(await verifyStripeSignature(raw, request.headers.get('Stripe-Signature'), secret))) {
    return json(401, { error: 'Invalid signature' });
  }
  let event: any;
  try {
    event = JSON.parse(raw);
  } catch {
    return json(400, { error: 'Invalid payload' });
  }
  const type = typeof event?.type === 'string' ? event.type : '';
  const object = event?.data?.object && typeof event.data.object === 'object' ? event.data.object : {};
  if (PROVISIONING_EVENT_TYPES.has(type)) return provisionSite(env, object);
  if (type === 'customer.subscription.deleted') return suspendSite(env, object);
  return json(200, { ok: true, ignored: true });
}

/**
 * The next state of a site's quota window, or null when the site is unmetered.
 *
 * The window is a fixed interval starting at `window_start_ms`: once
 * `window_seconds` have passed, the next accepted event opens a new window at
 * `now` with a count of 1, so a tenant that goes quiet is not throttled on its
 * first event back. A ceiling of exactly `0` is a suspension, not an absence, and
 * is answered as an exhausted window rather than as an unmetered plan.
 * @param {SiteRecord} site
 * @param {number} now
 * @returns {QuotaVerdict | null}
 */
function quotaVerdict(site: SiteRecord, now: number): QuotaVerdict | null {
  const declared = site.max_events_per_window;
  if (typeof declared !== 'number' || !Number.isFinite(declared) || declared < 0) return null;
  const limit = Math.trunc(declared);
  const rawWindow = Number(site.window_seconds);
  const windowSeconds = Number.isFinite(rawWindow) && rawWindow > 0 ? Math.trunc(rawWindow) : DEFAULT_WINDOW_SECONDS;
  const windowMs = windowSeconds * 1000;
  if (limit === 0) {
    return { allowed: false, limit: 0, count: 0, window_start_ms: now, retry_after_seconds: Math.max(1, windowSeconds) };
  }
  const previousStart = Number(site.window_start_ms);
  const previousCount = Number(site.event_count);
  const hasActiveWindow = Number.isFinite(previousStart) && previousStart > 0
    && Number.isFinite(previousCount) && previousCount >= 0
    && now - previousStart < windowMs;
  const windowStart = hasActiveWindow ? previousStart : now;
  const consumed = hasActiveWindow ? Math.trunc(previousCount) : 0;
  if (consumed >= limit) {
    return {
      allowed: false,
      limit,
      count: consumed,
      window_start_ms: windowStart,
      retry_after_seconds: Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000)),
    };
  }
  return { allowed: true, limit, count: consumed + 1, window_start_ms: windowStart, retry_after_seconds: 0 };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/v1/billing/webhook') {
      if (request.method !== 'POST') return json(404, { error: 'Not found' });
      return handleBilling(request, env);
    }
    if (url.pathname !== '/v1/sitemap/update' || request.method !== 'POST') {
      return json(404, { error: 'Not found' });
    }

    const authorization = request.headers.get('Authorization') ?? '';
    const match = /^Bearer ([^\s]+)$/.exec(authorization);
    if (!match) return json(401, { error: 'Unauthorized' });
    const apiKey = match[1];

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return json(400, { error: 'Invalid payload' });
    }
    if (!validateCrawlerPayload(payload)) return json(400, { error: 'Invalid payload' });
    const validated = payload as CrawlerPayload;

    try {
      const base = supabaseBase(env);
      const headers = supabaseHeaders(env);
      const siteResponse = await fetch(`${base}/rest/v1/sites?api_key=eq.${encodeURIComponent(apiKey)}&active=eq.true&select=id,allowed_origins,max_events_per_window,window_seconds,window_start_ms,event_count`, { headers });
      if (!siteResponse.ok) return json(500, { error: 'Internal server error' });
      const sites: unknown = await siteResponse.json();
      if (!Array.isArray(sites) || !sites[0] || typeof sites[0].id !== 'string') return json(401, { error: 'Unauthorized' });

      const site = sites[0] as SiteRecord;
      const payloadOrigin = extractOrigin(validated.url);
      const headerOrigin = request.headers.get('Origin');
      if (!originAllowed(site.allowed_origins, payloadOrigin, headerOrigin)) {
        return json(403, { error: 'Forbidden origin' });
      }

      // The ceiling is charged before the map is written: a refused request must
      // not have stored anything, and a metering write that fails must not be
      // papered over with a 200 that leaves the count stale.
      const quota = quotaVerdict(site, Date.now());
      if (quota) {
        if (!quota.allowed) {
          return json(429, { error: 'Quota exceeded' }, {
            'Retry-After': String(quota.retry_after_seconds),
            'X-Quota-Limit': String(quota.limit),
            'X-Quota-Remaining': '0',
          });
        }
        const patch = await fetch(`${base}/rest/v1/sites?id=eq.${encodeURIComponent(site.id)}`, {
          method: 'PATCH',
          headers: { ...headers, Prefer: 'return=minimal' },
          body: JSON.stringify({ window_start_ms: quota.window_start_ms, event_count: quota.count }),
        });
        if (!patch.ok) return json(500, { error: 'Internal server error' });
      }

      const siteId = site.id;
      const upsert = await fetch(`${base}/rest/v1/navigation_maps?on_conflict=site_id,url`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ site_id: siteId, url: validated.url, payload: validated }),
      });
      if (!upsert.ok) return json(500, { error: 'Internal server error' });
      return json(200, { ok: true, url: validated.url, targets: validated.actions.length });
    } catch {
      return json(500, { error: 'Internal server error' });
    }
  },
};
