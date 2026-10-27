// Navi adapter: drives Navi targets in a Playwright page and falls back to real
// driver input only when the host certifies that nothing was dispatched.
// This module is environment-agnostic: it only needs the small page surface below.
import { completeSettle, normalizeSettle, prepareSettle } from './settle.js';

/** @typedef {{x:number,y:number,width:number,height:number}} NaviBox */
/**
 * @typedef {object} NaviAction
 * @property {string} target_id
 * @property {string} role
 * @property {string} name
 * @property {{is_visible:boolean,is_enabled:boolean,is_in_viewport:boolean,is_occluded:boolean}} state
 * @property {NaviBox} coordinates
 * @property {string} suggested_action
 */
/** @typedef {{version:string,state_version:number,reset:boolean,truncated:boolean,actions:NaviAction[]}} NaviActionMap */
/** @typedef {{version:string,state_version:number,reset:boolean,truncated:boolean,actions:(NaviAction|{target_id:string,removed:true})[]}} NaviDifferentialMap */
/** @typedef {'synthetic'|'native-driver'} AdapterMode */
/** @typedef {{code:string,message:string,candidates?:{target_id:string,name:string,action:string}[]}} AdapterError */
/**
 * @typedef {object} AdapterResult
 * @property {boolean} ok
 * @property {{target_id?:string,action?:string,dispatched:boolean}} [result]
 * @property {AdapterError} [error]
 * @property {AdapterMode} [mode]
 * @property {string} [resolved_from] The handle that was resolved to a target id, when it was not one.
 * @property {string[]} [page_messages] Live-region text the action made the page say, when it said anything new.
 * @property {{available:boolean,reason?:string,before_state_version?:number,target?:{target_id:string,role:string,name:string,state:NaviAction['state']}|null,after?:{state_version:number,reset:boolean,targets:{target_id:string,role:string,name:string,state:NaviAction['state'],suggested_action:string}[],removed:string[],total:number,truncated:boolean}}} [action_trace] Optional pre-action target and post-action action-map changes; DOM evidence only.
 * @property {{mode:string,settled:boolean,elapsed_ms:number,final_url:string,navigated?:boolean,reason?:string}} [settle] Present only when the caller requested settlement.
 */
/**
 * Optional post-action settlement, forwarded from the caller. "mutation_settle"
 * waits for DOM silence (>=100ms with no mutation), "navigation" waits for a URL
 * change or document reload, "target_hidden" waits for the dispatched target to
 * leave the action map or be reported invisible/occluded.
 * @typedef {{timeout_ms?:number,wait_for?:'mutation_settle'|'navigation'|'target_hidden'}} SettleRequest
 * @typedef {{captureChanges?:boolean}} AdapterExecuteOptions
 */
/**
 * Structural subset of a Playwright page used by the adapter.
 * @typedef {object} NaviPageLike
 * @property {() => string} url
 * @property {(fn: any, arg?: any) => Promise<any>} evaluate
 * @property {{click:(x:number,y:number)=>Promise<void>}} mouse
 * @property {{press:(key:string)=>Promise<void>,insertText:(text:string)=>Promise<void>}} keyboard
 */
/**
 * @typedef {object} NaviAdapterOptions
 * @property {string} [protocolVersion] Expected in-page protocol version.
 * @property {boolean} [fallback] Allow native driver fallback (default true).
 * @property {number} [maxFallbackAgeMs] Freshness deadline for fallback discovery (default 2000).
 */

export const NAVI_PROTOCOL_VERSION = '0.3.0';
const ACTIONS = ['click', 'type', 'select'];
const MAX_TEXT = 10000;
/** Bounds on the page feedback attached to a receipt: small enough to be free, large enough to carry a validation reason. */
const MAX_MESSAGES = 4;
const MAX_MESSAGE_CHARS = 200;
/** How many current controls a failed handle names as candidates. */
const MAX_CANDIDATES = 6;

/**
 * Browser-serializable collector for the page's own live-region messages: the
 * places a page tells a reader what just happened (a validation reason, a
 * status line, an error banner). Only rendered, non-empty, non-hidden regions
 * are read, and only their text — no attributes, no markup.
 * @param {{max: number, chars: number}} arg
 * @returns {string[]}
 */
function collectMessages(arg) {
  /** @type {string[]} */
  const found = [];
  const seen = new Set();
  const regions = document.querySelectorAll('[role="alert"],[role="status"],[role="log"],[aria-live]');
  for (const region of regions) {
    if (region.getAttribute('aria-live') === 'off') continue;
    if (region.getAttribute('aria-hidden') === 'true') continue;
    if (!region.getClientRects().length) continue;
    const element = /** @type {HTMLElement} */ (region);
    const raw = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
    if (!raw) continue;
    const text = raw.length > arg.chars ? `${raw.slice(0, arg.chars - 1)}\u2026` : raw;
    if (seen.has(text)) continue;
    seen.add(text);
    found.push(text);
    if (found.length >= arg.max) break;
  }
  return found;
}

/**
 * Which messages are new, counting repeats: what the page is saying now that it
 * was not saying before the action. An unchanged "Ready" status is not news, so
 * it must not be reported as though the action produced it.
 * @param {string[]} before @param {string[]} after
 */
export function addedMessages(before, after) {
  /** @type {Map<string, number>} */
  const remaining = new Map();
  for (const text of before) remaining.set(text, (remaining.get(text) ?? 0) + 1);
  /** @type {string[]} */
  const added = [];
  for (const text of after) {
    const count = remaining.get(text) ?? 0;
    if (count > 0) { remaining.set(text, count - 1); continue; }
    added.push(text);
  }
  return added;
}
export const NAVI_KEYBOARD_KEYS = Object.freeze(['Enter', 'Escape', 'Tab', 'Shift+Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Backspace', 'Delete', 'Space', 'ControlOrMeta+A']);

/** Browser-serializable zero-config collector for pages without the Navi SDK. @param {{limit?: number, viewportOnly?: boolean}} [options] */
function collectTargets(options = {}) {
  const documentRef = document;
  /** @param {string} value */
  const escape = value => CSS.escape(value);
  /** @param {string} selector */
  const unique = selector => { try { return documentRef.querySelectorAll(selector).length === 1; } catch { return false; } };
  /** @param {HTMLElement} element */
  const selectorFor = element => {
  for (const [attribute, scoped] of /** @type {[string, boolean][]} */ ([['data-navi-id', false], ['data-testid', false], ['name', true], ['aria-label', true]])) {
    const value = element.getAttribute(attribute);
    if (!value?.trim()) continue;
    const roleValue = element.getAttribute('role');
    const role = attribute === 'aria-label' && roleValue ? `[role="${roleValue.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]` : '';
    const selector = `${scoped ? element.localName : ''}${role}[${attribute}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
    if (unique(selector)) return selector;
  }
    if (element.id && unique(`#${escape(element.id)}`)) return `#${escape(element.id)}`;
    for (const className of element.classList) {
      if (!className || /[a-f0-9]{8,}/i.test(className) || /^_[A-Za-z0-9_-]{5,}$/.test(className)) continue;
      const selector = `${element.localName}.${escape(className)}`;
      if (unique(selector)) return selector;
    }
    const parent = element.parentElement?.closest('[id]');
    const anchor = parent && unique(`#${escape(parent.id)}`) ? parent : documentRef.body;
    const parts = [];
    for (let node = /** @type {HTMLElement | null} */ (element); node && node !== anchor; node = node.parentElement) {
      const siblings = node.parentElement ? [...node.parentElement.children].filter(child => child.localName === node.localName) : [];
      parts.unshift(`${node.localName}:nth-of-type(${siblings.indexOf(node) + 1})`);
    }
    return `${anchor?.id ? `#${escape(anchor.id)}` : 'body'} > ${parts.join(' > ')}`;
  };
  const nodes = [...documentRef.querySelectorAll('button,input:not([type="hidden"]),textarea,select,a[href],[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="checkbox"],[role="switch"],[role="textbox"],[role="searchbox"],[role="combobox"],[contenteditable="true"]')].filter(element => element instanceof HTMLElement);
  const actions = [];
  const limit = options.limit ?? 5000;
  let truncated = false;
  for (const element of nodes) {
    if (!element.isConnected || element.getClientRects().length === 0) continue;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 || element.closest('[hidden],[inert],[aria-hidden="true"]')) continue;
    const rect = element.getBoundingClientRect();
    const inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
    if (options.viewportOnly !== false && !inViewport) continue;
    if (actions.length >= limit) { truncated = true; break; }
    const id = selectorFor(element);
    const inputType = element instanceof HTMLInputElement ? element.type.toLowerCase() : '';
    const explicitRole = element.getAttribute('role');
    const role = element.matches('a[href],[role="link"]') ? 'link' : explicitRole ||
      (inputType === 'checkbox' || inputType === 'radio' ? inputType :
        ['button', 'submit', 'reset', 'image'].includes(inputType) ? 'button' :
          element.isContentEditable || element.matches('input,textarea') ? 'textbox' : element.localName === 'select' ? 'combobox' : 'button');
    const control = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement ? element : null;
    const label = element.getAttribute('aria-label') || control?.labels?.[0]?.textContent || element.getAttribute('placeholder') || (element.isContentEditable ? '' : element.textContent) || element.getAttribute('name') || element.localName;
    const point = documentRef.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const isVisible = rect.width > 0 && rect.height > 0;
    const isOccluded = isVisible && inViewport && !(point === element || element.contains(point));
    const action = role === 'textbox' || role === 'searchbox' || element.isContentEditable ? 'type' : element instanceof HTMLSelectElement ? 'select' : 'click';
    const optionsForSelect = element instanceof HTMLSelectElement ? [...element.options].filter(option => !option.disabled && !option.closest('optgroup:disabled')).slice(0, 20).map(option => {
      const optionLabel = option.label.trim() || option.textContent?.trim() || option.value;
      return optionLabel === option.value ? optionLabel : `${optionLabel}=${option.value}`;
    }) : undefined;
    actions.push({ target_id: id, role, name: String(label).trim().replace(/\s+/g, ' ').slice(0, 160), action, selector: id,
      disabled: element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true' || element.hasAttribute('readonly'),
      ...(control?.required ? { required: true } : {}), ...(inputType ? { input_type: inputType } : {}), ...(optionsForSelect ? { options: optionsForSelect } : {}),
      state: { is_visible: isVisible, is_enabled: !element.matches(':disabled') && element.getAttribute('aria-disabled') !== 'true' && !element.hasAttribute('readonly'), is_in_viewport: inViewport, is_occluded: isOccluded },
      coordinates: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, suggested_action: action });
  }
  return { version: 'zero-config', state_version: 0, reset: true, truncated, actions };
}

/** Dispatch against a freshly resolved semantic selector on an uninstrumented document. @param {{targetId: string, actionType: string, payload: {text?: string, value?: string}}} arg */
function executeTarget(arg) {
  /** @type {HTMLElement[]} */
  const candidates = [...document.querySelectorAll('button,input:not([type="hidden"]),textarea,select,a[href],[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="checkbox"],[role="switch"],[role="textbox"],[role="searchbox"],[role="combobox"],[contenteditable="true"]')]
    .filter(element => element instanceof HTMLElement);
  /** @type {HTMLElement[]} */
  let matches;
  try {
    matches = [...document.querySelectorAll(arg.targetId)]
      .filter(element => element instanceof HTMLElement)
      .filter(element => candidates.includes(element));
  } catch {
    matches = [];
  }
  if (matches.length !== 1) throw Object.assign(new Error('Missing or ambiguous target'), { code: matches.length ? 'AMBIGUOUS' : 'NOT_FOUND' });
  const element = matches[0];
  const style = getComputedStyle(element);
  if (!element.isConnected || element.getClientRects().length === 0 || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 || element.closest('[hidden],[inert],[aria-hidden="true"]')) throw Object.assign(new Error('Target is unavailable'), { code: 'UNAVAILABLE' });
  if (element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true' || !element.isConnected) throw Object.assign(new Error('Target is disabled or detached'), { code: 'UNAVAILABLE' });
  if (arg.actionType === 'type' && element instanceof HTMLInputElement && !['button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'file', 'hidden'].includes(element.type.toLowerCase())) {
    element.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, arg.payload.text ?? '');
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (arg.actionType === 'type' && element instanceof HTMLTextAreaElement) {
    element.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(element, arg.payload.text ?? '');
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (arg.actionType === 'click') element.click();
  else if (arg.actionType === 'select' && element instanceof HTMLSelectElement) {
    const option = [...element.options].find(candidate => candidate.value === arg.payload.value && !candidate.disabled && !candidate.closest('optgroup:disabled'));
    if (!option) throw Object.assign(new Error('No enabled select option has that value'), { code: 'INVALID_ACTION' });
    element.focus();
    element.value = arg.payload.value ?? '';
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (arg.actionType === 'type' && element.isContentEditable) {
    element.focus();
    element.textContent = arg.payload.text ?? '';
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: arg.payload.text ?? '' }));
  } else throw Object.assign(new Error('Action does not match target'), { code: 'INVALID_ACTION' });
  return { target_id: arg.targetId, action: arg.actionType, dispatched: true };
}

/**
 * Tool adapter that turns a Navi action dictionary into executable browser commands.
 * Every method re-validates the page origin, so an unexpected navigation fails closed.
 */
export class NaviPlaywrightAdapter {
  /** @param {NaviPageLike} page @param {NaviAdapterOptions} [options] */
  constructor(page, options = {}) {
    if (!page || typeof page.evaluate !== 'function' || typeof page.url !== 'function') {
      throw new TypeError('NaviPlaywrightAdapter requires a Playwright page object');
    }
    this.page = page;
    this.protocolVersion = options.protocolVersion || NAVI_PROTOCOL_VERSION;
    this.fallback = options.fallback !== false;
    this.maxFallbackAgeMs = Number.isFinite(options.maxFallbackAgeMs) ? Number(options.maxFallbackAgeMs) : 2000;
    this.origin = new URL(page.url()).origin;
    /** @type {boolean} */
    this.busy = false;
  }

  checkOrigin() {
    if (new URL(this.page.url()).origin !== this.origin) {
      throw new Error('Adapter origin changed; reauthorize before continuing');
    }
  }

  /** @overload @param {{viewportOnly?: boolean, limit?: number, since_version: number}} options @returns {Promise<NaviDifferentialMap>} */
  /** @overload @param {{viewportOnly?: boolean, limit?: number}} [options] @returns {Promise<NaviActionMap>} */
  /** @param {{viewportOnly?: boolean, limit?: number, since_version?: number}} [options] @returns {Promise<NaviActionMap | NaviDifferentialMap>} */
  async discover(options = {}) {
    this.checkOrigin();
    const expected = this.protocolVersion;
    const snapshot = await this.page.evaluate(async (/** @type {{expected:string,viewportOnly?:boolean,limit?:number,since_version?:number}} */ arg) => {
      const navi = /** @type {any} */ (globalThis).Navi;
      if (!navi) return undefined;
      if (navi.version !== arg.expected) throw new Error(`Unsupported Navi protocol ${navi.version}; expected ${arg.expected}`);
      return navi.actions({ limit: arg.limit ?? 5000, coordinateSpace: 'top', viewportOnly: arg.viewportOnly, since_version: arg.since_version });
    }, { expected, viewportOnly: options.viewportOnly, limit: options.limit, since_version: options.since_version });
    const resolved = snapshot ?? await this.page.evaluate(collectTargets, { viewportOnly: options.viewportOnly, limit: options.limit });
    if (!resolved || typeof resolved !== 'object') throw new Error('Action map unavailable');
    if (resolved.truncated) throw new Error('Incomplete action map; raise the limit or narrow the page');
    return /** @type {NaviActionMap} */ (resolved);
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
      return Array.isArray(messages) ? messages.filter(message => typeof message === 'string') : [];
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
    if (this.busy) throw Object.assign(new Error('Adapter execution in flight'), { code: 'BUSY' });
    if (typeof targetId !== 'string' || !targetId || targetId.length > 512) {
      throw Object.assign(new Error('target_id must be a non-empty string of at most 512 characters'), { code: 'INVALID_PAYLOAD' });
    }
    this.busy = true;
    try {
      const before = await this.discover({ viewportOnly: false, limit: 5000 });
      const matches = before.actions.filter(action => action.target_id === targetId);
      if (matches.length !== 1) {
        throw Object.assign(new Error('Missing or ambiguous scroll target'), { code: matches.length ? 'AMBIGUOUS' : 'NOT_FOUND' });
      }
      const found = await this.page.evaluate(async (/** @type {{targetId:string,zeroConfig:boolean}} */ arg) => {
        const selector = arg.zeroConfig ? arg.targetId : `[data-agent-target="${CSS.escape(arg.targetId)}"]`;
        const elements = document.querySelectorAll(selector);
        if (elements.length !== 1) return false;
        elements[0].scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        return true;
      }, { targetId, zeroConfig: before.version === 'zero-config' });
      if (!found) {
        throw Object.assign(new Error('Target is not uniquely reachable from the top document; scroll its containing frame or element instead'), { code: 'SCROLL_TARGET_UNREACHABLE' });
      }
      const after = await this.discover({ viewportOnly: false, limit: 5000 });
      const visible = after.actions.filter(action => action.target_id === targetId);
      if (visible.length !== 1 || !visible[0].state.is_in_viewport) {
        throw Object.assign(new Error('Target is still not in the viewport after scrolling'), { code: 'SCROLL_INCOMPLETE' });
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
    if (this.busy) throw Object.assign(new Error('Adapter execution in flight'), { code: 'BUSY' });
    if (!NAVI_KEYBOARD_KEYS.includes(key)) throw Object.assign(new Error('Unsupported keyboard key'), { code: 'INVALID_KEY' });
    if (targetId !== undefined && (typeof targetId !== 'string' || !targetId || targetId.length > 512)) {
      throw Object.assign(new Error('target_id must be a non-empty string of at most 512 characters'), { code: 'INVALID_PAYLOAD' });
    }
    if (!this.fallback) throw Object.assign(new Error('Native keyboard input is disabled by --no-fallback'), { code: 'FALLBACK_DISABLED' });
    this.busy = true;
    try {
      if (targetId !== undefined) {
        const map = await this.discover({ viewportOnly: false, limit: 5000 });
        const matches = map.actions.filter(action => action.target_id === targetId);
        if (matches.length !== 1) throw Object.assign(new Error('Missing or ambiguous keyboard target'), { code: matches.length ? 'AMBIGUOUS' : 'NOT_FOUND' });
        const state = matches[0].state;
        if (!state.is_visible || !state.is_enabled || !state.is_in_viewport || state.is_occluded) {
          throw Object.assign(new Error('Keyboard target is not actionable'), { code: 'UNAVAILABLE' });
        }
        const focused = await this.page.evaluate((/** @type {{targetId:string,zeroConfig:boolean}} */ arg) => {
          const selector = arg.zeroConfig ? arg.targetId : `[data-agent-target="${CSS.escape(arg.targetId)}"]`;
          return document.activeElement?.matches(selector) === true;
        }, { targetId, zeroConfig: map.version === 'zero-config' });
        if (!focused) throw Object.assign(new Error('Expected target is not the focused top-document control'), { code: 'KEY_TARGET_NOT_FOCUSED' });
      }
      try { await this.page.keyboard.press(key); }
      catch (error) {
        throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), { code: 'KEYBOARD_FAILED', may_have_applied: true });
      }
      return { pressed: true, key, mode: 'native-driver' };
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
    if (this.busy) return { ok: false, error: { code: 'BUSY', message: 'Adapter execution in flight' } };
    if (!targetId || typeof targetId !== 'string' || targetId.length > 512 || !ACTIONS.includes(actionType) ||
      !payload || typeof payload !== 'object' ||
      Object.keys(payload).some(key => key !== (actionType === 'type' ? 'text' : actionType === 'select' ? 'value' : '')) ||
      (actionType === 'type' && (typeof payload.text !== 'string' || payload.text.length > MAX_TEXT))) {
      return { ok: false, error: { code: 'INVALID_PAYLOAD', message: 'Invalid adapter command' } };
    }
    if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some(key => key !== 'captureChanges') ||
      (options.captureChanges !== undefined && typeof options.captureChanges !== 'boolean')) {
      return { ok: false, error: { code: 'INVALID_PAYLOAD', message: 'Invalid adapter execution options' } };
    }
    let plan = null;
    if (settle !== undefined) {
      const normalized = normalizeSettle(settle);
      if ('error' in normalized) return { ok: false, error: { code: 'INVALID_SETTLE', message: normalized.error } };
      plan = normalized.plan;
    }
    this.busy = true;
    try {
      // Capture is opt-in because a full pre-action map adds work to every call.
      // Failure to collect optional evidence must never block the requested action.
      /** @type {NaviActionMap | null} */
      let beforeMap = null;
      if (options.captureChanges) {
        try { beforeMap = /** @type {NaviActionMap} */ (await this.discover({ viewportOnly: false, limit: 5000 })); }
        catch { /* execute without optional trace evidence */ }
      }
      // Read before arming, so a message the action itself produces is new rather
      // than part of the baseline.
      const before = await this.pageMessages();
      // Arming happens before the dispatch so a mutation made *during* the click
      // is observed, and so a reload that keeps the same URL is distinguishable.
      const prepared = plan ? await prepareSettle(this.page, plan) : null;
      const dispatchedAt = Date.now();
      const outcome = await this.#dispatch(targetId, actionType, payload, plan, prepared, dispatchedAt);
      // Read after settlement, from whichever document is there now: a replaced
      // document is read, not reported as absent.
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
    if (!outcome.ok || outcome.result?.dispatched !== true) return { available: false, reason: 'action_not_dispatched' };
    if (!before) return { available: false, reason: 'pre_action_map_unavailable' };
    try {
      const after = /** @type {NaviActionMap | NaviDifferentialMap} */ (await this.discover({
        viewportOnly: false, limit: 5000, since_version: before.state_version
      }));
      const targetId = outcome.result?.target_id ?? requestedTarget;
      const target = before.actions.find(action => action.target_id === targetId);
      const actions = after.actions;
      const changes = actions.slice(0, 12);
      /** @type {{target_id:string,role:string,name:string,state:NaviAction['state'],suggested_action:string}[]} */
      const targets = [];
      for (const action of changes) {
        if ('removed' in action) continue;
        targets.push({
          target_id: action.target_id,
          role: action.role,
          name: action.name,
          state: action.state,
          suggested_action: action.suggested_action
        });
      }
      const removed = changes.filter(action => 'removed' in action).map(action => action.target_id);
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
      return { available: false, reason: 'post_action_map_unavailable' };
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
    /** @type {string | undefined} */
    let resolvedFrom;
    /** @param {string} handle */
    const send = async handle => {
      // Transport exceptions deliberately propagate: the action may already have happened.
      const expected = this.protocolVersion;
      try {
        const response = await this.page.evaluate(async (/** @type {{targetId:string,actionType:string,payload:object,expected:string}} */ arg) => {
          const navi = /** @type {any} */ (globalThis).Navi;
          if (!navi) return undefined;
          if (navi.version !== arg.expected) throw new Error(`Unsupported Navi protocol ${navi.version}; expected ${arg.expected}`);
          try {
            return { ok: true, result: await navi.execute(arg.targetId, arg.actionType, arg.payload) };
          } catch (error) {
            const failure = /** @type {Error & {code?: string, reason?: string, dispatched?: boolean}} */ (error);
            return { ok: false, error: { code: failure.code || 'EXECUTION_ERROR', message: failure.message,
              reason: failure.reason, dispatched: failure.dispatched } };
          }
        }, { targetId: handle, actionType, payload, expected });
        if (response === undefined) {
          const result = await this.page.evaluate(executeTarget, { targetId: handle, actionType, payload });
          return { ok: true, result };
        }
        return response;
      } catch (error) {
        // A navigating action can take the execution context down before the
        // in-page settle returns. For the modes whose condition a navigation is,
        // that navigation is the receipt: `navigation` was waiting for exactly it,
        // and `mutation_settle` was observing a document the navigation replaced.
        // Surfacing the transport error instead would tell an agent to retry a
        // click that already applied. `target_hidden` observes live Navi state that
        // a destroyed context cannot answer for, so it still rethrows.
        if (!plan || !prepared) throw error;
        const receipt = await completeSettle(this.page, plan, handle, prepared);
        if (!receipt.settled) throw error;
        return { replacedDocument: receipt };
      }
    };
    /** @param {any} outcome */
    const attributed = outcome => resolvedFrom && outcome.ok === true ? { ...outcome, resolved_from: resolvedFrom } : outcome;
    /** @param {any} receipt */
    const settledInPage = receipt => attributed({
      ok: true,
      result: { target_id: id, action: actionType, dispatched: true },
      mode: 'synthetic',
      settle: { mode: plan ? plan.waitFor : 'mutation_settle', settled: true, elapsed_ms: Date.now() - dispatchedAt, final_url: this.page.url(),
        ...(receipt.navigated !== undefined ? { navigated: receipt.navigated } : {}),
        ...(receipt.reason ? { reason: receipt.reason } : {}) }
    });

    let response = await send(id);
    if (response.replacedDocument) return settledInPage(response.replacedDocument);
    const unhandled = response.ok === false && response.error?.code === 'NOT_FOUND' && response.error.dispatched !== true;
    if (unhandled) {
      // Resolution is a courtesy on a refusal that already happened, so a page it
      // cannot read (an unreadable map, a document that went away) must leave the
      // original refusal intact rather than replace it with a new failure.
      const resolution = await this.#byName(id, actionType).catch(() => null);
      if (!resolution) return { ok: false, error: response.error };
      if (!('targetId' in resolution)) {
        return { ok: false, error: { code: 'NOT_FOUND', message: resolution.message, candidates: resolution.candidates } };
      }
      resolvedFrom = id;
      id = resolution.targetId;
      response = await send(id);
      if (response.replacedDocument) return settledInPage(response.replacedDocument);
    }
    const returned = /** @type {{success?:boolean,reason?:string,dispatched?:boolean} | undefined} */ (response.result);
    const needsTrusted = returned?.success === false && returned.reason === 'untrusted_gesture_required' && returned.dispatched !== true;
    const dispatchFailed = response.error?.reason === 'dispatch_failed' && response.error.dispatched === false;
    const safeReturnedFailure = returned?.success === false && returned.reason === 'dispatch_failed' && returned.dispatched === false;
    if (!needsTrusted && !dispatchFailed && !safeReturnedFailure) {
      // An in-page failure that is not a certified pre-dispatch refusal is terminal:
      // it may already have applied, so it is reported and never retried.
      if (response.ok === false) return { ok: false, error: response.error };
      if (returned?.success === false) {
        return { ok: false, error: { code: 'EXECUTION_FAILED', message: returned.reason || 'Host reported failure' } };
      }
      return attributed(await this.#withSettle({ ok: true, result: response.result, mode: 'synthetic' }, plan, prepared, dispatchedAt, id));
    }
    if (!this.fallback) return { ok: false, error: { code: 'FALLBACK_DISABLED', message: 'Target requires trusted input and fallback is disabled' } };
    if (actionType !== 'click' && actionType !== 'type') {
      return { ok: false, error: { code: 'FALLBACK_UNSUPPORTED', message: 'Trusted fallback supports click and type only' } };
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
    const map = /** @type {NaviActionMap} */ (await this.discover({ viewportOnly: false, limit: 5000 }));
    /** @param {string} value */
    const normalize = value => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const wanted = normalize(handle);
    // Off-screen controls are kept: a match this code rejects as unusable is one
    // the caller can scroll to, while a match it hides is one it cannot find.
    const actionable = map.actions.filter(action => action.state.is_visible && action.state.is_enabled && !action.state.is_occluded);
    const typed = actionType === 'click' ? actionable : actionable.filter(action => action.suggested_action === actionType);
    const matched = typed.filter(action => normalize(action.name) === wanted || normalize(action.target_id) === wanted);
    if (matched.length === 1) return { targetId: matched[0].target_id };
    const tokens = new Set(wanted.split(' ').filter(Boolean));
    const candidates = actionable
      .map(action => ({ action, score: normalize(`${action.name} ${action.target_id}`).split(' ').filter(word => tokens.has(word)).length }))
      .sort((left, right) => right.score - left.score)
      .slice(0, MAX_CANDIDATES)
      .map(entry => ({ target_id: entry.action.target_id, name: entry.action.name, action: entry.action.suggested_action }));
    return {
      message: matched.length > 1
        ? `${matched.length} controls are named ${JSON.stringify(handle)}; use one of their target_ids instead.`
        : `No control is named ${JSON.stringify(handle)}. candidates lists the nearest current controls; act on one of their target_ids instead of repeating this handle.`,
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
        ...(receipt.navigated !== undefined ? { navigated: receipt.navigated } : {}),
        ...(receipt.reason ? { reason: receipt.reason } : {})
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
      return { ok: false, error: { code: 'STALE_COORDINATES', message: 'Fallback discovery exceeded its freshness deadline' } };
    }
    const matches = snapshot.actions.filter(action => action.target_id === targetId);
    if (matches.length !== 1) return { ok: false, error: { code: 'TARGET_UNAVAILABLE', message: 'Missing or ambiguous fallback target' } };
    const action = matches[0], state = action.state, box = action.coordinates;
    if (!state || !box || !state.is_visible || !state.is_enabled || !state.is_in_viewport || state.is_occluded ||
      ![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0) {
      return { ok: false, error: { code: 'TARGET_UNAVAILABLE', message: 'Fallback target is not actionable' } };
    }
    if (actionType === 'type' && action.suggested_action !== 'type') {
      return { ok: false, error: { code: 'TARGET_UNAVAILABLE', message: 'Fallback type requires a text control' } };
    }
    const viewport = await this.page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    if (!(x >= 0 && y >= 0 && x < viewport.width && y < viewport.height)) {
      return { ok: false, error: { code: 'TARGET_UNAVAILABLE', message: 'Fallback point is outside the viewport' } };
    }
    this.checkOrigin();
    await this.page.mouse.click(x, y);
    if (actionType === 'type') {
      await this.page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
      if (payload.text) await this.page.keyboard.insertText(payload.text);
      else await this.page.keyboard.press('Backspace');
      await this.page.keyboard.press('Tab');
    }
    // Bounded settle: this waits for Navi's index, not for business effects.
    await this.page.evaluate(async () => {
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      await /** @type {any} */ (globalThis).Navi?.ready();
    });
    return { ok: true, result: { target_id: targetId, action: actionType, dispatched: true }, mode: 'native-driver' };
  }
}

/**
 * Factory form of {@link NaviPlaywrightAdapter} for functional call sites.
 * @param {NaviPageLike} page @param {NaviAdapterOptions} [options]
 */
export function naviAdapter(page, options) {
  return new NaviPlaywrightAdapter(page, options);
}
