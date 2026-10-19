// Stripe billing: signature verification, tenant provisioning, and the one-time
// post-checkout claim behind both the JSON route and the onboarding page.
//
// The webhook is the one write in this service that arrives unauthenticated, so it
// is verified against the exact bytes that arrived, before the body is parsed, and
// a route with no configured secret refuses rather than trusting a body.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  BILLING_PAGE_HEADERS, renderBillingClaimErrorPage, renderBillingSuccessPage
} from './billing-success.js';
import { MAX_PAYLOAD_BYTES, readBody, requestOrigin, sendError, sendHtml, sendJson } from './http.js';
import { resolveQuota } from './pricing.js';

/** Validity window for a one-time Checkout Session API-key claim, in ms (15m). */
export const CHECKOUT_CLAIM_TTL_MS = 900_000;
/** Replay window this route enforces around a signature timestamp, in seconds. */
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;
/** Hard cap for one billing event body; Stripe events are JSON, not page data. */
export const MAX_BILLING_PAYLOAD_BYTES = 1024 * 1024;
/** How many random bytes a generated tenant key carries. */
export const TENANT_KEY_BYTES = 32;
/** Stripe events that create or refresh a tenant. */
export const PROVISIONING_EVENT_TYPES = new Set(['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated']);
/** Stripe events that revoke one. */
export const REVOCATION_EVENT_TYPE = 'customer.subscription.deleted';

/**
 * Parse a `Stripe-Signature` header.
 *
 * Stripe sends `t=<unix seconds>,v1=<hex hmac>` and may send several `v1` entries
 * while a secret is being rolled. A malformed header is `null` rather than a
 * partial result: every field this route needs must be present and well formed
 * before anything is compared.
 * @param {unknown} header
 * @returns {{timestamp: number, signatures: string[]} | null}
 */
export function parseStripeSignature(header) {
  if (typeof header !== 'string' || header.trim().length === 0) return null;
  /** @type {number | null} */
  let timestamp = null;
  /** @type {string[]} */
  const signatures = [];
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
 * Verify a Stripe webhook signature over the exact bytes that arrived.
 *
 * The digest covers `${t}.${rawBody}`, the timestamp is inside the signed string
 * so it cannot be edited, and the tolerance is checked before the digest because
 * an expired signature is refused whether or not its HMAC is valid. The compare
 * is constant time: a byte-by-byte early return would leak how much of a guess
 * was right.
 * @param {string} rawBody @param {unknown} header @param {string} secret
 * @param {number} [nowSeconds] @returns {boolean}
 */
export function verifyStripeSignature(rawBody, header, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!secret) return false;
  const parsed = parseStripeSignature(header);
  if (!parsed) return false;
  if (Math.abs(nowSeconds - parsed.timestamp) > STRIPE_SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = createHmac('sha256', secret).update(`${parsed.timestamp}.${rawBody}`, 'utf8').digest();
  return parsed.signatures.some(signature => {
    const provided = Buffer.from(signature, 'hex');
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  });
}

/**
 * Read an optional integer out of Stripe metadata, which is always strings.
 * An unusable value falls back to the documented default rather than yielding
 * `NaN` in a quota column.
 * @param {unknown} value @param {number} fallback @param {number} minimum @returns {number}
 */
export function metadataInteger(value, fallback, minimum) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum ? number : fallback;
}

/**
 * Read the optional `allowed_origins` metadata value: a JSON array, a comma- or
 * pipe-separated list, or a single origin. Each entry is reduced to its origin so
 * a trailing slash in metadata cannot make a legitimate pixel fail the check, and
 * `*` is preserved as the wildcard it is. Absent or unusable means unrestricted,
 * which is the behaviour a tenant had before it was provisioned.
 * @param {unknown} value @returns {string[]}
 */
export function parseAllowedOrigins(value) {
  /** @type {unknown[]} */
  let items = [];
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
    .filter((/** @type {unknown} */ item) => typeof item === 'string' && item.trim().length > 0)
    .map(item => String(item).trim())
    .map(origin => {
      if (origin === '*') return '*';
      try { return new URL(origin).origin; }
      catch { return origin; }
    });
  return origins.length > 0 ? [...new Set(origins)] : ['*'];
}

/**
 * @param {{store: any, stripeWebhookSecret: string, log(line: string): void, registerTenantDefinition(definition: any): void}} options
 */
export function createBillingRoutes(options) {
  const { store, stripeWebhookSecret, log, registerTenantDefinition } = options;

  /**
   * Resolve the tenant a Stripe object is about.
   *
   * A standard Payment Link needs no integration, so the buyer's session arrives with
   * `metadata.tenant_id` and `client_reference_id` unset. Metadata stays first because
   * it is the documented place; the `customer` is next because it is the one field a
   * checkout session and every later subscription event for that subscription both
   * carry, which is what makes a cancellation resolve to the tenant its purchase
   * created rather than to nothing. The session id is the last resort, and only on the
   * completed checkout, because that is the one event where it names a purchase.
   * @param {any} object @param {string} [eventType] @returns {string}
   */
  function billingTenantId(object, eventType = '') {
    const metadata = object?.metadata && typeof object.metadata === 'object' ? object.metadata : {};
    const fromMetadata = typeof metadata.tenant_id === 'string' ? metadata.tenant_id.trim() : '';
    if (fromMetadata) return fromMetadata;
    const fromReference = typeof object?.client_reference_id === 'string' ? object.client_reference_id.trim() : '';
    if (fromReference) return fromReference;
    const customer = typeof object?.customer === 'string' ? object.customer.trim() : '';
    if (customer) return `tenant_${customer}`;
    const fromSession = eventType === 'checkout.session.completed' && typeof object?.id === 'string' ? object.id.trim() : '';
    return fromSession ? `tenant_${fromSession}` : '';
  }

  /**
   * Create or refresh a tenant from a verified checkout/subscription event.
   * @param {any} object @param {string} [eventId] @param {string} [eventType]
   * @returns {Promise<{status: number, body: Record<string, unknown>}>}
   */
  async function provisionTenant(object, eventId = '', eventType = '') {
    const tenantId = billingTenantId(object, eventType);
    if (!tenantId) return { status: 400, body: { error: 'Missing tenant_id' } };
    const metadata = object?.metadata && typeof object.metadata === 'object' ? object.metadata : {};
    const explicitKey = typeof metadata.api_key === 'string' ? metadata.api_key.trim() : '';
    const existing = typeof store.readTenantDefinition === 'function' ? await store.readTenantDefinition(tenantId) : null;
    // The key is minted once. An update that carries no api_key must not rotate the
    // credential a tenant's page already embeds.
    const apiKey = explicitKey || existing?.api_key || `navi_live_${randomBytes(TENANT_KEY_BYTES).toString('hex')}`;
    const definitionInput = {
      tenant_id: tenantId,
      api_key: apiKey,
      allowed_origins: parseAllowedOrigins(metadata.allowed_origins),
      // A standard Payment Link carries no metadata, so the plan is inferred from the
      // amount billed; explicit metadata still wins, in `resolveQuota`'s order.
      ...resolveQuota(object)
    };
    const rawSessionId = typeof object?.id === 'string' ? object.id.trim() : '';
    const checkoutClaim = eventType === 'checkout.session.completed' && rawSessionId.startsWith('cs_')
      ? { session_id: rawSessionId, tenant_id: tenantId, api_key: apiKey, expires_at_ms: Date.now() + CHECKOUT_CLAIM_TTL_MS }
      : null;
    if (typeof store.applyWebhookEvent === 'function') {
      const applied = await store.applyWebhookEvent({
        event_id: eventId || null,
        definition: definitionInput,
        checkout_claim: checkoutClaim
      });
      if (applied.duplicate) return { status: 200, body: { ok: true, duplicate: true } };
      const record = applied.record ?? (await store.upsertTenantDefinition(definitionInput));
      registerTenantDefinition(record);
      log(`billing: provisioned ${record.tenant_id}`);
      return { status: 200, body: { ok: true, tenant_id: record.tenant_id, api_key: record.api_key } };
    }
    const record = await store.upsertTenantDefinition(definitionInput);
    if (checkoutClaim && typeof store.recordCheckoutClaim === 'function') {
      await store.recordCheckoutClaim(checkoutClaim);
    }
    registerTenantDefinition(record);
    log(`billing: provisioned ${record.tenant_id}`);
    return { status: 200, body: { ok: true, tenant_id: record.tenant_id, api_key: record.api_key } };
  }

  /**
   * Revoke a tenant without deleting it: the row and the key stay, the ceiling
   * becomes zero, and every ingest then answers 429 rather than 401.
   * @param {any} object @param {string} [eventId]
   * @returns {Promise<{status: number, body: Record<string, unknown>}>}
   */
  async function suspendTenant(object, eventId = '') {
    const tenantId = billingTenantId(object);
    if (!tenantId) return { status: 400, body: { error: 'Missing tenant_id' } };
    const existing = typeof store.readTenantDefinition === 'function' ? await store.readTenantDefinition(tenantId) : null;
    const definitionInput = /** @type {const} */ ({
      tenant_id: tenantId,
      api_key: existing?.api_key ?? `navi_live_${randomBytes(TENANT_KEY_BYTES).toString('hex')}`,
      allowed_origins: existing?.allowed_origins ?? ['*'],
      max_events_per_window: 0,
      window_seconds: existing?.window_seconds ?? 2592000,
      status: 'suspended'
    });
    if (typeof store.applyWebhookEvent === 'function') {
      const applied = await store.applyWebhookEvent({
        event_id: eventId || null,
        definition: definitionInput
      });
      if (applied.duplicate) return { status: 200, body: { ok: true, duplicate: true } };
      const record = applied.record ?? (await store.upsertTenantDefinition(definitionInput));
      registerTenantDefinition(record);
      log(`billing: suspended ${record.tenant_id}`);
      return { status: 200, body: { ok: true, tenant_id: record.tenant_id, status: 'suspended' } };
    }
    const record = await store.upsertTenantDefinition(definitionInput);
    registerTenantDefinition(record);
    log(`billing: suspended ${record.tenant_id}`);
    return { status: 200, body: { ok: true, tenant_id: record.tenant_id, status: 'suspended' } };
  }

  return {
    /**
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     */
    async webhook(req, res) {
      if (req.method !== 'POST') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use POST /v1/billing/webhook.');
      // Fail closed: with no secret there is no way to distinguish Stripe from
      // anyone who found this URL, so the route refuses instead of trusting a body.
      if (!stripeWebhookSecret) return sendJson(res, 503, { error: 'Billing webhook not configured' });
      const declaredLength = Number(req.headers['content-length'] ?? '');
      if (Number.isFinite(declaredLength) && declaredLength > MAX_BILLING_PAYLOAD_BYTES) {
        req.resume();
        return sendError(res, 413, 'PAYLOAD_TOO_LARGE', `Billing events are limited to ${MAX_BILLING_PAYLOAD_BYTES} bytes.`, { Connection: 'close' });
      }
      await new Promise(/** @param {(value?: void) => void} resolveBody */ resolveBody => {
        readBody(req, MAX_BILLING_PAYLOAD_BYTES, result => {
          if (result.tooLarge || result.raw === null) {
            sendError(res, 413, 'PAYLOAD_TOO_LARGE', `Billing events are limited to ${MAX_BILLING_PAYLOAD_BYTES} bytes.`, { Connection: 'close' });
            resolveBody();
            return;
          }
          const raw = result.raw;
          // The signature is checked before the body is parsed: an unsigned body
          // must not reach JSON.parse, and the digest covers these exact bytes.
          if (!verifyStripeSignature(raw, req.headers['stripe-signature'], stripeWebhookSecret)) {
            sendJson(res, 401, { error: 'Invalid signature' });
            resolveBody();
            return;
          }
          /** @type {any} */
          let event;
          try { event = JSON.parse(raw); }
          catch {
            sendJson(res, 400, { error: 'Invalid payload' });
            resolveBody();
            return;
          }
          const type = typeof event?.type === 'string' ? event.type : '';
          const object = event?.data?.object && typeof event.data.object === 'object' ? event.data.object : {};
          // Stripe resends a delivery it did not see acknowledged. The id is claimed
          // before anything is written, so a retry that arrives while the first is
          // still in flight cannot provision twice, and a retry after it completed
          // is answered `duplicate` rather than acting again.
          const eventId = typeof event?.id === 'string' ? event.id.trim() : '';
          void (async () => {
            let claimed = false;
            const hasAtomic = typeof store.applyWebhookEvent === 'function';
            try {
              if (!hasAtomic && eventId && typeof store.recordWebhookEvent === 'function') {
                claimed = await store.recordWebhookEvent(eventId);
                if (!claimed) {
                  sendJson(res, 200, { ok: true, duplicate: true });
                  return;
                }
              }
              let outcome;
              if (PROVISIONING_EVENT_TYPES.has(type)) {
                outcome = await provisionTenant(object, eventId, type);
              } else if (type === REVOCATION_EVENT_TYPE) {
                outcome = await suspendTenant(object, eventId);
              } else {
                if (typeof store.applyWebhookEvent === 'function' && eventId) {
                  const applied = await store.applyWebhookEvent({ event_id: eventId });
                  if (applied.duplicate) {
                    sendJson(res, 200, { ok: true, duplicate: true });
                    return;
                  }
                }
                outcome = { status: 200, body: { ok: true, ignored: true } };
              }
              // A refused delivery is one Stripe will resend. The claim has to be
              // withdrawn, or that resend is swallowed as a duplicate and the tenant
              // is silently never provisioned.
              if (claimed && outcome.status >= 300) await store.releaseWebhookEvent?.(eventId);
              sendJson(res, outcome.status, outcome.body);
            } catch (error) {
              log(`billing: ${type || 'unknown'} event failed: ${error instanceof Error ? error.message : String(error)}`);
              if (claimed) {
                try { await store.releaseWebhookEvent?.(eventId); }
                catch { log(`billing: could not release the claim on ${eventId}`); }
              }
              if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
            } finally {
              resolveBody();
            }
          })();
        });
      });
    },

    /**
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     * @param {URL} url
     */
    async session(req, res, url) {
      if (req.method !== 'GET') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use GET /v1/billing/session?session_id=<cs_id>.');
      const sessionId = (url.searchParams.get('session_id') ?? '').trim();
      if (!sessionId || !sessionId.startsWith('cs_') || typeof store.consumeCheckoutClaim !== 'function') {
        return sendJson(res, 404, { error: 'Session not found or already claimed' });
      }
      try {
        const claimed = await store.consumeCheckoutClaim(sessionId);
        if (!claimed) return sendJson(res, 404, { error: 'Session not found or already claimed' });
        return sendJson(res, 200, { ok: true, tenant_id: claimed.tenant_id, api_key: claimed.api_key });
      } catch {
        return sendJson(res, 500, { error: 'Internal server error' });
      }
    },

    /**
     * The onboarding page a Checkout `success_url` redirects to. It consumes the
     * same one-time claim the JSON route does, so a customer who reaches either
     * surface first sees the key and the other answers 404 — and unlike the JSON
     * route this one is opened by a browser, so every answer is a page.
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     * @param {URL} url
     */
    async success(req, res, url) {
      if (req.method !== 'GET') {
        return sendHtml(res, 405, renderBillingClaimErrorPage({
          title: 'Use a GET request',
          detail: 'This address renders the one-time key page, which a browser opens with GET. Nothing was claimed by this request.'
        }), { Allow: 'GET' });
      }
      const sessionId = (url.searchParams.get('session_id') ?? '').trim();
      if (!sessionId.startsWith('cs_') || typeof store.consumeCheckoutClaim !== 'function') {
        return sendHtml(res, 404, renderBillingClaimErrorPage());
      }
      try {
        const claimed = await store.consumeCheckoutClaim(sessionId);
        if (!claimed) return sendHtml(res, 404, renderBillingClaimErrorPage());
        return sendHtml(res, 200, renderBillingSuccessPage({
          tenant_id: claimed.tenant_id,
          api_key: claimed.api_key,
          loader_url: `${requestOrigin(req)}/v1/loader.js`
        }));
      } catch {
        return sendHtml(res, 500, renderBillingClaimErrorPage({
          title: 'Something went wrong',
          detail: 'The key could not be retrieved just now, and the link is still unused. Try it again in a moment.'
        }));
      }
    }
  };
}
