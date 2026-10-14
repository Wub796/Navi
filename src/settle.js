// Deterministic post-action settlement for the adapter.
//
// The in-page `execute()` already waits for Navi's *index* to quiesce (two
// frames plus `ready()`), which is everything the SDK can promise about itself:
// it observes the page for indexing, not for the business effects an action
// triggers. A click that opens a modal, swaps a route or removes its own control
// has not finished when the handler returns, so an agent that reads the action
// map straight afterwards can still see the pre-effect page.
//
// This module adds the three waits a caller can opt into. They run from the
// driver against the page, so the shipped browser bundle gains no bytes:
//
//   mutation_settle  the document (and its open shadow roots and same-origin
//                    frames) records no DOM mutation for a quiet window. An
//                    action that replaces the document outright, a full-page
//                    navigation, settles it too: the observers go down with the
//                    document they were watching, so the wait reports the
//                    replacement rather than an unsettled timeout;
//   navigation       the top-level URL changed, or the document reloaded;
//   target_hidden    the dispatched target left the action map, or Navi now
//                    reports it as invisible or occluded (a dismissed modal).
//
// A settle is a *receipt*, never a guess: `settled: false` with a reason is a
// first-class result, and the action itself is never retried or re-reported as
// failed because settlement did not hold.

import { randomUUID } from 'node:crypto';

/** Wait conditions a caller may request. */
export const SETTLE_MODES = /** @type {const} */ (['mutation_settle', 'navigation', 'target_hidden']);
/** Deadline applied when `timeout_ms` is omitted. */
export const DEFAULT_SETTLE_TIMEOUT_MS = 3000;
/** Hard upper bound for `timeout_ms`; a settle wait is a receipt, not a job. */
export const MAX_SETTLE_TIMEOUT_MS = 30000;
/** Published DOM-silence window: no mutations for at least this long. */
export const MUTATION_QUIET_MS = 100;
/** How often `target_hidden` re-reads the Navi action map. */
const TARGET_POLL_MS = 50;
/** How often the navigation wait re-checks the URL and the document marker. */
const NAVIGATION_POLL_MS = 50;

/** @typedef {'mutation_settle'|'navigation'|'target_hidden'} SettleMode */
/** @typedef {{waitFor: SettleMode, timeoutMs: number, quietMs: number}} SettlePlan */
/** @typedef {{token: string | null, beforeUrl: string | null, armed: boolean}} SettlePreparation */
/** @typedef {{settled: boolean, elapsedMs: number, reason?: string}} SettleOutcome */

/**
 * Structural subset of a Playwright page used by the settle waits. Typed
 * separately from the adapter's page type so this module stays environment-
 * agnostic and cannot reach into adapter internals.
 * @typedef {object} SettlePageLike
 * @property {() => string} url
 * @property {(fn: any, arg?: any) => Promise<any>} evaluate
 * @property {((state: string) => Promise<unknown>) | undefined} [waitForLoadState]
 */

/**
 * Validate an optional `settle` request into a plan. Unknown keys are refused
 * rather than ignored, so a typo cannot silently disable the wait a caller
 * believes they configured.
 * @param {unknown} input
 * @returns {{plan: SettlePlan} | {error: string}}
 */
export function normalizeSettle(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'settle must be an object with optional timeout_ms and wait_for.' };
  }
  const record = /** @type {Record<string, unknown>} */ (input);
  const unknown = Object.keys(record).filter(key => key !== 'timeout_ms' && key !== 'wait_for');
  if (unknown.length) return { error: `Unknown settle key(s) ${unknown.join(', ')}; expected timeout_ms and wait_for.` };
  const waitFor = record.wait_for ?? 'mutation_settle';
  if (typeof waitFor !== 'string' || !SETTLE_MODES.includes(/** @type {SettleMode} */ (waitFor))) {
    return { error: `wait_for must be one of ${SETTLE_MODES.join(', ')}; got ${JSON.stringify(waitFor)}.` };
  }
  const timeoutMs = record.timeout_ms ?? DEFAULT_SETTLE_TIMEOUT_MS;
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_SETTLE_TIMEOUT_MS) {
    return { error: `timeout_ms must be an integer between 1 and ${MAX_SETTLE_TIMEOUT_MS}.` };
  }
  return { plan: { waitFor: /** @type {SettleMode} */ (waitFor), timeoutMs, quietMs: MUTATION_QUIET_MS } };
}

/**
 * Arm a wait *before* the action is dispatched, so mutations that happen during
 * the dispatch are observed rather than missed, and a same-URL reload can be
 * told apart from "nothing happened".
 * @param {SettlePageLike} page
 * @param {SettlePlan} plan
 * @returns {Promise<SettlePreparation>}
 */
export async function prepareSettle(page, plan) {
  if (plan.waitFor === 'navigation') {
    const token = randomUUID();
    try {
      await page.evaluate(/** @param {string} value */ value => {
        /** @type {any} */ (globalThis).__naviSettleToken = value;
      }, token);
    } catch {
      // A context that cannot be written to cannot be observed either.
      return { token: null, beforeUrl: null, armed: false };
    }
    return { token, beforeUrl: page.url(), armed: true };
  }
  if (plan.waitFor === 'mutation_settle') {
    // The same document marker the navigation wait uses: if the observers die with
    // the document, this tells the replacement apart from "nothing happened" even
    // when the new document keeps the same URL.
    const token = randomUUID();
    try {
      await page.evaluate(/** @param {{quietMs: number, token: string}} arg */ arg => {
        const scope = /** @type {any} */ (globalThis);
        if (scope.__naviSettle) {
          for (const observer of scope.__naviSettle.observers) observer.disconnect();
        }
        /** @type {MutationObserver[]} */
        const observers = [];
        const state = { last: performance.now(), quietMs: arg.quietMs, observers };
        /** @param {Node} node */
        const watch = node => {
          const observer = new MutationObserver(() => { state.last = performance.now(); });
          observer.observe(node, { subtree: true, childList: true, attributes: true, characterData: true });
          observers.push(observer);
        };
        const seen = new Set();
        /** @param {Document | ShadowRoot} root */
        const walk = root => {
          watch(root);
          for (const element of root.querySelectorAll('*')) {
            if (element.shadowRoot && !seen.has(element.shadowRoot)) {
              seen.add(element.shadowRoot);
              walk(element.shadowRoot);
            }
          }
          for (const frame of root.querySelectorAll('iframe')) {
            let doc = null;
            try { doc = /** @type {HTMLIFrameElement} */ (frame).contentDocument; } catch { doc = null; }
            if (doc && !seen.has(doc)) { seen.add(doc); walk(doc); }
          }
        };
        walk(document);
        scope.__naviSettle = state;
        scope.__naviSettleToken = arg.token;
      }, { quietMs: plan.quietMs, token });
    } catch {
      return { token: null, beforeUrl: null, armed: false };
    }
    return { token, beforeUrl: page.url(), armed: true };
  }
  // target_hidden needs no setup: it reads live Navi state after the dispatch.
  return { token: null, beforeUrl: null, armed: true };
}

/**
 * Did the document this wait was armed on get replaced while the wait was running?
 *
 * A destroyed execution context is the only way a `mutation_settle` can fail once the
 * action has committed: the observers went down with the document they were watching.
 * That is evidence of the effect rather than of a broken wait, but it is only evidence,
 * so this asks the page instead of assuming. Only positive evidence settles it - a URL
 * that changed, or a document that no longer carries the marker the wait was armed with -
 * and the poll runs until that evidence appears or the budget is spent. A marker that is
 * still there, or a document that cannot be asked yet, is a replacement that has not
 * landed, which is exactly what the rest of the deadline is for. Nothing observable
 * replaced means false, so a context that dies for some other reason stays a reported
 * failure rather than being settled by a blanket rule.
 * @param {SettlePageLike} page
 * @param {SettlePreparation} prepared
 * @param {number} budgetMs
 * @returns {Promise<boolean>}
 */
async function documentReplaced(page, prepared, budgetMs) {
  const deadline = Date.now() + Math.max(0, budgetMs);
  try {
    // A navigation that has not committed yet is not a failed wait: give the load the
    // replacement is still in time to become the document this asks.
    await page.waitForLoadState?.('domcontentloaded');
  } catch { /* a page that will not answer is polled below */ }
  for (;;) {
    if (prepared.beforeUrl !== null && page.url() !== prepared.beforeUrl) return true;
    let token = null;
    let readable = false;
    try {
      token = await page.evaluate(() => /** @type {any} */ (globalThis).__naviSettleToken);
      readable = true;
    } catch { readable = false; }
    if (readable && token !== prepared.token) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, NAVIGATION_POLL_MS));
  }
}

/**
 * Wait for the plan's condition, then always clean up the page-side handle so a
 * later call cannot inherit a stale observer or token.
 * @param {SettlePageLike} page
 * @param {SettlePlan} plan
 * @param {string} targetId
 * @param {SettlePreparation} prepared
 * @returns {Promise<SettleOutcome>}
 */
export async function completeSettle(page, plan, targetId, prepared) {
  try {
    if (plan.waitFor === 'navigation') {
      if (!prepared.armed || !prepared.token) return { settled: false, elapsedMs: 0, reason: 'arm_failed' };
      if (page.url() !== prepared.beforeUrl) return { settled: true, elapsedMs: 0 };
      const started = Date.now();
      // Polled from the driver rather than through the page, because the page is
      // exactly what a navigation takes away: `waitForFunction` rejects with
      // "execution context was destroyed" at the moment the wait should succeed.
      while (Date.now() - started < plan.timeoutMs) {
        await new Promise(resolve => setTimeout(resolve, NAVIGATION_POLL_MS));
        if (page.url() !== prepared.beforeUrl) return { settled: true, elapsedMs: Date.now() - started };
        try {
          const token = await page.evaluate(() => /** @type {any} */ (globalThis).__naviSettleToken);
          // A reload of the same URL brings a fresh document, so the marker is gone.
          if (token !== prepared.token) return { settled: true, elapsedMs: Date.now() - started };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // A destroyed context can precede commit: page.url() may still be the
          // old URL. Keep polling until an observed URL/document change proves
          // navigation, rather than returning a premature final_url receipt.
          if (/execution context was destroyed|navigat/i.test(message)) continue;
          return { settled: false, elapsedMs: Date.now() - started, reason: 'settle_failed' };
        }
      }
      return { settled: false, elapsedMs: Date.now() - started, reason: 'timeout' };
    }

    if (plan.waitFor === 'mutation_settle') {
      if (!prepared.armed) return { settled: false, elapsedMs: 0, reason: 'arm_failed' };
      const started = Date.now();
      /** @type {SettleOutcome} */
      let failed;
      try {
        const outcome = /** @type {SettleOutcome} */ (await page.evaluate(async (/** @type {{timeoutMs: number}} */ arg) => {
          const scope = /** @type {any} */ (globalThis);
          const state = scope.__naviSettle;
          if (!state) return { settled: false, elapsedMs: 0, reason: 'not_armed' };
          const start = performance.now();
          const deadline = start + arg.timeoutMs;
          try {
            for (;;) {
              const now = performance.now();
              if (now - state.last >= state.quietMs) return { settled: true, elapsedMs: now - start };
              if (now >= deadline) return { settled: false, elapsedMs: now - start, reason: 'timeout' };
              await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - now))));
            }
          } finally {
            for (const observer of state.observers) observer.disconnect();
            delete scope.__naviSettle;
          }
        }, { timeoutMs: plan.timeoutMs }));
        // The wait can land on a document that is not the one it was armed on: when the
        // dispatch navigated, the observers are absent from whatever document answers, and
        // the page reports that as a settled:false `not_armed`. That is the same
        // replacement a destroyed context reports, so it is reconciled below rather than
        // returned as an unsettled wait the caller cannot act on.
        if (outcome.settled || outcome.reason !== 'not_armed') return outcome;
        failed = outcome;
      } catch (error) {
        // A context that died mid-wait reports the same replacement less politely: the
        // observers went down with the document they were armed on.
        failed = { settled: false, elapsedMs: 0, reason: `settle_failed: ${error instanceof Error ? error.message : String(error)}` };
      }
      const elapsedMs = Date.now() - started;
      // Either way, the wait is settled only by a replacement it can actually observe.
      if (await documentReplaced(page, prepared, plan.timeoutMs - elapsedMs)) {
        return { settled: true, elapsedMs, reason: 'document_replaced' };
      }
      return { ...failed, elapsedMs };
    }

    const outcome = /** @type {SettleOutcome} */ (await page.evaluate(async (/** @type {{targetId: string, timeoutMs: number, pollMs: number}} */ arg) => {
      const navi = /** @type {any} */ (globalThis).Navi;
      if (!navi) return { settled: false, elapsedMs: 0, reason: 'no_sdk' };
      const start = performance.now();
      const deadline = start + arg.timeoutMs;
      for (;;) {
        const map = await navi.actions({ limit: 5000, coordinateSpace: 'top' });
        const matches = map.actions.filter((/** @type {{target_id: string}} */ action) => action.target_id === arg.targetId);
        const action = matches.length === 1 ? matches[0] : null;
        // An absent target only means "hidden" when the map was complete; a
        // truncated map cannot prove absence.
        const hidden = action ? (!action.state.is_visible || action.state.is_occluded) : !map.truncated;
        if (hidden) return { settled: true, elapsedMs: performance.now() - start };
        if (performance.now() >= deadline) return { settled: false, elapsedMs: performance.now() - start, reason: 'timeout' };
        await new Promise(resolve => setTimeout(resolve, arg.pollMs));
      }
    }, { targetId, timeoutMs: plan.timeoutMs, pollMs: TARGET_POLL_MS }));
    return outcome;
  } catch (error) {
    // Settlement must never turn a dispatched action into a failure report.
    return { settled: false, elapsedMs: 0, reason: `settle_failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
