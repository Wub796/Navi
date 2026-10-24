import { test, expect } from '@playwright/test';
import { NaviPlaywrightAdapter } from '../src/adapter.js';

for (const instrumented of [true, false]) {
  test(`scrolls an off-screen control without activating it (${instrumented ? 'Navi SDK' : 'zero config'})`, async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 400 });
    await page.setContent('<style>html { scroll-behavior: smooth } button { margin-top: 1800px }</style><button id="finish" data-agent-target="finish">Finish</button><output id="count">0</output>');
    await page.evaluate(() => document.querySelector('button')?.addEventListener('click', () => {
      /** @type {HTMLElement} */ (document.querySelector('#count')).textContent = '1';
    }));
    if (instrumented) await page.addScriptTag({ path: 'dist/navi.min.js' });
    const adapter = new NaviPlaywrightAdapter(page);
    const before = await adapter.discover({ viewportOnly: false });
    const target = before.actions.find(action => action.name === 'Finish');
    expect(target).toBeTruthy();
    expect(target?.state.is_in_viewport).toBe(false);
    const id = /** @type {string} */ (target?.target_id);
    const scrolled = await adapter.scrollTo(id);
    expect(scrolled.state.is_in_viewport).toBe(true);
    expect(scrolled.state.is_occluded).toBe(false);
    await expect(page.locator('#count')).toHaveText('0');
    const executed = await adapter.execute(id, 'click');
    expect(executed.ok).toBe(true);
    await expect(page.locator('#count')).toHaveText('1');
    await expect(adapter.scrollTo('missing-target')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(adapter.scrollTo('')).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
  });
}

test('zero-config filtering is not truncation, but exceeding the result limit is', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 400 });
  await page.setContent('<button>Visible</button><button hidden>Hidden</button><button style="position:absolute;top:1800px">Off screen</button>');
  const adapter = new NaviPlaywrightAdapter(page);
  const viewport = await adapter.discover({ viewportOnly: true, limit: 1 });
  expect(viewport.truncated).toBe(false);
  expect(viewport.actions.map(action => action.name)).toEqual(['Visible']);
  const full = await adapter.discover({ viewportOnly: false, limit: 2 });
  expect(full.actions.map(action => action.name)).toEqual(['Visible', 'Off screen']);
  await expect(adapter.discover({ viewportOnly: false, limit: 1 })).rejects.toThrow('Incomplete action map');
});

test('scroll refuses ambiguous, shadow-root, and unmoved targets', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 400 });
  await page.setContent('<button data-agent-target="duplicate">One</button><button data-agent-target="duplicate">Two</button><div id="host"></div><button data-agent-target="blocked" style="margin-top:1800px">Blocked</button>');
  await page.addScriptTag({ path: 'dist/navi.min.js' });
  await page.evaluate(() => {
    const shadow = /** @type {HTMLElement} */ (document.querySelector('#host')).attachShadow({ mode: 'closed' });
    shadow.innerHTML = '<button data-agent-target="shadow">Shadow button</button>';
    /** @type {HTMLElement} */ (document.querySelector('[data-agent-target="blocked"]')).scrollIntoView = () => {};
  });
  const adapter = new NaviPlaywrightAdapter(page);
  await expect(adapter.scrollTo('duplicate')).rejects.toMatchObject({ code: 'AMBIGUOUS' });
  await expect(adapter.scrollTo('shadow')).rejects.toMatchObject({ code: 'SCROLL_TARGET_UNREACHABLE' });
  await expect(adapter.scrollTo('blocked')).rejects.toMatchObject({ code: 'SCROLL_INCOMPLETE' });
  // A refusal must release the busy guard so a later valid request can proceed.
  await page.evaluate(() => document.querySelectorAll('[data-agent-target="duplicate"]')[1].remove());
  expect((await adapter.scrollTo('duplicate')).state.is_in_viewport).toBe(true);
});
