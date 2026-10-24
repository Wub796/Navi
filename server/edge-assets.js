// The edge's two distributable scripts.
//
// `server/public-routes.js` serves the same two scripts from a Node host, reading
// them off disk. A Worker has no filesystem, so the build compiles the verified
// bytes into text modules and this module answers with them.
//
// What differs from the host is metering. A tenant's own page cannot be trusted to
// report how often the SDK was used — the beacon is attacker-controlled input, and
// a tenant who simply never sends one would use the paid product for free. Bundle
// serves and accepted sitemap writes therefore consume one shared hosted-site quota.
// That is also why the bundle is not shareable by a cache:
// see `METERED_SCRIPT_CACHE_CONTROL` in `endpoints.js`.

import {
  METERED_SCRIPT_CACHE_CONTROL,
  SCRIPT_CONTENT_TYPE,
  SCRIPT_CORS,
  SCRIPT_ENDPOINT_PATH,
} from './endpoints.js';

/**
 * The quota answer `consume_site_quota` returns for a metering-only call, read
 * defensively: the fields a served bundle needs are optional, and a malformed
 * answer must refuse rather than serve unmetered.
 * @typedef {Record<string, unknown>} QuotaAnswer
 */

/**
 * @param {number} status @param {Record<string, unknown>} body
 * @param {Record<string, string>} [extra]
 * @returns {Response}
 */
function refusal(status, body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': SCRIPT_CORS,
      ...extra,
    },
  });
}

/**
 * The origin a script request names, or `null` when the request names none.
 *
 * `Origin` is present because the supported embed is a `crossorigin="anonymous"`
 * script, which the browser fetches in CORS mode. `Referer` is the fallback for the
 * plain `<script>` embed and for a page whose referrer policy strips only the path.
 * Neither header is proof of anything — an allow-list is a boundary against
 * accidents, not against a determined caller — so a missing origin is reported as
 * missing and a restricted tenant refuses it rather than guessing.
 * @param {Request} request @returns {string | null}
 */
function requestOrigin(request) {
  for (const header of ['origin', 'referer']) {
    const value = request.headers.get(header);
    if (!value) continue;
    try {
      const parsed = new URL(value);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.origin;
    } catch {
      // An unparseable origin is not an origin; try the next header.
    }
  }
  return null;
}

/**
 * Headers every served script carries, with the quota counters a caller can pace
 * itself against. A `null` limit is an unmetered tenant, which is reported by
 * omission rather than as the string "null".
 * @param {QuotaAnswer} quota @returns {Record<string, string>}
 */
function servedHeaders(quota) {
  /** @type {Record<string, string>} */
  const headers = {
    'content-type': SCRIPT_CONTENT_TYPE,
    'cache-control': METERED_SCRIPT_CACHE_CONTROL,
    'x-content-type-options': 'nosniff',
    'access-control-allow-origin': SCRIPT_CORS,
  };
  if (typeof quota.limit === 'number') headers['x-quota-limit'] = String(quota.limit);
  if (typeof quota.remaining === 'number') headers['x-quota-remaining'] = String(quota.remaining);
  return headers;
}

/**
 * Serve the tenant embed loader.
 *
 * Anonymous and cacheable: the snippet carries no tenant key of its own — it reads
 * `data-key` from its own tag and appends it to the bundle request, which is where
 * the key is checked and the load is billed. Metering this file would charge for a
 * download that may never execute.
 * @param {Request} request @param {string} source @returns {Response}
 */
export function serveLoader(request, source) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return refusal(405, { error: 'Method not allowed', allow: 'GET, HEAD' });
  }
  return new Response(request.method === 'HEAD' ? null : source, {
    status: 200,
    headers: {
      'content-type': SCRIPT_CONTENT_TYPE,
      // The snippet changes only when the loader is rebuilt, which is a deploy.
      'cache-control': 'public, max-age=300, stale-while-revalidate=3600',
      'x-content-type-options': 'nosniff',
      'access-control-allow-origin': SCRIPT_CORS,
    },
  });
}

/**
 * Serve the browser bundle, consuming one hosted-site quota unit.
 *
 * The charge happens before the bytes are handed over, on every request that gets
 * this far — including a `304` revalidation, because a page that revalidates is a
 * page using the SDK. Bundle requests share the hosted-site quota with accepted
 * sitemap writes. A refused charge serves nothing: a suspended tenant cannot
 * obtain the runtime at all, which is what makes the meter enforced rather than
 * reported.
 * @param {Request} request
 * @param {{source: string, sri: string, charge: (input: {apiKey: string, origin: string | null, headerOrigin: string | null}) => Promise<QuotaAnswer>}} input
 * @returns {Promise<Response>}
 */
export async function serveBundle(request, input) {
  // GET only, deliberately: a HEAD would consume quota while delivering
  // no SDK, so the meter would count something the page never used. A browser never
  // issues HEAD for a script tag, and a `304` revalidation is a GET.
  if (request.method !== 'GET') {
    return refusal(405, { error: 'Method not allowed', allow: 'GET' });
  }
  const apiKey = (new URL(request.url).searchParams.get('key') ?? '').trim();
  if (!apiKey) {
    return refusal(401, {
      error: 'Unauthorized',
      detail: `Append ?key=<tenant key> to ${SCRIPT_ENDPOINT_PATH}; the loader does this for you from its data-key attribute.`,
    });
  }

  const origin = requestOrigin(request);
  const quota = await input.charge({ apiKey, origin, headerOrigin: origin });
  if (quota.found !== true) return refusal(401, { error: 'Unauthorized' });
  if (quota.forbidden === true) {
    return refusal(403, {
      error: 'Forbidden origin',
      detail: 'This page is not on the tenant\'s allowed_origins list.',
    });
  }
  if (quota.allowed !== true) {
    // A suspended subscription is stored as a zero ceiling and answered here, so a
    // revocation reads as a quota refusal rather than as a bad credential.
    /** @type {Record<string, string>} */
    const extra = { 'retry-after': String(typeof quota.retry_after_seconds === 'number' ? quota.retry_after_seconds : 1) };
    if (typeof quota.limit === 'number') extra['x-quota-limit'] = String(quota.limit);
    extra['x-quota-remaining'] = '0';
    return refusal(429, { error: 'Quota exceeded' }, extra);
  }

  const headers = servedHeaders(quota);
  const etag = `"${input.sri}"`;
  headers.etag = etag;
  if (request.headers.get('if-none-match') === etag) {
    // 304 carries the same cache and quota headers, so a revalidating page learns
    // its remaining allowance without re-downloading a byte.
    return new Response(null, { status: 304, headers });
  }
  return new Response(input.source, { status: 200, headers });
}
