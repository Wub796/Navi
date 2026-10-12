import { lookup } from 'node:dns/promises';
import { isIP, connect } from 'node:net';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export const CONTAINMENT_CODE = 'ERR_BLOCKED_BY_CONTAINMENT';
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_CONNECTIONS = 64;
const NETWORK_TIMEOUT_MS = 20000;

/** @param {string} detail */
export function containmentError(detail) {
  return Object.assign(new Error(`${CONTAINMENT_CODE}: ${detail}`), { code: CONTAINMENT_CODE });
}

/** Non-global addresses are never public browser destinations. @param {string} address */
export function isPrivateAddress(address) {
  const bare = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(bare) === 4) {
    const [a, b] = bare.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) ||
      (a === 198 && (b === 18 || b === 19));
  }
  if (isIP(bare) === 6) {
    // URL canonicalization normalizes expanded IPv6 and IPv4-mapped forms.
    const canonical = new URL(`http://[${bare}]/`).hostname.slice(1, -1);
    if (canonical.startsWith('::ffff:')) {
      const words = canonical.slice(7).split(':');
      const value = parseInt(words[0], 16) * 65536 + parseInt(words[1], 16);
      return isPrivateAddress([value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.'));
    }
    // Only global unicast 2000::/3; deny unspecified, loopback, ULA, link-local,
    // multicast, NAT64 and transition addresses that could embed private IPv4.
    const first = parseInt(canonical.split(':')[0], 16);
    return !Number.isFinite(first) || first < 0x2000 || first > 0x3fff || canonical.startsWith('2001:0:') || canonical.startsWith('2002:');
  }
  return true;
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
 * @param {string} value @param {boolean} allowLocalNetwork
 * @returns {Promise<{url: URL, address: string, family: number}>}
 */
export async function resolveDestination(value, allowLocalNetwork) {
  let url;
  try { url = new URL(value); } catch { throw containmentError('Invalid destination URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw containmentError('Only credential-free HTTP(S) destinations are permitted');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!allowLocalNetwork && (host === 'localhost' || host.endsWith('.localhost') || (isIP(host) && isPrivateAddress(host)))) {
    throw containmentError('Private, loopback or link-local destination refused');
  }
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolveHost(host);
  if (!addresses.length || (!allowLocalNetwork && addresses.some(entry => isPrivateAddress(entry.address)))) throw containmentError('DNS resolves to a non-public address');
  return { url, ...addresses[0] };
}

/** Node-side runtime negotiation uses the same pinned sockets as browser egress.
 * Never follow a redirect before authorizing the new destination.
 * @param {string} value @param {boolean} allowLocalNetwork
 * @param {{timeoutMs?: number, maxBytes?: number, sameOrigin?: string}} [options]
 * @returns {Promise<{status: number, headers: import('node:http').IncomingHttpHeaders, bytes: Buffer, url: string}>}
 */
export async function containedGet(value, allowLocalNetwork, options = {}) {
  let target = value;
  const deadline = Date.now() + (options.timeoutMs ?? NETWORK_TIMEOUT_MS);
  for (let hop = 0; hop <= 5; hop++) {
    if (options.sameOrigin && new URL(target).origin !== options.sameOrigin) throw containmentError('Cross-origin runtime redirect refused');
    const { url, address, family } = await resolveDestination(target, allowLocalNetwork);
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
 */
export async function createContainmentProxy(allowLocalNetwork, onBlocked) {
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
      const { url, address, family } = await resolveDestination(req.url ?? '', allowLocalNetwork);
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
      const { url, address } = await resolveDestination(`https://${req.url ?? ''}/`, allowLocalNetwork);
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
