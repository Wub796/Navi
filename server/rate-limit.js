// Per-tenant ingest rate limiting.
//
// A token bucket per tenant, held in this process and nowhere else. Bounded memory
// is the whole reason this is a module of its own: a bucket is created on first
// use, refilled continuously at `perMinute`, and forgotten once it has been
// untouched for `idleMs`, so the map is a function of how many tenants are active
// right now rather than of how many have ever been seen.
//
// Distribution never consults this: serving the bundle is unaffected by a
// tenant's ingest rate.

import { sendError } from './http.js';

/** Ingestion ceiling per tenant: requests per minute, replenished continuously. */
export const RATE_LIMIT_PER_MINUTE = 120;
/** How many requests a tenant may send back to back before that ceiling applies. */
export const RATE_LIMIT_BURST = 30;
/** How long an untouched tenant bucket is remembered, in milliseconds. */
export const RATE_LIMIT_IDLE_MS = 10 * 60 * 1000;
/** Sweep cadence for idle buckets, in milliseconds. */
export const RATE_LIMIT_SWEEP_MS = 60 * 1000;
/**
 * Bucket count that triggers a sweep on the next request. The timer alone is not
 * enough: a flood of distinct tenant ids would otherwise grow the map for a full
 * sweep interval before anything removed the entries.
 */
export const RATE_LIMIT_SWEEP_THRESHOLD = 1000;

/**
 * @typedef {{allowed: boolean, remaining: number, retryAfterSeconds: number}} RateVerdict
 * @typedef {{enabled: boolean, perMinute: number, burst: number, size: number, take(key: string): RateVerdict, sweep(at?: number): number, reset(): void, close(): void}} RateLimiter
 */

/**
 * A token bucket per tenant, held in this process and nowhere else.
 * `perMinute` or `burst` of `0` disables limiting entirely.
 * @param {{perMinute?: number, burst?: number, idleMs?: number, sweepIntervalMs?: number, now?: () => number, timer?: boolean}} [options]
 * @returns {RateLimiter}
 */
export function createRateLimiter(options = {}) {
  const perMinute = options.perMinute ?? RATE_LIMIT_PER_MINUTE;
  const burst = options.burst ?? RATE_LIMIT_BURST;
  const idleMs = options.idleMs ?? RATE_LIMIT_IDLE_MS;
  const enabled = perMinute > 0 && burst > 0;
  const now = options.now ?? (() => Date.now());
  /** Tokens added per millisecond: a minute's allowance spread across the minute. */
  const refillPerMs = perMinute / 60000;
  /** @type {Map<string, {tokens: number, at: number}>} */
  const buckets = new Map();
  /** @param {number} [at] @returns {number} buckets removed */
  const sweep = (at = now()) => {
    let removed = 0;
    for (const [key, bucket] of buckets) {
      if (at - bucket.at >= idleMs) {
        buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  };
  let timer = /** @type {ReturnType<typeof setInterval> | null} */ (null);
  if (enabled && options.timer !== false) {
    timer = setInterval(() => sweep(), options.sweepIntervalMs ?? RATE_LIMIT_SWEEP_MS);
    // Never hold the process open, and never a reason for a test to hang.
    timer.unref?.();
  }
  return {
    enabled,
    perMinute,
    burst,
    get size() { return buckets.size; },
    /** @param {string} key @returns {RateVerdict} */
    take(key) {
      if (!enabled) return { allowed: true, remaining: 0, retryAfterSeconds: 0 };
      const at = now();
      let bucket = buckets.get(key);
      if (!bucket) {
        if (buckets.size >= RATE_LIMIT_SWEEP_THRESHOLD) sweep(at);
        bucket = { tokens: burst, at };
        buckets.set(key, bucket);
      } else {
        // Refill by elapsed time, capped at the burst allowance, so an idle tenant
        // banks nothing beyond it.
        bucket.tokens = Math.min(burst, bucket.tokens + (at - bucket.at) * refillPerMs);
        bucket.at = at;
      }
      if (bucket.tokens < 1) {
        const missing = 1 - bucket.tokens;
        return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil(missing / refillPerMs / 1000)) };
      }
      bucket.tokens -= 1;
      return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterSeconds: 0 };
    },
    sweep,
    reset() { buckets.clear(); },
    close() { if (timer) clearInterval(timer); timer = null; }
  };
}

/**
 * Charge one ingest request against its tenant's bucket. Returns the verdict the
 * request proceeds under, or null after answering `429` — in which case the
 * caller must send nothing further. `Retry-After` is whole seconds with a floor
 * of one, because a header asking a client to retry in zero seconds is a loop.
 * @param {import('node:http').ServerResponse} res
 * @param {RateLimiter} limiter
 * @param {string} tenantId
 * @param {(tenantId: string) => void} onRateLimited
 * @returns {RateVerdict | null}
 */
export function chargeIngest(res, limiter, tenantId, onRateLimited) {
  if (!limiter.enabled) return { allowed: true, remaining: 0, retryAfterSeconds: 0 };
  const verdict = limiter.take(tenantId);
  if (verdict.allowed) return verdict;
  onRateLimited(tenantId);
  sendError(res, 429, 'RATE_LIMITED', `Tenant "${tenantId}" has used its ${limiter.perMinute} ingestion requests per minute (burst ${limiter.burst}). Retry after ${verdict.retryAfterSeconds}s; raise NAVI_RATE_LIMIT_PER_MINUTE if this tenant legitimately reports more.`, {
    'Retry-After': String(verdict.retryAfterSeconds),
    'X-RateLimit-Limit': String(limiter.perMinute),
    'X-RateLimit-Remaining': '0'
  });
  return null;
}

/** The same counters on an accepted response, so a client can pace itself.
 * @param {RateLimiter} limiter @param {RateVerdict} verdict @returns {Record<string, string>} */
export function rateLimitHeaders(limiter, verdict) {
  return limiter.enabled ? { 'X-RateLimit-Limit': String(limiter.perMinute), 'X-RateLimit-Remaining': String(verdict.remaining) } : {};
}
