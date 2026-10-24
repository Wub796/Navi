import { test, expect } from '@playwright/test';
import { serveBundle, serveLoader } from '../server/edge-assets.js';

/**
 * The edge's script routes, driven through their exported handlers rather than a
 * Worker harness: a Worker has no filesystem and no `fetch` on the request path
 * here, so the handlers take the bytes and the charge as arguments. What is
 * asserted is the wire contract a tenant's page sees, and that the charge happens
 * once per serve on the server — the property that makes the meter enforced rather
 * than reported.
 */

const SRI = 'sha384-TmtbTx4Um3FaZ25htbRgiApDW48G3G8321WSwpRCRvAvbvad2hGkA8aOMWiod1Tv';
const BUNDLE = '/* bundle bytes */';
const LOADER = '/* loader bytes */';

/**
 * Add headers to a request without dropping the ones it already carries: passing a
 * `headers` init to `new Request(request, ...)` replaces the whole header list, which
 * would silently discard the `If-None-Match` a revalidation is about.
 * @param {Request} request @param {Record<string, string>} [headers]
 */
const withHeaders = (request, headers = {}) => {
  const merged = new Headers(request.headers);
  for (const [name, value] of Object.entries(headers)) merged.set(name, value);
  return new Request(request, { headers: merged });
};

/**
 * @typedef {{found?: boolean, forbidden?: boolean, allowed?: boolean,
 *   limit?: number | null, remaining?: number | null, retry_after_seconds?: number}} Quota
 * @typedef {{apiKey: string, origin: string | null, headerOrigin: string | null}} ChargeInput
 */

/** A charge stub that records every call and answers with the given quota. @param {Quota} quota */
function charging(quota) {
  /** @type {ChargeInput[]} */
  const calls = [];
  return {
    calls,
    /** @param {ChargeInput} input */
    charge: async (input) => {
      calls.push(input);
      return quota;
    },
  };
}

const allowed = { found: true, forbidden: false, allowed: true, limit: 10000, remaining: 9999 };

test('the loader is anonymous, cacheable and never metered', async () => {
  const response = await serveLoader(new Request('https://edge.test/v1/loader.js'), LOADER);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(LOADER);
  expect(response.headers.get('content-type')).toBe('application/javascript; charset=utf-8');
  expect(response.headers.get('access-control-allow-origin')).toBe('*');
  expect(response.headers.get('cache-control')).toContain('public, max-age=300');

  // HEAD carries the headers a cache revalidates against, and no body.
  const head = await serveLoader(new Request('https://edge.test/v1/loader.js', { method: 'HEAD' }), LOADER);
  expect(head.status).toBe(200);
  expect(await head.text()).toBe('');

  const wrong = await serveLoader(new Request('https://edge.test/v1/loader.js', { method: 'POST' }), LOADER);
  expect(wrong.status).toBe(405);
});

test('the bundle refuses a request with no key before it charges anything', async () => {
  const meter = charging(allowed);
  const response = await serveBundle(new Request('https://edge.test/v1/navi.js'), { source: BUNDLE, sri: SRI, charge: meter.charge });
  expect(response.status).toBe(401);
  expect(meter.calls).toEqual([]);
  expect(await response.text()).not.toContain(BUNDLE);

  // HEAD would be charged as a load while delivering no SDK, so it is refused too.
  const head = charging(allowed);
  const headResponse = await serveBundle(new Request('https://edge.test/v1/navi.js?key=k', { method: 'HEAD' }), {
    source: BUNDLE, sri: SRI, charge: head.charge,
  });
  expect(headResponse.status).toBe(405);
  expect(head.calls).toEqual([]);
});

test('an unknown key, a forbidden origin and a spent ceiling all serve no bytes', async () => {
  const unknown = charging({ found: false });
  expect((await serveBundle(new Request('https://edge.test/v1/navi.js?key=nope'), {
    source: BUNDLE, sri: SRI, charge: unknown.charge,
  })).status).toBe(401);

  const forbidden = charging({ found: true, forbidden: true, allowed: false });
  expect((await serveBundle(new Request('https://edge.test/v1/navi.js?key=k'), {
    source: BUNDLE, sri: SRI, charge: forbidden.charge,
  })).status).toBe(403);

  // A suspended subscription is stored as a zero ceiling: it must read as a quota
  // refusal, with the window as its retry hint, and never as a bad credential.
  const spent = charging({ found: true, forbidden: false, allowed: false, limit: 0, remaining: 0, retry_after_seconds: 2592000 });
  const response = await serveBundle(new Request('https://edge.test/v1/navi.js?key=k'), {
    source: BUNDLE, sri: SRI, charge: spent.charge,
  });
  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('2592000');
  expect(response.headers.get('x-quota-limit')).toBe('0');
  expect(response.headers.get('x-quota-remaining')).toBe('0');
  expect(await response.text()).not.toContain(BUNDLE);
});

test('an allowed serve returns the bytes, the SRI as ETag, and one charge', async () => {
  const meter = charging(allowed);
  const request = withHeaders(new Request('https://edge.test/v1/navi.js?key=navi_live_test'), {
    origin: 'https://shop.example',
  });
  const response = await serveBundle(request, { source: BUNDLE, sri: SRI, charge: meter.charge });

  expect(response.status).toBe(200);
  expect(await response.text()).toBe(BUNDLE);
  expect(response.headers.get('etag')).toBe(`"${SRI}"`);
  expect(response.headers.get('content-type')).toBe('application/javascript; charset=utf-8');
  expect(response.headers.get('access-control-allow-origin')).toBe('*');
  // One browser-bundle serve is one hosted-site quota unit, so a shared cache must not replay it.
  expect(response.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
  expect(response.headers.get('x-quota-limit')).toBe('10000');
  expect(response.headers.get('x-quota-remaining')).toBe('9999');

  expect(meter.calls).toEqual([{ apiKey: 'navi_live_test', origin: 'https://shop.example', headerOrigin: 'https://shop.example' }]);
});

test('a bundle revalidation is still a hosted-site quota unit, and a 304 costs no bytes', async () => {
  const meter = charging(allowed);
  const request = withHeaders(
    new Request('https://edge.test/v1/navi.js?key=navi_live_test', { headers: { 'if-none-match': `"${SRI}"` } }),
    { referer: 'https://shop.example/cart?session=secret' },
  );
  const response = await serveBundle(request, { source: BUNDLE, sri: SRI, charge: meter.charge });

  expect(response.status).toBe(304);
  expect(await response.text()).toBe('');
  expect(response.headers.get('etag')).toBe(`"${SRI}"`);
  expect(response.headers.get('x-quota-remaining')).toBe('9999');
  expect(meter.calls).toHaveLength(1);
  // The fallback origin is the origin, not the URL: a query string is not sent to
  // the database as part of an allow-list comparison.
  expect(meter.calls[0].origin).toBe('https://shop.example');
});

test('an unmetered tenant reports no ceiling rather than the string "null"', async () => {
  const meter = charging({ found: true, forbidden: false, allowed: true, limit: null, remaining: null });
  const response = await serveBundle(new Request('https://edge.test/v1/navi.js?key=k'), {
    source: BUNDLE, sri: SRI, charge: meter.charge,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('x-quota-limit')).toBeNull();
  expect(response.headers.get('x-quota-remaining')).toBeNull();
});
