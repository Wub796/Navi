var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
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
  const waitFor2 = record.wait_for ?? "mutation_settle";
  if (typeof waitFor2 !== "string" || !SETTLE_MODES.includes(
    /** @type {SettleMode} */
    waitFor2
  )) {
    return { error: `wait_for must be one of ${SETTLE_MODES.join(", ")}; got ${JSON.stringify(waitFor2)}.` };
  }
  const timeoutMs = record.timeout_ms ?? DEFAULT_SETTLE_TIMEOUT_MS;
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_SETTLE_TIMEOUT_MS) {
    return { error: `timeout_ms must be an integer between 1 and ${MAX_SETTLE_TIMEOUT_MS}.` };
  }
  return { plan: { waitFor: (
    /** @type {SettleMode} */
    waitFor2
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
    const token = randomUUID();
    try {
      await page.evaluate(
        /** @param {{quietMs: number, token: string}} arg */
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
          scope.__naviSettleToken = arg.token;
        },
        { quietMs: plan.quietMs, token }
      );
    } catch {
      return { token: null, beforeUrl: null, armed: false };
    }
    return { token, beforeUrl: page.url(), armed: true };
  }
  return { token: null, beforeUrl: null, armed: true };
}
async function documentReplaced(page, prepared, budgetMs) {
  const deadline = Date.now() + Math.max(0, budgetMs);
  try {
    await page.waitForLoadState?.("domcontentloaded");
  } catch {
  }
  for (; ; ) {
    if (prepared.beforeUrl !== null && page.url() !== prepared.beforeUrl) return true;
    let token = null;
    let readable = false;
    try {
      token = await page.evaluate(() => (
        /** @type {any} */
        globalThis.__naviSettleToken
      ));
      readable = true;
    } catch {
      readable = false;
    }
    if (readable && token !== prepared.token) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, NAVIGATION_POLL_MS));
  }
}
async function completeSettle(page, plan, targetId, prepared) {
  try {
    if (plan.waitFor === "navigation") {
      if (!prepared.armed || !prepared.token) return { settled: false, elapsedMs: 0, reason: "arm_failed" };
      if (page.url() !== prepared.beforeUrl) return { settled: true, elapsedMs: 0, navigated: true };
      const started = Date.now();
      while (Date.now() - started < plan.timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, NAVIGATION_POLL_MS));
        if (page.url() !== prepared.beforeUrl) return { settled: true, elapsedMs: Date.now() - started, navigated: true };
        try {
          const token = await page.evaluate(() => (
            /** @type {any} */
            globalThis.__naviSettleToken
          ));
          if (token !== prepared.token) return { settled: true, elapsedMs: Date.now() - started, navigated: true };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/execution context was destroyed|navigat/i.test(message)) continue;
          return { settled: false, elapsedMs: Date.now() - started, reason: "settle_failed", navigated: false };
        }
      }
      return { settled: false, elapsedMs: Date.now() - started, reason: "timeout", navigated: false };
    }
    if (plan.waitFor === "mutation_settle") {
      if (!prepared.armed) return { settled: false, elapsedMs: 0, reason: "arm_failed" };
      const started = Date.now();
      let failed;
      try {
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
                if (now - state.last >= state.quietMs) return { settled: true, elapsedMs: now - start, navigated: false };
                if (now >= deadline) return { settled: false, elapsedMs: now - start, reason: "timeout", navigated: false };
                await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, deadline - now))));
              }
            } finally {
              for (const observer of state.observers) observer.disconnect();
              delete scope.__naviSettle;
            }
          }, { timeoutMs: plan.timeoutMs })
        );
        if (outcome2.settled) {
          let navigated = prepared.beforeUrl !== null && page.url() !== prepared.beforeUrl;
          if (!navigated) {
            try {
              const token = await page.evaluate(() => (
                /** @type {any} */
                globalThis.__naviSettleToken
              ));
              navigated = token !== prepared.token;
            } catch {
            }
          }
          return { ...outcome2, navigated };
        }
        if (outcome2.reason !== "not_armed") return outcome2;
        failed = outcome2;
      } catch (error) {
        failed = { settled: false, elapsedMs: 0, reason: `settle_failed: ${error instanceof Error ? error.message : String(error)}` };
      }
      const elapsedMs = Date.now() - started;
      if (await documentReplaced(page, prepared, plan.timeoutMs - elapsedMs)) {
        return { settled: true, elapsedMs, reason: "document_replaced", navigated: true };
      }
      return { ...failed, elapsedMs };
    }
    const outcome = (
      /** @type {SettleOutcome} */
      await page.evaluate(async (arg) => {
        const navi = (
          /** @type {any} */
          globalThis.Navi
        );
        if (!navi) {
          const target = document.querySelector(arg.targetId);
          if (!target || !target.isConnected) return { settled: true, elapsedMs: 0 };
          const rect = target.getBoundingClientRect();
          const style = getComputedStyle(target);
          const hidden = rect.width <= 0 || rect.height <= 0 || style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0 || target.getAttribute("aria-hidden") === "true";
          if (hidden) return { settled: true, elapsedMs: 0 };
          return { settled: false, elapsedMs: 0, reason: "visible" };
        }
        const start = performance.now();
        const deadline = start + arg.timeoutMs;
        for (; ; ) {
          const map = await navi.actions({ limit: 5e3, coordinateSpace: "top" });
          const matches = map.actions.filter((action2) => action2.target_id === arg.targetId);
          const action = matches.length === 1 ? matches[0] : null;
          const hidden = action ? !action.state.is_visible || action.state.is_occluded : !map.truncated;
          if (hidden) return { settled: true, elapsedMs: performance.now() - start };
          if (performance.now() >= deadline) return { settled: false, elapsedMs: performance.now() - start, reason: "timeout" };
          await new Promise((resolve) => setTimeout(resolve, arg.pollMs));
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
var adapter_exports = {};
__export(adapter_exports, {
  NAVI_KEYBOARD_KEYS: () => NAVI_KEYBOARD_KEYS,
  NAVI_PROTOCOL_VERSION: () => NAVI_PROTOCOL_VERSION,
  NaviPlaywrightAdapter: () => NaviPlaywrightAdapter,
  addedMessages: () => addedMessages,
  naviAdapter: () => naviAdapter
});
function collectMessages(arg) {
  const found = [];
  const seen = /* @__PURE__ */ new Set();
  const regions = document.querySelectorAll('[role="alert"],[role="status"],[role="log"],[aria-live]');
  for (const region of regions) {
    if (region.getAttribute("aria-live") === "off") continue;
    if (region.getAttribute("aria-hidden") === "true") continue;
    if (!region.getClientRects().length) continue;
    const element = (
      /** @type {HTMLElement} */
      region
    );
    const raw = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
    if (!raw) continue;
    const text = raw.length > arg.chars ? `${raw.slice(0, arg.chars - 1)}\u2026` : raw;
    if (seen.has(text)) continue;
    seen.add(text);
    found.push(text);
    if (found.length >= arg.max) break;
  }
  return found;
}
function addedMessages(before, after) {
  const remaining = /* @__PURE__ */ new Map();
  for (const text of before) remaining.set(text, (remaining.get(text) ?? 0) + 1);
  const added = [];
  for (const text of after) {
    const count = remaining.get(text) ?? 0;
    if (count > 0) {
      remaining.set(text, count - 1);
      continue;
    }
    added.push(text);
  }
  return added;
}
function collectTargets(options = {}) {
  const documentRef = document;
  const escape = (value) => CSS.escape(value);
  const unique = (selector) => {
    try {
      return documentRef.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  };
  const selectorFor = (element) => {
    for (
      const [attribute, scoped] of
      /** @type {[string, boolean][]} */
      [["data-navi-id", false], ["data-testid", false], ["name", true], ["aria-label", true]]
    ) {
      const value = element.getAttribute(attribute);
      if (!value?.trim()) continue;
      const roleValue = element.getAttribute("role");
      const role = attribute === "aria-label" && roleValue ? `[role="${roleValue.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]` : "";
      const selector = `${scoped ? element.localName : ""}${role}[${attribute}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
      if (unique(selector)) return selector;
    }
    if (element.id && unique(`#${escape(element.id)}`)) return `#${escape(element.id)}`;
    for (const className of element.classList) {
      if (!className || /[a-f0-9]{8,}/i.test(className) || /^_[A-Za-z0-9_-]{5,}$/.test(className)) continue;
      const selector = `${element.localName}.${escape(className)}`;
      if (unique(selector)) return selector;
    }
    const parent = element.parentElement?.closest("[id]");
    const anchor = parent && unique(`#${escape(parent.id)}`) ? parent : documentRef.body;
    const parts = [];
    for (let node = (
      /** @type {HTMLElement | null} */
      element
    ); node && node !== anchor; node = node.parentElement) {
      const siblings = node.parentElement ? [...node.parentElement.children].filter((child) => child.localName === node.localName) : [];
      parts.unshift(`${node.localName}:nth-of-type(${siblings.indexOf(node) + 1})`);
    }
    return `${anchor?.id ? `#${escape(anchor.id)}` : "body"} > ${parts.join(" > ")}`;
  };
  const nodes = [...documentRef.querySelectorAll('button,input:not([type="hidden"]),textarea,select,a[href],[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="checkbox"],[role="switch"],[role="textbox"],[role="searchbox"],[role="combobox"],[contenteditable="true"]')].filter((element) => element instanceof HTMLElement);
  const actions = [];
  const limit = options.limit ?? 5e3;
  let truncated = false;
  for (const element of nodes) {
    if (!element.isConnected || element.getClientRects().length === 0) continue;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0 || element.closest('[hidden],[inert],[aria-hidden="true"]')) continue;
    const rect = element.getBoundingClientRect();
    const inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
    if (options.viewportOnly !== false && !inViewport) continue;
    if (actions.length >= limit) {
      truncated = true;
      break;
    }
    const id = selectorFor(element);
    const inputType = element instanceof HTMLInputElement ? element.type.toLowerCase() : "";
    const explicitRole = element.getAttribute("role");
    const role = element.matches('a[href],[role="link"]') ? "link" : explicitRole || (inputType === "checkbox" || inputType === "radio" ? inputType : ["button", "submit", "reset", "image"].includes(inputType) ? "button" : element.isContentEditable || element.matches("input,textarea") ? "textbox" : element.localName === "select" ? "combobox" : "button");
    const control = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement ? element : null;
    const label = element.getAttribute("aria-label") || control?.labels?.[0]?.textContent || element.getAttribute("placeholder") || (element.isContentEditable ? "" : element.textContent) || element.getAttribute("name") || element.localName;
    const point = documentRef.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const isVisible = rect.width > 0 && rect.height > 0;
    const isOccluded = isVisible && inViewport && !(point === element || element.contains(point));
    const action = role === "textbox" || role === "searchbox" || element.isContentEditable ? "type" : element instanceof HTMLSelectElement ? "select" : "click";
    const optionsForSelect = element instanceof HTMLSelectElement ? [...element.options].filter((option) => !option.disabled && !option.closest("optgroup:disabled")).slice(0, 20).map((option) => {
      const optionLabel = option.label.trim() || option.textContent?.trim() || option.value;
      return optionLabel === option.value ? optionLabel : `${optionLabel}=${option.value}`;
    }) : void 0;
    actions.push({
      target_id: id,
      role,
      name: String(label).trim().replace(/\s+/g, " ").slice(0, 160),
      action,
      selector: id,
      disabled: element.matches(":disabled") || element.getAttribute("aria-disabled") === "true" || element.hasAttribute("readonly"),
      ...control?.required ? { required: true } : {},
      ...inputType ? { input_type: inputType } : {},
      ...optionsForSelect ? { options: optionsForSelect } : {},
      state: { is_visible: isVisible, is_enabled: !element.matches(":disabled") && element.getAttribute("aria-disabled") !== "true" && !element.hasAttribute("readonly"), is_in_viewport: inViewport, is_occluded: isOccluded },
      coordinates: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      suggested_action: action
    });
  }
  return { version: "zero-config", state_version: 0, reset: true, truncated, actions };
}
function executeTarget(arg) {
  const candidates = [...document.querySelectorAll('button,input:not([type="hidden"]),textarea,select,a[href],[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="checkbox"],[role="switch"],[role="textbox"],[role="searchbox"],[role="combobox"],[contenteditable="true"]')].filter((element2) => element2 instanceof HTMLElement);
  let matches;
  try {
    matches = [...document.querySelectorAll(arg.targetId)].filter((element2) => element2 instanceof HTMLElement).filter((element2) => candidates.includes(element2));
  } catch {
    matches = [];
  }
  if (matches.length !== 1) throw Object.assign(new Error("Missing or ambiguous target"), { code: matches.length ? "AMBIGUOUS" : "NOT_FOUND" });
  const element = matches[0];
  const style = getComputedStyle(element);
  if (!element.isConnected || element.getClientRects().length === 0 || style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0 || element.closest('[hidden],[inert],[aria-hidden="true"]')) throw Object.assign(new Error("Target is unavailable"), { code: "UNAVAILABLE" });
  if (element.matches(":disabled") || element.getAttribute("aria-disabled") === "true" || !element.isConnected) throw Object.assign(new Error("Target is disabled or detached"), { code: "UNAVAILABLE" });
  if (arg.actionType === "type" && element instanceof HTMLInputElement && !["button", "submit", "reset", "image", "checkbox", "radio", "file", "hidden"].includes(element.type.toLowerCase())) {
    element.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(element, arg.payload.text ?? "");
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (arg.actionType === "type" && element instanceof HTMLTextAreaElement) {
    element.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(element, arg.payload.text ?? "");
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (arg.actionType === "click") element.click();
  else if (arg.actionType === "select" && element instanceof HTMLSelectElement) {
    const option = [...element.options].find((candidate) => candidate.value === arg.payload.value && !candidate.disabled && !candidate.closest("optgroup:disabled"));
    if (!option) throw Object.assign(new Error("No enabled select option has that value"), { code: "INVALID_ACTION" });
    element.focus();
    element.value = arg.payload.value ?? "";
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (arg.actionType === "type" && element.isContentEditable) {
    element.focus();
    element.textContent = arg.payload.text ?? "";
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: arg.payload.text ?? "" }));
  } else throw Object.assign(new Error("Action does not match target"), { code: "INVALID_ACTION" });
  return { target_id: arg.targetId, action: arg.actionType, dispatched: true };
}
function naviAdapter(page, options) {
  return new NaviPlaywrightAdapter(page, options);
}
var NAVI_PROTOCOL_VERSION, ACTIONS, MAX_TEXT, MAX_MESSAGES, MAX_MESSAGE_CHARS, MAX_CANDIDATES, NAVI_KEYBOARD_KEYS, NaviPlaywrightAdapter;
var init_adapter = __esm({
  "src/adapter.js"() {
    "use strict";
    init_settle();
    NAVI_PROTOCOL_VERSION = "0.3.0";
    ACTIONS = ["click", "type", "select"];
    MAX_TEXT = 1e4;
    MAX_MESSAGES = 4;
    MAX_MESSAGE_CHARS = 200;
    MAX_CANDIDATES = 6;
    NAVI_KEYBOARD_KEYS = Object.freeze(["Enter", "Escape", "Tab", "Shift+Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Backspace", "Delete", "Space", "ControlOrMeta+A"]);
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
          if (!navi) return void 0;
          if (navi.version !== arg.expected) throw new Error(`Unsupported Navi protocol ${navi.version}; expected ${arg.expected}`);
          return navi.actions({ limit: arg.limit ?? 5e3, coordinateSpace: "top", viewportOnly: arg.viewportOnly, since_version: arg.since_version });
        }, { expected, viewportOnly: options.viewportOnly, limit: options.limit, since_version: options.since_version });
        const resolved = snapshot ?? await this.page.evaluate(collectTargets, { viewportOnly: options.viewportOnly, limit: options.limit });
        if (!resolved || typeof resolved !== "object") throw new Error("Action map unavailable");
        if (resolved.truncated) throw new Error("Incomplete action map; raise the limit or narrow the page");
        return (
          /** @type {NaviActionMap} */
          resolved
        );
      }
      /**
       * What the page itself is saying right now: its rendered live regions.
       *
       * The action map answers "what can I press"; this answers "what did it tell
       * me", which is the half a rejecting form keeps in a non-interactive element.
       * It never throws: feedback is an addition to a call that already succeeded,
       * so a page that cannot be read (a torn-down context, a document that
       * navigated to another origin) reports no messages rather than turning a
       * dispatched action into a failure.
       * @returns {Promise<string[]>}
       */
      async pageMessages() {
        try {
          this.checkOrigin();
          const messages = await this.page.evaluate(collectMessages, { max: MAX_MESSAGES, chars: MAX_MESSAGE_CHARS });
          return Array.isArray(messages) ? messages.filter((message) => typeof message === "string") : [];
        } catch {
          return [];
        }
      }
      /**
       * Scroll a unique top-document control into view and return its fresh state.
       * Shadow-root and frame targets require scrolling their container separately.
       * @param {string} targetId
       * @returns {Promise<NaviAction>}
       */
      async scrollTo(targetId) {
        this.checkOrigin();
        if (this.busy) throw Object.assign(new Error("Adapter execution in flight"), { code: "BUSY" });
        if (typeof targetId !== "string" || !targetId || targetId.length > 512) {
          throw Object.assign(new Error("target_id must be a non-empty string of at most 512 characters"), { code: "INVALID_PAYLOAD" });
        }
        this.busy = true;
        try {
          const before = await this.discover({ viewportOnly: false, limit: 5e3 });
          const matches = before.actions.filter((action) => action.target_id === targetId);
          if (matches.length !== 1) {
            throw Object.assign(new Error("Missing or ambiguous scroll target"), { code: matches.length ? "AMBIGUOUS" : "NOT_FOUND" });
          }
          const found = await this.page.evaluate(async (arg) => {
            const selector = arg.zeroConfig ? arg.targetId : `[data-agent-target="${CSS.escape(arg.targetId)}"]`;
            const elements = document.querySelectorAll(selector);
            if (elements.length !== 1) return false;
            elements[0].scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
            await new Promise(requestAnimationFrame);
            await new Promise(requestAnimationFrame);
            return true;
          }, { targetId, zeroConfig: before.version === "zero-config" });
          if (!found) {
            throw Object.assign(new Error("Target is not uniquely reachable from the top document; scroll its containing frame or element instead"), { code: "SCROLL_TARGET_UNREACHABLE" });
          }
          const after = await this.discover({ viewportOnly: false, limit: 5e3 });
          const visible = after.actions.filter((action) => action.target_id === targetId);
          if (visible.length !== 1 || !visible[0].state.is_in_viewport) {
            throw Object.assign(new Error("Target is still not in the viewport after scrolling"), { code: "SCROLL_INCOMPLETE" });
          }
          return visible[0];
        } finally {
          this.busy = false;
        }
      }
      /**
       * Send one native key to the current focus, optionally checking its identity.
       * @param {string} key
       * @param {string} [targetId] Expected focused top-document target.
       */
      async pressKey(key, targetId) {
        this.checkOrigin();
        if (this.busy) throw Object.assign(new Error("Adapter execution in flight"), { code: "BUSY" });
        if (!NAVI_KEYBOARD_KEYS.includes(key)) throw Object.assign(new Error("Unsupported keyboard key"), { code: "INVALID_KEY" });
        if (targetId !== void 0 && (typeof targetId !== "string" || !targetId || targetId.length > 512)) {
          throw Object.assign(new Error("target_id must be a non-empty string of at most 512 characters"), { code: "INVALID_PAYLOAD" });
        }
        if (!this.fallback) throw Object.assign(new Error("Native keyboard input is disabled by --no-fallback"), { code: "FALLBACK_DISABLED" });
        this.busy = true;
        try {
          if (targetId !== void 0) {
            const map = await this.discover({ viewportOnly: false, limit: 5e3 });
            const matches = map.actions.filter((action) => action.target_id === targetId);
            if (matches.length !== 1) throw Object.assign(new Error("Missing or ambiguous keyboard target"), { code: matches.length ? "AMBIGUOUS" : "NOT_FOUND" });
            const state = matches[0].state;
            if (!state.is_visible || !state.is_enabled || !state.is_in_viewport || state.is_occluded) {
              throw Object.assign(new Error("Keyboard target is not actionable"), { code: "UNAVAILABLE" });
            }
            const focused = await this.page.evaluate((arg) => {
              const selector = arg.zeroConfig ? arg.targetId : `[data-agent-target="${CSS.escape(arg.targetId)}"]`;
              return document.activeElement?.matches(selector) === true;
            }, { targetId, zeroConfig: map.version === "zero-config" });
            if (!focused) throw Object.assign(new Error("Expected target is not the focused top-document control"), { code: "KEY_TARGET_NOT_FOCUSED" });
          }
          try {
            await this.page.keyboard.press(key);
          } catch (error) {
            throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), { code: "KEYBOARD_FAILED", may_have_applied: true });
          }
          return { pressed: true, key, mode: "native-driver" };
        } finally {
          this.busy = false;
        }
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
       * @param {AdapterExecuteOptions} [options] Opt-in capture of bounded before/after map evidence.
       * @returns {Promise<AdapterResult>}
       */
      async execute(targetId, actionType, payload = {}, settle, options = {}) {
        this.checkOrigin();
        if (this.busy) return { ok: false, error: { code: "BUSY", message: "Adapter execution in flight" } };
        if (!targetId || typeof targetId !== "string" || targetId.length > 512 || !ACTIONS.includes(actionType) || !payload || typeof payload !== "object" || Object.keys(payload).some((key) => key !== (actionType === "type" ? "text" : actionType === "select" ? "value" : "")) || actionType === "type" && (typeof payload.text !== "string" || payload.text.length > MAX_TEXT)) {
          return { ok: false, error: { code: "INVALID_PAYLOAD", message: "Invalid adapter command" } };
        }
        if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some((key) => key !== "captureChanges") || options.captureChanges !== void 0 && typeof options.captureChanges !== "boolean") {
          return { ok: false, error: { code: "INVALID_PAYLOAD", message: "Invalid adapter execution options" } };
        }
        let plan = null;
        if (settle !== void 0) {
          const normalized = normalizeSettle(settle);
          if ("error" in normalized) return { ok: false, error: { code: "INVALID_SETTLE", message: normalized.error } };
          plan = normalized.plan;
        }
        this.busy = true;
        try {
          let beforeMap = null;
          if (options.captureChanges) {
            try {
              beforeMap = /** @type {NaviActionMap} */
              await this.discover({ viewportOnly: false, limit: 5e3 });
            } catch {
            }
          }
          const before = await this.pageMessages();
          const prepared = plan ? await prepareSettle(this.page, plan) : null;
          const dispatchedAt = Date.now();
          const outcome = await this.#dispatch(targetId, actionType, payload, plan, prepared, dispatchedAt);
          const messages = addedMessages(before, await this.pageMessages());
          const withMessages = messages.length ? { ...outcome, page_messages: messages } : outcome;
          if (!options.captureChanges) return withMessages;
          return { ...withMessages, action_trace: await this.#captureActionTrace(beforeMap, targetId, outcome) };
        } finally {
          this.busy = false;
        }
      }
      /**
       * Capture a bounded before/after semantic record. A reset after navigation is
       * reported as a full snapshot, not mislabeled as a delta. The record is browser
       * evidence only; callers still need an independent business-state assertion.
       * @param {NaviActionMap | null} before
       * @param {string} requestedTarget
       * @param {AdapterResult} outcome
       */
      async #captureActionTrace(before, requestedTarget, outcome) {
        if (!outcome.ok || outcome.result?.dispatched !== true) return { available: false, reason: "action_not_dispatched" };
        if (!before) return { available: false, reason: "pre_action_map_unavailable" };
        try {
          const after = (
            /** @type {NaviActionMap | NaviDifferentialMap} */
            await this.discover({
              viewportOnly: false,
              limit: 5e3,
              since_version: before.state_version
            })
          );
          const targetId = outcome.result?.target_id ?? requestedTarget;
          const target = before.actions.find((action) => action.target_id === targetId);
          const actions = after.actions;
          const changes = actions.slice(0, 12);
          const targets = [];
          for (const action of changes) {
            if ("removed" in action) continue;
            targets.push({
              target_id: action.target_id,
              role: action.role,
              name: action.name,
              state: action.state,
              suggested_action: action.suggested_action
            });
          }
          const removed = changes.filter((action) => "removed" in action).map((action) => action.target_id);
          return {
            available: true,
            before_state_version: before.state_version,
            target: target ? { target_id: target.target_id, role: target.role, name: target.name, state: target.state } : null,
            after: {
              state_version: after.state_version,
              reset: after.reset,
              targets,
              removed,
              total: actions.length,
              truncated: actions.length > 12
            }
          };
        } catch {
          return { available: false, reason: "post_action_map_unavailable" };
        }
      }
      /**
       * Dispatch one action, resolving a name-shaped handle when no id matches it.
       *
       * A `NOT_FOUND` that never dispatched is the one refusal that is provably
       * hands-off, so it is the one place a second attempt is safe. It is worth
       * taking because the handle a planner usually has is the control's *name* ("Add
       * to cart", "Place order") rather than the id a map happened to assign it,
       * and a name that resolves to exactly one actionable control is a lookup, not
       * a guess. Zero or several matches are refused with the nearest current
       * controls, so a planner that misremembered a label gets one bounded step
       * forward instead of repeating the same invented id.
       * @param {string} targetId @param {string} actionType @param {{text?: string, value?: string}} payload
       * @param {{waitFor: 'mutation_settle'|'navigation'|'target_hidden', timeoutMs: number, quietMs: number} | null} plan
       * @param {{token: string | null, beforeUrl: string | null, armed: boolean} | null} prepared
       * @param {number} dispatchedAt
       * @returns {Promise<AdapterResult>}
       */
      async #dispatch(targetId, actionType, payload, plan, prepared, dispatchedAt) {
        let id = targetId;
        let resolvedFrom;
        const send = async (handle) => {
          const expected = this.protocolVersion;
          try {
            const response2 = await this.page.evaluate(async (arg) => {
              const navi = (
                /** @type {any} */
                globalThis.Navi
              );
              if (!navi) return void 0;
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
            }, { targetId: handle, actionType, payload, expected });
            if (response2 === void 0) {
              const result = await this.page.evaluate(executeTarget, { targetId: handle, actionType, payload });
              return { ok: true, result };
            }
            return response2;
          } catch (error) {
            if (!plan || !prepared) throw error;
            const receipt = await completeSettle(this.page, plan, handle, prepared);
            if (!receipt.settled) throw error;
            return { replacedDocument: receipt };
          }
        };
        const attributed = (outcome) => resolvedFrom && outcome.ok === true ? { ...outcome, resolved_from: resolvedFrom } : outcome;
        const settledInPage = (receipt) => attributed({
          ok: true,
          result: { target_id: id, action: actionType, dispatched: true },
          mode: "synthetic",
          settle: {
            mode: plan ? plan.waitFor : "mutation_settle",
            settled: true,
            elapsed_ms: Date.now() - dispatchedAt,
            final_url: this.page.url(),
            ...receipt.navigated !== void 0 ? { navigated: receipt.navigated } : {},
            ...receipt.reason ? { reason: receipt.reason } : {}
          }
        });
        let response = await send(id);
        if (response.replacedDocument) return settledInPage(response.replacedDocument);
        const unhandled = response.ok === false && response.error?.code === "NOT_FOUND" && response.error.dispatched !== true;
        if (unhandled) {
          const resolution = await this.#byName(id, actionType).catch(() => null);
          if (!resolution) return { ok: false, error: response.error };
          if (!("targetId" in resolution)) {
            return { ok: false, error: { code: "NOT_FOUND", message: resolution.message, candidates: resolution.candidates } };
          }
          resolvedFrom = id;
          id = resolution.targetId;
          response = await send(id);
          if (response.replacedDocument) return settledInPage(response.replacedDocument);
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
          return attributed(await this.#withSettle({ ok: true, result: response.result, mode: "synthetic" }, plan, prepared, dispatchedAt, id));
        }
        if (!this.fallback) return { ok: false, error: { code: "FALLBACK_DISABLED", message: "Target requires trusted input and fallback is disabled" } };
        if (actionType !== "click" && actionType !== "type") {
          return { ok: false, error: { code: "FALLBACK_UNSUPPORTED", message: "Trusted fallback supports click and type only" } };
        }
        return attributed(await this.#withSettle(await this.#fallback(id, actionType, payload), plan, prepared, dispatchedAt, id));
      }
      /**
       * Resolve a handle that is not a target id against the page's live accessible
       * names. Normalization is deliberately blunt (case, punctuation and runs of
       * whitespace are folded) because that is the difference between "Place order"
       * and "place-order", not between two different controls.
       * @param {string} handle @param {string} actionType
       * @returns {Promise<{targetId: string} | {message: string, candidates: {target_id: string, name: string, action: string}[]}>}
       */
      async #byName(handle, actionType) {
        const map = (
          /** @type {NaviActionMap} */
          await this.discover({ viewportOnly: false, limit: 5e3 })
        );
        const normalize = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        const wanted = normalize(handle);
        const actionable = map.actions.filter((action) => action.state.is_visible && action.state.is_enabled && !action.state.is_occluded);
        const typed = actionType === "click" ? actionable : actionable.filter((action) => action.suggested_action === actionType);
        const matched = typed.filter((action) => normalize(action.name) === wanted || normalize(action.target_id) === wanted);
        if (matched.length === 1) return { targetId: matched[0].target_id };
        const tokens = new Set(wanted.split(" ").filter(Boolean));
        const candidates = actionable.map((action) => ({ action, score: normalize(`${action.name} ${action.target_id}`).split(" ").filter((word) => tokens.has(word)).length })).sort((left, right) => right.score - left.score).slice(0, MAX_CANDIDATES).map((entry) => ({ target_id: entry.action.target_id, name: entry.action.name, action: entry.action.suggested_action }));
        return {
          message: matched.length > 1 ? `${matched.length} controls are named ${JSON.stringify(handle)}; use one of their target_ids instead.` : `No control is named ${JSON.stringify(handle)}. candidates lists the nearest current controls; act on one of their target_ids instead of repeating this handle.`,
          candidates
        };
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
            ...receipt.navigated !== void 0 ? { navigated: receipt.navigated } : {},
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

// src/index.js
init_adapter();
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// src/flow.js
var MAX_STEPS = 200;
var MAX_TEXT2 = 1e4;
var MAX_TIMEOUT = 12e4;
var FORBIDDEN_KEYS = /* @__PURE__ */ new Set(["__proto__", "constructor", "prototype"]);
var ACTIONS2 = /* @__PURE__ */ new Set(["click", "type", "select"]);
var ASSERT_MODES = /* @__PURE__ */ new Set(["text", "value", "visible", "exists", "url", "name"]);
var STEP_KEYS = {
  action: /* @__PURE__ */ new Set(["label", "target", "action", "text", "value", "consequential", "expect"]),
  assert: /* @__PURE__ */ new Set(["label", "assert", "target", "selector", "equals", "contains", "matches", "timeoutMs"]),
  wait: /* @__PURE__ */ new Set(["label", "wait"]),
  waitFor: /* @__PURE__ */ new Set(["label", "waitFor", "timeoutMs"]),
  scrollTo: /* @__PURE__ */ new Set(["label", "scrollTo"])
};
function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function isBoundedString(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}
function validateFlow(input) {
  const errors = [];
  if (!isPlainObject(input)) return { ok: false, errors: ["flow must be a JSON object"] };
  const raw = (
    /** @type {Record<string, unknown>} */
    input
  );
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_KEYS.has(key)) errors.push(`forbidden key "${key}"`);
    else if (!["name", "url", "viewport", "steps"].includes(key)) errors.push(`unknown flow field "${key}"`);
  }
  if (!Array.isArray(raw.steps)) errors.push("flow.steps must be an array");
  else if (raw.steps.length === 0) errors.push("flow.steps must not be empty");
  else if (raw.steps.length > MAX_STEPS) errors.push(`flow.steps must contain at most ${MAX_STEPS} steps`);
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 120) : "flow";
  if (raw.url !== void 0 && !isBoundedString(raw.url)) errors.push("flow.url must be a bounded non-empty string");
  if (errors.length) return { ok: false, errors };
  const steps = [];
  const list = (
    /** @type {unknown[]} */
    raw.steps
  );
  for (let index = 0; index < list.length; index++) {
    const step = list[index];
    const at = `steps[${index}]`;
    if (!isPlainObject(step)) {
      errors.push(`${at} must be an object`);
      continue;
    }
    const entry = (
      /** @type {Record<string, unknown>} */
      step
    );
    const kind = "action" in entry ? "action" : "assert" in entry ? "assert" : "wait" in entry ? "wait" : "waitFor" in entry ? "waitFor" : "scrollTo" in entry ? "scrollTo" : null;
    if (!kind) {
      errors.push(`${at} must declare one of action, assert, wait, waitFor or scrollTo`);
      continue;
    }
    const declared = ["action", "assert", "wait", "waitFor", "scrollTo"].filter((key) => key in entry);
    if (declared.length > 1) {
      errors.push(`${at} declares multiple step kinds: ${declared.join(", ")}`);
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (FORBIDDEN_KEYS.has(key)) errors.push(`${at} has forbidden key "${key}"`);
      else if (!STEP_KEYS[
        /** @type {keyof typeof STEP_KEYS} */
        kind
      ].has(key)) errors.push(`${at} has unknown field "${key}"`);
    }
    const label = typeof entry.label === "string" && entry.label.trim() ? entry.label.trim().slice(0, 120) : `${kind} ${index + 1}`;
    if (kind === "action") {
      if (!isBoundedString(entry.target)) errors.push(`${at}.target must be a bounded non-empty string`);
      if (typeof entry.action !== "string" || !ACTIONS2.has(entry.action)) errors.push(`${at}.action must be one of click, type, select`);
      if (entry.action === "type" && (typeof entry.text !== "string" || entry.text.length > MAX_TEXT2)) errors.push(`${at}.text must be a string of at most ${MAX_TEXT2} characters`);
      if (entry.action !== "type" && entry.text !== void 0) errors.push(`${at}.text is only valid for type actions`);
      if (entry.action === "select" && (typeof entry.value !== "string" || !entry.value.length || entry.value.length > 512)) errors.push(`${at}.value must be a bounded non-empty string for select`);
      if (entry.action !== "select" && entry.value !== void 0) errors.push(`${at}.value is only valid for select actions`);
      if (entry.consequential !== void 0 && typeof entry.consequential !== "boolean") errors.push(`${at}.consequential must be a boolean`);
      if (entry.expect !== void 0) {
        if (!isPlainObject(entry.expect)) errors.push(`${at}.expect must be an object`);
        else {
          for (const key of Object.keys(
            /** @type {object} */
            entry.expect
          )) {
            if (!["selector", "target", "text", "value", "name"].includes(key)) errors.push(`${at}.expect has unknown field "${key}"`);
          }
          const expect = (
            /** @type {Record<string, unknown>} */
            entry.expect
          );
          const hasComparator = typeof expect.text === "string" || typeof expect.value === "string" || typeof expect.name === "string";
          if (!hasComparator) errors.push(`${at}.expect needs text, value or name`);
          if (!isBoundedString(expect.target) && !isBoundedString(entry.target)) errors.push(`${at}.expect needs a target`);
          if (typeof expect.name !== "string" && !isBoundedString(expect.selector)) errors.push(`${at}.expect needs a selector or name`);
          if (typeof expect.name === "string" && isBoundedString(expect.selector)) errors.push(`${at}.expect cannot combine selector and name`);
        }
      }
      if (errors.some((message) => message.startsWith(at))) continue;
      const normalized2 = { kind: "action", label, target: (
        /** @type {string} */
        entry.target
      ), action: (
        /** @type {string} */
        entry.action
      ), consequential: entry.consequential === true };
      if (typeof entry.text === "string") normalized2.text = entry.text;
      if (typeof entry.value === "string") normalized2.value = entry.value;
      steps.push(normalized2);
      if (entry.expect !== void 0) {
        const expect = (
          /** @type {Record<string, unknown>} */
          entry.expect
        );
        const mode = typeof expect.name === "string" ? "name" : typeof expect.text === "string" ? "text" : "value";
        const target = isBoundedString(expect.target) ? expect.target : (
          /** @type {string} */
          entry.target
        );
        const assertion = { kind: "assert", label: `${label} \xB7 expect`, mode, equals: String(expect[mode]) };
        if (mode === "name" || !isBoundedString(expect.selector)) assertion.target = target;
        else assertion.selector = expect.selector;
        steps.push(assertion);
      }
      continue;
    }
    if (kind === "assert") {
      if (typeof entry.assert !== "string" || !ASSERT_MODES.has(entry.assert)) errors.push(`${at}.assert must be one of ${[...ASSERT_MODES].join(", ")}`);
      const mode = String(entry.assert);
      const hasTarget = isBoundedString(entry.target), hasSelector = isBoundedString(entry.selector);
      if (mode === "url") {
        if (hasTarget || hasSelector) errors.push(`${at} url assertions take no target or selector`);
      } else if (mode === "name") {
        if (!hasTarget) errors.push(`${at} name assertions require a target`);
        if (hasSelector) errors.push(`${at} name assertions take no selector`);
      } else if (hasTarget === hasSelector) errors.push(`${at} needs exactly one of target or selector`);
      const comparators = ["equals", "contains", "matches"].filter((key) => entry[key] !== void 0);
      for (const key of comparators) if (typeof entry[key] !== "string") errors.push(`${at}.${key} must be a string`);
      if (mode !== "visible" && mode !== "exists" && comparators.length === 0) errors.push(`${at} needs equals, contains or matches`);
      if (mode === "url" && entry.matches !== void 0) {
        try {
          new RegExp(String(entry.matches));
        } catch {
          errors.push(`${at}.matches is not a valid regular expression`);
        }
      }
      if (errors.some((message) => message.startsWith(at))) continue;
      const normalized2 = { kind: "assert", label, mode };
      if (hasTarget) normalized2.target = /** @type {string} */
      entry.target;
      if (hasSelector) normalized2.selector = /** @type {string} */
      entry.selector;
      if (typeof entry.timeoutMs === "number" && Number.isFinite(entry.timeoutMs) && entry.timeoutMs >= 0 && entry.timeoutMs <= MAX_TIMEOUT) {
        normalized2.timeoutMs = Math.floor(entry.timeoutMs);
      }
      for (const key of comparators) normalized2[key] = entry[key];
      steps.push(normalized2);
      continue;
    }
    if (kind === "scrollTo") {
      if (!isBoundedString(entry.scrollTo)) errors.push(`${at}.scrollTo must be a bounded non-empty target id`);
      else steps.push({ kind: "scrollTo", label, target: entry.scrollTo });
      continue;
    }
    if (kind === "wait") {
      if (typeof entry.wait !== "number" || !Number.isFinite(entry.wait) || entry.wait < 0 || entry.wait > MAX_TIMEOUT) {
        errors.push(`${at}.wait must be a number between 0 and ${MAX_TIMEOUT}`);
        continue;
      }
      steps.push({ kind: "wait", label, ms: Math.floor(entry.wait) });
      continue;
    }
    if (entry.timeoutMs !== void 0 && (typeof entry.timeoutMs !== "number" || !Number.isFinite(entry.timeoutMs) || entry.timeoutMs < 0 || entry.timeoutMs > MAX_TIMEOUT)) {
      errors.push(`${at}.timeoutMs must be a number between 0 and ${MAX_TIMEOUT}`);
    }
    const waitFor2 = entry.waitFor;
    if (!isPlainObject(waitFor2)) {
      errors.push(`${at}.waitFor must be an object`);
      continue;
    }
    for (const key of Object.keys(
      /** @type {object} */
      waitFor2
    )) {
      if (!["selector", "text", "urlIncludes"].includes(key)) errors.push(`${at}.waitFor has unknown field "${key}"`);
    }
    const criteria = (
      /** @type {Record<string, unknown>} */
      waitFor2
    );
    const provided = ["selector", "text", "urlIncludes"].filter((key) => isBoundedString(criteria[key]));
    if (provided.length !== 1) errors.push(`${at}.waitFor needs exactly one bounded string of selector, text or urlIncludes`);
    if (errors.some((message) => message.startsWith(at))) continue;
    const normalized = { kind: "waitFor", label, timeoutMs: typeof entry.timeoutMs === "number" ? Math.floor(entry.timeoutMs) : 15e3 };
    for (const key of provided) normalized[key] = criteria[key];
    steps.push(normalized);
  }
  if (errors.length) return { ok: false, errors };
  const flow = { name, steps };
  if (typeof raw.url === "string") flow.url = raw.url;
  return { ok: true, flow };
}
async function runFlow({ adapter, page, flow, allowConsequential = false, timeoutMs = 15e3, onStep }) {
  const started = Date.now();
  const results = [];
  function record(step, index, began, ok, mode, error) {
    const result = { index, label: step.label, kind: step.kind, ok, durationMs: Date.now() - began, ...mode ? { mode } : {}, ...error ? { error } : {} };
    results.push(result);
    onStep?.(result);
    return result;
  }
  for (let index = 0; index < flow.steps.length; index++) {
    const step = flow.steps[index];
    const began = Date.now();
    if (step.kind === "action" && step.consequential && !allowConsequential) {
      return { ok: false, steps: results, failedStep: record(step, index, began, false, void 0, { code: "CONSEQUENTIAL_BLOCKED", message: "Step is marked consequential; rerun with --allow-consequential after reviewing it" }), durationMs: Date.now() - started };
    }
    try {
      if (step.kind === "action") {
        const outcome = await withTimeout(adapter.execute(step.target, step.action, step.action === "type" ? { text: step.text ?? "" } : step.action === "select" ? { value: step.value ?? "" } : {}), timeoutMs, `action "${step.target}"`);
        if (!outcome.ok) throw stepError(outcome.error?.code || "EXECUTION_FAILED", outcome.error?.message || "Execution failed");
        record(step, index, began, true, outcome.mode);
        continue;
      }
      if (step.kind === "wait") {
        await new Promise((resolve) => setTimeout(resolve, step.ms));
        record(step, index, began, true);
        continue;
      }
      if (step.kind === "scrollTo") {
        await withTimeout(adapter.scrollTo(step.target), timeoutMs, `scrollTo ${step.target}`);
        record(step, index, began, true);
        continue;
      }
      if (step.kind === "waitFor") {
        await withTimeout(waitFor(page, step), step.timeoutMs, `waitFor on ${step.label}`);
        record(step, index, began, true);
        continue;
      }
      const budget = step.timeoutMs ?? timeoutMs;
      const observation = step.mode === "name" ? await withTimeout(observeName(adapter, step), budget, `assert "${step.label}"`) : await withTimeout(observe(page, step), budget, `assert "${step.label}"`);
      const failure = compare(step, observation);
      if (failure) throw stepError("ASSERTION_FAILED", failure);
      record(step, index, began, true);
    } catch (error) {
      const failure = (
        /** @type {Error & {code?: string}} */
        error
      );
      return { ok: false, steps: results, failedStep: record(step, index, began, false, void 0, { code: failure.code || "STEP_FAILED", message: failure.message }), durationMs: Date.now() - started };
    }
  }
  return { ok: true, steps: results, durationMs: Date.now() - started };
}
function stepError(code, message) {
  return Object.assign(new Error(message), { code });
}
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(stepError("TIMEOUT", `${label} exceeded ${ms}ms; the action may have partially applied and is not retried`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
async function waitFor(page, step) {
  const deadline = Date.now() + step.timeoutMs;
  for (; ; ) {
    const observed = await page.evaluate((arg) => {
      if (arg.selector) return { hit: !!document.querySelector(arg.selector) };
      return { hit: (document.body?.innerText || "").includes(
        /** @type {string} */
        arg.text
      ) };
    }, { selector: step.selector, text: step.text });
    if (observed.hit && (!step.urlIncludes || page.url().includes(step.urlIncludes))) return;
    if (Date.now() >= deadline) throw stepError("TIMEOUT", `waitFor on ${step.label} exceeded ${step.timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
async function observeName(adapter, step) {
  const map = await adapter.discover();
  const matches = map.actions.filter((action2) => action2.target_id === step.target);
  const url = adapter.page.url();
  if (matches.length !== 1) return { found: false, url };
  const action = matches[0];
  return { found: true, visible: action.state.is_visible, name: action.name, url };
}
async function observe(page, step) {
  return page.evaluate((arg) => {
    const escape = (value) => typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, "\\$&");
    const selector = arg.target ? `[data-agent-target="${escape(arg.target)}"]` : (
      /** @type {string} */
      arg.selector
    );
    const element = document.querySelector(selector);
    const found = !!element;
    return {
      found,
      selector,
      visible: found ? element.getClientRects().length > 0 : false,
      text: found ? (element.textContent || "").trim() : void 0,
      value: found && "value" in element ? String(
        /** @type {any} */
        element.value
      ) : void 0,
      url: location.href
    };
  }, { target: step.target, selector: step.selector });
}
function compare(step, observed) {
  if (step.mode === "url") {
    if (step.equals !== void 0 && observed.url !== step.equals) return `expected url ${JSON.stringify(step.equals)}, received ${JSON.stringify(observed.url)}`;
    if (step.contains !== void 0 && !observed.url.includes(step.contains)) return `expected url to contain ${JSON.stringify(step.contains)}`;
    if (step.matches !== void 0 && !new RegExp(step.matches).test(observed.url)) return `expected url to match ${step.matches}`;
    return null;
  }
  if (step.mode === "name" && !observed.found) return `expected target ${step.target} to be present in the action map`;
  const where = step.selector ? `selector ${step.selector}` : `target ${step.target}`;
  if (step.mode === "exists") return observed.found ? null : `expected ${where} to exist`;
  if (step.mode === "visible") return observed.visible ? null : `expected ${where} to be visible`;
  const actual = step.mode === "value" ? observed.value : step.mode === "name" ? observed.name : observed.text;
  if (actual === void 0) return `expected ${where} to expose a ${step.mode}`;
  if (step.equals !== void 0 && actual !== step.equals) return `expected ${step.mode} ${JSON.stringify(step.equals)}, received ${JSON.stringify(actual)}`;
  if (step.contains !== void 0 && !actual.includes(step.contains)) return `expected ${step.mode} to contain ${JSON.stringify(step.contains)}, received ${JSON.stringify(actual)}`;
  if (step.matches !== void 0 && !new RegExp(step.matches).test(actual)) return `expected ${step.mode} to match ${step.matches}, received ${JSON.stringify(actual)}`;
  return null;
}

// src/index.js
var NAVI_SDK_FILE = "navi.min.js";
function naviSdkPath() {
  return fileURLToPath(new URL(NAVI_SDK_FILE, import.meta.url));
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
async function connectNavi(page, options = {}) {
  const { NaviPlaywrightAdapter: Adapter } = await Promise.resolve().then(() => (init_adapter(), adapter_exports));
  const installed = await page.evaluate(() => Boolean(
    /** @type {any} */
    globalThis.Navi
  )).catch(() => false);
  const sdkPath = installed ? null : await installNavi(page, options);
  const adapter = new Adapter(page, options);
  if (options.requireIndexed !== false) {
    await page.evaluate(async () => {
      await /** @type {any} */
      globalThis.Navi?.ready();
    });
  }
  return { adapter, sdkPath };
}
export {
  NAVI_PROTOCOL_VERSION,
  NAVI_SDK_FILE,
  NaviPlaywrightAdapter,
  connectNavi,
  installNavi,
  naviAdapter,
  naviSdkPath,
  runFlow,
  validateFlow
};
