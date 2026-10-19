import { validateCrawlerPayload } from './crawler-payload.js';
import type { CrawlerPayload } from './dom-crawler.js';
import { BILLING_PAGE_HEADERS, renderBillingClaimErrorPage, renderBillingSuccessPage } from '../server/billing-success.js';
import { LANDING_PAGE_HEADERS, renderLandingPage } from '../server/landing.js';

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  STRIPE_WEBHOOK_SECRET?: string;
  /** Stripe Payment Link for the self-serve tier; absent => the quickstart is shown. */
  STRIPE_PAYMENT_LINK_URL?: string;
}

/** Ceiling a provisioned site gets when Stripe metadata omits one. */
const DEFAULT_MAX_EVENTS_PER_WINDOW = 10000;
/** Window a provisioned site gets when Stripe metadata omits one: 30 days. */
const DEFAULT_PROVISION_WINDOW_SECONDS = 2592000;
/** Replay window enforced around a Stripe signature timestamp, in seconds. */
const SIGNATURE_TOLERANCE_SECONDS = 300;
/** Validity window for a one-time post-checkout API-key claim, in milliseconds (15 minutes). */
const CHECKOUT_CLAIM_TTL_MS = 900_000;
/** Random bytes in a generated `navi_live_` key. */
const TENANT_KEY_BYTES = 32;

const PROVISIONING_EVENT_TYPES = new Set(['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated']);

/**
 * What every route answers when the database is behind this Worker. The message
 * names the file to apply rather than the HTTP status alone, because the operator
 * reading it is the one who can fix it.
 */
const SCHEMA_OUT_OF_DATE_MESSAGE = 'Database schema out of date: apply deploy/supabase-schema.sql';
/** PostgREST's code for a function that is not in its introspected schema. */
const PGRST_FUNCTION_NOT_FOUND = 'PGRST202';

/** A decoded PostgREST RPC payload. Narrowing is the caller's job, per field. */
type RpcResult = Record<string, unknown>;

/**
 * The database predates this Worker: a function is absent, or an older signature
 * answered without the field the newer contract requires. That is a deployment
 * order problem and never a transient one, so it is its own error rather than a
 * generic failure a caller might retry.
 */
class SchemaOutOfDateError extends Error {
  constructor() {
    super(SCHEMA_OUT_OF_DATE_MESSAGE);
    this.name = 'SchemaOutOfDateError';
  }
}

const json = (status: number, body: Record<string, unknown>, extraHeaders: Record<string, string> = {}): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders },
});

/**
 * An HTML response for the onboarding page, with the shared header set (CSP,
 * `no-store`, `no-referrer`) applied by the renderer's module rather than restated
 * here, so the Worker and the host service cannot disagree about them.
 * @param {number} status @param {string} body @param {Record<string, string>} [extraHeaders]
 * @returns {Response}
 */
const html = (status: number, body: string, extraHeaders: Record<string, string> = {}): Response => new Response(body, {
  status,
  headers: { ...BILLING_PAGE_HEADERS, ...extraHeaders },
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

const schemaOutOfDate = (): Response => json(503, { error: SCHEMA_OUT_OF_DATE_MESSAGE });

/**
 * Call one of the schema's atomic functions through PostgREST.
 *
 * Every write this Worker makes goes through here, because PostgREST cannot span
 * several REST calls in one transaction: a claim, a site upsert and a claim row
 * issued as separate requests can be interleaved by two isolates, and a crash
 * between them leaves an event id claimed by an event that never landed. A
 * function call is one transaction, so a failure rolls the whole thing back and
 * the resend Stripe generates is processed instead of being swallowed.
 * @param {Env} env @param {string} name @param {Record<string, unknown>} body
 * @returns {Promise<RpcResult>}
 */
async function callRpc(env: Env, name: string, body: Record<string, unknown>): Promise<RpcResult> {
  const response = await fetch(`${supabaseBase(env)}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: supabaseHeaders(env),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    // A missing function is a 404 `PGRST202` from PostgREST's schema cache, which is
    // the deployment-order signal: the Worker is newer than the database. It is not
    // a 404 from this service, so it must not be answered as one.
    if (response.status === 404) {
      let body: unknown = null;
      try { body = await response.json(); } catch { body = null; }
      if (body && typeof body === 'object' && (body as Record<string, unknown>).code === PGRST_FUNCTION_NOT_FOUND) throw new SchemaOutOfDateError();
    }
    throw new Error(`the ${name} function answered ${response.status}`);
  }
  const decoded: unknown = await response.json();
  return decoded && typeof decoded === 'object' ? decoded as RpcResult : {};
}

/**
 * Resolve the tenant a Stripe object is about.
 *
 * A standard Payment Link needs no integration, so the buyer's session arrives with
 * `metadata.tenant_id` and `client_reference_id` unset. Metadata stays first because
 * it is the documented place; the `customer` is next because it is the one field a
 * checkout session and every later subscription event for that subscription both
 * carry, so a cancellation resolves to the tenant its purchase created. The session
 * id is the last resort, and only on the completed checkout, because that is the one
 * event where it names a purchase.
 * @param {any} object @param {string} [eventType]
 * @returns {string}
 */
function billingTenantId(object: any, eventType = ''): string {
  const metadata = object?.metadata && typeof object.metadata === 'object' ? object.metadata : {};
  if (typeof metadata.tenant_id === 'string' && metadata.tenant_id.trim().length > 0) return metadata.tenant_id.trim();
  if (typeof object?.client_reference_id === 'string' && object.client_reference_id.trim().length > 0) return object.client_reference_id.trim();
  if (typeof object?.customer === 'string' && object.customer.trim().length > 0) return `tenant_${object.customer.trim()}`;
  if (eventType === 'checkout.session.completed' && typeof object?.id === 'string' && object.id.trim().length > 0) return `tenant_${object.id.trim()}`;
  return '';
}

/**
 * Provision a tenant from a verified billing event.
 *
 * One round trip: the key is generated here and sent as a candidate, which the
 * function uses only when it inserts a new row. It keeps the key on conflict, so a
 * subscription update or a retry cannot rotate the credential a live page is already
 * embedding, and there is no read to race with the write or to fall through from.
 * An event that names a key in `metadata.api_key` still sets it, because that is an
 * explicit instruction rather than an omission.
 * @param {Env} env @param {any} object @param {string} eventType @param {string} eventId
 * @returns {Promise<Response>}
 */
async function provisionSite(env: Env, object: any, eventType: string, eventId: string): Promise<Response> {
  const tenantId = billingTenantId(object, eventType);
  if (!tenantId) return json(400, { error: 'Missing tenant_id' });
  const metadata = object?.metadata && typeof object.metadata === 'object' ? object.metadata : {};
  try {
    const explicitKey = typeof metadata.api_key === 'string' ? metadata.api_key.trim() : '';
    const rawSessionId = eventType === 'checkout.session.completed' && typeof object?.id === 'string' ? object.id.trim() : '';
    const sessionId = rawSessionId.startsWith('cs_') ? rawSessionId : null;
    const result = await callRpc(env, 'apply_stripe_webhook', {
      p_event_id: eventId || null,
      p_site_id: tenantId,
      p_api_key: explicitKey || null,
      p_candidate_api_key: explicitKey ? null : randomTenantKey(),
      p_allowed_origins: parseAllowedOrigins(metadata.allowed_origins),
      p_max_events_per_window: metadataInteger(metadata.max_events_per_window, DEFAULT_MAX_EVENTS_PER_WINDOW, 0),
      p_window_seconds: metadataInteger(metadata.window_seconds, DEFAULT_PROVISION_WINDOW_SECONDS, 1),
      p_active: true,
      // The claim is written in the same transaction as the tenant: a key handed
      // out for a site that does not exist is worse than a claim that never landed.
      p_session_id: sessionId,
      p_claim_expires_at: sessionId ? new Date(Date.now() + CHECKOUT_CLAIM_TTL_MS).toISOString() : null,
    });
    if (result.duplicate) return json(200, { ok: true, duplicate: true });
    // The function answers with the key the row actually holds. No key means the
    // nine-argument signature answered without one: this Worker is newer than the
    // schema, so a 200 carrying a credential that authenticates nothing would be
    // the one wrong answer.
    if (typeof result.api_key !== 'string' || result.api_key.length === 0) throw new SchemaOutOfDateError();
    return json(200, { ok: true, tenant_id: tenantId, api_key: result.api_key });
  } catch (error) {
    if (error instanceof SchemaOutOfDateError) return schemaOutOfDate();
    return json(500, { error: 'Internal server error' });
  }
}

/**
 * Suspend a tenant by zeroing its ceiling instead of deleting the row, so
 * ingestion is a deterministic 429 rather than a 401 the tenant would read as a
 * bad key. The call carries no `api_key`, so the function preserves the existing
 * credential: a cancellation must not rotate the key a page is still embedding.
 * @param {Env} env @param {any} object @param {string} eventId
 * @returns {Promise<Response>}
 */
async function suspendSite(env: Env, object: any, eventId: string): Promise<Response> {
  const tenantId = billingTenantId(object);
  if (!tenantId) return json(400, { error: 'Missing tenant_id' });
  try {
    const result = await callRpc(env, 'apply_stripe_webhook', {
      p_event_id: eventId || null,
      p_site_id: tenantId,
      p_api_key: null,
      // NULL here is "leave the tenant's configuration alone", which is what a
      // cancellation carries: only the ceiling is being changed.
      p_allowed_origins: null,
      p_max_events_per_window: 0,
      p_window_seconds: null,
      p_active: true,
      p_session_id: null,
      p_claim_expires_at: null,
    });
    if (result.duplicate) return json(200, { ok: true, duplicate: true });
    return json(200, { ok: true, tenant_id: tenantId, status: 'suspended' });
  } catch (error) {
    if (error instanceof SchemaOutOfDateError) return schemaOutOfDate();
    return json(500, { error: 'Internal server error' });
  }
}

/**
 * Record the id of an event this deployment ignores, so its resend is a no-op
 * too. The same function does it with a NULL site id: the ledger insert is the
 * only write, and it still happens in its own transaction.
 * @param {Env} env @param {string} eventId
 * @returns {Promise<Response>}
 */
async function recordIgnoredEvent(env: Env, eventId: string): Promise<Response> {
  if (!eventId) return json(200, { ok: true, ignored: true });
  try {
    const result = await callRpc(env, 'apply_stripe_webhook', {
      p_event_id: eventId,
      p_site_id: null,
      p_api_key: null,
      p_allowed_origins: null,
      p_max_events_per_window: null,
      p_window_seconds: null,
      p_active: null,
      p_session_id: null,
      p_claim_expires_at: null,
    });
    return json(200, result.duplicate ? { ok: true, duplicate: true } : { ok: true, ignored: true });
  } catch (error) {
    if (error instanceof SchemaOutOfDateError) return schemaOutOfDate();
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
  const eventId = typeof event?.id === 'string' ? event.id.trim() : '';
  // Each branch is one RPC call, and the event id travels inside it: the ledger
  // claim and the tenant write commit together or not at all, so a redelivery is
  // answered as a duplicate and a failed delivery leaves nothing to withdraw.
  if (PROVISIONING_EVENT_TYPES.has(type)) return provisionSite(env, object, type, eventId);
  if (type === 'customer.subscription.deleted') return suspendSite(env, object, eventId);
  return recordIgnoredEvent(env, eventId);
}

/**
 * Render the post-checkout onboarding page, consuming the claim to do it.
 *
 * The same claim the JSON route consumes, deliberately: a key is shown once, so
 * whichever surface a customer reaches first is the one that reveals it and the
 * other answers 404. The page is a plain document with no script, and the headers
 * carry the CSP that enforces it.
 * @param {URL} url @param {Env} env @param {string} pageOrigin
 * @returns {Promise<Response>}
 */
async function handleBillingSuccess(url: URL, env: Env, pageOrigin: string): Promise<Response> {
  const sessionId = (url.searchParams.get('session_id') ?? '').trim();
  // Nothing is claimed for a value that cannot be a Checkout Session id, so a
  // scanner cannot burn a customer's one-time link by guessing at it.
  if (!sessionId.startsWith('cs_')) return html(404, renderBillingClaimErrorPage());
  try {
    const result = await callRpc(env, 'claim_checkout_session', { p_session_id: sessionId });
    // A claim that exists always carries both fields, so a successful answer without
    // them is a database older than this Worker — not a link the customer already used.
    if (result.ok !== true) return html(404, renderBillingClaimErrorPage());
    if (typeof result.tenant_id !== 'string' || typeof result.api_key !== 'string') throw new SchemaOutOfDateError();
    return html(200, renderBillingSuccessPage({
      tenant_id: result.tenant_id,
      api_key: result.api_key,
      loader_url: `${pageOrigin}/v1/loader.js`,
    }));
  } catch (error) {
    // This surface is opened by a browser, so the diagnostic keeps its shape: a page
    // that names the missing migration rather than raw JSON a customer cannot read.
    if (error instanceof SchemaOutOfDateError) {
      return html(503, renderBillingClaimErrorPage({
        title: 'Database schema out of date',
        detail: SCHEMA_OUT_OF_DATE_MESSAGE,
      }));
    }
    return html(500, renderBillingClaimErrorPage({
      title: 'Something went wrong',
      detail: 'The key could not be retrieved just now, and the link is still unused. Try it again in a moment.',
    }));
  }
}

/** @param {URL} url @param {Env} env @returns {Promise<Response>} */
async function handleBillingSession(url: URL, env: Env): Promise<Response> {
  const sessionId = (url.searchParams.get('session_id') ?? '').trim();
  if (!sessionId || !sessionId.startsWith('cs_')) {
    return json(404, { error: 'Session not found or already claimed' });
  }
  try {
    const result = await callRpc(env, 'claim_checkout_session', { p_session_id: sessionId });
    if (result.ok !== true) return json(404, { error: 'Session not found or already claimed' });
    if (typeof result.tenant_id !== 'string' || typeof result.api_key !== 'string') throw new SchemaOutOfDateError();
    return json(200, { ok: true, tenant_id: result.tenant_id, api_key: result.api_key });
  } catch (error) {
    if (error instanceof SchemaOutOfDateError) return schemaOutOfDate();
    return json(500, { error: 'Internal server error' });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Liveness answers before any routing or storage access: the check exists to
    // say the isolate is up, and one that touched the database would fail during
    // exactly the incident it is meant to report.
    if (url.pathname === '/healthz') {
      if (request.method !== 'GET') return json(405, { error: 'Method not allowed' }, { allow: 'GET' });
      return json(200, { ok: true, service: 'navi-edge' });
    }
    // The root is public and anonymous by design; everything below it authenticates.
    if (url.pathname === '/') {
      if (request.method !== 'GET') return json(405, { error: 'Method not allowed' }, { allow: 'GET' });
      return new Response(renderLandingPage({
        loaderUrl: `${url.origin}/v1/loader.js`,
        sitemapUrl: `${url.origin}/v1/sitemap/update`,
        paymentLinkUrl: env.STRIPE_PAYMENT_LINK_URL,
      }), { status: 200, headers: LANDING_PAGE_HEADERS });
    }
    if (url.pathname === '/v1/billing/webhook') {
      if (request.method !== 'POST') return json(404, { error: 'Not found' });
      return handleBilling(request, env);
    }
    if (url.pathname === '/v1/billing/session') {
      if (request.method !== 'GET') return json(404, { error: 'Not found' });
      return handleBillingSession(url, env);
    }
    if (url.pathname === '/v1/billing/success') {
      // A browser follows a Stripe redirect with GET; anything else is answered as
      // the same page-shaped error rather than a JSON body a browser would render
      // as text.
      if (request.method !== 'GET') {
        return html(405, renderBillingClaimErrorPage({
          title: 'Use a GET request',
          detail: 'This address renders the one-time key page, which a browser opens with GET. Nothing was claimed by this request.',
        }), { allow: 'GET' });
      }
      return handleBillingSuccess(url, env, url.origin);
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
      // The origin policy and the charge are one statement under a row lock. Doing
      // the check here and the charge next would charge a forbidden request, and
      // doing both as a read followed by a write lets two isolates admit twice the
      // ceiling. An unparseable `Origin` header is passed as an empty string, which
      // matches no allow-list entry, so a malformed header fails closed.
      const rawOrigin = request.headers.get('Origin');
      const headerOrigin = rawOrigin === null || rawOrigin.trim().length === 0
        ? null
        : (extractOrigin(rawOrigin.trim()) ?? '');
      // One call: the charge, the origin decision and the map write are one
      // transaction, so the map cannot be stored without being charged for and the
      // charge cannot survive a storage failure. `p_url`/`p_payload` are what make
      // it the ingest call rather than a metering-only one.
      const quota = await callRpc(env, 'consume_site_quota', {
        p_api_key: apiKey,
        p_now_ms: Date.now(),
        p_origin: extractOrigin(validated.url),
        p_header_origin: headerOrigin,
        p_url: validated.url,
        p_payload: validated,
      });
      if (quota.found !== true) return json(401, { error: 'Unauthorized' });
      if (quota.forbidden === true) return json(403, { error: 'Forbidden origin' });
      if (quota.allowed !== true) {
        return json(429, { error: 'Quota exceeded' }, {
          'Retry-After': String(typeof quota.retry_after_seconds === 'number' ? quota.retry_after_seconds : 1),
          'X-Quota-Limit': String(typeof quota.limit === 'number' ? quota.limit : 0),
          'X-Quota-Remaining': '0',
        });
      }
      return json(200, { ok: true, url: validated.url, targets: validated.actions.length });
    } catch (error) {
      if (error instanceof SchemaOutOfDateError) return schemaOutOfDate();
      return json(500, { error: 'Internal server error' });
    }
  },
};
