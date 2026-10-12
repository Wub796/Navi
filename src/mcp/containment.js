import { lookup } from 'node:dns/promises';
import { isIP, connect } from 'node:net';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export const CONTAINMENT_CODE = 'ERR_BLOCKED_BY_CONTAINMENT';
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_CONNECTIONS = 64;
const NETWORK_TIMEOUT_MS = 20000;
const MAX_LOGGED_TARGET_CHARS = 512;

/** @param {string} detail */
export function containmentError(detail) {
  return Object.assign(new Error(`${CONTAINMENT_CODE}: ${detail}`), { code: CONTAINMENT_CODE });
}

/**
 * Categories a refused destination is reported under. A category is the unit an
 * operator alerts on, so the taxonomy is fixed here rather than derived from
 * whatever address happened to be refused first.
 */
export const VIOLATION_CATEGORIES = Object.freeze([
  'metadata_endpoint', 'private_ipv4', 'loopback_or_local', 'cgnat_or_multicast', 'ipv6_special', 'dns_rebinding_rejected'
]);

/** Process-lifetime counters. Node runs one event loop, so these increments are
 * monotonic and race-free without a lock; they reset only on restart.
 * @type {Record<string, number>} */
const violationsByCategory = { metadata_endpoint: 0, private_ipv4: 0, loopback_or_local: 0, cgnat_or_multicast: 0, ipv6_special: 0, dns_rebinding_rejected: 0 };
let violationsTotal = 0;

/** Whether the private-network policy is active for this process. The override
 * exists for fixtures; it is never a production setting. */
export function containmentEnforced() {
  return process.env.NAVI_ALLOW_LOCAL_NETWORK !== '1';
}

/** The live payload `GET /healthz` and `GET /metrics` publish.
 * `violations_total` counts every refusal, while `violations_by_category` covers
 * the classified ones, so a malformed or credentialed URL is counted in the
 * total and logged as `unclassified` rather than forced into a category.
 * @returns {{containment: {enforced: boolean, violations_total: number, violations_by_category: Record<string, number>}}} */
export function containmentMetrics() {
  return {
    containment: {
      enforced: containmentEnforced(),
      violations_total: violationsTotal,
      violations_by_category: { ...violationsByCategory }
    }
  };
}

/** Zero the counters, for a test that asserts on deltas. Monotonic counters are
 * what a scrape wants, so nothing in the server calls this. */
export function resetContainmentMetrics() {
  violationsTotal = 0;
  for (const category of VIOLATION_CATEGORIES) violationsByCategory[category] = 0;
}

/** Strip everything the caller supplied as data: credentials, query and fragment.
 * An audit line records which destination was refused, not what was sent to it.
 * @param {string} value @returns {string} */
export function sanitizeTarget(value) {
  const text = String(value ?? '');
  let sanitized;
  try {
    const url = new URL(text);
    sanitized = ['http:', 'https:'].includes(url.protocol) ? `${url.origin}${url.pathname}` : stripUserInfo(text);
  } catch { sanitized = stripUserInfo(text); }
  return sanitized.length > MAX_LOGGED_TARGET_CHARS ? `${sanitized.slice(0, MAX_LOGGED_TARGET_CHARS)}...` : sanitized;
}

/** @param {string} text */
function stripUserInfo(text) {
  return text.split('#')[0].split('?')[0].replace(/\/\/[^/@]*@/, '//');
}

/**
 * One structured line per refusal, on stderr so the stdio transport's stdout
 * stays a clean protocol surface.
 * @param {{category: string | null, target: string, resolvedIp?: string | null, sessionId?: string | null}} violation
 */
export function recordContainmentViolation(violation) {
  violationsTotal++;
  const category = violation.category && VIOLATION_CATEGORIES.includes(violation.category) ? violation.category : null;
  if (category) violationsByCategory[category]++;
  const record = {
    level: 'WARN',
    type: 'SECURITY_CONTAINMENT_VIOLATION',
    timestamp: new Date().toISOString(),
    session_id: violation.sessionId ?? null,
    target_url: sanitizeTarget(violation.target),
    resolved_ip: violation.resolvedIp ?? null,
    category: category ?? 'unclassified',
    action: 'BLOCKED'
  };
  // Counters are incremented before this write, and a sink that has gone away
  // must not turn a refused destination into a crash or a different error: the
  // enforcement decision never depends on being able to log it.
  try { process.stderr.write(`${JSON.stringify(record)}\n`); }
  catch { /* the refusal still stands; a lost audit line is reported by the counter gap */ }
}

/** Classify a non-public address into the bucket an audit reader triages by, or
 * return null when the address is a legitimate public destination. Kept pure:
 * `resolveDestination` is the single place that refuses and therefore reports.
 * @param {string} address @returns {string | null} */
export function classifyAddress(address) {
  const bare = String(address).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const version = isIP(bare);
  if (version === 4) {
    const [a, b] = bare.split('.').map(Number);
    if (a === 127) return 'loopback_or_local';
    if (a === 169 && b === 254) return 'metadata_endpoint';
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private_ipv4';
    if ((a === 100 && b >= 64 && b <= 127) || a >= 224) return 'cgnat_or_multicast';
    // This network, IETF protocol assignments and benchmarking ranges are not
    // routable destinations either, so they share the private bucket.
    if (a === 0 || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19))) return 'private_ipv4';
    return null;
  }
  if (version === 6) {
    // URL canonicalization normalizes expanded and IPv4-mapped forms.
    const canonical = new URL(`http://[${bare}]/`).hostname.slice(1, -1);
    if (canonical === '::' || canonical === '::1') return 'loopback_or_local';
    if (canonical.startsWith('::ffff:')) return 'ipv6_special';
    const first = parseInt(canonical.split(':')[0] || '', 16);
    if (first >= 0xfe80 && first <= 0xfebf) return 'metadata_endpoint';
    if (first >= 0xfc00 && first <= 0xfdff) return 'ipv6_special';
    if (first >= 0xff00 && first <= 0xffff) return 'cgnat_or_multicast';
    // Only global unicast 2000::/3; NAT64, Teredo and 6to4 are refused because
    // they can carry an embedded private IPv4 destination.
    if (first >= 0x2000 && first <= 0x3fff && !canonical.startsWith('2001:0:') && !canonical.startsWith('2002:')) return null;
    return 'ipv6_special';
  }
  return null;
}

/** Non-global addresses are never public browser destinations. Unparseable text
 * is refused too, so a hostname that never should have reached this predicate
 * fails closed rather than being treated as public. @param {string} address */
export function isPrivateAddress(address) {
  const category = classifyAddress(address);
  if (category) return true;
  return isIP(String(address).toLowerCase().replace(/^\[|\]$/g, '')) === 0;
}

/** @param {string} host */
async function resolveHost(host) {
  let timer = /** @type {ReturnType<typeof setTimeout> | undefined} */ (undefined);
  try {
    return await Promise.race([
      lookup(host, { all: true, verbatim: true }),
      new Promise(/** @param {(value: never) => void} _resolve @param {(error: Error) => void} reject */ (_resolve, reject) => {
        timer = setTimeout(() => reject(containmentError('DNS resolution timed out')), 5000);
        timer.unref();
      })
    ]);
  } catch { throw containmentError('Destination DNS could not be validated'); }
  finally { if (timer) clearTimeout(timer); }
}

/** Resolve once and connect to that exact address; mixed public/private DNS fails closed.
 * Every refusal is counted and audited here, which is why this is the only
 * emitting site: the predicate above stays usable for reporting.
 * @param {string} value @param {boolean} allowLocalNetwork
 * @param {{sessionId?: string | null}} [context] session the refusal is attributed to
 * @returns {Promise<{url: URL, address: string, family: number}>}
 */
export async function resolveDestination(value, allowLocalNetwork, context = {}) {
  /** @param {string | null} category @param {string | null} resolvedIp @param {string} detail */
  const refuse = (category, resolvedIp, detail) => {
    // With the fixture override the policy is off, so a refusal here is a
    // malformed request rather than a containment violation; reporting it would
    // make `enforced: false` counters look alarming.
    if (!allowLocalNetwork) recordContainmentViolation({ category, target: value, resolvedIp, sessionId: context.sessionId ?? null });
    return containmentError(detail);
  };
  let url;
  try { url = new URL(value); } catch { throw refuse(null, null, 'Invalid destination URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw refuse(null, null, 'Only credential-free HTTP(S) destinations are permitted');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!allowLocalNetwork && (host === 'localhost' || host.endsWith('.localhost'))) throw refuse('loopback_or_local', null, 'Private, loopback or link-local destination refused');
  if (!allowLocalNetwork && isIP(host)) {
    const category = classifyAddress(host);
    if (category) throw refuse(category, host, 'Private, loopback or link-local destination refused');
  }
  let addresses;
  if (isIP(host)) addresses = [{ address: host, family: isIP(host) }];
  else {
    try { addresses = await resolveHost(host); }
    catch { throw refuse(null, null, 'Destination DNS could not be validated'); }
  }
  if (!addresses.length) throw refuse('dns_rebinding_rejected', null, 'DNS resolves to a non-public address');
  const offending = allowLocalNetwork ? undefined : addresses.find(entry => isPrivateAddress(entry.address));
  if (offending) throw refuse('dns_rebinding_rejected', offending.address, 'DNS resolves to a non-public address');
  return { url, ...addresses[0] };
}

/** Node-side runtime negotiation uses the same pinned sockets as browser egress.
 * Never follow a redirect before authorizing the new destination.
 * @param {string} value @param {boolean} allowLocalNetwork
 * @param {{timeoutMs?: number, maxBytes?: number, sameOrigin?: string, sessionId?: string | null}} [options]
 * @returns {Promise<{status: number, headers: import('node:http').IncomingHttpHeaders, bytes: Buffer, url: string}>}
 */
export async function containedGet(value, allowLocalNetwork, options = {}) {
  let target = value;
  const deadline = Date.now() + (options.timeoutMs ?? NETWORK_TIMEOUT_MS);
  for (let hop = 0; hop <= 5; hop++) {
    if (options.sameOrigin && new URL(target).origin !== options.sameOrigin) throw containmentError('Cross-origin runtime redirect refused');
    const { url, address, family } = await resolveDestination(target, allowLocalNetwork, { sessionId: options.sessionId ?? null });
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw containmentError('Runtime request timed out');
    const response = await new Promise(/** @param {(value: {status: number, headers: import('node:http').IncomingHttpHeaders, bytes: Buffer, url: string}) => void} resolve @param {(error: Error) => void} reject */ (resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        agent: false, lookup: (_host, _options, callback) => callback(null, address, family),
        headers: { Accept: '*/*', 'Accept-Encoding': 'identity' }, signal: AbortSignal.timeout(remaining)
      }, incoming => {
        const chunks = /** @type {Buffer[]} */ ([]);
        let bytes = 0;
        incoming.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > (options.maxBytes ?? MAX_RESPONSE_BYTES)) incoming.destroy(containmentError('Runtime response exceeds byte limit'));
          else chunks.push(chunk);
        });
        incoming.on('error', reject);
        incoming.on('end', () => resolve({ status: incoming.statusCode ?? 502, headers: incoming.headers, bytes: Buffer.concat(chunks), url: url.href }));
      });
      request.on('error', reject);
      request.end();
    });
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
      target = new URL(response.headers.location, target).href;
      continue;
    }
    return response;
  }
  throw containmentError('Too many runtime redirects');
}

/** HTTP proxy with IP pinning at connect time, including every redirect and CONNECT.
 * Chromium is configured with no DIRECT fallback and no implicit loopback bypass.
 * WebSockets are denied (including CONNECT-based WSS by context interception).
 * @param {boolean} allowLocalNetwork @param {() => void} onBlocked
 * @param {{sessionId?: string | null}} [context] session a refused connect is attributed to
 */
export async function createContainmentProxy(allowLocalNetwork, onBlocked, context = {}) {
  const sockets = /** @type {Set<import('node:net').Socket>} */ (new Set());
  let closed = false;
  /** @param {import('node:net').Socket} socket */
  const track = socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    return socket;
  };
  const server = createServer((req, res) => {
    void (async () => {
      const { url, address, family } = await resolveDestination(req.url ?? '', allowLocalNetwork, { sessionId: context.sessionId ?? null });
      if (closed) throw containmentError('Session closed');
      const headers = /** @type {import('node:http').IncomingHttpHeaders} */ ({ ...req.headers, host: url.host });
      delete headers['proxy-authorization']; delete headers['proxy-connection']; delete headers.connection;
      const outbound = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method: req.method, headers, agent: false,
        lookup: (_host, _options, callback) => callback(null, address, family)
      }, response => {
        const outgoingHeaders = { ...response.headers,
          'permissions-policy': 'geolocation=(), camera=(), microphone=(), clipboard-read=(), clipboard-write=()' };
        res.writeHead(response.statusCode ?? 502, outgoingHeaders);
        response.pipe(res);
        response.on('error', () => res.destroy());
      });
      outbound.on('socket', track);
      outbound.setTimeout(NETWORK_TIMEOUT_MS, () => outbound.destroy());
      outbound.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      res.on('close', () => outbound.destroy());
      req.pipe(outbound);
    })().catch(() => { onBlocked(); if (!res.headersSent) res.writeHead(403, { 'X-Navi-Error': CONTAINMENT_CODE }); res.end(CONTAINMENT_CODE); });
  });
  server.on('connection', socket => {
    if (closed || sockets.size >= MAX_CONNECTIONS) { socket.destroy(); return; }
    track(socket);
    socket.setTimeout(NETWORK_TIMEOUT_MS, () => socket.destroy());
  });
  server.on('upgrade', (_req, socket) => { onBlocked(); socket.destroy(); });
  server.on('connect', (req, client, head) => {
    void (async () => {
      const { url, address } = await resolveDestination(`https://${req.url ?? ''}/`, allowLocalNetwork, { sessionId: context.sessionId ?? null });
      if (closed) throw containmentError('Session closed');
      const upstream = track(connect({ host: address, port: Number(url.port || 443) }));
      upstream.setTimeout(NETWORK_TIMEOUT_MS, () => upstream.destroy());
      client.on('close', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
      upstream.on('close', () => client.destroy());
      upstream.once('connect', () => {
        if (closed || client.destroyed) { upstream.destroy(); return; }
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
    })().catch(() => { onBlocked(); client.end(`HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n${CONTAINMENT_CODE}`); });
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise(/** @param {(value?: void) => void} resolve @param {(error: Error) => void} reject */ (resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw containmentError('Proxy failed to bind');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise(/** @param {(value?: void) => void} resolve */ resolve => { server.close(() => resolve()); });
    }
  };
}
