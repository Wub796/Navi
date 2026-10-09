import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

/**
 * Defensive prototype isolation.
 *
 * The threat model is a host application script that replaces, wraps, nulls or
 * freezes the DOM primitives Navi depends on *after* the SDK has loaded. Every
 * assertion below fails if the SDK resolves those primitives at call time
 * instead of using the references it pinned during initialization.
 */
const FIXTURE = `
  <main>
    <button data-agent-target="tamper-click">Run</button>
    <input data-agent-target="tamper-type" aria-label="Field">
    <div id="late"></div>
  </main>`;

/** Install the shipped bundle through the driver, which is CSP-independent. @param {import('@playwright/test').Page} page */
async function install(page) {
  await page.evaluate(await readFile('dist/navi.min.js', 'utf8'));
  await page.evaluate(async () => { await window.Navi?.ready(); });
}

/** @param {import('@playwright/test').Page} page @returns {Promise<import('../types/index.js').NaviActionMap>} */
const readMap = page => page.evaluate(async () => {
  const navi = /** @type {import('../types/index.js').NaviAPI} */ (window.Navi);
  return navi.actions({ limit: 50 });
});

test('discovery and execution survive a host that tampers with prototypes after load', async ({ page }) => {
  /** @type {string[]} */
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error)));
  await page.setContent(FIXTURE);
  await page.evaluate(() => {
    const state = /** @type {any} */ (window);
    state.__clicks = 0;
    document.querySelector('[data-agent-target="tamper-click"]')?.addEventListener('click', () => { state.__clicks++; });
  });
  await install(page);

  // Untampered baseline, so a later failure cannot be blamed on the fixture.
  const before = (await readMap(page)).actions.find(action => action.target_id === 'tamper-click');
  expect(before?.coordinates.width).toBeGreaterThan(0);

  await page.evaluate(() => {
    const state = /** @type {any} */ (window);
    // 1. Geometry lies: every box collapses to zero.
    Element.prototype.getBoundingClientRect = function () {
      state.__poisonedRectCalls = (state.__poisonedRectCalls || 0) + 1;
      return /** @type {any} */ ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 });
    };
    // 2. Style lies: everything claims to be hidden, transparent and transformed.
    state.getComputedStyle = () => ({ display: 'none', visibility: 'hidden', opacity: '0', transform: 'matrix(1,0,0,1,40,40)' });
    // 3. Observers and schedulers are replaced with throwing stubs.
    state.MutationObserver = function () { throw new Error('MutationObserver tampered'); };
    state.IntersectionObserver = function () { throw new Error('IntersectionObserver tampered'); };
    state.requestAnimationFrame = () => { throw new Error('requestAnimationFrame tampered'); };
    state.requestIdleCallback = () => { throw new Error('requestIdleCallback tampered'); };
    state.queueMicrotask = () => { throw new Error('queueMicrotask tampered'); };
    // 4. The prototype itself is locked against further writes.
    Object.freeze(Element.prototype);
  });

  const after = (await readMap(page)).actions.find(action => action.target_id === 'tamper-click');
  expect(after?.coordinates.width, 'pinned getBoundingClientRect must win over the poisoned one').toBe(before?.coordinates.width);
  expect(after?.state.is_visible).toBe(true);
  expect(after?.state.is_occluded, 'pinned getComputedStyle must win over the poisoned one').toBe(false);

  const clicked = await page.evaluate(async () => {
    const navi = /** @type {import('../types/index.js').NaviAPI} */ (window.Navi);
    return navi.execute('tamper-click', 'click');
  });
  expect(clicked.dispatched).toBe(true);
  expect(await page.evaluate(() => /** @type {any} */ (window).__clicks)).toBe(1);

  // Schedulers are pinned, so further work still drains after the tamper.
  await page.evaluate(async () => {
    const button = document.createElement('button');
    button.textContent = 'Late';
    button.setAttribute('data-agent-target', 'tamper-late');
    document.querySelector('main')?.append(button);
    await window.Navi?.ready();
  });
  const late = (await readMap(page)).actions.map(action => action.target_id);
  expect(late, 'mutations are still indexed through the pinned observer and schedulers').toContain('tamper-late');

  expect(pageErrors).toEqual([]);
  expect(await page.evaluate(() => /** @type {any} */ (window).__poisonedRectCalls ?? 0)).toBe(0);
});

test('a frozen prototype in a late frame cannot break capture or initialization', async ({ page }) => {
  /** @type {string[]} */
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error)));
  await page.setContent(FIXTURE);
  await install(page);

  // A frame whose Element.prototype is locked before Navi can hook it: the hook
  // assignment throws inside hook(), and the SDK must carry on rather than
  // tearing down the document it was observing.
  await page.evaluate(async () => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const realm = /** @type {any} */ (frame.contentWindow);
    Object.freeze(realm.Element.prototype);
    const doc = /** @type {Document} */ (frame.contentDocument);
    doc.body.innerHTML = '<button data-agent-target="frame-late" role="button">Late frame</button>';
    await window.Navi?.ready();
  });

  const map = await readMap(page);
  expect(map.actions.map(action => action.target_id), 'the frame document is still observed and indexed').toContain('frame-late');
  expect(pageErrors).toEqual([]);

  const state = map.actions.find(action => action.target_id === 'frame-late');
  expect(state?.state.is_visible).toBe(true);
});
