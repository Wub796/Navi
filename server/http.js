// Response and request primitives shared by every host route.
//
// Kept in one module rather than restated per route: the headers here are the
// security contract of the service (no-store on everything tenant-scoped, a
// pinned content type, a length that matches the body), and two copies of them
// are two chances to disagree.

import { BILLING_PAGE_HEADERS } from './billing-success.js';

/** Hard cap for one telemetry beacon body. */
export const MAX_PAYLOAD_BYTES = 2048;

/**
 * The `Link` relations are not set here: they are set on the response before
 * routing, so every route carries them without restating them.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {Record<string, unknown>} body
 * @param {Record<string, string>} [extraHeaders]
 */
export function sendJson(res, status, body, extraHeaders = {}) {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'X-Content-Type-Options': 'nosniff',
    // Every JSON response here is either tenant-scoped or an error, so nothing
    // on this service is safe for a shared cache to keep. The one exception is the
    // discovery document, which passes its own public policy in extraHeaders.
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(payload);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @param {Record<string, string>} [extraHeaders]
 */
export function sendError(res, status, code, message, extraHeaders = {}) {
  sendJson(res, status, { ok: false, error: { code, message } }, extraHeaders);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} html
 * @param {Record<string, string>} [extraHeaders]
 */
export function sendHtml(res, status, html, extraHeaders = {}) {
  res.writeHead(status, {
    ...BILLING_PAGE_HEADERS,
    'Content-Length': Buffer.byteLength(html),
    ...extraHeaders
  });
  res.end(html);
}

/**
 * Prometheus text. Unauthenticated like `/healthz`, and aggregate-only: a scrape
 * carries counters and one `tenant_id` per throttled tenant, never a URL, a
 * session identifier or a key. `/metrics` never consults the limiter.
 * @param {import('node:http').ServerResponse} res
 * @param {string} text
 */
export function sendMetrics(res, text) {
  res.writeHead(200, {
    'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store'
  });
  res.end(text);
}

/**
 * Read a request body up to `limit` bytes. `done` runs exactly once, as soon as
 * the size limit is breached or the stream ends, so the caller never awaits a
 * body it has already decided to reject.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit
 * @param {(result: {tooLarge: boolean, raw: string | null}) => void} done
 */
export function readBody(req, limit, done) {
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  let finished = false;
  /** @param {{tooLarge: boolean, raw: string | null}} result */
  const finish = result => {
    if (finished) return;
    finished = true;
    done(result);
  };
  req.on('data', chunk => {
    if (tooLarge) return;
    const buffer = /** @type {Buffer} */ (chunk);
    size += buffer.length;
    if (size > limit) {
      tooLarge = true;
      chunks.length = 0;
      finish({ tooLarge: true, raw: null });
      return;
    }
    chunks.push(buffer);
  });
  req.on('end', () => finish(tooLarge ? { tooLarge: true, raw: null } : { tooLarge: false, raw: Buffer.concat(chunks).toString('utf8') }));
  req.on('error', () => finish({ tooLarge: false, raw: null }));
}

/**
 * A canonical origin is its own URL, which rejects paths, query strings,
 * fragments, trailing slashes and embedded credentials in one check.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isCanonicalOrigin(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return url.origin === value;
  } catch {
    return false;
  }
}

/**
 * The origin a customer's browser used, for the loader URL in the onboarding page.
 *
 * `Host` is what the browser asked for and what the embed snippet must name, but it
 * is caller-supplied and lands in the page, so anything that is not a plain
 * host[:port] is replaced rather than reflected. The scheme comes from the proxy
 * header when there is one, because this service is usually behind a terminator
 * that speaks HTTP to it.
 * @param {import('node:http').IncomingMessage} req
 * @returns {string}
 */
export function requestOrigin(req) {
  const forwarded = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim().toLowerCase();
  const proto = forwarded === 'https' ? 'https' : 'http';
  const host = String(req.headers.host ?? '').trim();
  return `${proto}://${/^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(host) ? host : '127.0.0.1'}`;
}
