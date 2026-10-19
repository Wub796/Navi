// Commercial plans and the quota one Stripe event grants.
//
// A standard Payment Link is created in Stripe's hosted editor, which exposes no
// metadata field: `checkout.session.completed` arrives with an empty `metadata` and
// the only plan signal is the amount billed. So the ceiling is inferred from that
// amount, and metadata overrides it only when an operator set it through the API.
// The table lives here rather than duplicated in the Worker and the host, because
// two copies of a price list drift silently while both suites stay green.

/** The 30-day window every commercial plan is sold in. */
export const PLAN_WINDOW_SECONDS = 2592000;

/** Ceilings the named plans grant, keyed by `metadata.tier` or `metadata.plan`. */
export const NAMED_PLAN_CEILINGS = Object.freeze({ starter: 10000, pro: 50000, enterprise: 250000 });

/**
 * The four commercial tiers, in display order. `maxEventsPerWindow: null` is the
 * Community plan: self-hosted under AGPL-3.0 with no hosted ceiling.
 * @typedef {{id: string, name: string, priceCents: number, maxEventsPerWindow: number | null, summary: string}} Tier
 * @type {readonly Tier[]}
 */
export const TIERS = Object.freeze([
  {
    id: 'community',
    name: 'Community',
    priceCents: 0,
    maxEventsPerWindow: null,
    summary: 'Self-host the bridge under AGPL-3.0, with your own storage and no hosted quota.'
  },
  {
    id: 'starter',
    name: 'Starter',
    priceCents: 2900,
    maxEventsPerWindow: 10000,
    summary: 'The hosted loader and sitemap endpoint, metered across a 30-day window.'
  },
  {
    id: 'pro',
    name: 'Pro',
    priceCents: 4900,
    maxEventsPerWindow: 50000,
    summary: 'Five times the Starter window, plus a commercial licence that exempts you from AGPL-3.0.'
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    priceCents: 19900,
    maxEventsPerWindow: 250000,
    summary: 'The largest hosted window, plus a commercial licence for self-hosted Docker deployments.'
  }
]);

/**
 * The ceiling an amount in cents buys. The boundaries are the tier prices: $199
 * and up is Enterprise, $49-$198.99 is Pro, and any smaller charge is Starter. An
 * absent or zero amount is a link whose price this deployment cannot see, and Pro
 * is the documented default rather than an unmetered sale.
 * @param {number | null} cents @returns {number}
 */
export function ceilingForAmount(cents) {
  if (typeof cents !== 'number' || !Number.isFinite(cents) || cents <= 0) return NAMED_PLAN_CEILINGS.pro;
  if (cents >= 19900) return NAMED_PLAN_CEILINGS.enterprise;
  if (cents >= 4900) return NAMED_PLAN_CEILINGS.pro;
  return NAMED_PLAN_CEILINGS.starter;
}

/**
 * The amount billed, in integer cents, from whichever field the event carries. A
 * Checkout Session reports `amount_subtotal`/`amount_total`; a subscription
 * reports the price on its first line item, or `plan.amount` on older payloads.
 * @param {any} object @returns {number | null}
 */
export function amountInCents(object) {
  const candidates = [
    object?.amount_subtotal,
    object?.amount_total,
    object?.items?.data?.[0]?.price?.unit_amount,
    object?.plan?.amount,
  ];
  for (const candidate of candidates) {
    if (Number.isInteger(candidate) && candidate >= 0) return candidate;
  }
  return null;
}

/** @param {unknown} value @param {number} minimum @returns {number | null} */
function optionalInteger(value, minimum) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum ? number : null;
}

/**
 * The quota one billing event grants.
 *
 * Explicit metadata wins, in this order: `unmetered` (no ceiling at all), a
 * numeric `max_events_per_window`, then a named `tier`/`plan`. With no metadata —
 * the standard Payment Link — the billed amount decides. `window_seconds` is
 * metadata-configurable only alongside an explicit ceiling: a named or inferred
 * plan is always sold in the 30-day window, so a stale value cannot shrink it.
 * @param {any} object
 * @returns {{max_events_per_window: number | null, window_seconds: number}}
 */
export function resolveQuota(object) {
  const metadata = object?.metadata && typeof object.metadata === 'object' ? object.metadata : {};
  const windowSeconds = optionalInteger(metadata.window_seconds, 1) ?? PLAN_WINDOW_SECONDS;
  if (String(metadata.unmetered ?? '').trim().toLowerCase() === 'true') {
    return { max_events_per_window: null, window_seconds: windowSeconds };
  }
  const explicit = optionalInteger(metadata.max_events_per_window, 0);
  if (explicit !== null) return { max_events_per_window: explicit, window_seconds: windowSeconds };
  const planName = String(metadata.tier ?? metadata.plan ?? '').trim().toLowerCase();
  if (Object.hasOwn(NAMED_PLAN_CEILINGS, planName)) {
    return {
      max_events_per_window: /** @type {Record<string, number>} */ (NAMED_PLAN_CEILINGS)[planName],
      window_seconds: PLAN_WINDOW_SECONDS
    };
  }
  return {
    max_events_per_window: ceilingForAmount(amountInCents(object)),
    window_seconds: PLAN_WINDOW_SECONDS
  };
}
