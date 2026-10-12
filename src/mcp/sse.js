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
// Idle eviction waits for active calls, but the hard 30-minute TTL never does.
// Disconnection/TTL closes the session immediately, cancelling browser work.
//
// Containment refusals are visible from outside the process: `GET /healthz`
// carries the live counters and `GET /metrics` serves them in Prometheus text,
// so an operator can alert on blocked egress without reading the audit lines on
// stderr. Both are unauthenticated like `/healthz` and carry aggregate counts
// only — never a refused URL or a session identifier.
import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { beginProcessLifecycle } from '../../server/store.js';

const START_TIME_SECONDS = Math.floor(Date.now() / 1000);
import { containmentForwardingMetrics, containmentMetrics } from './containment.js';

/** Default port for the remote transport. */
export const DEFAULT_SSE_PORT = 3001;
/**
 * Hard deadline for a graceful stop, in milliseconds. A browser that will not
 * close must not hold the process open forever: past this the HTTP side is shut
 * down anyway and the remaining cleanup is reported rather than joined. The host
 * service declares the same number, and a test asserts the two agree.
 */
export const SHUTDOWN_DEADLINE_MS = 5000;
/** Largest accepted JSON-RPC POST body. Requests are messages, not documents. */
export const MAX_MESSAGE_BYTES = 1024 * 1024;
/** Comment-frame interval; keeps intermediaries from reaping an idle stream. */
const HEARTBEAT_MS = 15000;
/** Concurrent event streams one server holds open by default. */
export const DEFAULT_MAX_SESSIONS = 10;
/** How long a session may sit idle before it is reaped, by default. */
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
export const SESSION_MAX_TTL_MS = 1800000;
export const MAX_PENDING_MESSAGES = 16;
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
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} text
 * @param {string} contentType
 */
function sendText(res, status, text, contentType) {
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(text), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
  res.end(text);
}

/**
 * Containment counters and the session gauge in the Prometheus text format. The
 * categories are sorted so a scrape diff shows real movement rather than a
 * reordered exposition.
 * @param {number} sessionCount @param {number} sessionCeiling @param {number} uncleanShutdowns @returns {string}
 */
function prometheusMetrics(sessionCount, sessionCeiling, uncleanShutdowns) {
  const { containment } = containmentMetrics();
  const forwarding = containmentForwardingMetrics();
  const lines = [
    '# HELP process_start_time_seconds Process start time in Unix seconds.',
    '# TYPE process_start_time_seconds gauge',
    `process_start_time_seconds ${START_TIME_SECONDS}`,
    '# HELP navi_mcp_unclean_shutdowns_total Previous SSE owner did not complete graceful teardown (0 or 1 per boot).',
    '# TYPE navi_mcp_unclean_shutdowns_total counter',
    `navi_mcp_unclean_shutdowns_total ${uncleanShutdowns}`,
    '# HELP navi_containment_enforced 1 while the private-network policy is active, 0 when NAVI_ALLOW_LOCAL_NETWORK=1 disabled it.',
    '# TYPE navi_containment_enforced gauge',
    `navi_containment_enforced ${containment.enforced ? 1 : 0}`,
    '# HELP navi_containment_violations_total Destinations refused by the containment policy since process start.',
    '# TYPE navi_containment_violations_total counter',
    `navi_containment_violations_total ${containment.violations_total}`,
    '# HELP navi_containment_violations Destinations refused by the containment policy, by category.',
    '# TYPE navi_containment_violations counter'
  ];
  for (const category of Object.keys(containment.violations_by_category).sort()) lines.push(`navi_containment_violations{category="${category}"} ${containment.violations_by_category[category]}`);
  lines.push(
    // A climbing failed or dropped count is the signal that the durable audit
    // trail has holes, which is the one risk a fail-safe forwarder introduces.
    '# HELP navi_containment_forwarded_total Violations accepted by the telemetry host.',
    '# TYPE navi_containment_forwarded_total counter',
    `navi_containment_forwarded_total ${forwarding.forwarded}`,
    '# HELP navi_containment_forward_failed_total Violations the telemetry host refused or never answered.',
    '# TYPE navi_containment_forward_failed_total counter',
    `navi_containment_forward_failed_total ${forwarding.failed}`,
    '# HELP navi_containment_forward_dropped_total Violations not queued because the forward backlog was full.',
    '# TYPE navi_containment_forward_dropped_total counter',
    `navi_containment_forward_dropped_total ${forwarding.dropped}`,
    '# HELP navi_containment_forward_queued Violations waiting to be forwarded.',
    '# TYPE navi_containment_forward_queued gauge',
    `navi_containment_forward_queued ${forwarding.queued}`,
    '# HELP navi_mcp_sessions Open SSE sessions.', '# TYPE navi_mcp_sessions gauge', `navi_mcp_sessions ${sessionCount}`,
    '# HELP navi_mcp_sessions_max Configured SSE session ceiling.', '# TYPE navi_mcp_sessions_max gauge', `navi_mcp_sessions_max ${sessionCeiling}`
  );
  return `${lines.join('\n')}\n`;
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
    const timer = setTimeout(() => { req.destroy(); resolve({ text: '' }); }, 10000);
    timer.unref();
    req.once('close', () => { clearTimeout(timer); resolve({ text: '' }); });
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
    req.on('end', () => { clearTimeout(timer); resolve({ text: Buffer.concat(chunks).toString('utf8') }); });
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
 * @property {Timer | null} ttlTimer
 * @property {Timer | null} heartbeat
 * @property {boolean} released
 * @property {Promise<void> | null} cleanup
 * @property {() => void} touch Restarts the idle clock.
 */

/**
 * Start an SSE MCP server.
 * @param {object} options
 * @param {number} [options.port] 0 picks a free port.
 * @param {string} [options.host]
 * @param {(id: string) => any} options.createSession
 * @param {(message: Record<string, any>, state: {session: any, initialized: {value: boolean}, log: (line: string) => void}) => Promise<unknown>} options.handleMessage
 * @param {(line: string) => void} [options.log]
 * @param {string} [options.authToken] Require this bearer token when non-empty.
 * @param {number} [options.maxSessions] Concurrent streams allowed.
 * @param {number} [options.idleTimeoutMs] 0 disables idle reaping.
 * @param {number} [options.sessionMaxTtlMs] May shorten, never extend the hard TTL.
 * @param {string} [options.stateFile] Exclusive lifecycle state path; defaults to /tmp/navi-mcp-state.
 * @param {number} [options.shutdownDeadlineMs] May shorten the teardown deadline for embedded callers.
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
  const sessionMaxTtlMs = options.sessionMaxTtlMs ?? SESSION_MAX_TTL_MS;
  if (!Number.isInteger(sessionMaxTtlMs) || sessionMaxTtlMs < 1 || sessionMaxTtlMs > SESSION_MAX_TTL_MS) throw new Error('Session TTL must be between 1 and 1800000ms');
  const shutdownDeadlineMs = Math.min(SHUTDOWN_DEADLINE_MS, Math.max(1, options.shutdownDeadlineMs ?? SHUTDOWN_DEADLINE_MS));
  const lifecycle = await beginProcessLifecycle(options.stateFile ?? process.env.NAVI_MCP_STATE_FILE ?? '/tmp/navi-mcp-state', { createState: true });
  const cleanupTasks = new Set();
  /** Remember even failed disconnect cleanups already removed from the registry. */
  let cleanupFailure = /** @type {unknown} */ (null);
  /** @type {Promise<void> | null} */
  let closePromise = null;
  let stopping = false;
  /** @type {Map<string, SseSession>} */
  const sessions = new Map();

  /**
   * Drop a session from the registry and close its browser exactly once. Both
   * the idle reaper and the socket close event land here.
   * @param {SseSession} entry
   * @param {string} reason
   */
  const release = (entry, reason) => {
    if (entry.released) return entry.cleanup;
    entry.released = true;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (entry.ttlTimer) clearTimeout(entry.ttlTimer);
    if (entry.heartbeat) clearInterval(entry.heartbeat);
    // Invoke close now, not after the message queue; an active tool must not keep
    // Chromium alive after disconnection. Keep the slot occupied until cleanup
    // completes so reconnect storms cannot exceed the browser ceiling.
    let closing;
    try { closing = entry.session.close?.(); } catch (error) { closing = Promise.reject(error); }
    entry.cleanup = Promise.resolve(closing).catch(error => {
      log(`sse session cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      cleanupFailure ??= error;
      throw error;
    }).finally(() => {
      sessions.delete(entry.id);
      cleanupTasks.delete(entry.cleanup);
    });
    cleanupTasks.add(entry.cleanup);
    // Disconnect handlers cannot await, but server.close() joins every cleanup.
    void entry.cleanup.catch(() => {});
    entry.res.end();
    log(`sse session ${entry.id} closing (${reason})`);
    return entry.cleanup;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (stopping) { sendJson(res, 503, { ok: false, error: { code: 'SERVER_STOPPING' } }); return; }

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
      let session;
      try { session = createSession(id); }
      catch (error) {
        log(`session creation failed: ${error instanceof Error ? error.message : String(error)}`);
        res.end(); return;
      }
      /** @type {SseSession} */
      const entry = { id, res, session, initialized: { value: false }, queue: Promise.resolve(), openedAt: Date.now(), callsInFlight: 0, idleTimer: null, ttlTimer: null, heartbeat: null, released: false, cleanup: null, touch: () => {} };
      sessions.set(id, entry);
      log(`sse session ${id} opened (${sessions.size} open)`);

      const heartbeat = setInterval(() => { write(': ping\n\n'); }, HEARTBEAT_MS);
      heartbeat.unref?.();
      entry.heartbeat = heartbeat;
      entry.ttlTimer = setTimeout(() => { release(entry, 'hard session TTL'); }, sessionMaxTtlMs);
      entry.ttlTimer.unref?.();

      // Idle reaping. An abandoned stream would otherwise hold a browser open for
      // the life of the process.
      const arm = () => {
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        if (!idleTimeoutMs || entry.released) return;
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
      if (!entry || entry.released) {
        sendJson(res, 404, { jsonrpc: '2.0', id: null, error: { code: -32001, message: `Unknown or expired sessionId "${id}". Open GET /sse first and use the sessionId from its endpoint event.` } });
        return;
      }
      if (entry.callsInFlight >= MAX_PENDING_MESSAGES) {
        sendJson(res, 429, { ok: false, error: { code: 'TOO_MANY_PENDING_MESSAGES' } }); return;
      }
      entry.callsInFlight++;
      entry.touch();
      const body = await readBody(req, MAX_MESSAGE_BYTES);
      if (entry.released) { entry.callsInFlight--; res.end(); return; }
      if ('tooLarge' in body) {
        entry.callsInFlight--;
        sendJson(res, 413, { jsonrpc: '2.0', id: null, error: { code: -32600, message: `Request body over ${MAX_MESSAGE_BYTES} bytes` } });
        return;
      }
      /** @type {Record<string, any>} */
      let message;
      try {
        message = JSON.parse(body.text || 'null');
      } catch (error) {
        entry.callsInFlight--;
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
      entry.queue = entry.queue.then(async () => {
        try {
          if (entry.released) return;
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

    if (req.method === 'GET' && url.pathname === '/metrics') {
      // A scraper asking for OpenMetrics text gets the same body: the counters it
      // reads are identical, and the version parameter names the format served.
      sendText(res, 200, prometheusMetrics(sessions.size, maxSessions, lifecycle.uncleanShutdowns), 'text/plain; version=0.0.4; charset=utf-8');
      return;
    }

    if (req.method === 'GET' && url.pathname === '/healthz') {
      sendJson(res, 200, { ok: true, transport: 'sse', sessions: sessions.size, maxSessions, auth: authToken ? 'bearer' : 'none', idleTimeoutMs, sessionMaxTtlMs, maxPendingMessages: MAX_PENDING_MESSAGES, containment: containmentMetrics().containment, containmentForwarding: containmentForwardingMetrics() });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/') {
      sendJson(res, 200, { ok: true, transport: 'sse', endpoints: { stream: 'GET /sse', messages: 'POST /message?sessionId=<id>', health: 'GET /healthz', metrics: 'GET /metrics' } });
      return;
    }

    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${url.pathname}.` } });
  });

  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  await new Promise(/** @param {(value?: void) => void} resolve @param {(error: Error) => void} reject */ (resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;

  return {
    server,
    port: boundPort,
    host,
    sessions,
    close: () => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        stopping = true;
        for (const entry of [...sessions.values()]) release(entry, 'server shutdown');
        // Every session has been asked to close, which is what terminates its browser
        // and removes its download directory. The join is bounded: a cleanup that does
        // not finish in time is reported and abandoned, because a stop that one wedged
        // browser can hold open is not a stop.
        let timer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
        const results = await Promise.race([
          Promise.allSettled([...cleanupTasks]),
          new Promise(/** @param {(value: null) => void} resolve */ resolve => {
            timer = setTimeout(() => resolve(null), shutdownDeadlineMs);
          })
        ]);
        if (timer) clearTimeout(timer);
        server.closeAllConnections();
        await new Promise(/** @param {(value?: void) => void} resolve */ resolve => server.close(() => resolve()));
        if (!Array.isArray(results)) {
          throw new Error(`browser cleanup did not finish within ${shutdownDeadlineMs}ms; transport stopped without a clean marker`);
        }
        const failed = results.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
        if (cleanupFailure !== null) throw cleanupFailure;
        await lifecycle.markClean();
      })();
      return closePromise;
    }
  };
}
