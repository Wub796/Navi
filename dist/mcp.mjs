#!/usr/bin/env node
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};

// src/settle.js
import { randomUUID } from "node:crypto";
function normalizeSettle(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { error: "settle must be an object with optional timeout_ms and wait_for." };
  }
  const record = (
    /** @type {Record<string, unknown>} */
    input
  );
  const unknown = Object.keys(record).filter((key) => key !== "timeout_ms" && key !== "wait_for");
  if (unknown.length) return { error: `Unknown settle key(s) ${unknown.join(", ")}; expected timeout_ms and wait_for.` };
  const waitFor = record.wait_for ?? "mutation_settle";
  if (typeof waitFor !== "string" || !SETTLE_MODES.includes(
    /** @type {SettleMode} */
    waitFor
  )) {
    return { error: `wait_for must be one of ${SETTLE_MODES.join(", ")}; got ${JSON.stringify(waitFor)}.` };
  }
  const timeoutMs = record.timeout_ms ?? DEFAULT_SETTLE_TIMEOUT_MS;
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_SETTLE_TIMEOUT_MS) {
    return { error: `timeout_ms must be an integer between 1 and ${MAX_SETTLE_TIMEOUT_MS}.` };
  }
  return { plan: { waitFor: (
    /** @type {SettleMode} */
    waitFor
  ), timeoutMs, quietMs: MUTATION_QUIET_MS } };
}
async function prepareSettle(page, plan) {
  if (plan.waitFor === "navigation") {
    const token = randomUUID();
    try {
      await page.evaluate(
        /** @param {string} value */
        (value) => {
          globalThis.__naviSettleToken = value;
        },
        token
      );
    } catch {
      return { token: null, beforeUrl: null, armed: false };
    }
    return { token, beforeUrl: page.url(), armed: true };
  }
  if (plan.waitFor === "mutation_settle") {
    try {
      await page.evaluate(
        /** @param {{quietMs: number}} arg */
        (arg) => {
          const scope = (
            /** @type {any} */
            globalThis
          );
          if (scope.__naviSettle) {
            for (const observer of scope.__naviSettle.observers) observer.disconnect();
          }
          const observers = [];
          const state = { last: performance.now(), quietMs: arg.quietMs, observers };
          const watch = (node) => {
            const observer = new MutationObserver(() => {
              state.last = performance.now();
            });
            observer.observe(node, { subtree: true, childList: true, attributes: true, characterData: true });
            observers.push(observer);
          };
          const seen = /* @__PURE__ */ new Set();
          const walk = (root) => {
            watch(root);
            for (const element of root.querySelectorAll("*")) {
              if (element.shadowRoot && !seen.has(element.shadowRoot)) {
                seen.add(element.shadowRoot);
                walk(element.shadowRoot);
              }
            }
            for (const frame of root.querySelectorAll("iframe")) {
              let doc = null;
              try {
                doc = /** @type {HTMLIFrameElement} */
                frame.contentDocument;
              } catch {
                doc = null;
              }
              if (doc && !seen.has(doc)) {
                seen.add(doc);
                walk(doc);
              }
            }
          };
          walk(document);
          scope.__naviSettle = state;
        },
        { quietMs: plan.quietMs }
      );
    } catch {
      return { token: null, beforeUrl: null, armed: false };
    }
    return { token: null, beforeUrl: null, armed: true };
  }
  return { token: null, beforeUrl: null, armed: true };
}
async function completeSettle(page, plan, targetId, prepared) {
  try {
    if (plan.waitFor === "navigation") {
      if (!prepared.armed || !prepared.token) return { settled: false, elapsedMs: 0, reason: "arm_failed" };
      if (page.url() !== prepared.beforeUrl) return { settled: true, elapsedMs: 0 };
      const started = Date.now();
      while (Date.now() - started < plan.timeoutMs) {
        await new Promise((resolve2) => setTimeout(resolve2, NAVIGATION_POLL_MS));
        if (page.url() !== prepared.beforeUrl) return { settled: true, elapsedMs: Date.now() - started };
        try {
          const token = await page.evaluate(() => (
            /** @type {any} */
            globalThis.__naviSettleToken
          ));
          if (token !== prepared.token) return { settled: true, elapsedMs: Date.now() - started };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/execution context was destroyed|navigat/i.test(message)) continue;
          return { settled: false, elapsedMs: Date.now() - started, reason: "settle_failed" };
        }
      }
      return { settled: false, elapsedMs: Date.now() - started, reason: "timeout" };
    }
    if (plan.waitFor === "mutation_settle") {
      if (!prepared.armed) return { settled: false, elapsedMs: 0, reason: "arm_failed" };
      const outcome2 = (
        /** @type {SettleOutcome} */
        await page.evaluate(async (arg) => {
          const scope = (
            /** @type {any} */
            globalThis
          );
          const state = scope.__naviSettle;
          if (!state) return { settled: false, elapsedMs: 0, reason: "not_armed" };
          const start = performance.now();
          const deadline = start + arg.timeoutMs;
          try {
            for (; ; ) {
              const now = performance.now();
              if (now - state.last >= state.quietMs) return { settled: true, elapsedMs: now - start };
              if (now >= deadline) return { settled: false, elapsedMs: now - start, reason: "timeout" };
              await new Promise((resolve2) => setTimeout(resolve2, Math.min(50, Math.max(1, deadline - now))));
            }
          } finally {
            for (const observer of state.observers) observer.disconnect();
            delete scope.__naviSettle;
          }
        }, { timeoutMs: plan.timeoutMs })
      );
      return outcome2;
    }
    const outcome = (
      /** @type {SettleOutcome} */
      await page.evaluate(async (arg) => {
        const navi = (
          /** @type {any} */
          globalThis.Navi
        );
        if (!navi) return { settled: false, elapsedMs: 0, reason: "no_sdk" };
        const start = performance.now();
        const deadline = start + arg.timeoutMs;
        for (; ; ) {
          const map = await navi.actions({ limit: 5e3, coordinateSpace: "top" });
          const matches = map.actions.filter((action2) => action2.target_id === arg.targetId);
          const action = matches.length === 1 ? matches[0] : null;
          const hidden = action ? !action.state.is_visible || action.state.is_occluded : !map.truncated;
          if (hidden) return { settled: true, elapsedMs: performance.now() - start };
          if (performance.now() >= deadline) return { settled: false, elapsedMs: performance.now() - start, reason: "timeout" };
          await new Promise((resolve2) => setTimeout(resolve2, arg.pollMs));
        }
      }, { targetId, timeoutMs: plan.timeoutMs, pollMs: TARGET_POLL_MS })
    );
    return outcome;
  } catch (error) {
    return { settled: false, elapsedMs: 0, reason: `settle_failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
var SETTLE_MODES, DEFAULT_SETTLE_TIMEOUT_MS, MAX_SETTLE_TIMEOUT_MS, MUTATION_QUIET_MS, TARGET_POLL_MS, NAVIGATION_POLL_MS;
var init_settle = __esm({
  "src/settle.js"() {
    "use strict";
    SETTLE_MODES = /** @type {const} */
    ["mutation_settle", "navigation", "target_hidden"];
    DEFAULT_SETTLE_TIMEOUT_MS = 3e3;
    MAX_SETTLE_TIMEOUT_MS = 3e4;
    MUTATION_QUIET_MS = 100;
    TARGET_POLL_MS = 50;
    NAVIGATION_POLL_MS = 50;
  }
});

// src/adapter.js
var NAVI_PROTOCOL_VERSION, ACTIONS, MAX_TEXT, NaviPlaywrightAdapter;
var init_adapter = __esm({
  "src/adapter.js"() {
    "use strict";
    init_settle();
    NAVI_PROTOCOL_VERSION = "0.3.0";
    ACTIONS = ["click", "type", "select"];
    MAX_TEXT = 1e4;
    NaviPlaywrightAdapter = class {
      /** @param {NaviPageLike} page @param {NaviAdapterOptions} [options] */
      constructor(page, options = {}) {
        if (!page || typeof page.evaluate !== "function" || typeof page.url !== "function") {
          throw new TypeError("NaviPlaywrightAdapter requires a Playwright page object");
        }
        this.page = page;
        this.protocolVersion = options.protocolVersion || NAVI_PROTOCOL_VERSION;
        this.fallback = options.fallback !== false;
        this.maxFallbackAgeMs = Number.isFinite(options.maxFallbackAgeMs) ? Number(options.maxFallbackAgeMs) : 2e3;
        this.origin = new URL(page.url()).origin;
        this.busy = false;
      }
      checkOrigin() {
        if (new URL(this.page.url()).origin !== this.origin) {
          throw new Error("Adapter origin changed; reauthorize before continuing");
        }
      }
      /** @overload @param {{viewportOnly?: boolean, limit?: number, since_version: number}} options @returns {Promise<NaviDifferentialMap>} */
      /** @overload @param {{viewportOnly?: boolean, limit?: number}} [options] @returns {Promise<NaviActionMap>} */
      /** @param {{viewportOnly?: boolean, limit?: number, since_version?: number}} [options] @returns {Promise<NaviActionMap | NaviDifferentialMap>} */
      async discover(options = {}) {
        this.checkOrigin();
        const expected = this.protocolVersion;
        const snapshot = await this.page.evaluate(async (arg) => {
          const navi = (
            /** @type {any} */
            globalThis.Navi
          );
          if (!navi) throw new Error("Navi is not installed on this page");
          if (navi.version !== arg.expected) throw new Error(`Unsupported Navi protocol ${navi.version}; expected ${arg.expected}`);
          return navi.actions({ limit: arg.limit ?? 5e3, coordinateSpace: "top", viewportOnly: arg.viewportOnly, since_version: arg.since_version });
        }, { expected, viewportOnly: options.viewportOnly, limit: options.limit, since_version: options.since_version });
        if (!snapshot || typeof snapshot !== "object") throw new Error("Navi returned no action map");
        if (snapshot.truncated) throw new Error("Incomplete action map; raise the limit or narrow the page");
        return (
          /** @type {NaviActionMap} */
          snapshot
        );
      }
      /**
       * Execute one target. Returns a structured result instead of throwing for
       * anticipated refusals so callers can decide policy.
       *
       * The optional `settle` request is armed *before* dispatch and completed after
       * it, inside the same busy window, so no other call can observe the page
       * mid-action. Settlement never retries an action and never turns a dispatched
       * action into an error; it only reports whether the requested condition held.
       * @param {string} targetId
       * @param {'click'|'type'|'select'|string} actionType
       * @param {{text?: string, value?: string}} [payload]
       * @param {unknown} [settle] Optional settlement request, validated by src/settle.js.
       * @returns {Promise<AdapterResult>}
       */
      async execute(targetId, actionType, payload = {}, settle) {
        this.checkOrigin();
        if (this.busy) return { ok: false, error: { code: "BUSY", message: "Adapter execution in flight" } };
        if (!targetId || typeof targetId !== "string" || targetId.length > 512 || !ACTIONS.includes(actionType) || !payload || typeof payload !== "object" || Object.keys(payload).some((key) => key !== (actionType === "type" ? "text" : actionType === "select" ? "value" : "")) || actionType === "type" && (typeof payload.text !== "string" || payload.text.length > MAX_TEXT)) {
          return { ok: false, error: { code: "INVALID_PAYLOAD", message: "Invalid adapter command" } };
        }
        let plan = null;
        if (settle !== void 0) {
          const normalized = normalizeSettle(settle);
          if ("error" in normalized) return { ok: false, error: { code: "INVALID_SETTLE", message: normalized.error } };
          plan = normalized.plan;
        }
        this.busy = true;
        try {
          const prepared = plan ? await prepareSettle(this.page, plan) : null;
          const dispatchedAt = Date.now();
          const expected = this.protocolVersion;
          let response;
          try {
            response = await this.page.evaluate(async (arg) => {
              const navi = (
                /** @type {any} */
                globalThis.Navi
              );
              if (!navi) throw new Error("Navi is not installed on this page");
              if (navi.version !== arg.expected) throw new Error(`Unsupported Navi protocol ${navi.version}; expected ${arg.expected}`);
              try {
                return { ok: true, result: await navi.execute(arg.targetId, arg.actionType, arg.payload) };
              } catch (error) {
                const failure = (
                  /** @type {Error & {code?: string, reason?: string, dispatched?: boolean}} */
                  error
                );
                return { ok: false, error: {
                  code: failure.code || "EXECUTION_ERROR",
                  message: failure.message,
                  reason: failure.reason,
                  dispatched: failure.dispatched
                } };
              }
            }, { targetId, actionType, payload, expected });
          } catch (error) {
            if (!plan || plan.waitFor !== "navigation" || !prepared) throw error;
            const receipt = await completeSettle(this.page, plan, targetId, prepared);
            if (!receipt.settled) throw error;
            return {
              ok: true,
              result: { target_id: targetId, action: actionType, dispatched: true },
              mode: "synthetic",
              settle: {
                mode: plan.waitFor,
                settled: true,
                elapsed_ms: Date.now() - dispatchedAt,
                final_url: this.page.url(),
                ...receipt.reason ? { reason: receipt.reason } : {}
              }
            };
          }
          const returned = (
            /** @type {{success?:boolean,reason?:string,dispatched?:boolean} | undefined} */
            response.result
          );
          const needsTrusted = returned?.success === false && returned.reason === "untrusted_gesture_required" && returned.dispatched !== true;
          const dispatchFailed = response.error?.reason === "dispatch_failed" && response.error.dispatched === false;
          const safeReturnedFailure = returned?.success === false && returned.reason === "dispatch_failed" && returned.dispatched === false;
          if (!needsTrusted && !dispatchFailed && !safeReturnedFailure) {
            if (response.ok === false) return { ok: false, error: response.error };
            if (returned?.success === false) {
              return { ok: false, error: { code: "EXECUTION_FAILED", message: returned.reason || "Host reported failure" } };
            }
            return await this.#withSettle({ ok: true, result: response.result, mode: "synthetic" }, plan, prepared, dispatchedAt, targetId);
          }
          if (!this.fallback) return { ok: false, error: { code: "FALLBACK_DISABLED", message: "Target requires trusted input and fallback is disabled" } };
          if (actionType !== "click" && actionType !== "type") {
            return { ok: false, error: { code: "FALLBACK_UNSUPPORTED", message: "Trusted fallback supports click and type only" } };
          }
          return await this.#withSettle(await this.#fallback(targetId, actionType, payload), plan, prepared, dispatchedAt, targetId);
        } finally {
          this.busy = false;
        }
      }
      /**
       * Attach a settlement receipt to a dispatched outcome. The receipt carries the
       * requested mode, whether the condition held, the wall time from dispatch to
       * receipt, and where the page ended up.
       * @param {AdapterResult} outcome
       * @param {{waitFor: 'mutation_settle'|'navigation'|'target_hidden', timeoutMs: number, quietMs: number} | null} plan
       * @param {{token: string | null, beforeUrl: string | null, armed: boolean} | null} prepared
       * @param {number} dispatchedAt
       * @param {string} targetId
       * @returns {Promise<AdapterResult>}
       */
      async #withSettle(outcome, plan, prepared, dispatchedAt, targetId) {
        if (!plan || !prepared || !outcome.ok) return outcome;
        const receipt = await completeSettle(this.page, plan, targetId, prepared);
        return {
          ...outcome,
          settle: {
            mode: plan.waitFor,
            settled: receipt.settled,
            elapsed_ms: Date.now() - dispatchedAt,
            final_url: this.page.url(),
            ...receipt.reason ? { reason: receipt.reason } : {}
          }
        };
      }
      /**
       * Native driver fallback: fresh coordinates, strict state checks, no blind retries.
       * When settlement was requested, the caller's #withSettle wraps this result, so
       * the trusted path reports the same receipt fields as the synthetic one.
       * @param {string} targetId
       * @param {string} actionType
       * @param {{text?: string, value?: string}} payload
       * @returns {Promise<AdapterResult>}
       */
      async #fallback(targetId, actionType, payload) {
        const started = Date.now();
        const snapshot = await this.discover({ viewportOnly: true });
        if (Date.now() - started > this.maxFallbackAgeMs) {
          return { ok: false, error: { code: "STALE_COORDINATES", message: "Fallback discovery exceeded its freshness deadline" } };
        }
        const matches = snapshot.actions.filter((action2) => action2.target_id === targetId);
        if (matches.length !== 1) return { ok: false, error: { code: "TARGET_UNAVAILABLE", message: "Missing or ambiguous fallback target" } };
        const action = matches[0], state = action.state, box = action.coordinates;
        if (!state || !box || !state.is_visible || !state.is_enabled || !state.is_in_viewport || state.is_occluded || ![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0) {
          return { ok: false, error: { code: "TARGET_UNAVAILABLE", message: "Fallback target is not actionable" } };
        }
        if (actionType === "type" && action.suggested_action !== "type") {
          return { ok: false, error: { code: "TARGET_UNAVAILABLE", message: "Fallback type requires a text control" } };
        }
        const viewport = await this.page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        const x = box.x + box.width / 2, y = box.y + box.height / 2;
        if (!(x >= 0 && y >= 0 && x < viewport.width && y < viewport.height)) {
          return { ok: false, error: { code: "TARGET_UNAVAILABLE", message: "Fallback point is outside the viewport" } };
        }
        this.checkOrigin();
        await this.page.mouse.click(x, y);
        if (actionType === "type") {
          await this.page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
          if (payload.text) await this.page.keyboard.insertText(payload.text);
          else await this.page.keyboard.press("Backspace");
          await this.page.keyboard.press("Tab");
        }
        await this.page.evaluate(async () => {
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
          await /** @type {any} */
          globalThis.Navi?.ready();
        });
        return { ok: true, result: { target_id: targetId, action: actionType, dispatched: true }, mode: "native-driver" };
      }
    };
  }
});

// src/mcp/server.js
import { createHash, randomUUID as randomUUID3 } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// src/mcp/containment.js
import { lookup } from "node:dns/promises";
import { isIP, connect } from "node:net";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
var CONTAINMENT_CODE = "ERR_BLOCKED_BY_CONTAINMENT";
var MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
var MAX_CONNECTIONS = 64;
var NETWORK_TIMEOUT_MS = 2e4;
function containmentError(detail) {
  return Object.assign(new Error(`${CONTAINMENT_CODE}: ${detail}`), { code: CONTAINMENT_CODE });
}
function isPrivateAddress(address) {
  const bare = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(bare) === 4) {
    const [a, b] = bare.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0) || a === 198 && (b === 18 || b === 19);
  }
  if (isIP(bare) === 6) {
    const canonical = new URL(`http://[${bare}]/`).hostname.slice(1, -1);
    if (canonical.startsWith("::ffff:")) {
      const words = canonical.slice(7).split(":");
      const value = parseInt(words[0], 16) * 65536 + parseInt(words[1], 16);
      return isPrivateAddress([value >>> 24, value >>> 16 & 255, value >>> 8 & 255, value & 255].join("."));
    }
    const first = parseInt(canonical.split(":")[0], 16);
    return !Number.isFinite(first) || first < 8192 || first > 16383 || canonical.startsWith("2001:0:") || canonical.startsWith("2002:");
  }
  return true;
}
async function resolveHost(host) {
  let timer = (
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    void 0
  );
  try {
    return await Promise.race([
      lookup(host, { all: true, verbatim: true }),
      new Promise(
        /** @param {(value: never) => void} _resolve @param {(error: Error) => void} reject */
        (_resolve, reject) => {
          timer = setTimeout(() => reject(containmentError("DNS resolution timed out")), 5e3);
          timer.unref();
        }
      )
    ]);
  } catch {
    throw containmentError("Destination DNS could not be validated");
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function resolveDestination(value, allowLocalNetwork) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw containmentError("Invalid destination URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw containmentError("Only credential-free HTTP(S) destinations are permitted");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!allowLocalNetwork && (host === "localhost" || host.endsWith(".localhost") || isIP(host) && isPrivateAddress(host))) {
    throw containmentError("Private, loopback or link-local destination refused");
  }
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolveHost(host);
  if (!addresses.length || !allowLocalNetwork && addresses.some((entry) => isPrivateAddress(entry.address))) throw containmentError("DNS resolves to a non-public address");
  return { url, ...addresses[0] };
}
async function containedGet(value, allowLocalNetwork, options = {}) {
  let target = value;
  const deadline = Date.now() + (options.timeoutMs ?? NETWORK_TIMEOUT_MS);
  for (let hop = 0; hop <= 5; hop++) {
    if (options.sameOrigin && new URL(target).origin !== options.sameOrigin) throw containmentError("Cross-origin runtime redirect refused");
    const { url, address, family } = await resolveDestination(target, allowLocalNetwork);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw containmentError("Runtime request timed out");
    const response = await new Promise(
      /** @param {(value: {status: number, headers: import('node:http').IncomingHttpHeaders, bytes: Buffer, url: string}) => void} resolve @param {(error: Error) => void} reject */
      (resolve2, reject) => {
        const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
          agent: false,
          lookup: (_host, _options, callback) => callback(null, address, family),
          headers: { Accept: "*/*", "Accept-Encoding": "identity" },
          signal: AbortSignal.timeout(remaining)
        }, (incoming) => {
          const chunks = (
            /** @type {Buffer[]} */
            []
          );
          let bytes = 0;
          incoming.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > (options.maxBytes ?? MAX_RESPONSE_BYTES)) incoming.destroy(containmentError("Runtime response exceeds byte limit"));
            else chunks.push(chunk);
          });
          incoming.on("error", reject);
          incoming.on("end", () => resolve2({ status: incoming.statusCode ?? 502, headers: incoming.headers, bytes: Buffer.concat(chunks), url: url.href }));
        });
        request.on("error", reject);
        request.end();
      }
    );
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
      target = new URL(response.headers.location, target).href;
      continue;
    }
    return response;
  }
  throw containmentError("Too many runtime redirects");
}
async function createContainmentProxy(allowLocalNetwork, onBlocked) {
  const sockets = (
    /** @type {Set<import('node:net').Socket>} */
    /* @__PURE__ */ new Set()
  );
  let closed = false;
  const track = (socket) => {
    sockets.add(socket);
    socket.on("error", () => {
    });
    socket.on("close", () => sockets.delete(socket));
    return socket;
  };
  const server = createServer((req, res) => {
    void (async () => {
      const { url, address: address2, family } = await resolveDestination(req.url ?? "", allowLocalNetwork);
      if (closed) throw containmentError("Session closed");
      const headers = (
        /** @type {import('node:http').IncomingHttpHeaders} */
        { ...req.headers, host: url.host }
      );
      delete headers["proxy-authorization"];
      delete headers["proxy-connection"];
      delete headers.connection;
      const outbound = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
        method: req.method,
        headers,
        agent: false,
        lookup: (_host, _options, callback) => callback(null, address2, family)
      }, (response) => {
        const outgoingHeaders = {
          ...response.headers,
          "permissions-policy": "geolocation=(), camera=(), microphone=(), clipboard-read=(), clipboard-write=()"
        };
        res.writeHead(response.statusCode ?? 502, outgoingHeaders);
        response.pipe(res);
        response.on("error", () => res.destroy());
      });
      outbound.on("socket", track);
      outbound.setTimeout(NETWORK_TIMEOUT_MS, () => outbound.destroy());
      outbound.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      res.on("close", () => outbound.destroy());
      req.pipe(outbound);
    })().catch(() => {
      onBlocked();
      if (!res.headersSent) res.writeHead(403, { "X-Navi-Error": CONTAINMENT_CODE });
      res.end(CONTAINMENT_CODE);
    });
  });
  server.on("connection", (socket) => {
    if (closed || sockets.size >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    track(socket);
    socket.setTimeout(NETWORK_TIMEOUT_MS, () => socket.destroy());
  });
  server.on("upgrade", (_req, socket) => {
    onBlocked();
    socket.destroy();
  });
  server.on("connect", (req, client, head) => {
    void (async () => {
      const { url, address: address2 } = await resolveDestination(`https://${req.url ?? ""}/`, allowLocalNetwork);
      if (closed) throw containmentError("Session closed");
      const upstream = track(connect({ host: address2, port: Number(url.port || 443) }));
      upstream.setTimeout(NETWORK_TIMEOUT_MS, () => upstream.destroy());
      client.on("close", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      upstream.on("close", () => client.destroy());
      upstream.once("connect", () => {
        if (closed || client.destroyed) {
          upstream.destroy();
          return;
        }
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
    })().catch(() => {
      onBlocked();
      client.end(`HTTP/1.1 403 Forbidden\r
Connection: close\r
\r
${CONTAINMENT_CODE}`);
    });
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise(
    /** @param {(value?: void) => void} resolve @param {(error: Error) => void} reject */
    (resolve2, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve2);
    }
  );
  const address = server.address();
  if (!address || typeof address === "string") throw containmentError("Proxy failed to bind");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise(
        /** @param {(value?: void) => void} resolve */
        (resolve2) => {
          server.close(() => resolve2());
        }
      );
    }
  };
}

// src/mcp/server.js
init_adapter();
init_settle();
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

// src/browser.js
init_adapter();
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
function isAllowedUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return !url.username && !url.password;
  } catch {
    return false;
  }
}
async function resolveChromium() {
  const candidates = ["playwright", "playwright-core", "@playwright/test"];
  const tried = [];
  for (const name of candidates) {
    try {
      const module = await import(name);
      if (module?.chromium?.launch) return (
        /** @type {any} */
        module.chromium
      );
      tried.push(`${name} (no chromium export)`);
    } catch {
      tried.push(name);
    }
  }
  throw Object.assign(new Error(`Playwright is required. Install it (npm i -D playwright) and run "npx playwright install chromium". Tried: ${tried.join(", ")}`), { code: "NO_BROWSER" });
}
function resolveSdkPath(override) {
  if (override) return realpathSync(override);
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, "navi.min.js"), resolve(here, "../dist/navi.min.js")];
  for (const candidate of candidates) if (existsSync(candidate)) return realpathSync(candidate);
  throw Object.assign(new Error('Could not locate navi.min.js; run "npm run build" first'), { code: "NO_SDK" });
}
async function ensureNavi(page, sdkPath, expected = NAVI_PROTOCOL_VERSION) {
  const installed = await page.evaluate(() => Boolean(
    /** @type {any} */
    globalThis.Navi
  ));
  if (!installed) await page.addScriptTag({ path: sdkPath });
  const version = await page.evaluate(async (want) => {
    const navi = (
      /** @type {any} */
      globalThis.Navi
    );
    if (!navi) throw new Error("Navi failed to install");
    if (navi.version !== want) throw new Error(`Navi protocol ${navi.version} does not match the expected ${want}`);
    await navi.ready();
    return navi.version;
  }, expected);
  return { injected: !installed, version: (
    /** @type {string} */
    version
  ) };
}

// src/index.js
import { readFile } from "node:fs/promises";
import { fileURLToPath as fileURLToPath2 } from "node:url";
var NAVI_SDK_FILE = "navi.min.js";
function naviSdkPath() {
  return fileURLToPath2(new URL(NAVI_SDK_FILE, import.meta.url));
}
async function installNavi(page, options = {}) {
  const scriptPath = options.scriptPath || naviSdkPath();
  const timeoutMs = options.timeoutMs ?? 5e3;
  const inline = options.inline === true;
  const requested = options.strategy ?? (inline ? "evaluate" : "auto");
  const attempts = requested === "auto" ? ["tag", "evaluate"] : [requested];
  const failures = [];
  for (const attempt of attempts) {
    try {
      if (attempt === "tag") {
        if (inline) await page.addScriptTag({ content: await readFile(scriptPath, "utf8") });
        else await page.addScriptTag({ path: scriptPath });
      } else {
        await page.evaluate(await readFile(scriptPath, "utf8"));
      }
      await page.waitForFunction(() => Boolean(
        /** @type {any} */
        globalThis.Navi
      ), void 0, { timeout: timeoutMs });
      return scriptPath;
    } catch (error) {
      failures.push(`${attempt}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
  }
  throw Object.assign(new Error(
    `Could not install the Navi SDK on ${typeof page.url === "function" ? page.url() : "the page"} (${failures.join("; ")}). A page whose Content-Security-Policy blocks inline scripts rejects <script> injection; serve navi.min.js from the page origin, add a matching nonce, or use strategy "evaluate".`
  ), { code: "NAVI_INSTALL_FAILED" });
}

// src/mcp/sse.js
import { createServer as createServer2 } from "node:http";
import { randomUUID as randomUUID2, timingSafeEqual } from "node:crypto";
var DEFAULT_SSE_PORT = 3001;
var MAX_MESSAGE_BYTES = 1024 * 1024;
var HEARTBEAT_MS = 15e3;
var DEFAULT_MAX_SESSIONS = 10;
var DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1e3;
var SESSION_MAX_TTL_MS = 18e5;
var MAX_PENDING_MESSAGES = 16;
var AUTH_CHALLENGE = 'Bearer realm="navi-mcp"';
function sendJson(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text), "X-Content-Type-Options": "nosniff", ...extraHeaders });
  res.end(text);
}
function isAuthorized(req, token) {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const offered = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(token, "utf8");
  return offered.length === expected.length && timingSafeEqual(offered, expected);
}
function rejectUnauthorized(res) {
  sendJson(res, 401, {
    ok: false,
    error: {
      code: "UNAUTHORIZED",
      message: 'This MCP server requires a Bearer token. Send "Authorization: Bearer <token>" on both GET /sse and POST /message.'
    }
  }, { "WWW-Authenticate": AUTH_CHALLENGE });
}
function seconds(ms) {
  const value = ms / 1e3;
  return value >= 1 ? String(Math.round(value)) : value.toFixed(1);
}
function readBody(req, limit) {
  return new Promise((resolve2) => {
    const timer = setTimeout(() => {
      req.destroy();
      resolve2({ text: "" });
    }, 1e4);
    timer.unref();
    req.once("close", () => {
      clearTimeout(timer);
      resolve2({ text: "" });
    });
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        resolve2({ tooLarge: true });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      clearTimeout(timer);
      resolve2({ text: Buffer.concat(chunks).toString("utf8") });
    });
    req.on("error", () => resolve2({ text: "" }));
  });
}
async function createSseServer(options) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? DEFAULT_SSE_PORT;
  const createSession = options.createSession;
  const handleMessage2 = options.handleMessage;
  const log = options.log ?? (() => {
  });
  const authToken = options.authToken ?? "";
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const sessionMaxTtlMs = options.sessionMaxTtlMs ?? SESSION_MAX_TTL_MS;
  if (!Number.isInteger(sessionMaxTtlMs) || sessionMaxTtlMs < 1 || sessionMaxTtlMs > SESSION_MAX_TTL_MS) throw new Error("Session TTL must be between 1 and 1800000ms");
  const cleanupTasks = /* @__PURE__ */ new Set();
  let stopping = false;
  const sessions = /* @__PURE__ */ new Map();
  const release = (entry, reason) => {
    if (entry.released) return entry.cleanup;
    entry.released = true;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (entry.ttlTimer) clearTimeout(entry.ttlTimer);
    if (entry.heartbeat) clearInterval(entry.heartbeat);
    let closing;
    try {
      closing = entry.session.close?.();
    } catch (error) {
      closing = Promise.reject(error);
    }
    entry.cleanup = Promise.resolve(closing).catch((error) => {
      log(`sse session cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }).finally(() => {
      sessions.delete(entry.id);
      cleanupTasks.delete(entry.cleanup);
    });
    cleanupTasks.add(entry.cleanup);
    void entry.cleanup.catch(() => {
    });
    entry.res.end();
    log(`sse session ${entry.id} closing (${reason})`);
    return entry.cleanup;
  };
  const server = createServer2(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (stopping) {
      sendJson(res, 503, { ok: false, error: { code: "SERVER_STOPPING" } });
      return;
    }
    if (req.method === "GET" && url.pathname === "/sse") {
      if (authToken && !isAuthorized(req, authToken)) {
        log("rejected an unauthenticated GET /sse");
        rejectUnauthorized(res);
        return;
      }
      if (sessions.size >= maxSessions) {
        log(`refused GET /sse: ${sessions.size} of ${maxSessions} sessions are open`);
        sendJson(res, 503, {
          ok: false,
          error: {
            code: "TOO_MANY_SESSIONS",
            message: `All ${maxSessions} session slots are in use. Close a stream, wait for an idle session to be reaped, or raise --max-sessions.`
          }
        }, { "Retry-After": "5", Connection: "close" });
        return;
      }
      const id = randomUUID2();
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff"
      });
      res.on("error", () => {
      });
      const write = (chunk) => {
        if (res.writableEnded || res.destroyed) return false;
        try {
          res.write(chunk);
          return true;
        } catch {
          return false;
        }
      };
      write(`event: endpoint
data: /message?sessionId=${id}

`);
      let session;
      try {
        session = createSession(id);
      } catch (error) {
        log(`session creation failed: ${error instanceof Error ? error.message : String(error)}`);
        res.end();
        return;
      }
      const entry = { id, res, session, initialized: { value: false }, queue: Promise.resolve(), openedAt: Date.now(), callsInFlight: 0, idleTimer: null, ttlTimer: null, heartbeat: null, released: false, cleanup: null, touch: () => {
      } };
      sessions.set(id, entry);
      log(`sse session ${id} opened (${sessions.size} open)`);
      const heartbeat = setInterval(() => {
        write(": ping\n\n");
      }, HEARTBEAT_MS);
      heartbeat.unref?.();
      entry.heartbeat = heartbeat;
      entry.ttlTimer = setTimeout(() => {
        release(entry, "hard session TTL");
      }, sessionMaxTtlMs);
      entry.ttlTimer.unref?.();
      const arm = () => {
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        if (!idleTimeoutMs || entry.released) return;
        entry.idleTimer = setTimeout(() => {
          if (entry.callsInFlight > 0) {
            arm();
            return;
          }
          const idleLabel = seconds(idleTimeoutMs);
          log(`sse session ${id} idle for ${idleLabel}s, reaping it`);
          write(`: idle timeout after ${idleLabel}s; reconnect with a new GET /sse

`);
          res.end();
          release(entry, "idle timeout");
        }, idleTimeoutMs);
        entry.idleTimer.unref?.();
      };
      entry.touch = arm;
      arm();
      const shutdown = () => {
        clearInterval(heartbeat);
        if (!sessions.has(id)) return;
        release(entry, "client closed");
      };
      req.on("close", shutdown);
      res.on("close", shutdown);
      return;
    }
    if (req.method === "POST" && url.pathname === "/message") {
      if (authToken && !isAuthorized(req, authToken)) {
        log("rejected an unauthenticated POST /message");
        rejectUnauthorized(res);
        return;
      }
      const id = url.searchParams.get("sessionId") ?? "";
      const entry = sessions.get(id);
      if (!entry || entry.released) {
        sendJson(res, 404, { jsonrpc: "2.0", id: null, error: { code: -32001, message: `Unknown or expired sessionId "${id}". Open GET /sse first and use the sessionId from its endpoint event.` } });
        return;
      }
      if (entry.callsInFlight >= MAX_PENDING_MESSAGES) {
        sendJson(res, 429, { ok: false, error: { code: "TOO_MANY_PENDING_MESSAGES" } });
        return;
      }
      entry.callsInFlight++;
      entry.touch();
      const body = await readBody(req, MAX_MESSAGE_BYTES);
      if (entry.released) {
        entry.callsInFlight--;
        res.end();
        return;
      }
      if ("tooLarge" in body) {
        entry.callsInFlight--;
        sendJson(res, 413, { jsonrpc: "2.0", id: null, error: { code: -32600, message: `Request body over ${MAX_MESSAGE_BYTES} bytes` } });
        return;
      }
      let message;
      try {
        message = JSON.parse(body.text || "null");
      } catch (error) {
        entry.callsInFlight--;
        sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: `Parse error: ${/** @type {Error} */
        error.message}` } });
        return;
      }
      sendJson(res, 202, { ok: true });
      const push = (payload) => {
        if (entry.res.writableEnded || entry.res.destroyed) return;
        try {
          entry.res.write(`data: ${JSON.stringify(payload)}

`);
        } catch {
        }
      };
      entry.queue = entry.queue.then(async () => {
        try {
          if (entry.released) return;
          const reply = await handleMessage2(message, { session: entry.session, initialized: entry.initialized, log });
          if (reply) push(reply);
        } catch (error) {
          push({ jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32603, message: `Internal error: ${error instanceof Error ? error.message : String(error)}` } });
        } finally {
          entry.callsInFlight--;
          entry.touch();
        }
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/healthz") {
      sendJson(res, 200, { ok: true, transport: "sse", sessions: sessions.size, maxSessions, auth: authToken ? "bearer" : "none", idleTimeoutMs, sessionMaxTtlMs, maxPendingMessages: MAX_PENDING_MESSAGES });
      return;
    }
    if (req.method === "GET" && url.pathname === "/") {
      sendJson(res, 200, { ok: true, transport: "sse", endpoints: { stream: "GET /sse", messages: "POST /message?sessionId=<id>", health: "GET /healthz" } });
      return;
    }
    sendJson(res, 404, { ok: false, error: { code: "NOT_FOUND", message: `No route for ${req.method} ${url.pathname}.` } });
  });
  server.requestTimeout = 1e4;
  server.headersTimeout = 1e4;
  await new Promise(
    /** @param {(value?: void) => void} resolve @param {(error: Error) => void} reject */
    (resolve2, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve2());
    }
  );
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  return {
    server,
    port: boundPort,
    host,
    sessions,
    close: async () => {
      stopping = true;
      for (const entry of [...sessions.values()]) release(entry, "server shutdown");
      const results = await Promise.allSettled([...cleanupTasks]);
      server.closeAllConnections();
      await new Promise(
        /** @param {(value?: void) => void} resolve */
        (resolve2) => server.close(() => resolve2())
      );
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    }
  };
}

// src/mcp/server.js
var SERVER_NAME = "navi-mcp-server";
var SERVER_VERSION = (() => {
  for (const candidate of ["../package.json", "../../package.json"]) {
    try {
      const version = JSON.parse(readFileSync(new URL(candidate, import.meta.url), "utf8")).version;
      if (typeof version === "string") return version;
    } catch {
    }
  }
  return "0.0.0";
})();
var PROTOCOL_VERSION = "2025-11-25";
var SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];
var DEFAULT_VIEWPORT = { width: 1360, height: 900 };
var DEFAULT_TIMEOUT_MS = 2e4;
var MAX_ACTIONS = 5e3;
var MAX_PAGES_PER_SESSION = 3;
var MANIFEST_TIMEOUT_MS = 500;
var HOST_ASSET_TIMEOUT_MS = 4e3;
var MAX_MANIFEST_BYTES = 16 * 1024;
var RESOLUTION_STRATEGY_MAP = Object.freeze({
  page: "host_inline",
  host_manifest: "host_manifest",
  bundled: "bundled_fallback"
});
function assertResolutionParity(sdkSource, strategy) {
  const expected = (
    /** @type {Record<string, string>} */
    RESOLUTION_STRATEGY_MAP[strategy]
  );
  if (expected === void 0) {
    throw Object.assign(
      new Error(`NAVI_RESOLUTION_UNMAPPED: the runtime decision ${JSON.stringify(strategy)} is not in RESOLUTION_STRATEGY_MAP, so no sdk.source can be derived from it`),
      { code: "NAVI_RESOLUTION_UNMAPPED" }
    );
  }
  if (expected !== sdkSource) {
    throw Object.assign(
      new Error(`NAVI_RESOLUTION_DIVERGED: the runtime decision ${JSON.stringify(strategy)} publishes sdk.source ${JSON.stringify(expected)}, but this navigation set ${JSON.stringify(sdkSource)}`),
      { code: "NAVI_RESOLUTION_DIVERGED" }
    );
  }
  return sdkSource;
}
var GUIDANCE = {
  NOT_FOUND: "The target_id is not in the action map. Call navi_get_actions and use a target_id from that response; ids change when the page re-renders.",
  AMBIGUOUS: "The target_id matched more than one element. Re-read the action map; the page has duplicate or unstable identities.",
  UNAVAILABLE: "The element exists but is not actionable: hidden, disabled, off-screen or covered. Scroll it into view, wait for it to become enabled, or dismiss the overlay first.",
  TARGET_UNAVAILABLE: "The element was not visible, enabled, in-viewport and unoccluded at execution time. Re-read the action map and retry once the element has settled.",
  INVALID_PAYLOAD: 'The payload does not match the action. "type" takes {text}, "select" takes {value}, "click" takes no payload.',
  INVALID_SETTLE: "The settle request is not valid. Use timeout_ms between 1 and 30000 and wait_for one of mutation_settle, navigation, target_hidden.",
  INVALID_SESSION: "The session payload is not a usable storage state. Pass an inline { cookies, origins } object or a path to a Playwright storageState.json file; every cookie needs name and value plus url or domain+path, and every origin needs a bare origin plus localStorage entries.",
  INVALID_ACTION: "The action type is not valid for this element. Use the suggested_action from navi_get_actions.",
  BUSY: "Another execution is already in flight on this page. Wait for it to finish, then retry.",
  CANCELED: 'The page canceled the synthesized event, so the control may be protected. Mark it data-navi-trusted="true" to use trusted native input instead.',
  STOPPED: "The SDK was stopped on this page (window.Navi.stop()). Call navi_navigate again to reinstall it.",
  FALLBACK_DISABLED: "This control requires trusted input and fallback is disabled for this session. Restart the server without --no-fallback, or drive the control with a real browser tool.",
  FALLBACK_UNSUPPORTED: "Trusted native fallback supports click and type only. Use a click or type control for trusted actions.",
  STALE_COORDINATES: "The fallback action map was too old to act on safely. Retry; nothing was dispatched.",
  EXECUTION_FAILED: "The page reported a failed action. Nothing further is retried automatically because the action may already have applied.",
  EXECUTION_ERROR: "The action failed inside the page. Read the action map again before retrying.",
  NAVI_INSTALL_FAILED: "The SDK could not be installed on this page. A strict Content-Security-Policy blocks <script> injection, so serve navi.min.js from the page origin, add a matching nonce, or allow the evaluate strategy.",
  NO_BROWSER: 'Playwright is not installed. Install it with "npm i -D playwright" and run "npx playwright install chromium".',
  NO_SDK: 'The built browser bundle was not found. Run "npm run build" first.',
  NO_PAGE: "No page is open. Call navi_navigate with a URL first.",
  ERR_BLOCKED_BY_CONTAINMENT: "Private network access is disabled. NAVI_ALLOW_LOCAL_NETWORK=1 is an explicit test-fixture override, not a production setting.",
  SESSION_CLOSED: "This session has terminated. Open a new MCP session.",
  PAGE_ORIGIN_CHANGED: "The page navigated to a different origin, so the previous action map is void. Call navi_navigate again.",
  UNINSTRUMENTED_HOST: 'The page publishes no agent-bridge discovery marker, so this session cannot know which Navi build the host runs. Serve the tenant loader, or declare <meta name="agent-bridge" content="active">, to make the host discoverable.',
  MANIFEST_UNREACHABLE: "The page declares instrumentation but no usable discovery document could be read from its own origin, so the packaged runtime was injected instead. Serve /.well-known/navi.json (GET /.well-known/navi.json on the host) or fix the Link target it advertises.",
  MANIFEST_CROSS_ORIGIN: "The page advertised a discovery document on another origin, which this client refuses to read: a page must not be able to point the agent at an arbitrary host. The packaged runtime was injected instead. Serve the document from the page origin.",
  MANIFEST_INCOMPATIBLE: "The host published a discovery document declaring a different Navi protocol version, so the packaged runtime was injected instead. Upgrade the host runtime or install an agent that speaks that version.",
  HOST_ASSET_MISMATCH: "The host declared a subresource integrity hash for its runtime and the served bytes did not match it, so nothing from that host was executed and the packaged runtime was injected instead. Redistribute the asset or update the hash in the manifest.",
  HOST_ASSET_BLOCKED: "The host published a runtime endpoint, but injecting it was refused (most likely the page Content-Security-Policy forbids that script origin), so the packaged runtime was injected instead. Allow the script origin in script-src, or omit the manifest and let the packaged runtime be used deliberately."
};
function guidance(code, message) {
  const hint = GUIDANCE[code];
  if (!hint) return message;
  if (!message) return hint;
  return hint.includes(message) ? hint : `${message} ${hint}`;
}
function redactUrl(value) {
  return value.replace(/\/\/[^/@\s]*@/, "//[redacted]@");
}
function errorCode(error) {
  const code = (
    /** @type {{code?: unknown}} */
    error?.code
  );
  return typeof code === "string" && code ? code : "EXECUTION_ERROR";
}
function warningFor(code, detail) {
  const message = GUIDANCE[code] ?? code;
  return { code, message: detail ? `${message} (${detail})` : message };
}
function agentBridgeLink(headers) {
  const raw = headers?.link;
  if (typeof raw !== "string") return null;
  for (const entry of raw.split(/,(?=\s*<)/)) {
    const match = /^\s*<([^>]*)>\s*;\s*(.+)$/.exec(entry);
    if (match && /rel\s*=\s*"?agent-bridge"?/i.test(match[2])) return match[1];
  }
  return null;
}
async function probeAgentBridge(page, response) {
  const meta = await page.evaluate(() => {
    const element = document.querySelector('meta[name="agent-bridge"]');
    if (!element) return null;
    return { version: element.getAttribute("data-version") };
  }).catch(() => null);
  const link = agentBridgeLink(response?.headers ? response.headers() : void 0);
  let manifest = null;
  if (link) {
    try {
      const url = new URL(link, page.url());
      if (url.protocol === "http:" || url.protocol === "https:") manifest = redactUrl(url.href);
    } catch {
    }
  }
  const declared = meta?.version && meta.version !== "0.0.0" ? meta.version : null;
  return {
    instrumented: Boolean(meta) || Boolean(link),
    source: meta ? "meta-tag" : link ? "link-header" : "none",
    declared_version: declared,
    manifest,
    script: null,
    integrity: "not_declared"
  };
}
function isIntegrityHash(value) {
  return /^sha(256|384|512)-[A-Za-z0-9+/=]{16,}$/.test(value);
}
async function fetchHostManifest(pageUrl, link, allowLocalNetwork) {
  const origin = new URL(pageUrl).origin;
  let target;
  try {
    target = new URL(link ?? "/.well-known/navi.json", pageUrl);
    if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("not http(s)");
  } catch {
    return { ok: false, code: "MANIFEST_UNREACHABLE", detail: "the advertised manifest URL could not be resolved" };
  }
  if (target.origin !== origin) {
    return { ok: false, code: "MANIFEST_CROSS_ORIGIN", detail: `${target.origin} is not the page origin ${origin}` };
  }
  try {
    const response = await containedGet(target.href, allowLocalNetwork, { timeoutMs: MANIFEST_TIMEOUT_MS, maxBytes: MAX_MANIFEST_BYTES, sameOrigin: origin });
    if (response.status < 200 || response.status >= 300) return { ok: false, code: "MANIFEST_UNREACHABLE", detail: `GET ${redactUrl(target.href)} answered HTTP ${response.status}` };
    const declaredLength = Number(response.headers["content-length"] ?? "");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_MANIFEST_BYTES) return { ok: false, code: "MANIFEST_UNREACHABLE", detail: `the document declares ${declaredLength} bytes` };
    const text = response.bytes.toString("utf8");
    if (text.length > MAX_MANIFEST_BYTES) return { ok: false, code: "MANIFEST_UNREACHABLE", detail: `the document is larger than ${MAX_MANIFEST_BYTES} bytes` };
    const document2 = JSON.parse(text);
    if (!document2 || typeof document2 !== "object" || Array.isArray(document2)) return { ok: false, code: "MANIFEST_UNREACHABLE", detail: "the document is not a JSON object" };
    return { ok: true, document: document2, url: target.href };
  } catch (error) {
    const timedOut = ["TimeoutError", "AbortError"].includes(String(
      /** @type {{name?: unknown}} */
      error?.name
    ));
    return { ok: false, code: "MANIFEST_UNREACHABLE", detail: timedOut ? `no answer within ${MANIFEST_TIMEOUT_MS}ms` : error instanceof Error ? error.message : String(error) };
  }
}
async function fetchHostAsset(url, integrity, allowLocalNetwork) {
  const algorithm = integrity.slice(0, integrity.indexOf("-"));
  try {
    const response = await containedGet(url.href, allowLocalNetwork, { timeoutMs: HOST_ASSET_TIMEOUT_MS });
    if (response.status < 200 || response.status >= 300) return { ok: false, code: "MANIFEST_UNREACHABLE", detail: `GET ${redactUrl(url.href)} answered HTTP ${response.status}` };
    const bytes = response.bytes;
    const digest = `${algorithm}-${createHash(algorithm).update(bytes).digest("base64")}`;
    if (digest !== integrity) return { ok: false, code: "HOST_ASSET_MISMATCH", detail: `the served bytes hash to ${digest.slice(0, 20)}\u2026, the manifest declared ${integrity.slice(0, 20)}\u2026` };
    return { ok: true, text: bytes.toString("utf8") };
  } catch (error) {
    const timedOut = ["TimeoutError", "AbortError"].includes(String(
      /** @type {{name?: unknown}} */
      error?.name
    ));
    return { ok: false, code: "MANIFEST_UNREACHABLE", detail: timedOut ? `${redactUrl(url.href)} did not answer within ${HOST_ASSET_TIMEOUT_MS}ms` : error instanceof Error ? error.message : String(error) };
  }
}
async function negotiateHostRuntime(page, discovery, allowLocalNetwork) {
  const resolution = { source: "bundled_fallback", manifest: null, script: null, integrity: "not_declared", warning: null, detail: null };
  const fallback = (code, detail) => {
    resolution.warning = code;
    resolution.detail = detail;
    return resolution;
  };
  const fetched = await fetchHostManifest(page.url(), discovery.manifest, allowLocalNetwork);
  if (!fetched.ok) return fallback(fetched.code, fetched.detail);
  resolution.manifest = redactUrl(fetched.url);
  const declaredVersion = fetched.document.version;
  if (declaredVersion !== NAVI_PROTOCOL_VERSION) {
    return fallback("MANIFEST_INCOMPATIBLE", `the manifest declares protocol ${typeof declaredVersion === "string" ? declaredVersion : "no version"}, this server speaks ${NAVI_PROTOCOL_VERSION}`);
  }
  const declared = fetched.document.endpoints?.script;
  let scriptUrl;
  try {
    if (typeof declared !== "string" || !declared) throw new Error("no endpoints.script");
    scriptUrl = new URL(declared, fetched.url);
    if (scriptUrl.protocol !== "http:" && scriptUrl.protocol !== "https:") throw new Error("not http(s)");
  } catch (error) {
    return fallback("MANIFEST_UNREACHABLE", `the document declares no usable endpoints.script (${error instanceof Error ? error.message : String(error)})`);
  }
  resolution.script = redactUrl(scriptUrl.href);
  const declaredIntegrity = typeof fetched.document.integrity === "string" && isIntegrityHash(fetched.document.integrity.trim()) ? fetched.document.integrity.trim() : null;
  try {
    if (declaredIntegrity) {
      const asset = await fetchHostAsset(scriptUrl, declaredIntegrity, allowLocalNetwork);
      if (!asset.ok) {
        resolution.integrity = "failed";
        return fallback(asset.code, asset.detail);
      }
      await page.addScriptTag({ content: asset.text });
      resolution.integrity = "verified";
    } else {
      await page.addScriptTag({ url: scriptUrl.href });
    }
    await page.waitForFunction(() => Boolean(
      /** @type {any} */
      globalThis.Navi
    ), void 0, { timeout: HOST_ASSET_TIMEOUT_MS });
    resolution.source = "host_manifest";
    return resolution;
  } catch (error) {
    if (declaredIntegrity) resolution.integrity = "failed";
    return fallback("HOST_ASSET_BLOCKED", error instanceof Error ? error.message.split("\n")[0] : String(error));
  }
}
function toolError(code, message, extra = {}) {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: { code, message: guidance(code, message) }, ...extra }, null, 2) }],
    isError: true
  };
}
function toolResult(result) {
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, .../** @type {Record<string, unknown>} */
  result }, null, 2) }], isError: false };
}
var TOOLS = [
  {
    name: "navi_navigate",
    title: "Navigate and initialize Navi",
    description: `Open an http(s) URL in the controlled browser, detect the host's agent-bridge discovery marker (a Link response header or <meta name="agent-bridge">), read the host's own discovery document from the page origin and inject the runtime it designates (verifying a declared subresource integrity hash before executing anything), bind to a Navi instance the page is already running, or fall back to the packaged runtime (protocol ${NAVI_PROTOCOL_VERSION}) when the host publishes nothing usable. Every outcome is reported as runtime_resolution.strategy: host_manifest, host_inline or bundled_fallback, with runtime_resolution.manifest_url naming the document that was actually read and runtime_resolution.script_origin saying whether the running script came from the host or from this package. Then wait for indexing and return the page title with the number of actionable controls. Only credential-free http(s) URLs are accepted.`,
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL to open." },
        width: { type: "number", description: `Viewport width in CSS pixels. Default ${DEFAULT_VIEWPORT.width}.` },
        height: { type: "number", description: `Viewport height in CSS pixels. Default ${DEFAULT_VIEWPORT.height}.` },
        timeoutMs: { type: "number", description: `Navigation timeout in milliseconds. Default ${DEFAULT_TIMEOUT_MS}.` }
      },
      required: ["url"],
      additionalProperties: false
    }
  },
  {
    name: "navi_get_actions",
    title: "Read the Navi action map",
    description: "Return the current NaviActionMap: target_id, role, accessible name, live visible/enabled/in-viewport/occluded state, CSS-pixel coordinates and the suggested action for each interactive control. Viewport-only by default; pass all=true for the whole document, including off-screen controls.",
    inputSchema: {
      type: "object",
      properties: {
        since_version: { type: "integer", minimum: 0, description: "Document-scoped cursor from the previous map. Returns changed targets/removal tombstones; reset:true means replace the cache with this full snapshot. Expired, differently filtered, negative or malformed cursors reset instead of failing." },
        all: { type: "boolean", description: "Return every indexed control instead of only those in the viewport. Default false." },
        limit: { type: "number", description: `Maximum controls to return, 1-${MAX_ACTIONS}. Default 500.` }
      },
      additionalProperties: false
    }
  },
  {
    name: "navi_execute_action",
    title: "Execute an action on a target",
    description: `Run click, type or select on a target_id from the action map. Uses the guarded synthetic path first; controls marked data-navi-trusted="true" automatically fall back to trusted native driver input at the target's live coordinates. Failed actions are never retried automatically, because they may already have applied. Pass settle to wait deterministically for the action's effect before this call returns; the receipt reports whether the requested condition held.`,
    inputSchema: {
      type: "object",
      properties: {
        target_id: { type: "string", description: "target_id from navi_get_actions." },
        action_type: { type: "string", enum: ["click", "type", "select"], description: "Action to perform." },
        payload: {
          type: "object",
          properties: {
            text: { type: "string", description: 'Text for action_type "type".' },
            value: { type: "string", description: 'Option value for action_type "select".' }
          },
          additionalProperties: false
        },
        settle: {
          type: "object",
          description: "Optional deterministic settlement. mutation_settle waits for DOM silence (>=100ms with no mutation, including open shadow roots and same-origin frames); navigation waits for a URL change or document reload; target_hidden waits for the target to be removed, invisible or occluded. A timeout reports settled:false and never re-runs the action.",
          properties: {
            timeout_ms: { type: "number", description: `Settlement deadline in milliseconds, 1-${MAX_SETTLE_TIMEOUT_MS}. Default ${DEFAULT_SETTLE_TIMEOUT_MS}.` },
            wait_for: { type: "string", enum: [...SETTLE_MODES], description: 'Which condition to wait for. Default "mutation_settle".' }
          },
          additionalProperties: false
        }
      },
      required: ["target_id", "action_type"],
      additionalProperties: false
    }
  },
  {
    name: "navi_assert_state",
    title: "Assert a target's state",
    description: "Check that a target_id exists and optionally that it is visible, enabled, in the viewport, and matches an expected accessible name. Returns the observed state and whether every requested expectation held.",
    inputSchema: {
      type: "object",
      properties: {
        target_id: { type: "string", description: "target_id to check." },
        exists: { type: "boolean", description: "Require the target to be present in the action map. Default true." },
        visible: { type: "boolean", description: "Require is_visible to match this value." },
        enabled: { type: "boolean", description: "Require is_enabled to match this value." },
        in_viewport: { type: "boolean", description: "Require is_in_viewport to match this value." },
        name: { type: "string", description: "Require the accessible name to equal this string." },
        name_contains: { type: "string", description: "Require the accessible name to contain this substring." }
      },
      required: ["target_id"],
      additionalProperties: false
    }
  },
  {
    name: "navi_set_session",
    title: "Hydrate an authenticated session",
    description: "Seed the browser context with cookies and localStorage before navigating, so navi_navigate opens a pre-authenticated page instead of a sign-in screen. Accepts an inline { cookies, origins } payload or a path to a Playwright storageState.json file. Hydration rebuilds the context, so it must be called before navi_navigate; passing url hydrates and opens the page in one step. Cookie values are never echoed back.",
    inputSchema: {
      type: "object",
      properties: {
        cookies: {
          type: "array",
          description: "Playwright cookies. Each entry needs name, value and either url or domain+path.",
          items: { type: "object" }
        },
        origins: {
          type: "array",
          description: "Local storage per origin: [{ origin, localStorage: [{ name, value }] }].",
          items: { type: "object" }
        },
        storage_state: {
          description: "A path to a storageState.json file, or an inline { cookies, origins } object. Takes precedence over cookies/origins.",
          anyOf: [{ type: "string" }, { type: "object" }]
        },
        url: { type: "string", description: "Optional http(s) URL to open immediately after hydrating, using the hydrated context." }
      },
      additionalProperties: false
    }
  }
];
function isCanonicalOrigin(value) {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
}
function normalizeStorageState(input) {
  let raw = input;
  if (typeof raw === "string") {
    const path = raw;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      return { error: `Could not read storageState file "${path}": ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "Session state must be an object holding cookies and/or origins, or a path to a storageState JSON file." };
  }
  const state = (
    /** @type {Record<string, unknown>} */
    raw
  );
  const unknown = Object.keys(state).filter((key) => key !== "cookies" && key !== "origins");
  if (unknown.length) return { error: `Unknown session key(s) ${unknown.join(", ")}; a storage state holds only cookies and origins.` };
  const cookies = state.cookies ?? [];
  const origins = state.origins ?? [];
  if (!Array.isArray(cookies)) return { error: "cookies must be an array." };
  if (!Array.isArray(origins)) return { error: "origins must be an array." };
  for (const cookie of cookies) {
    if (!cookie || typeof cookie !== "object") return { error: "Every cookie must be an object." };
    const entry = (
      /** @type {Record<string, unknown>} */
      cookie
    );
    if (typeof entry.name !== "string" || !entry.name) return { error: "Every cookie needs a non-empty name." };
    if (typeof entry.value !== "string") return { error: `Cookie "${entry.name}" needs a string value.` };
    const scoped = typeof entry.url === "string" && entry.url || typeof entry.domain === "string" && typeof entry.path === "string";
    if (!scoped) return { error: `Cookie "${entry.name}" needs either url or both domain and path.` };
  }
  let entries = 0;
  for (const origin of origins) {
    if (!origin || typeof origin !== "object") return { error: "Every origin entry must be an object." };
    const entry = (
      /** @type {Record<string, unknown>} */
      origin
    );
    if (typeof entry.origin !== "string" || !isCanonicalOrigin(entry.origin)) {
      return { error: `Origin "${String(entry.origin)}" must be a bare http(s) origin such as https://app.example.com, without a path, query or trailing slash.` };
    }
    if (!Array.isArray(entry.localStorage)) return { error: `Origin ${entry.origin} needs a localStorage array; it may be empty.` };
    for (const item of entry.localStorage) {
      if (!item || typeof item !== "object" || typeof /** @type {Record<string, unknown>} */
      item.name !== "string" || typeof /** @type {Record<string, unknown>} */
      item.value !== "string") {
        return { error: `Every localStorage entry for ${entry.origin} needs string name and value.` };
      }
      entries++;
    }
  }
  if (!cookies.length && !entries) return { error: "Nothing to hydrate: the session carries no cookies and no localStorage entries." };
  return { state: { cookies, origins }, summary: { cookies: cookies.length, origins: origins.length, localStorage: entries } };
}
var NaviSession = class {
  /** @param {{viewport?: {width: number, height: number}, headless?: boolean, fallback?: boolean, log?: (line: string) => void, sessionId?: string}} [options] */
  constructor(options = {}) {
    this.viewport = options.viewport ?? DEFAULT_VIEWPORT;
    this.headless = options.headless !== false;
    this.fallback = options.fallback !== false;
    this.log = options.log ?? (() => {
    });
    this.browser = /** @type {any} */
    null;
    this.context = /** @type {any} */
    null;
    this.permissionSession = /** @type {any} */
    null;
    this.sessionId = options.sessionId ?? randomUUID3();
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(this.sessionId)) throw new Error("Invalid session identifier");
    this.allowLocalNetwork = process.env.NAVI_ALLOW_LOCAL_NETWORK === "1";
    this.closed = false;
    this.abort = new AbortController();
    this.blockedRequests = 0;
    this.downloadDirectory = /** @type {string | null} */
    null;
    this.proxy = /** @type {Awaited<ReturnType<typeof createContainmentProxy>> | null} */
    null;
    this.launchPromise = /** @type {Promise<any> | null} */
    null;
    this.closePromise = /** @type {Promise<void> | null} */
    null;
    this.page = null;
    this.adapter = null;
    this.sdkStrategy = null;
    this.storageState = null;
  }
  /** Initialize an empty contained context without navigating or reading host state. */
  async initialize() {
    return this.#ensurePage();
  }
  async #ensurePage() {
    if (this.closed) throw Object.assign(new Error("Session closed"), { code: "SESSION_CLOSED" });
    if (this.page && !this.page.isClosed()) return this.page;
    if (this.launchPromise) return this.launchPromise;
    if (this.context) {
      this.page = await this.context.newPage();
      return this.page;
    }
    this.launchPromise = this.#launchPage();
    try {
      return await this.launchPromise;
    } finally {
      this.launchPromise = null;
    }
  }
  /** Cancel protocol setup commands even if Chromium closes before CDP responds.
   * @template T @param {Promise<T>} operation @returns {Promise<T>} */
  async #active(operation) {
    const stopped = () => Object.assign(new Error("Session closed during setup"), { code: "SESSION_CLOSED" });
    let cancel = () => {
    };
    const canceled = new Promise(
      /** @param {(value: never) => void} _resolve @param {(error: Error) => void} reject */
      (_resolve, reject) => {
        cancel = () => reject(stopped());
        if (this.closed) cancel();
        else this.abort.signal.addEventListener("abort", cancel, { once: true });
      }
    );
    try {
      return await Promise.race([operation, canceled]);
    } finally {
      this.abort.signal.removeEventListener("abort", cancel);
    }
  }
  async #launchPage() {
    try {
      const chromium = await resolveChromium();
      this.downloadDirectory = await mkdtemp(join(tmpdir(), `navi-downloads-${this.sessionId}-`));
      this.proxy = await createContainmentProxy(this.allowLocalNetwork, () => {
        this.blockedRequests++;
      });
      const browser = await chromium.launch({
        headless: this.headless,
        chromiumSandbox: true,
        downloadsPath: this.downloadDirectory,
        proxy: { server: this.proxy.url },
        args: ["--proxy-bypass-list=<-loopback>", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--disable-quic"]
      });
      this.browser = browser;
      browser.on("disconnected", () => {
        if (!this.closed && this.browser === browser) void this.close().catch((error) => this.log(`browser cleanup failed: ${error.message}`));
      });
      if (this.closed) throw Object.assign(new Error("Session closed during launch"), { code: "SESSION_CLOSED" });
      const context = await this.#active(browser.newContext({
        viewport: this.viewport,
        permissions: [],
        serviceWorkers: "block",
        acceptDownloads: true,
        ...this.storageState ? { storageState: this.storageState } : {}
      }));
      this.context = context;
      if (this.closed) throw Object.assign(new Error("Session closed during context creation"), { code: "SESSION_CLOSED" });
      await this.#active(context.clearPermissions());
      await this.#active(context.route("**/*", async (route) => {
        try {
          if (this.closed) throw containmentError("Session closed");
          await resolveDestination(route.request().url(), this.allowLocalNetwork);
          await route.continue();
        } catch {
          this.blockedRequests++;
          await route.abort("blockedbyclient").catch(() => {
          });
        }
      }));
      if (typeof context.routeWebSocket !== "function") throw containmentError("Playwright >=1.48 is required for websocket containment");
      await this.#active(context.routeWebSocket("**/*", (socket) => {
        socket.close();
      }));
      const cdp = await this.#active(browser.newBrowserCDPSession());
      this.permissionSession = cdp;
      const page = await this.#active(context.newPage());
      const target = await this.#active(context.newCDPSession(page));
      const { targetInfo } = await this.#active(target.send("Target.getTargetInfo"));
      for (const name of ["geolocation", "camera", "microphone", "notifications", "clipboard-read", "clipboard-write"]) {
        await this.#active(cdp.send("Browser.setPermission", { browserContextId: targetInfo.browserContextId, permission: { name }, setting: "denied" }));
      }
      await this.#active(target.detach());
      this.page = page;
      const accepted = /* @__PURE__ */ new Set([page]);
      context.on("page", (popup) => {
        if (this.closed || accepted.size >= MAX_PAGES_PER_SESSION) {
          void popup.close({ runBeforeUnload: false }).catch((error) => this.log(`popup close failed: ${error.message}`));
          return;
        }
        accepted.add(popup);
        popup.on("close", () => accepted.delete(popup));
      });
      page.on("close", () => accepted.delete(page));
      context.on("close", () => {
        if (!this.closed && this.context === context) void this.close().catch((error) => this.log(`session cleanup failed: ${error.message}`));
      });
      if (this.closed) throw Object.assign(new Error("Session closed during context setup"), { code: "SESSION_CLOSED" });
      this.log(`browser launched (${this.viewport.width}x${this.viewport.height}, ephemeral session ${this.sessionId})`);
      return page;
    } catch (error) {
      await this.#disposeBrowser();
      throw error;
    }
  }
  /** @param {Record<string, unknown>} args */
  async navigate(args) {
    const url = typeof args.url === "string" ? args.url : "";
    if (!isAllowedUrl(url)) return toolError("INVALID_URL", `Refusing to open "${redactUrl(url)}": only absolute credential-free http(s) URLs are allowed.`);
    const safe = url;
    const width = Number.isFinite(args.width) ? Number(args.width) : this.viewport.width;
    const height = Number.isFinite(args.height) ? Number(args.height) : this.viewport.height;
    const timeout = Number.isFinite(args.timeoutMs) ? Number(args.timeoutMs) : DEFAULT_TIMEOUT_MS;
    if (width < 1 || width > 4096 || height < 1 || height > 4096 || timeout < 1 || timeout > 3e4) return toolError("INVALID_PAYLOAD", "Viewport must be 1\u20134096 pixels and timeoutMs 1\u201330000.");
    try {
      if (this.closed) throw Object.assign(new Error("Session closed"), { code: "SESSION_CLOSED" });
      await resolveDestination(safe, this.allowLocalNetwork);
      const beforeBlocked = this.blockedRequests;
      const page = await this.#ensurePage();
      await page.setViewportSize({ width, height });
      this.adapter = null;
      let response;
      try {
        response = await page.goto(safe, { waitUntil: "load", timeout });
      } catch (error) {
        if (this.blockedRequests > beforeBlocked) throw containmentError("Navigation or redirect reached a blocked destination");
        throw error;
      }
      await resolveDestination(page.url(), this.allowLocalNetwork);
      const status = response ? response.status() : null;
      let discovery = await probeAgentBridge(page, response);
      const installed = await page.evaluate(() => Boolean(
        /** @type {any} */
        globalThis.Navi
      ));
      const sdkPath = resolveSdkPath();
      let strategy;
      let resolution;
      let source;
      let warning = null;
      let negotiatedManifest = null;
      const installBundled = async () => {
        try {
          await installNavi(page, { scriptPath: sdkPath, strategy: "tag" });
          return "tag";
        } catch {
          await installNavi(page, { scriptPath: sdkPath, strategy: "evaluate" });
          return "evaluate";
        }
      };
      if (installed) {
        strategy = "already-present";
        resolution = "page";
        source = "host_inline";
        if (!discovery.instrumented) warning = warningFor("UNINSTRUMENTED_HOST");
      } else if (discovery.instrumented) {
        const negotiated = await negotiateHostRuntime(page, discovery, this.allowLocalNetwork);
        negotiatedManifest = negotiated.manifest;
        discovery = { ...discovery, manifest: negotiated.manifest ?? discovery.manifest, script: negotiated.script, integrity: negotiated.integrity };
        if (negotiated.source === "host_manifest") {
          strategy = "tag";
          resolution = "host_manifest";
          source = "host_manifest";
        } else {
          warning = warningFor(negotiated.warning ?? "MANIFEST_UNREACHABLE", negotiated.detail ?? void 0);
          strategy = await installBundled();
          resolution = "bundled";
          source = "bundled_fallback";
        }
      } else {
        warning = warningFor("UNINSTRUMENTED_HOST");
        strategy = await installBundled();
        resolution = "bundled";
        source = "bundled_fallback";
      }
      assertResolutionParity(source, resolution);
      const { version } = await ensureNavi(page, sdkPath);
      this.adapter = new NaviPlaywrightAdapter(page, { fallback: this.fallback });
      const map = await this.adapter.discover({ limit: MAX_ACTIONS });
      this.sdkStrategy = strategy;
      this.log(`navigated to ${page.url()} (HTTP ${status}, SDK ${strategy} via ${source}, discovery ${discovery.source}${discovery.manifest ? ` ${discovery.manifest}` : ""}, ${map.actions.length} controls)`);
      return toolResult({
        url: page.url(),
        title: await page.title(),
        status,
        protocolVersion: version,
        sdk: { strategy, injected: !installed, source },
        // Which runtime this page is now running, and where it came from. `strategy` is
        // the source the decision above publishes, looked up through
        // RESOLUTION_STRATEGY_MAP, and assertResolutionParity has already compared that
        // lookup against the value the branch set for `sdk.source` - so the two cannot
        // disagree. The source is named again here because `source` is ambiguous in a
        // receipt that also carries the manifest's `source` (the Corresponding Source
        // URL of the host) and `discovery.source` (how instrumentation was detected - a
        // link header, a meta tag, or nothing).
        runtime_resolution: {
          strategy: RESOLUTION_STRATEGY_MAP[resolution],
          manifest_url: negotiatedManifest,
          // A page that was already running its own Navi is running the host's build,
          // not ours, so only the packaged fallback reports a bundled script.
          script_origin: source === "bundled_fallback" ? "bundled" : "host"
        },
        discovery,
        ...warning ? { warning } : {},
        viewport: { width, height },
        actions: map.actions.length,
        truncated: map.truncated
      });
    } catch (error) {
      const code = errorCode(error);
      if (code === CONTAINMENT_CODE) this.adapter = null;
      return toolError(code === "EXECUTION_ERROR" ? "NAVIGATION_FAILED" : code, error instanceof Error ? error.message : String(error), { url: safe });
    }
  }
  #requireAdapter() {
    if (this.adapter) return this.adapter;
    return null;
  }
  /**
   * Rebuild the browser context around a storage state. Cookies and localStorage
   * cannot be applied to a live document portably — localStorage only takes
   * effect at document start — so hydration replaces the session instead of
   * patching it, and the next navigation opens authenticated.
   * @param {{cookies: any[], origins: any[]}} state
   */
  async hydrate(state) {
    if (this.closed) throw Object.assign(new Error("Session closed"), { code: "SESSION_CLOSED" });
    await this.#disposeBrowser();
    this.storageState = state;
  }
  /** @param {Record<string, unknown>} args */
  async setSession(args) {
    const url = typeof args.url === "string" ? args.url : "";
    if (typeof args.storage_state === "string" && !this.allowLocalNetwork) return toolError("INVALID_SESSION", "Remote sessions accept inline state only; server-side file paths are disabled.");
    if (url && !isAllowedUrl(url)) return toolError("INVALID_URL", `Refusing to open "${redactUrl(url)}": only absolute credential-free http(s) URLs are allowed.`);
    const inline = args.cookies !== void 0 || args.origins !== void 0 ? { cookies: args.cookies ?? [], origins: args.origins ?? [] } : void 0;
    const input = args.storage_state !== void 0 ? args.storage_state : inline;
    if (input === void 0) return toolError("INVALID_SESSION", "Provide storage_state, or cookies and/or origins.");
    const normalized = normalizeStorageState(input);
    if ("error" in normalized) return toolError("INVALID_SESSION", normalized.error);
    try {
      await this.hydrate(normalized.state);
      this.log(`hydrated session: ${normalized.summary.cookies} cookie(s), ${normalized.summary.origins} origin(s), ${normalized.summary.localStorage} localStorage entr(ies)`);
      if (url) return await this.navigate({ url });
      return toolResult({
        hydrated: normalized.summary,
        applies_to: "the next navi_navigate call",
        note: "Called without url, so no page is open yet; the next navigation starts inside this session."
      });
    } catch (error) {
      return toolError(errorCode(error), error instanceof Error ? error.message : String(error));
    }
  }
  /** @param {Record<string, unknown>} args */
  async getActions(args) {
    const adapter = this.#requireAdapter();
    if (!adapter) return toolError("NO_PAGE", "No page is open.");
    const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(MAX_ACTIONS, Math.floor(Number(args.limit)))) : 500;
    try {
      const cursor = Number.isSafeInteger(args.since_version) && Number(args.since_version) >= 0 ? Number(args.since_version) : void 0;
      const options = { viewportOnly: args.all !== true, limit };
      const map = cursor === void 0 ? await adapter.discover(options) : await adapter.discover({ ...options, since_version: cursor });
      return toolResult({ ...map, viewportOnly: args.all !== true, url: adapter.page.url() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Incomplete action map/.test(message)) {
        return toolError("MAP_TRUNCATED", "The page holds more controls than the requested limit. Raise limit or narrow the page with a smaller viewport.");
      }
      return toolError(errorCode(error), message);
    }
  }
  /** @param {Record<string, unknown>} args */
  async executeAction(args) {
    const adapter = this.#requireAdapter();
    if (!adapter) return toolError("NO_PAGE", "No page is open.");
    const targetId = typeof args.target_id === "string" ? args.target_id : "";
    const actionType = typeof args.action_type === "string" ? args.action_type : "";
    if (!targetId || !["click", "type", "select"].includes(actionType)) {
      return toolError("INVALID_ACTION", "target_id is required and action_type must be click, type or select.");
    }
    const payload = (
      /** @type {{text?: string, value?: string}} */
      args.payload && typeof args.payload === "object" ? args.payload : {}
    );
    try {
      const blockedBefore = this.blockedRequests;
      const result = await adapter.execute(targetId, actionType, payload, args.settle);
      if (this.blockedRequests > blockedBefore) return toolError(CONTAINMENT_CODE, "An action attempted blocked network access.", { may_have_applied: true });
      if (!result.ok) {
        const code = result.error?.code ?? "EXECUTION_ERROR";
        return toolError(code, result.error?.message ?? "The action failed.", { target_id: targetId, action_type: actionType });
      }
      const settle = result.settle;
      return toolResult({
        executed: true,
        target_id: targetId,
        action_type: actionType,
        mode: result.mode,
        trusted_fallback: result.mode === "native-driver",
        dispatched: result.result?.dispatched === true,
        url: adapter.page.url(),
        // The receipt is present only when the caller asked for settlement, so
        // an unconfigured call cannot be mistaken for a verified one.
        ...settle ? {
          settled: settle.settled,
          elapsed_ms: settle.elapsed_ms,
          final_url: settle.final_url,
          settle: settle.mode,
          ...settle.reason ? { settle_reason: settle.reason } : {}
        } : {}
      });
    } catch (error) {
      return toolError(errorCode(error), error instanceof Error ? error.message : String(error), { target_id: targetId, action_type: actionType, may_have_applied: true });
    }
  }
  /** @param {Record<string, unknown>} args */
  async assertState(args) {
    const adapter = this.#requireAdapter();
    if (!adapter) return toolError("NO_PAGE", "No page is open.");
    const targetId = typeof args.target_id === "string" ? args.target_id : "";
    if (!targetId) return toolError("INVALID_ACTION", "target_id is required.");
    try {
      const map = await adapter.discover({ limit: MAX_ACTIONS });
      const matches = map.actions.filter((action2) => action2.target_id === targetId);
      const action = matches.length === 1 ? matches[0] : null;
      const expectExists = args.exists !== false;
      const checks = [];
      const add = (label, expected, observed, ok) => checks.push({ label, expected, observed, ok });
      add("exists", expectExists, matches.length === 1, matches.length === 1 === expectExists);
      add("unique", true, matches.length <= 1, matches.length <= 1);
      if (action) {
        const stateChecks = [
          ["visible", args.visible, action.state.is_visible],
          ["enabled", args.enabled, action.state.is_enabled],
          ["in_viewport", args.in_viewport, action.state.is_in_viewport]
        ];
        for (const [label, expected, observed] of stateChecks) {
          if (typeof expected === "boolean") add(label, expected, observed, observed === expected);
        }
        if (typeof args.name === "string") add("name", args.name, action.name, action.name === args.name);
        if (typeof args.name_contains === "string") add("name_contains", args.name_contains, action.name, action.name.includes(args.name_contains));
      }
      return toolResult({
        target_id: targetId,
        passed: checks.every((check) => check.ok),
        matches: matches.length,
        observed: action ? { role: action.role, name: action.name, suggested_action: action.suggested_action, state: action.state, coordinates: action.coordinates } : null,
        checks
      });
    } catch (error) {
      return toolError(errorCode(error), error instanceof Error ? error.message : String(error));
    }
  }
  async #disposeBrowser() {
    const browser = this.browser;
    const context = this.context;
    const proxy = this.proxy;
    const directory = this.downloadDirectory;
    this.proxy = null;
    this.downloadDirectory = null;
    this.permissionSession = null;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.adapter = null;
    try {
      if (context) await context.close();
    } finally {
      try {
        if (browser) await browser.close();
      } finally {
        try {
          if (proxy) await proxy.close();
        } finally {
          if (directory) await rm(directory, { recursive: true, force: true });
        }
      }
    }
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.abort.abort();
    this.closePromise = (async () => {
      await this.#disposeBrowser();
      await this.launchPromise?.catch(() => {
      });
      await this.#disposeBrowser();
      this.storageState = null;
    })();
    return this.closePromise;
  }
};
async function handleMessage(message, state) {
  const { session, initialized } = state;
  const id = message?.id;
  const isNotification = id === void 0 || id === null;
  const reply = (result) => isNotification ? null : { jsonrpc: "2.0", id, result };
  const fail = (code, message_, data) => isNotification ? null : { jsonrpc: "2.0", id, error: { code, message: message_, ...data === void 0 ? {} : { data } } };
  const method = message?.method;
  if (typeof method !== "string") return fail(-32600, "Invalid Request: method must be a string");
  if (isNotification) {
    if (method === "notifications/initialized") initialized.value = true;
    if (method === "notifications/cancelled") state.log("client cancelled a request");
    return null;
  }
  if (method === "initialize") {
    const requested = (
      /** @type {{protocolVersion?: unknown}} */
      message.params?.protocolVersion
    );
    const negotiated = typeof requested === "string" && SUPPORTED_PROTOCOLS.includes(requested) ? requested : PROTOCOL_VERSION;
    initialized.value = true;
    return reply({
      protocolVersion: negotiated,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: "Navi exposes a validated action map and guarded execution. Call navi_navigate first, then navi_get_actions, then navi_execute_action with a current target_id."
    });
  }
  if (!initialized.value) return fail(-32002, "Server not initialized: send initialize first");
  if (method === "ping") return reply({});
  if (method === "tools/list") return reply({ tools: TOOLS });
  if (method === "tools/call") {
    const params = (
      /** @type {{name?: unknown, arguments?: unknown}} */
      message.params
    );
    const name = typeof params?.name === "string" ? params.name : "";
    const args = (
      /** @type {Record<string, unknown>} */
      params?.arguments && typeof params.arguments === "object" ? params.arguments : {}
    );
    state.log(`tools/call ${name}`);
    if (name === "navi_navigate") return reply(await session.navigate(args));
    if (name === "navi_get_actions") return reply(await session.getActions(args));
    if (name === "navi_execute_action") return reply(await session.executeAction(args));
    if (name === "navi_assert_state") return reply(await session.assertState(args));
    if (name === "navi_set_session") return reply(await session.setSession(args));
    return reply(toolError("UNKNOWN_TOOL", `Unknown tool "${name}". Available tools: ${TOOLS.map((tool) => tool.name).join(", ")}.`));
  }
  return fail(-32601, `Method not found: ${method}`);
}
async function runStdioServer(options = {}) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const log = options.log ?? ((line) => process.stderr.write(`[navi-mcp] ${line}
`));
  const session = options.session ?? new NaviSession({ log });
  const initialized = { value: false };
  const send = (body) => {
    if (body) output.write(`${JSON.stringify(body)}
`);
  };
  let queue = Promise.resolve();
  const reader = createInterface({ input, crlfDelay: Infinity });
  reader.on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch (error) {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: `Parse error: ${/** @type {Error} */
      error.message}` } });
      return;
    }
    queue = queue.then(async () => {
      try {
        send(await handleMessage(message, { session, initialized, log }));
      } catch (error) {
        send({ jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32603, message: `Internal error: ${error instanceof Error ? error.message : String(error)}` } });
      }
    });
  });
  await new Promise(
    /** @param {(value?: void) => void} resolve */
    (resolve2) => {
      const finish = () => resolve2();
      reader.on("close", finish);
      input.on?.("end", finish);
    }
  );
  await queue;
  await session.close();
  log("stdin closed, session closed");
}
function option(argv, flag, fallback) {
  const index = argv.indexOf(flag);
  return index === -1 ? fallback : argv[index + 1] ?? fallback;
}
function isLoopbackHost(host) {
  const bare = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return bare === "localhost" || bare === "::1" || bare === "0:0:0:0:0:0:0:1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}
async function main(argv = []) {
  if (argv.includes("--help")) {
    process.stdout.write(`navi-mcp \xB7 MCP server for the Navi protocol

Usage
  navi-mcp                        Speak MCP over stdio (default)
  navi-mcp --transport sse        Serve the remote SSE transport instead
  navi-mcp --transport sse --port 3001 --host 127.0.0.1
                                  Port defaults to 3001, host to 127.0.0.1
  navi-mcp --transport sse --auth-token <token>
                                  Require "Authorization: Bearer <token>" on /sse
                                  and /message (or set NAVI_MCP_TOKEN). Mandatory
                                  for any --host that is not loopback
  navi-mcp --transport sse --max-sessions 10
                                  Concurrent event streams; beyond the ceiling is
                                  503. Default 10
  navi-mcp --transport sse --idle-timeout 300
                                  Reap a session idle this many seconds, closing its
                                  browser. Default 300; 0 disables
  navi-mcp --no-fallback          Refuse trusted native input; synthetic dispatch only
  navi-mcp --version              Print the server and protocol version
  navi-mcp --help                 Print this help

SSE endpoints
  GET  /sse                       Event stream; the first frame carries the POST URL
  POST /message?sessionId=<id>    One JSON-RPC message per request
  GET  /healthz                   Liveness, open-session count, transport posture

Security
  An open SSE port is an open browser: whoever can reach it can drive a real
  Chromium. Only loopback is served without a bearer token, and a non-loopback
  --host without one is refused rather than warned about.

Environment
  NAVI_MCP_TOKEN=<token>          Bearer token, same as --auth-token
  NAVI_MCP_DEBUG=1                Log every tool call to stderr
  NAVI_ALLOW_LOCAL_NETWORK=1      TEST ONLY: permit private/loopback destinations
                                  Default denied, including page subresources.
  Sessions: 3 pages maximum, 30-minute hard TTL over SSE, ephemeral downloads,
  no camera/microphone/geolocation/notifications/clipboard grants.
`);
    return 0;
  }
  if (argv.includes("--version")) {
    process.stdout.write(`${SERVER_VERSION} (protocol ${PROTOCOL_VERSION}, navi ${NAVI_PROTOCOL_VERSION})
`);
    return 0;
  }
  const debug = process.env.NAVI_MCP_DEBUG === "1";
  const fallback = !argv.includes("--no-fallback");
  const log = (line) => {
    if (debug) process.stderr.write(`[navi-mcp] ${line}
`);
  };
  const transport = option(argv, "--transport", "stdio");
  if (transport === "sse") {
    const port = Number(option(argv, "--port", String(DEFAULT_SSE_PORT)));
    const host = option(argv, "--host", "127.0.0.1");
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      process.stderr.write(`navi-mcp: --port must be an integer between 0 and 65535, got "${option(argv, "--port", "")}"
`);
      return 2;
    }
    if (!host || host.startsWith("-")) {
      process.stderr.write(`navi-mcp: --host needs a host name or address, got "${host}" (use 127.0.0.1 for loopback)
`);
      return 2;
    }
    const flagToken = option(argv, "--auth-token", "");
    if (argv.includes("--auth-token") && (!flagToken || flagToken.startsWith("-"))) {
      process.stderr.write('navi-mcp: --auth-token needs a value, e.g. --auth-token "$NAVI_MCP_TOKEN"\n');
      return 2;
    }
    const authToken = flagToken || (typeof process.env.NAVI_MCP_TOKEN === "string" ? process.env.NAVI_MCP_TOKEN : "");
    const maxSessions = Number(option(argv, "--max-sessions", String(DEFAULT_MAX_SESSIONS)));
    if (!Number.isInteger(maxSessions) || maxSessions < 1) {
      process.stderr.write(`navi-mcp: --max-sessions must be a positive integer, got "${option(argv, "--max-sessions", "")}"
`);
      return 2;
    }
    const idleSeconds = Number(option(argv, "--idle-timeout", String(DEFAULT_IDLE_TIMEOUT_MS / 1e3)));
    if (!Number.isFinite(idleSeconds) || idleSeconds < 0) {
      process.stderr.write(`navi-mcp: --idle-timeout must be a non-negative number of seconds, got "${option(argv, "--idle-timeout", "")}"
`);
      return 2;
    }
    if (!isLoopbackHost(host) && !authToken) {
      process.stderr.write(`navi-mcp: refusing to bind ${host} without an auth token, which would expose a browser driver to every host that can reach it. Pass --auth-token <token> (or set NAVI_MCP_TOKEN), or bind 127.0.0.1.
`);
      return 2;
    }
    const remote = await createSseServer({
      host,
      port,
      log,
      handleMessage,
      authToken,
      maxSessions,
      idleTimeoutMs: Math.round(idleSeconds * 1e3),
      createSession: (id) => new NaviSession({ fallback, log, sessionId: id })
    });
    process.stderr.write(`navi-mcp: SSE transport listening on http://${host}:${remote.port}/sse (endpoint POST /message?sessionId=<id>; auth ${authToken ? "bearer" : "none, loopback only"}, max-sessions ${maxSessions}, idle-timeout ${idleSeconds}s)
`);
    await new Promise(
      /** @param {(value?: void) => void} resolve */
      (resolve2) => {
        const stop = () => resolve2();
        for (
          const signal of
          /** @type {const} */
          ["SIGTERM", "SIGINT"]
        ) process.once(signal, stop);
      }
    );
    await remote.close();
    log("remote transport closed");
    return 0;
  }
  if (transport !== "stdio") {
    process.stderr.write(`navi-mcp: unknown --transport "${transport}"; use stdio or sse
`);
    return 2;
  }
  await runStdioServer({
    session: new NaviSession({ fallback, log }),
    log
  });
  return 0;
}
export {
  MAX_PAGES_PER_SESSION,
  NaviSession,
  PROTOCOL_VERSION,
  RESOLUTION_STRATEGY_MAP,
  SERVER_NAME,
  SERVER_VERSION,
  SUPPORTED_PROTOCOLS,
  TOOLS,
  assertResolutionParity,
  handleMessage,
  main,
  normalizeStorageState,
  runStdioServer,
  toolError,
  toolResult
};
