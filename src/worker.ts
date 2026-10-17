import { validateCrawlerPayload } from './crawler-payload.js';
import type { CrawlerPayload } from './dom-crawler.js';

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

/**
 * The `sites` row the ingestion path needs. `allowed_origins` and the quota
 * columns are optional because a deployment may predate them: an absent list
 * means "any origin" and an absent/zero ceiling means "unmetered", which is the
 * behaviour this endpoint had before either feature existed.
 */
export interface SiteRecord {
  id: string;
  allowed_origins?: string[] | null;
  max_events_per_window?: number | null;
  window_seconds?: number | null;
  window_start_ms?: number | null;
  event_count?: number | null;
}

/** Window length when a site sets a ceiling but no window. Matches the host's default. */
const DEFAULT_WINDOW_SECONDS = 3600;

interface QuotaVerdict {
  allowed: boolean;
  limit: number;
  count: number;
  window_start_ms: number;
  retry_after_seconds: number;
}

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
 * The next state of a site's quota window, or null when the site is unmetered.
 *
 * The window is a fixed interval starting at `window_start_ms`: once
 * `window_seconds` have passed, the next accepted event opens a new window at
 * `now` with a count of 1, so a tenant that goes quiet is not throttled on its
 * first event back. Anything unusable in the row (a negative or missing
 * timestamp, a non-integer ceiling) is treated as "no window yet" rather than as
 * an error, because a metering column an operator has not filled in must not turn
 * ingestion into a 500.
 * @param {SiteRecord} site
 * @param {number} now
 * @returns {QuotaVerdict | null}
 */
function quotaVerdict(site: SiteRecord, now: number): QuotaVerdict | null {
  const rawLimit = Number(site.max_events_per_window);
  if (!Number.isFinite(rawLimit) || rawLimit <= 0) return null;
  const limit = Math.trunc(rawLimit);
  const rawWindow = Number(site.window_seconds);
  const windowSeconds = Number.isFinite(rawWindow) && rawWindow > 0 ? Math.trunc(rawWindow) : DEFAULT_WINDOW_SECONDS;
  const windowMs = windowSeconds * 1000;
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
      const base = env.SUPABASE_URL.replace(/\/$/, '');
      const headers = {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'content-type': 'application/json',
      };
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
