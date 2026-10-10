import { test, expect } from '@playwright/test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';

/**
 * Non-destructive external smoke test.
 *
 * Proves the shipped developer kit works against a real, live, dynamic SPA
 * rather than only against the local fixtures: the built adapter initializes on
 * a third-party origin, populates a React-controlled input through the Navi
 * protocol, and detects elements that appear only after a dynamic update.
 *
 * Targets the public TodoMVC demo. That app keeps its state in localStorage and
 * makes no server writes, so the run leaves the target unchanged; the smoke
 * still deletes the todo it created and clears only its own additions.
 *
 * Override with NAVI_SMOKE_URL only for another public, non-destructive target.
 */
const target = process.env.NAVI_SMOKE_URL || 'https://demo.playwright.dev/todomvc/#/';

test('shipped adapter runs against a live dynamic SPA without errors or long tasks', async ({ page, browser }) => {
  test.setTimeout(120000);
  const log = /** @type {{step: string, detail: string, ms: number}[]} */ ([]);
  /** @param {string} step @param {string} detail @param {number} ms */
  const record = (step, detail, ms) => log.push({ step, detail, ms: Math.round(ms * 100) / 100 });

  /** @type {string[]} */
  const pageErrors = [];
  /** @type {string[]} */
  const consoleErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });

  const { naviSdkPath, installNavi, connectNavi } = await import(new URL('../dist/index.mjs', import.meta.url).href);
  const artifact = JSON.parse(await readFile('reports/build.json', 'utf8'));
  /** @type {Record<string, any>} */
  const report = {
    recordedAt: new Date().toISOString(),
    target,
    browser: `Chromium ${browser.version()} headless`,
    node: process.version,
    artifact: { rawBytes: artifact.rawBytes, budgetBytes: artifact.budgetBytes },
    gates: { longTaskMs: 50 },
    steps: log
  };

  try {
    // 1. Reach the live target.
    const started = Date.now();
    const response = await page.goto(target, { waitUntil: 'load' });
    expect(response, `external target unreachable: ${target}`).toBeTruthy();
    const status = response?.status() ?? 0;
    expect(status, `external target returned HTTP ${status}`).toBeLessThan(400);
    await page.waitForLoadState('domcontentloaded');
    record('navigate', `HTTP ${status} ${page.url()}`, Date.now() - started);
    report.title = await page.title();
    report.finalUrl = page.url();

    // 2. Initialize the shipped SDK on a third-party origin.
    const installStart = Date.now();
    const sdkPath = await installNavi(page);
    expect(sdkPath.endsWith('navi.min.js'), 'the shipped browser bundle must be what was injected').toBe(true);
    const version = await page.evaluate(() => window.Navi?.version);
    expect(version).toBe('0.3.0');
    record('initialize', `injected ${sdkPath.split('/').pop()} protocol v${version}`, Date.now() - installStart);

    const connected = await connectNavi(page);
    const adapter = connected.adapter;
    expect(adapter, 'adapter must be available after connectNavi').toBeTruthy();
    record('connect', `same-origin protocol ${adapter.protocolVersion}`, 0);

    // 3. Discover the live page's action map and observe long tasks during the
    //    traversal. Only small metrics cross the boundary, so Playwright's own
    //    serialization cannot be mistaken for SDK traversal cost.
    const probe = /** @type {{supported: boolean, elapsedMs: number, actions: number, longTasksMs: number[], idleWindowLongTasksMs?: number[]}} */ (await page.evaluate(async () => {
      const navi = window.Navi;
      if (!navi) throw new Error('Missing Navi SDK');
      if (!PerformanceObserver.supportedEntryTypes.includes('longtask')) return { supported: false, longTasksMs: [], elapsedMs: 0, actions: 0 };
      /** @type {number[]} */
      const longTasksMs = [];
      const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) longTasksMs.push(entry.duration); });
      observer.observe({ type: 'longtask' });
      observer.takeRecords();
      const start = performance.now();
      await navi.refresh();
      const map = await navi.actions({ limit: 5000, viewportOnly: true });
      const actions = map.actions.length;
      const elapsedMs = performance.now() - start;
      const duringTraversal = [...longTasksMs];
      await new Promise(resolve => setTimeout(resolve, 120));
      for (const entry of observer.takeRecords()) longTasksMs.push(entry.duration);
      observer.disconnect();
      return { supported: true, elapsedMs, actions, longTasksMs: duringTraversal, idleWindowLongTasksMs: [...longTasksMs] };
    }));
    expect(probe.supported, 'Long Tasks API unavailable: traversal cost cannot be verified').toBe(true);
    report.traversal = probe;
    record('traverse', `refresh + ${probe.actions} controls in ${probe.elapsedMs.toFixed(2)}ms`, probe.elapsedMs);
    expect(probe.longTasksMs.filter(duration => duration > 50), 'Dominant long task during live traversal').toEqual([]);

    const discovered = await adapter.discover({ limit: 5000 });
    /** @type {{target_id: string, role: string, name: string, suggested_action: string}[]} */
    const initialActions = discovered.actions;
    expect(discovered.truncated, 'action map must not be truncated').toBe(false);
    expect(initialActions.length).toBeGreaterThan(0);
    /** @type {{role: string, name: string, suggested_action: string}[]} */
    const discoveredSummary = initialActions.map(action => ({ role: action.role, name: action.name, suggested_action: action.suggested_action }));
    report.discovered = discoveredSummary;
    record('discover', `${initialActions.length} controls: ${discoveredSummary.map(action => action.role).join(', ')}`, 0);

    // 4. Populate a real input field through the protocol.
    const field = initialActions.find(action => action.role === 'textbox');
    expect(field, 'live page must expose a textbox control').toBeTruthy();
    if (!field) throw new Error('live page must expose a textbox control');
    const todoText = `navi smoke ${String(report.recordedAt).slice(11, 19)}`;
    const typed = await adapter.execute(field.target_id, 'type', { text: todoText });
    expect(typed.ok, `type failed: ${typed.error ? `${typed.error.code} ${typed.error.message}` : 'no detail'}`).toBe(true);
    expect(typed.mode).toBe('synthetic');
    await expect(page.locator('input.new-todo')).toHaveValue(todoText);
    // The SDK must leave the control it typed into focused, so the user's next
    // keypress reaches the field rather than the document.
    await expect(page.locator('input.new-todo')).toBeFocused();
    record('populate', `typed into ${field.name || field.role} via Navi.execute (mode ${typed.mode}), control left focused`, 0);

    // 5. Detect dynamic updates: the app re-renders on Enter, and Navi must
    //    index the newly created controls without a full reprocess.
    const before = new Set(initialActions.map(action => action.target_id));
    await page.keyboard.press('Enter');
    // React TodoMVC renders its items as `ul.todo-list li` with no base class;
    // the `.filters` list is also a `ul`, so scope the selector to the real list.
    await expect(page.locator('ul.todo-list li')).toHaveCount(1);
    const after = await adapter.discover({ limit: 5000 });
    /** @type {{target_id: string, role: string}[]} */
    const afterActions = after.actions;
    const added = afterActions.filter(action => !before.has(action.target_id));
    expect(added.length, 'Navi must index controls that only exist after the dynamic update').toBeGreaterThan(0);
    const rows = await page.locator('ul.todo-list li').count();
    report.dynamicUpdate = { domRows: rows, newControls: added.length, roles: added.map(action => action.role), totalAfter: afterActions.length };
    record('dynamic-update', `${rows} list row(s) rendered, ${added.length} new control(s) indexed (${report.dynamicUpdate.roles.join(', ')})`, 0);

    // 6. Clean up after ourselves: remove the todo we created, through the UI.
    await page.locator('ul.todo-list li').hover();
    await page.locator('ul.todo-list li button.destroy').click();
    await expect(page.locator('ul.todo-list li')).toHaveCount(0);
    record('cleanup', 'created todo removed; target left unchanged', 0);
  } finally {
    // The target keeps state in localStorage; clear only our own additions.
    await page.evaluate(() => { try { localStorage.clear(); } catch { /* opaque origin */ } }).catch(() => {});
    report.pageErrors = pageErrors;
    report.consoleErrors = consoleErrors;
    const traversal = /** @type {{longTasksMs?: number[]}} */ (report.traversal ?? {});
    report.longTaskGate = (traversal.longTasksMs ?? []).filter(duration => duration > 50);
    report.ok = pageErrors.length === 0 && consoleErrors.length === 0 && report.longTaskGate.length === 0;
    await mkdir('reports', { recursive: true });
    await writeFile('reports/smoke-external.json', `${JSON.stringify(report, null, 2)}\n`);
    console.log(`[smoke] ${JSON.stringify({ target, ok: report.ok, steps: log.map(entry => `${entry.step}:${entry.ms}ms`), traversalMs: report.traversal?.elapsedMs, longTasks: report.longTaskGate?.length ?? null, newControls: report.dynamicUpdate?.newControls ?? null })}`);
  }

  expect(pageErrors, 'uncaught page errors').toEqual([]);
  expect(consoleErrors, 'console errors').toEqual([]);
});
