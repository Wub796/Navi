// Remote MCP transport: Server-Sent Events for server -> client messages and
// plain POSTs for client -> server messages, which is what the MCP SSE binding
// specifies. Built on `node:http` alone, so this ships with no HTTP framework,
// no router and no session library.
//
// The wire contract the official client implements:
//   GET  /sse                 -> text/event-stream; first frame is
//                                `event: endpoint` with the POST URL, then one
//                                default-message frame per JSON-RPC response.
//   POST /message?sessionId=x -> one JSON-RPC message, answered 202 immediately
//                                (the reply arrives on the stream instead).
//
// Every SSE connection owns its own NaviSession, i.e. its own browser, so two
// clients cannot drive each other's pages. That is also why an open stream is a
// resource: a caller that reaches this port can steer a real browser. Three
// bounds keep that from being unbounded:
//   * a bearer token (`--auth-token` / `NAVI_MCP_TOKEN`) gates /sse and /message;
//   * a session ceiling (`--max-sessions`) answers excess streams with 503;
//   * an idle timeout reaps abandoned sessions and closes their browsers.
// A session that is mid-call is never reaped, so a slow tool call cannot have
// its browser pulled out from under it.
import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';

/** Default port for the remote transport. */
export const DEFAULT_SSE_PORT = 3001;
/** Largest accepted JSON-RPC POST body. Requests are messages, not documents. */
export const MAX_MESSAGE_BYTES = 1024 * 1024;
/** Comment-frame interval; keeps intermediaries from reaping an idle stream. */
const HEARTBEAT_MS = 15000;
/** Concurrent event streams one server holds open by default. */
export const DEFAULT_MAX_SESSIONS = 10;
/** How long a session may sit idle before it is reaped, by default. */
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
/** HTTP header a rejected caller must send. */
const AUTH_CHALLENGE = 'Bearer realm="navi-mcp"';

/** @typedef {ReturnType<typeof setInterval>} Timer */

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {Record<string, unknown>} body
 * @param {Record<string, string>} [extraHeaders]
 */
function sendJson(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'X-Content-Type-Options': 'nosniff', ...extraHeaders });
  res.end(text);
}

/**
 * Constant-time bearer check.
 *
 * The length is compared before `timingSafeEqual`, which throws when the two
 * buffers differ in length; that leaks the token's length and nothing else.
 * @param {import('node:http').IncomingMessage} req
 * @param {string} token
 */
function isAuthorized(req, token) {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const offered = Buffer.from(header.slice('Bearer '.length), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return offered.length === expected.length && timingSafeEqual(offered, expected);
}

/** @param {import('node:http').ServerResponse} res */
function rejectUnauthorized(res) {
  sendJson(res, 401, {
    ok: false,
    error: {
      code: 'UNAUTHORIZED',
      message: 'This MCP server requires a Bearer token. Send "Authorization: Bearer <token>" on both GET /sse and POST /message.'
    }
  }, { 'WWW-Authenticate': AUTH_CHALLENGE });
}

/** Human-readable seconds for a millisecond timeout, so a sub-second window is
 * reported as 0.3 rather than a rounded 0. @param {number} ms */
function seconds(ms) {
  const value = ms / 1000;
  return value >= 1 ? String(Math.round(value)) : value.toFixed(1);
}

/**
 * Read a request body with a hard cap, so an oversized or never-ending body can
 * not be used to hold memory open.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<{ text: string } | { tooLarge: true }>}
 */
function readBody(req, limit) {
  return new Promise(resolve => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        resolve({ tooLarge: true });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => resolve({ text: '' }));
  });
}

/**
 * @typedef {object} SseSession
 * @property {string} id
 * @property {import('node:http').ServerResponse} res
 * @property {any} session NaviSession
 * @property {{value: boolean}} initialized
 * @property {Promise<void>} queue Serializes messages for one client.
 * @property {number} openedAt
 * @property {number} callsInFlight Dispatched tool calls not yet answered.
 * @property {Timer | null} idleTimer
 * @property {() => void} touch Restarts the idle clock.
 */

/**
 * Start an SSE MCP server.
 * @param {object} options
 * @param {number} [options.port] 0 picks a free port.
 * @param {string} [options.host]
 * @param {() => any} options.createSession
 * @param {(message: Record<string, any>, state: {session: any, initialized: {value: boolean}, log: (line: string) => void}) => Promise<unknown>} options.handleMessage
 * @param {(line: string) => void} [options.log]
 * @param {string} [options.authToken] Require this bearer token when non-empty.
 * @param {number} [options.maxSessions] Concurrent streams allowed.
 * @param {number} [options.idleTimeoutMs] 0 disables idle reaping.
 * @returns {Promise<{ server: import('node:http').Server, port: number, host: string, sessions: Map<string, SseSession>, close: () => Promise<void> }>}
 */
export async function createSseServer(options) {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? DEFAULT_SSE_PORT;
  const createSession = options.createSession;
  const handleMessage = options.handleMessage;
  const log = options.log ?? (() => {});
  const authToken = options.authToken ?? '';
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  /** @type {Map<string, SseSession>} */
  const sessions = new Map();

  /**
   * Drop a session from the registry and close its browser exactly once. Both
   * the idle reaper and the socket close event land here.
   * @param {SseSession} entry
   * @param {string} reason
   */
  const release = (entry, reason) => {
    if (!sessions.delete(entry.id)) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    log(`sse session ${entry.id} closed after ${Math.round((Date.now() - entry.openedAt) / 1000)}s (${reason}; ${sessions.size} open)`);
    Promise.resolve(entry.session.close?.()).catch(() => {});
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/sse') {
      // Auth and the ceiling are decided before a stream is opened or a session
      // is created, so a rejected caller costs nothing but a response.
      if (authToken && !isAuthorized(req, authToken)) {
        log('rejected an unauthenticated GET /sse');
        rejectUnauthorized(res);
        return;
      }
      if (sessions.size >= maxSessions) {
        log(`refused GET /sse: ${sessions.size} of ${maxSessions} sessions are open`);
        sendJson(res, 503, {
          ok: false,
          error: {
            code: 'TOO_MANY_SESSIONS',
            message: `All ${maxSessions} session slots are in use. Close a stream, wait for an idle session to be reaped, or raise --max-sessions.`
          }
        }, { 'Retry-After': '5', Connection: 'close' });
        return;
      }

      const id = randomUUID();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Content-Type-Options': 'nosniff'
      });
      // A client that vanishes mid-write must not take the process down with an
      // unhandled ERR_STREAM_WRITE_AFTER_END; the session is released by the
      // close handler below, which is the part that matters.
      res.on('error', () => {});
      /** Write one chunk unless the stream is already gone. @param {string} chunk */
      const write = (chunk) => {
        if (res.writableEnded || res.destroyed) return false;
        try { res.write(chunk); return true; } catch { return false; }
      };
      // The endpoint frame tells the client where to POST. The origin must match
      // this stream's origin, which is why only the path is sent.
      write(`event: endpoint\ndata: /message?sessionId=${id}\n\n`);
      const session = createSession();
      /** @type {SseSession} */
      const entry = { id, res, session, initialized: { value: false }, queue: Promise.resolve(), openedAt: Date.now(), callsInFlight: 0, idleTimer: null, touch: () => {} };
      sessions.set(id, entry);
      log(`sse session ${id} opened (${sessions.size} open)`);

      const heartbeat = setInterval(() => { write(': ping\n\n'); }, HEARTBEAT_MS);
      heartbeat.unref?.();

      // Idle reaping. An abandoned stream would otherwise hold a browser open for
      // the life of the process.
      const arm = () => {
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        if (!idleTimeoutMs) return;
        entry.idleTimer = setTimeout(() => {
          // Busy sessions are re-checked rather than reaped: a tool call may
          // legitimately run longer than the idle window.
          if (entry.callsInFlight > 0) { arm(); return; }
          const idleLabel = seconds(idleTimeoutMs);
          log(`sse session ${id} idle for ${idleLabel}s, reaping it`);
          write(`: idle timeout after ${idleLabel}s; reconnect with a new GET /sse\n\n`);
          res.end();
          release(entry, 'idle timeout');
        }, idleTimeoutMs);
        entry.idleTimer.unref?.();
      };
      entry.touch = arm;
      arm();

      const shutdown = () => {
        clearInterval(heartbeat);
        if (!sessions.has(id)) return;
        release(entry, 'client closed');
      };
      req.on('close', shutdown);
      res.on('close', shutdown);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/message') {
      if (authToken && !isAuthorized(req, authToken)) {
        log('rejected an unauthenticated POST /message');
        rejectUnauthorized(res);
        return;
      }
      const id = url.searchParams.get('sessionId') ?? '';
      const entry = sessions.get(id);
      if (!entry) {
        sendJson(res, 404, { jsonrpc: '2.0', id: null, error: { code: -32001, message: `Unknown or expired sessionId "${id}". Open GET /sse first and use the sessionId from its endpoint event.` } });
        return;
      }
      entry.touch();
      const body = await readBody(req, MAX_MESSAGE_BYTES);
      if ('tooLarge' in body) {
        sendJson(res, 413, { jsonrpc: '2.0', id: null, error: { code: -32600, message: `Request body over ${MAX_MESSAGE_BYTES} bytes` } });
        return;
      }
      /** @type {Record<string, any>} */
      let message;
      try {
        message = JSON.parse(body.text || 'null');
      } catch (error) {
        sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: `Parse error: ${/** @type {Error} */ (error).message}` } });
        return;
      }
      // Acknowledge before the work happens: replies belong on the event stream,
      // and a slow tool call must not hold this POST open.
      sendJson(res, 202, { ok: true });
      /** @param {unknown} payload */
      const push = (payload) => {
        if (entry.res.writableEnded || entry.res.destroyed) return;
        try { entry.res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { /* the stream is gone; the client will reconnect */ }
      };
      entry.callsInFlight++;
      entry.queue = entry.queue.then(async () => {
        try {
          const reply = await handleMessage(message, { session: entry.session, initialized: entry.initialized, log });
          if (reply) push(reply);
        } catch (error) {
          push({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32603, message: `Internal error: ${error instanceof Error ? error.message : String(error)}` } });
        } finally {
          entry.callsInFlight--;
          entry.touch();
        }
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/healthz') {
      sendJson(res, 200, { ok: true, transport: 'sse', sessions: sessions.size, maxSessions, auth: authToken ? 'bearer' : 'none', idleTimeoutMs });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/') {
      sendJson(res, 200, { ok: true, transport: 'sse', endpoints: { stream: 'GET /sse', messages: 'POST /message?sessionId=<id>', health: 'GET /healthz' } });
      return;
    }

    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${url.pathname}.` } });
  });

  await new Promise(/** @param {(value?: void) => void} resolve */ resolve => server.listen(port, host, () => resolve()));
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;

  return {
    server,
    port: boundPort,
    host,
    sessions,
    close: async () => {
      for (const entry of [...sessions.values()]) {
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        try { entry.res.end(); } catch { /* already closed */ }
        await Promise.resolve(entry.session.close?.()).catch(() => {});
      }
      sessions.clear();
      await new Promise(/** @param {(value?: void) => void} resolve */ resolve => server.close(() => resolve()));
    }
  };
}
