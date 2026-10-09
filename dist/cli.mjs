#!/usr/bin/env node

// src/cli.js
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname as dirname2, isAbsolute, resolve as resolve2 } from "node:path";

// src/adapter.js
var NAVI_PROTOCOL_VERSION = "0.2.0";
var ACTIONS = ["click", "type", "select"];
var MAX_TEXT = 1e4;
var NaviPlaywrightAdapter = class {
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
  /** @param {{viewportOnly?: boolean, limit?: number}} [options] @returns {Promise<NaviActionMap>} */
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
      return navi.actions({ limit: arg.limit ?? 5e3, coordinateSpace: "top", viewportOnly: arg.viewportOnly });
    }, { expected, viewportOnly: options.viewportOnly, limit: options.limit });
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
   * @param {string} targetId
   * @param {'click'|'type'|'select'|string} actionType
   * @param {{text?: string, value?: string}} [payload]
   * @returns {Promise<AdapterResult>}
   */
  async execute(targetId, actionType, payload = {}) {
    this.checkOrigin();
    if (this.busy) return { ok: false, error: { code: "BUSY", message: "Adapter execution in flight" } };
    if (!targetId || typeof targetId !== "string" || targetId.length > 512 || !ACTIONS.includes(actionType) || !payload || typeof payload !== "object" || Object.keys(payload).some((key) => key !== (actionType === "type" ? "text" : actionType === "select" ? "value" : "")) || actionType === "type" && (typeof payload.text !== "string" || payload.text.length > MAX_TEXT)) {
      return { ok: false, error: { code: "INVALID_PAYLOAD", message: "Invalid adapter command" } };
    }
    this.busy = true;
    try {
      const expected = this.protocolVersion;
      const response = await this.page.evaluate(async (arg) => {
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
        return { ok: true, result: response.result, mode: "synthetic" };
      }
      if (!this.fallback) return { ok: false, error: { code: "FALLBACK_DISABLED", message: "Target requires trusted input and fallback is disabled" } };
      if (actionType !== "click" && actionType !== "type") {
        return { ok: false, error: { code: "FALLBACK_UNSUPPORTED", message: "Trusted fallback supports click and type only" } };
      }
      return await this.#fallback(targetId, actionType, payload);
    } finally {
      this.busy = false;
    }
  }
  /**
   * Native driver fallback: fresh coordinates, strict state checks, no blind retries.
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
        await new Promise((resolve3) => setTimeout(resolve3, step.ms));
        record(step, index, began, true);
        continue;
      }
      if (step.kind === "scrollTo") {
        await withTimeout(scrollTo(adapter, page, step), timeoutMs, `scrollTo ${step.target}`);
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
  return new Promise((resolve3, reject) => {
    const timer = setTimeout(() => reject(stepError("TIMEOUT", `${label} exceeded ${ms}ms; the action may have partially applied and is not retried`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve3(value);
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
    await new Promise((resolve3) => setTimeout(resolve3, 50));
  }
}
async function scrollTo(adapter, page, step) {
  const found = await page.evaluate((arg) => {
    const escape = (value) => typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, "\\$&");
    const element = document.querySelector(`[data-agent-target="${escape(arg.target)}"]`);
    if (!element) return false;
    element.scrollIntoView({ block: "center", inline: "center" });
    return true;
  }, { target: step.target });
  if (!found) {
    throw stepError("SCROLL_TARGET_UNREACHABLE", `target ${step.target} is not reachable from the top document; scroll its containing frame or element instead`);
  }
  await page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    await /** @type {any} */
    globalThis.Navi?.ready();
  });
  const map = await adapter.discover();
  const matches = map.actions.filter((action) => action.target_id === step.target);
  if (matches.length !== 1 || !matches[0].state.is_in_viewport) {
    throw stepError("SCROLL_INCOMPLETE", `target ${step.target} is still not in the viewport after scrolling`);
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

// src/browser.js
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

// src/cli.js
var EXIT = { OK: 0, FAILED: 1, USAGE: 2, ENVIRONMENT: 3 };
var FORBIDDEN_KEYS2 = /* @__PURE__ */ new Set(["__proto__", "constructor", "prototype"]);
var HELP = `navi \xB7 agent harness for the Navi protocol

Usage
  navi run --url <url> --action-file <flow.json> [options]
  navi discover --url <url> [--json]

Options
  --url <url>              Target http(s) URL. Required unless the flow declares one.
  --action-file <path>     JSON flow file (see flows/example-checkout.json).
  --timeout <ms>           Per-step timeout, 1-120000. Default 15000.
  --viewport <WxH>         Browser viewport. Default 1360x900.
  --headed                 Run with a visible browser window.
  --json                   Print the machine-readable report only.
  --report <path>          Also write the JSON report to a file.
  --discover               With run: print targets and exit without executing.
  --allow-consequential    Permit steps marked "consequential": true.
  --strict-synthetic       Never fall back to native driver input.
  --quiet                  Suppress per-step lines.
  --help, --version

Exit codes
  0 success   1 flow or assertion failure   2 usage or invalid flow   3 environment failure

Safety
  Flows are untrusted input: they are schema-validated, never eval'd, and steps
  marked consequential require --allow-consequential. Failed or timed-out actions
  are reported, never retried automatically, because they may already have applied.
`;
function parseArgs(argv) {
  const options = { command: null, timeoutMs: 15e3, viewport: { width: 1360, height: 900 }, headed: false, json: false, discoverOnly: false, allowConsequential: false, fallback: true, quiet: false, errors: [] };
  const list = [...argv];
  if (list[0] === "run" || list[0] === "discover") options.command = /** @type {'run'|'discover'} */
  list.shift();
  else if (list.includes("--help") || list.includes("-h")) {
    options.command = "help";
    return options;
  } else if (list.includes("--version") || list.includes("-v")) {
    options.command = "version";
    return options;
  } else if (list.length) options.command = "run";
  while (list.length) {
    const flag = (
      /** @type {string} */
      list.shift()
    );
    const value = (name) => {
      const next = list.shift();
      if (next === void 0 || next.startsWith("--")) options.errors.push(`${name} requires a value`);
      return next || "";
    };
    switch (flag) {
      case "--url":
        options.url = value("--url");
        break;
      case "--action-file":
      case "--flow":
      case "-f":
        options.actionFile = value(flag);
        break;
      case "--report":
        options.report = value("--report");
        break;
      case "--timeout": {
        const raw = Number(value("--timeout"));
        if (!Number.isFinite(raw) || raw < 1 || raw > 12e4) options.errors.push("--timeout must be a number between 1 and 120000");
        else options.timeoutMs = Math.floor(raw);
        break;
      }
      case "--viewport": {
        const match = /^(\d{3,5})x(\d{3,5})$/.exec(value("--viewport"));
        if (!match) options.errors.push("--viewport must look like 1360x900");
        else options.viewport = { width: Number(match[1]), height: Number(match[2]) };
        break;
      }
      case "--headed":
        options.headed = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--discover":
        options.discoverOnly = true;
        break;
      case "--allow-consequential":
        options.allowConsequential = true;
        break;
      case "--strict-synthetic":
        options.fallback = false;
        break;
      case "--quiet":
        options.quiet = true;
        break;
      default:
        options.errors.push(`unknown argument "${flag}"`);
    }
  }
  if (options.url && !isAllowedUrl(options.url)) options.errors.push("--url must be an http(s) URL without embedded credentials");
  if (options.command === "discover" && !options.url) options.errors.push("discover requires --url");
  if (options.command === "run" && !options.url && !options.actionFile) options.errors.push("run requires --url, --action-file, or both");
  return options;
}
function parseFlowDocument(text) {
  return JSON.parse(text, (key, value) => {
    if (FORBIDDEN_KEYS2.has(key)) throw new Error(`flow JSON contains forbidden key "${key}"`);
    return value;
  });
}
async function packageVersion() {
  try {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    return String(manifest.version || NAVI_PROTOCOL_VERSION);
  } catch {
    return NAVI_PROTOCOL_VERSION;
  }
}
function describeUrl(target) {
  try {
    return new URL(
      /** @type {string} */
      target
    ).origin;
  } catch {
    return target || "";
  }
}
async function main(argv, io = {}) {
  const out = io.stdout || ((line) => process.stdout.write(line + "\n"));
  const err = io.stderr || ((line) => process.stderr.write(line + "\n"));
  const options = parseArgs(argv);
  if (options.command === "help" || !options.command) {
    out(HELP);
    return options.command === "help" ? EXIT.OK : EXIT.USAGE;
  }
  if (options.command === "version") {
    out(await packageVersion());
    return EXIT.OK;
  }
  if (options.errors.length) {
    for (const message of options.errors) err(`error: ${message}`);
    err('Run "navi --help" for usage.');
    return EXIT.USAGE;
  }
  let validated = null;
  if (options.actionFile) {
    let text;
    try {
      text = await readFile(isAbsolute(options.actionFile) ? options.actionFile : resolve2(process.cwd(), options.actionFile), "utf8");
    } catch (error) {
      err(`error: cannot read flow file ${options.actionFile}: ${/** @type {Error} */
      error.message}`);
      return EXIT.USAGE;
    }
    let document2;
    try {
      document2 = parseFlowDocument(text);
    } catch (error) {
      err(`error: invalid flow JSON: ${/** @type {Error} */
      error.message}`);
      return EXIT.USAGE;
    }
    validated = validateFlow(document2);
    if (!validated.ok) {
      for (const message of validated.errors) err(`error: ${message}`);
      return EXIT.USAGE;
    }
  }
  const flowUrl = validated?.flow.url;
  const url = options.url || flowUrl;
  if (!url) {
    err('error: no target URL; pass --url or set "url" in the flow file');
    return EXIT.USAGE;
  }
  if (!isAllowedUrl(url)) {
    err(`error: refusing to open unsupported URL "${url}"`);
    return EXIT.USAGE;
  }
  let chromium;
  let sdkPath;
  try {
    chromium = await resolveChromium();
    sdkPath = resolveSdkPath();
  } catch (error) {
    err(`error: ${/** @type {Error} */
    error.message}`);
    return EXIT.ENVIRONMENT;
  }
  const startedAt = (/* @__PURE__ */ new Date()).toISOString();
  const began = Date.now();
  const browser = await chromium.launch({ headless: !options.headed });
  let page;
  try {
    page = await browser.newPage({ viewport: options.viewport });
    const loaded = await page.goto(url, { waitUntil: "load", timeout: 45e3 });
    if (loaded && loaded.status() >= 400) {
      err(`error: ${url} responded with HTTP ${loaded.status()}`);
      page;
      return EXIT.ENVIRONMENT;
    }
    const install = await ensureNavi(page, sdkPath);
    const adapter = new NaviPlaywrightAdapter(page, { fallback: options.fallback });
    let targets = [];
    let steps = [];
    let ok = true;
    let failedStep;
    let failure;
    if (options.command === "discover" || options.discoverOnly) {
      const map = await adapter.discover();
      targets = map.actions;
    } else if (validated?.ok) {
      const result = await runFlow({ adapter, page, flow: validated.flow, allowConsequential: options.allowConsequential, timeoutMs: options.timeoutMs });
      ok = result.ok;
      steps = result.steps;
      failedStep = result.failedStep;
      failure = failedStep?.error;
    }
    const discovery = Boolean(targets.length || options.discoverOnly || options.command === "discover");
    const report = {
      tool: "navi",
      packageVersion: await packageVersion(),
      protocolVersion: install.version,
      mode: discovery ? "discover" : "run",
      flow: validated?.ok ? validated.flow.name : void 0,
      url: page.url(),
      origin: describeUrl(page.url()),
      startedAt,
      durationMs: Date.now() - began,
      ok,
      ...failure ? { failure } : {},
      ...targets.length ? { targets } : {},
      ...validated?.ok && !discovery ? { steps } : {}
    };
    if (options.report) {
      const path = isAbsolute(options.report) ? options.report : resolve2(process.cwd(), options.report);
      await mkdir(dirname2(path), { recursive: true });
      await writeFile(path, JSON.stringify(report, null, 2) + "\n");
    }
    if (options.json) out(JSON.stringify(report, null, 2));
    else {
      out(`navi ${report.packageVersion} \xB7 protocol ${report.protocolVersion} \xB7 ${report.mode}`);
      out(`url    ${report.url}`);
      out(`sdk    ${sdkPath}${install.injected ? " (injected)" : " (already present)"}`);
      if (targets.length) {
        out(`targets (${targets.length}):`);
        for (const target of targets) {
          const state = target.state || {};
          const flags = [state.is_enabled === false ? "disabled" : "enabled", state.is_visible === false ? "hidden" : "visible", state.is_in_viewport === false ? "off-viewport" : "in-viewport", state.is_occluded ? "occluded" : "clear"].join(" \xB7 ");
          out(`  ${String(target.target_id).padEnd(28)} ${String(target.role).padEnd(10)} ${flags}  ${JSON.stringify(target.name)}`);
        }
      }
      if (!options.quiet) {
        for (const step of steps) {
          const status = step.ok ? "ok  " : "FAIL";
          if (!options.json) out(`${status} ${String(step.index + 1).padStart(2)}. ${step.label} (${step.kind}${step.mode ? `, ${step.mode}` : ""}, ${step.durationMs}ms)`);
          if (step.error) out(`     ${step.error.code}: ${step.error.message}`);
        }
      }
      out(`result: ${ok ? "PASSED" : "FAILED"} in ${report.durationMs}ms${steps.length ? ` (${steps.filter((step) => step.ok).length}/${steps.length} steps)` : ""}`);
    }
    if (failure?.code === "CONSEQUENTIAL_BLOCKED") return EXIT.USAGE;
    return ok ? EXIT.OK : EXIT.FAILED;
  } catch (error) {
    const failure = (
      /** @type {Error & {code?: string}} */
      error
    );
    err(`error: ${failure.message}`);
    return failure.code === "NO_SDK" || failure.code === "NO_BROWSER" ? EXIT.ENVIRONMENT : EXIT.FAILED;
  } finally {
    await browser.close().catch(() => void 0);
  }
}
export {
  EXIT,
  isAllowedUrl,
  main,
  parseArgs
};
