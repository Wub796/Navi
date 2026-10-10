import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import os from 'node:os';
import { naviAdapter } from '../scripts/navi-adapter.mjs';

const sdkPath = 'dist/navi.min.js';
/** @param {import('@playwright/test').Page} page @param {string} html @param {string} [setup] */
async function install(page, html, setup = '') {
  await page.goto('/frame.html');
  await page.setContent(html);
  if (setup) await page.evaluate(code => (0, eval)(code), setup);
  await page.addScriptTag({ path: sdkPath });
  await page.evaluate(async () => await window.Navi?.ready());
}
/** @param {import('@playwright/test').Page} page @param {string} id @param {string} action @param {{text?: string,value?: string}} [payload] */
async function execute(page, id, action, payload) {
  return page.evaluate(async ({ id, action, payload }) => {
    if (!window.Navi) throw new Error('SDK missing');
    return window.Navi.execute(id, action, payload);
  }, { id, action, payload });
}
/** @param {import('@playwright/test').Page} page @param {string} id @param {string} action @param {{text?: string,value?: string}} [payload] */
async function rejection(page, id, action = 'click', payload) {
  return page.evaluate(async ({ id, action, payload }) => {
    try { await window.Navi?.execute(id, action, payload); return 'NO_ERROR'; }
    catch (error) { return /** @type {Error & {code: string}} */ (error).code; }
  }, { id, action, payload });
}
/** @param {import('@playwright/test').Page} page */
async function map(page) {
  return page.evaluate(async () => {
    if (!window.Navi) throw new Error('SDK missing');
    return window.Navi.actions({ limit: 5000 });
  });
}

test('rich schema, names, native roles, fingerprints, opt-ins, bounded output and privacy', async ({ page }) => {
  await install(page, `<button aria-label="Pay now">Wrong text</button>
    <label for="email">Email address</label><input id="email" value="SECRET-123">
    <div role="button" data-navi-action="checkout-submit">Pay</div>
    <button aria-labelledby="name">Other</button><span id="name">Confirm order</span>
    <button>Crème brûlée</button><input type="HIDDEN"><div id="opaque">Opaque handler</div>
    <div onclick="void 0">Inline action</div><a href="/">Home</a>`);
  const snapshot = await map(page);
  expect(snapshot.version).toBe('0.3.0');
  expect(snapshot.actions.map(a => a.name).sort()).toEqual(['Pay now', 'Email address', 'Pay', 'Confirm order', 'Crème brûlée', 'Inline action', 'Home'].sort());
  expect(snapshot.actions.every(a => /-[a-f0-9]{8}$/.test(a.target_id))).toBe(true);
  expect(new Set(snapshot.actions.map(a => a.target_id)).size).toBe(7);
  expect(snapshot.actions.find(a => a.name === 'Email address')?.suggested_action).toBe('type');
  expect(snapshot.actions.find(a => a.name === 'Home')?.role).toBe('link');
  expect(snapshot.actions[0]).toEqual(expect.objectContaining({
    state: { is_visible: true, is_enabled: true, is_in_viewport: true, is_occluded: false },
    coordinates: { x: expect.any(Number), y: expect.any(Number), width: expect.any(Number), height: expect.any(Number) }
  }));
  expect(JSON.stringify(snapshot)).not.toContain('SECRET');
  expect(JSON.stringify(snapshot)).not.toContain('selector');
  await expect(page.locator('#opaque')).not.toHaveAttribute('data-agent-target');
  expect(await page.evaluate(async () => (await window.Navi?.actions({ limit: 2 }))?.truncated)).toBe(true);
});

test('structural fingerprints survive identical replacement; explicit and hash collisions fail closed', async ({ page }) => {
  await install(page, '<main id="checkout"><button>Save</button><button>Save</button><button data-agent-target="duplicate">A</button><button data-agent-target="duplicate">B</button></main>');
  const before = await page.locator('button').evaluateAll(nodes => nodes.map(el => el.getAttribute('data-agent-target')));
  expect(before[0]).not.toBe(before[1]);
  await page.evaluate(() => document.querySelector('main')?.replaceChildren(...Array.from(document.querySelectorAll('button')).map(el => {
    const clone = el.cloneNode(true);
    if (clone instanceof Element && clone.getAttribute('data-agent-target') !== 'duplicate') clone.removeAttribute('data-agent-target');
    return clone;
  })));
  await page.evaluate(async () => await window.Navi?.ready());
  expect(await page.locator('button').evaluateAll(nodes => nodes.map(el => el.getAttribute('data-agent-target')))).toEqual(before);
  expect(await rejection(page, 'duplicate')).toBe('AMBIGUOUS');
  // A copied generated attribute is deliberately treated as an authored ambiguity.
  await page.evaluate(() => document.querySelector('main')?.append(document.querySelector('button')?.cloneNode(true) || document.createElement('span')));
  expect(await rejection(page, before[0] || '')).toBe('AMBIGUOUS');
  await page.evaluate(() => document.querySelector('button')?.setAttribute('data-agent-target', 'x" ] , body \\ y'));
  expect((await map(page)).actions.some(a => a.target_id === 'x" ] , body \\ y')).toBe(true);
  expect((await execute(page, 'x" ] , body \\ y', 'click')).dispatched).toBe(true);
});

test('real React controlled input, keyed sorting and element replacement preserve business targets', async ({ page }) => {
  const bundle = await build({ stdin: { contents: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    function App() {
      const [text,setText] = useState(''); const [reverse,setReverse] = useState(false); const [epoch,setEpoch] = useState(0);
      const items = reverse ? ['b','a'] : ['a','b'];
      return React.createElement('main', {id:'react-checkout'},
        React.createElement('input', {'data-agent-target':'search-input',value:text,onChange:e=>setText(e.target.value)}),
        React.createElement('output', {id:'react-value'}, text),
        React.createElement('button', {'data-agent-target':'sort',onClick:()=>setReverse(!reverse)}, 'Sort'),
        React.createElement('button', {'data-agent-target':'replace',onClick:()=>setEpoch(epoch+1)}, 'Replace'),
        ...items.map(id=>React.createElement('section', {key:id+'-'+epoch,'data-navi-key':id},
          React.createElement('button', {'data-navi-action':'choose',onClick:()=>setText(id)}, 'Choose'))));
    }
    createRoot(document.getElementById('app')).render(React.createElement(App));
  `, resolveDir: process.cwd(), loader: 'js' }, bundle: true, write: false, format: 'iife', define: { 'process.env.NODE_ENV': '"production"' } });
  await install(page, '<div id="app"></div>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await expect(page.locator('#react-value')).toHaveCount(1);
  await page.evaluate(async () => await window.Navi?.ready());
  /** @returns {Promise<Record<string,string>>} */
  async function identities() {
    return page.locator('[data-navi-key]').evaluateAll(nodes => Object.fromEntries(nodes.map(el => [el.getAttribute('data-navi-key'), el.querySelector('button')?.getAttribute('data-agent-target')])));
  }
  const before = await identities();
  await execute(page, 'search-input', 'type', { text: 'shoes' });
  await expect(page.locator('#react-value')).toHaveText('shoes');
  await execute(page, 'sort', 'click');
  expect(await identities()).toEqual(before);
  await execute(page, 'replace', 'click');
  expect(await identities()).toEqual(before);
  await execute(page, before.a, 'click');
  await expect(page.locator('#react-value')).toHaveText('a');
  expect(await page.locator('[data-agent-target="search-input"]').inputValue()).toBe('a');
});

test('shadow hook captures nested closed roots, preserves semantics and restores on stop', async ({ page }) => {
  await install(page, '<div id="before"></div><div id="closed"></div><div id="open"></div>', `
    window.originalAttachShadow = Element.prototype.attachShadow;
    document.querySelector('#before').attachShadow({mode:'closed'}).innerHTML='<button>Before hook</button>';
  `);
  await page.evaluate(() => {
    const host = document.querySelector('#closed');
    if (!host) throw new Error('Missing host');
    const root = host.attachShadow({ mode: 'closed', delegatesFocus: true });
    root.innerHTML = '<section id="nested"></section>';
    const nested = root.querySelector('#nested');
    if (!nested) throw new Error('Missing nested');
    const child = nested.attachShadow({ mode: 'closed' });
    child.innerHTML = '<button data-agent-target="private-action">Closed action</button>';
    child.querySelector('button')?.addEventListener('click', () => host.setAttribute('data-result', 'clicked'));
    document.querySelector('#open')?.attachShadow({ mode: 'open' }).append(Object.assign(document.createElement('button'), { textContent: 'Open action' }));
  });
  expect((await map(page)).actions.map(a => a.name).sort()).toEqual(['Closed action', 'Open action']);
  expect(await page.locator('#closed').evaluate(el => el.shadowRoot)).toBeNull();
  await execute(page, 'private-action', 'click');
  await expect(page.locator('#closed')).toHaveAttribute('data-result', 'clicked');
  expect(await page.evaluate(() => { try { document.querySelector('#closed')?.attachShadow({ mode: 'open' }); return false; } catch { return true; } })).toBe(true);
  await page.evaluate(() => window.Navi?.stop());
  expect(await page.evaluate(() => Element.prototype.attachShadow === Reflect.get(window, 'originalAttachShadow'))).toBe(true);
});

test('same-origin frame capture, navigation and sandbox exclusion clean old index entries', async ({ page }) => {
  await install(page, '<iframe id="frame" src="/frame.html"></iframe><iframe sandbox="allow-scripts" srcdoc="<button>Isolated</button>"></iframe>');
  await expect.poll(async () => (await map(page)).actions.some(a => a.target_id === 'payment-demo')).toBe(true);
  await page.evaluate(() => {
    const doc = /** @type {HTMLIFrameElement} */ (document.querySelector('#frame')).contentDocument;
    if (!doc) throw new Error('Missing frame');
    const host = doc.createElement('div'); doc.body.append(host);
    host.attachShadow({ mode: 'closed' }).innerHTML = '<button data-agent-target="frame-closed">Frame closed</button>';
  });
  expect((await execute(page, 'frame-closed', 'click')).dispatched).toBe(true);
  await page.evaluate(() => document.querySelector('#frame')?.setAttribute('srcdoc', '<button data-agent-target="new-document">New document</button>'));
  await expect.poll(async () => (await map(page)).actions.some(a => a.target_id === 'new-document')).toBe(true);
  expect((await map(page)).actions.some(a => ['payment-demo', 'frame-closed', 'isolated'].includes(a.target_id))).toBe(false);
  await page.evaluate(() => document.querySelector('#frame')?.remove());
  await page.evaluate(async () => await window.Navi?.ready());
  expect(await page.evaluate(() => window.Navi?.stats().roots)).toBe(1);
  expect((await map(page)).actions).toEqual([]);
});

test('modal backdrop occlusion is live and prevents a misclick; partial frame overlay uses target point', async ({ page }) => {
  await install(page, '<button data-agent-target="pay">Pay now</button><iframe id="frame" src="/frame.html" style="position:absolute;left:300px;top:10px;width:400px;height:120px"></iframe>');
  expect((await map(page)).actions.find(a => a.target_id === 'pay')?.state.is_occluded).toBe(false);
  await page.evaluate(() => {
    const overlay = document.createElement('div'); overlay.id = 'backdrop';
    overlay.style.cssText = 'position:fixed;inset:0;background:#0008;z-index:100'; document.body.append(overlay);
  });
  expect((await map(page)).actions.find(a => a.target_id === 'pay')?.state.is_occluded).toBe(true);
  expect(await rejection(page, 'pay')).toBe('UNAVAILABLE');
  await page.evaluate(() => document.querySelector('#backdrop')?.remove());
  await execute(page, 'pay', 'click');
  await page.evaluate(() => {
    const overlay = document.createElement('div'); overlay.id = 'partial';
    overlay.style.cssText = 'position:absolute;left:300px;top:10px;width:270px;height:40px;z-index:100'; document.body.append(overlay);
  });
  expect((await map(page)).actions.find(a => a.target_id === 'payment-demo')?.state.is_occluded).toBe(true);
  expect(await rejection(page, 'payment-demo')).toBe('UNAVAILABLE');
});

test('hidden disabled inert readonly opacity and offscreen targets fail closed', async ({ page }) => {
  await install(page, '<fieldset disabled><button data-agent-target="disabled">D</button></fieldset><div hidden><button data-agent-target="hidden">H</button></div><div inert><button data-agent-target="inert">I</button></div><input readonly data-agent-target="readonly"><button style="opacity:0" data-agent-target="opacity">O</button><button style="position:absolute;top:2000px" data-agent-target="offscreen">F</button>');
  const snapshot = await map(page);
  expect(snapshot.actions.find(a => a.target_id === 'disabled')?.state.is_enabled).toBe(false);
  expect(snapshot.actions.find(a => a.target_id === 'hidden')?.state.is_visible).toBe(false);
  expect(snapshot.actions.find(a => a.target_id === 'opacity')?.state.is_visible).toBe(false);
  expect(snapshot.actions.find(a => a.target_id === 'offscreen')?.state.is_in_viewport).toBe(false);
  for (const id of ['disabled', 'hidden', 'inert', 'opacity', 'offscreen']) expect(await rejection(page, id)).toBe('UNAVAILABLE');
  expect(await rejection(page, 'readonly', 'type', { text: 'blocked' })).toBe('UNAVAILABLE');
});

test('native event sequence updates Vue-style listeners; select, cancel and payload checks', async ({ page }) => {
  await install(page, '<input data-agent-target="search"><textarea data-agent-target="notes"></textarea><select data-agent-target="size"><option value="s">Small</option><option disabled value="l">Large</option></select><button data-agent-target="button">Button</button><output id="events"></output>');
  await page.evaluate(() => {
    const events = /** @type {string[]} */ ([]);
    for (const type of ['keydown', 'beforeinput', 'input', 'change', 'keyup']) document.querySelector('input')?.addEventListener(type, event => {
      events.push(event.type);
      const output = document.querySelector('#events'); if (output) output.textContent = events.join(',');
    });
  });
  await execute(page, 'search', 'type', { text: 'shoes' });
  await expect(page.locator('input')).toHaveValue('shoes');
  await expect(page.locator('#events')).toHaveText('keydown,beforeinput,input,change,keyup');
  await execute(page, 'notes', 'type', { text: 'A note' });
  await expect(page.locator('textarea')).toHaveValue('A note');
  await execute(page, 'size', 'select', { value: 's' });
  expect(await rejection(page, 'size', 'select', { value: 'l' })).toBe('INVALID_PAYLOAD');
  expect(await rejection(page, 'button', 'type', { text: 'invalid' })).toBe('INVALID_PAYLOAD');
  expect(await rejection(page, 'missing')).toBe('NOT_FOUND');
  expect(await rejection(page, 'button', 'eval')).toBe('INVALID_ACTION');
  expect(await rejection(page, 'search', 'type', { text: 'x'.repeat(10001) })).toBe('INVALID_PAYLOAD');
  await page.evaluate(() => document.querySelector('input')?.addEventListener('keydown', event => event.preventDefault(), { once: true }));
  expect(await rejection(page, 'search', 'type', { text: 'canceled' })).toBe('CANCELED');
  await expect(page.locator('input')).toHaveValue('shoes');
});

test('mutation bursts converge, eligibility changes and SPA unmounts release index/root history', async ({ page }) => {
  await install(page, '<main></main>');
  for (let round = 0; round < 4; round++) {
    await page.evaluate(() => {
      const main = document.querySelector('main'); if (!main) throw new Error('Missing main');
      main.innerHTML = Array.from({ length: 200 }, (_, i) => `<button>Action ${i}</button>`).join('');
      const host = document.createElement('div'); main.append(host);
      host.attachShadow({ mode: 'closed' }).innerHTML = '<button>Shadow action</button>';
    });
    await page.evaluate(async () => await window.Navi?.ready());
    expect((await map(page)).actions).toHaveLength(201);
    await page.evaluate(() => document.querySelector('main')?.replaceChildren());
    await page.evaluate(async () => await window.Navi?.ready());
    expect(await page.evaluate(() => ({ roots: window.Navi?.stats().roots, indexed: window.Navi?.stats().indexed }))).toEqual({ roots: 1, indexed: 0 });
  }
  await page.evaluate(() => {
    const el = document.createElement('div'); el.id = 'eligible'; document.body.append(el); el.setAttribute('role', 'button');
  });
  expect((await map(page)).actions).toHaveLength(1);
  await page.evaluate(() => document.querySelector('#eligible')?.removeAttribute('role'));
  expect((await map(page)).actions).toHaveLength(0);
  const before = await page.evaluate(() => window.Navi?.stats().ticks);
  await page.waitForTimeout(100); // quiet-window assertion, not readiness timing
  expect(await page.evaluate(() => window.Navi?.stats().ticks)).toBe(before);
});

test('viewport candidates overtake background controls through IntersectionObserver', async ({ page }) => {
  await page.goto('/frame.html');
  await page.setContent('<main>' + Array.from({ length: 500 }, (_, i) => `<button style="position:absolute;top:2000px" data-navi-action="off-${i}">Off</button>`).join('') + '<button data-navi-action="visible">Visible</button></main>');
  await page.evaluate(() => {
    const order = /** @type {string[]} */ ([]);
    Reflect.set(window, 'tagOrder', order);
    new MutationObserver(records => { for (const record of records) if (record.type === 'attributes') order.push(/** @type {Element} */ (record.target).getAttribute('data-navi-action') || ''); }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-agent-target'] });
  });
  await page.addScriptTag({ path: sdkPath });
  await page.evaluate(async () => await window.Navi?.ready());
  const order = /** @type {string[]} */ (await page.evaluate(() => Reflect.get(window, 'tagOrder')));
  expect(order.indexOf('visible')).toBeLessThan(order.indexOf('off-499'));
  expect(order).toHaveLength(501);
});

test('mutations during an unfinished traversal are rescanned and concurrent execution fails closed', async ({ page }) => {
  await install(page, '<main>' + '<span>Static</span>'.repeat(2000) + '</main><button data-agent-target="concurrent">Run</button>');
  await page.evaluate(async () => {
    const pending = window.Navi?.refresh();
    document.querySelector('main')?.prepend(Object.assign(document.createElement('button'), { textContent: 'Inserted behind cursor' }));
    await pending;
  });
  expect((await map(page)).actions.some(a => a.name === 'Inserted behind cursor')).toBe(true);
  const outcome = await page.evaluate(async () => {
    const first = window.Navi?.execute('concurrent', 'click');
    let code = 'NO_ERROR';
    try { await window.Navi?.execute('concurrent', 'click'); } catch (error) { code = /** @type {Error & {code:string}} */ (error).code; }
    await first;
    return code;
  });
  expect(outcome).toBe('BUSY');
});

test('requestAnimationFrame + microtask fallback progresses without idle or IO support', async ({ page }) => {
  await install(page, '<main>' + '<button>Fallback</button>'.repeat(100) + '</main>', `window.requestIdleCallback=undefined;window.IntersectionObserver=undefined;`);
  expect((await map(page)).actions).toHaveLength(100);
  expect(await page.evaluate(() => window.Navi?.stats().maxTickMs)).toBeLessThan(6);
});

test('stop rejects waiting operations, releases state, restores only owned hooks and prevents reinjection', async ({ page }) => {
  await install(page, '<button>Stop test</button>');
  const outcome = await page.evaluate(async () => {
    const promise = window.Navi?.actions();
    window.Navi?.stop();
    try { await promise; return 'NO_ERROR'; } catch { return 'STOPPED'; }
  });
  expect(outcome).toBe('STOPPED');
  await page.addScriptTag({ path: sdkPath });
  expect(await page.evaluate(() => ({ roots: window.Navi?.stats().roots, indexed: window.Navi?.stats().indexed, pending: window.Navi?.stats().pending }))).toEqual({ roots: 0, indexed: 0, pending: 0 });
  expect(await rejection(page, 'stop-test')).toBe('STOPPED');
});

test('no automatic SDK telemetry, field values, or CSS/ARIA rewrites', async ({ page }) => {
  /** @type {string[]} */
  const requests = [];
  page.on('request', req => requests.push(req.url()));
  await install(page, '<style>button{width:120px;height:40px}</style><button aria-label="Keep label">A</button><input value="PRIVATE-VALUE">');
  expect(JSON.stringify(await map(page))).not.toContain('PRIVATE-VALUE');
  await expect(page.locator('button')).toHaveAttribute('aria-label', 'Keep label');
  expect(await page.locator('button').evaluate(el => ({ width: el.getBoundingClientRect().width, tab: el.getAttribute('tabindex') }))).toEqual({ width: 120, tab: null });
  expect(requests.filter(url => !url.endsWith('/frame.html'))).toEqual([]);
});

test('full transaction exclusively uses Navi.execute including a closed root and iframe', async ({ page }) => {
  /** @type {string[]} */
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1360, height: 1200 });
  await page.goto('/');
  await page.evaluate(async () => await window.Navi?.ready());
  await execute(page, 'checkout-email', 'type', { text: 'agent@example.com' });
  await execute(page, 'checkout-delivery', 'select', { value: 'Send me a link' });
  await execute(page, 'checkout-add-discount', 'click');
  await execute(page, 'checkout-discount', 'type', { text: 'DEMO' });
  await execute(page, 'checkout-gift', 'click');
  await execute(page, 'payment-demo', 'click');
  await execute(page, 'checkout-submit', 'click');
  await expect(page.getByRole('status')).toHaveText('Sandbox checkout complete — no payment was made.');
  await expect(page.frameLocator('iframe').locator('button')).toHaveAttribute('aria-pressed', 'true');
  expect(errors).toEqual([]);
});

test('viewport query and top coordinates support trusted native input in main and frame contexts', async ({ page }) => {
  await install(page, '<button data-agent-target="trusted" data-navi-trusted="true">Trusted</button><input data-agent-target="trusted-input" data-navi-trusted="true"><button style="position:absolute;top:2000px" data-agent-target="off">Off</button><iframe id="frame" src="/frame.html" style="position:absolute;left:320px;top:80px;width:400px;height:120px;border:3px solid"></iframe>');
  await page.evaluate(() => {
    const button = document.querySelector('button'); button?.addEventListener('click', event => { if (event.isTrusted) button.setAttribute('data-result', 'trusted'); });
    const input = document.querySelector('input'); input?.addEventListener('input', event => { if (event.isTrusted) input.setAttribute('data-result', 'trusted'); });
  });
  expect(await execute(page, 'trusted', 'click')).toEqual({ success: false, reason: 'untrusted_gesture_required', dispatched: false });
  await expect(page.locator('button').first()).not.toHaveAttribute('data-result');
  const tools = naviAdapter(page);
  expect((await tools.discover({ viewportOnly: true })).actions.some(a => a.target_id === 'off')).toBe(false);
  expect((await tools.execute('trusted', 'click')).mode).toBe('native-driver');
  await expect(page.locator('button').first()).toHaveAttribute('data-result', 'trusted');
  expect((await tools.execute('trusted-input', 'type', { text: 'shoes' })).mode).toBe('native-driver');
  await expect(page.locator('input')).toHaveValue('shoes');
  await expect(page.locator('input')).toHaveAttribute('data-result', 'trusted');
  // Tab can focus the next offscreen control and scroll; restore viewport before reuse.
  await page.evaluate(() => window.scrollTo(0, 0));
  expect((await tools.execute('trusted-input', 'type', { text: '' })).ok).toBe(true);
  await expect(page.locator('input')).toHaveValue('');
  await page.frameLocator('iframe').locator('button').waitFor();
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    const button = /** @type {HTMLIFrameElement} */ (document.querySelector('iframe')).contentDocument?.querySelector('button');
    button?.setAttribute('data-navi-trusted', 'true');
    button?.addEventListener('click', event => { if (event.isTrusted) button.setAttribute('data-result', 'trusted'); });
  });
  expect((await tools.execute('payment-demo', 'click')).mode).toBe('native-driver');
  await expect(page.frameLocator('iframe').locator('button')).toHaveAttribute('data-result', 'trusted');
});

test('fallback handles certified dispatch failure but never retries unknown errors or occlusion', async ({ page }) => {
  await install(page, '<button data-agent-target="pay" data-navi-trusted="true">Pay</button>');
  await page.evaluate(() => {
    const navi = window.Navi; if (!navi) throw new Error('Missing SDK');
    navi.execute = async () => { throw Object.assign(new Error('Not dispatched'), { reason: 'dispatch_failed', dispatched: false }); };
    document.querySelector('button')?.addEventListener('click', event => { if (event.isTrusted) document.body.setAttribute('data-clicked', 'yes'); });
  });
  const tools = naviAdapter(page);
  expect((await tools.execute('pay', 'click')).mode).toBe('native-driver');
  await expect(page.locator('body')).toHaveAttribute('data-clicked', 'yes');
  await page.evaluate(() => {
    document.body.removeAttribute('data-clicked');
    if (window.Navi) window.Navi.execute = async () => { throw new Error('Maybe dispatched'); };
  });
  expect((await tools.execute('pay', 'click')).ok).toBe(false);
  await expect(page.locator('body')).not.toHaveAttribute('data-clicked');
  await page.evaluate(() => {
    if (window.Navi) Reflect.set(window.Navi, 'execute', async () => ({ success: false, reason: 'untrusted_gesture_required', dispatched: true }));
  });
  expect((await tools.execute('pay', 'click')).ok).toBe(false);
  await expect(page.locator('body')).not.toHaveAttribute('data-clicked');
  await page.evaluate(() => {
    if (window.Navi) window.Navi.execute = async () => ({ success: false, reason: 'untrusted_gesture_required', dispatched: false });
    const overlay = document.createElement('div'); overlay.style.cssText = 'position:fixed;inset:0;z-index:100'; document.body.append(overlay);
  });
  // Occlusion is an anticipated refusal: it returns a structured result (never throws,
  // never dispatches). Only transport failures propagate as exceptions.
  const occluded = await tools.execute('pay', 'click');
  expect(occluded.ok).toBe(false);
  expect(occluded.error?.code).toBe('TARGET_UNAVAILABLE');
  await expect(page.locator('body')).not.toHaveAttribute('data-clicked');
});

test('10,000-element benchmark verifies complete indexing, metadata and cleanup with slice/long-task gates', async ({ browser }) => {
  test.setTimeout(180000);
  const code = await readFile(sdkPath, 'utf8');
  /** @type {{elapsedMs: number, maxTickMs: number, ticks: number, tickSamplesMs: number[], longTasksMs: number[]}[]} */
  const runs = [];
  for (let run = 0; run < 20; run++) {
    const page = await browser.newPage();
    // Exactly 10,000 elements in main, including main itself; 1,000 controls.
    await page.setContent('<main>' + Array.from({ length: 9999 }, (_, i) => i % 10 === 0 ? `<button>Action ${i}</button>` : '<span>Static content</span>').join('') + '</main><div id="shadow"></div><div id="closed"></div><iframe srcdoc="<button>Frame action</button>"></iframe>');
    await page.frameLocator('iframe').locator('button').waitFor();
    await page.evaluate(() => {
      document.querySelector('#shadow')?.attachShadow({ mode: 'open' }).append(Object.assign(document.createElement('button'), { textContent: 'Shadow action' }));
    });
    // Settle fixture layout BEFORE the observed SDK interval, not after it.
    await page.evaluate(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
    const result = await page.evaluate(async source => {
      if (!PerformanceObserver.supportedEntryTypes.includes('longtask')) throw new Error('Long Tasks API unavailable');
      const longTasks = /** @type {number[]} */ ([]);
      const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) if (entry.duration > 50) longTasks.push(entry.duration); });
      observer.observe({ type: 'longtask' });
      const start = performance.now();
      (0, eval)(source);
      if (!window.Navi) throw new Error('SDK missing');
      document.querySelector('#closed')?.attachShadow({ mode: 'closed' }).append(Object.assign(document.createElement('button'), { textContent: 'Closed action' }));
      await window.Navi.ready();
      const snapshot = await window.Navi.actions({ limit: 5000 });
      const host = document.querySelector('#closed'); host?.remove();
      await window.Navi.ready();
      const stats = window.Navi.stats();
      const elapsedMs = performance.now() - start;
      await new Promise(resolve => setTimeout(resolve, 80));
      for (const entry of observer.takeRecords()) if (entry.duration > 50) longTasks.push(entry.duration);
      observer.disconnect();
      return { elapsedMs, stats, longTasksMs: longTasks, actions: snapshot.actions.length, remainingRoots: stats.roots };
    }, code);
    expect(result.actions).toBe(1003);
    expect(result.remainingRoots).toBe(3);
    expect(await page.locator('main button[data-agent-target]').count()).toBe(1000);
    runs.push({ elapsedMs: result.elapsedMs, maxTickMs: result.stats.maxTickMs, ticks: result.stats.ticks, tickSamplesMs: result.stats.tickSamplesMs, longTasksMs: result.longTasksMs });
    await page.close();
  }
  const ticks = runs.flatMap(run => run.tickSamplesMs).sort((a,b) => a-b);
  const size = JSON.parse(await readFile('reports/build.json', 'utf8'));
  const report = {
    recordedAt: new Date().toISOString(), protocol: '0.3.0', browser: `Chromium ${browser.version()} headless`,
    hardware: { cpu: os.cpus()[0].model, logicalCpus: os.cpus().length, memoryBytes: os.totalmem(), os: `${os.platform()} ${os.release()} ${os.arch()}` },
    size,
    benchmark: { fixtureElements: 10000, fixtureControls: 1000, extraControls: 3, runs: runs.length,
      budgetMs: 6, frameBudgetMs: 16, maxTickMs: Math.max(...runs.map(run => run.maxTickMs)), p95SampledTickMs: ticks[Math.ceil(ticks.length * .95) - 1],
      longTasksOver50ms: runs.reduce((sum,run) => sum + run.longTasksMs.length,0), samples: runs },
    scope: 'SDK injection + initial indexing + rich actions metadata + closed-root removal cleanup. Fixture setup/layout settled before observer begins. Local unthrottled Chromium; no universal scheduling/INP or 10x claim. Tick history bounded to last 512 ticks; max tracks all ticks.'
  };
  await writeFile('reports/verification.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ rawBytes: size.rawBytes, runs: runs.length, maxTickMs: report.benchmark.maxTickMs, p95Ms: report.benchmark.p95SampledTickMs, longTasksOver50ms: report.benchmark.longTasksOver50ms, elapsedMs: runs.map(run => run.elapsedMs) }));
  expect(size.rawBytes).toBeLessThan(15000);
  expect(report.benchmark.maxTickMs).toBeLessThanOrEqual(6);
  expect(report.benchmark.maxTickMs).toBeLessThan(16);
  expect(report.benchmark.longTasksOver50ms).toBe(0);
});
