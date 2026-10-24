import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { NaviPlaywrightAdapter } from '../src/adapter.js';

for (const instrumented of [true, false]) {
  test(`Enter submits once after typing (${instrumented ? 'SDK' : 'zero config'})`, async ({ page }) => {
    await page.setContent('<form><input id="email" data-agent-target="email" aria-label="Email"><button data-agent-target="submit">Submit</button></form><output id="status">Ready</output>');
    await page.evaluate(() => {
      let submits = 0;
      document.querySelector('form')?.addEventListener('submit', event => {
        event.preventDefault();
        /** @type {HTMLElement} */ (document.querySelector('#status')).textContent = `Submitted ${++submits}`;
      });
      document.querySelector('input')?.addEventListener('keydown', event => {
        if (/** @type {KeyboardEvent} */ (event).key === 'Enter') document.body.dataset.trusted = String(event.isTrusted);
      });
    });
    if (instrumented) await page.addScriptTag({ path: 'dist/navi.min.js' });
    const adapter = new NaviPlaywrightAdapter(page);
    const map = await adapter.discover({ viewportOnly: false });
    const field = /** @type {string} */ (map.actions.find(a => a.name === 'Email')?.target_id);
    const button = /** @type {string} */ (map.actions.find(a => a.name === 'Submit')?.target_id);
    expect((await adapter.execute(field, 'type', { text: 'keyboard@example.test' })).ok).toBe(true);
    await expect(page.locator('#email')).toBeFocused();
    await expect(adapter.pressKey('Enter', button)).rejects.toMatchObject({ code: 'KEY_TARGET_NOT_FOCUSED' });
    await expect(adapter.pressKey('F99')).rejects.toMatchObject({ code: 'INVALID_KEY' });
    await expect(page.locator('#status')).toHaveText('Ready');
    expect((await adapter.pressKey('Enter', field)).pressed).toBe(true);
    await expect(page.locator('#status')).toHaveText('Submitted 1');
    await expect(page.locator('body')).toHaveAttribute('data-trusted', 'true');
  });
}

test('Escape dismisses a modal, while strict sessions refuse native keys', async ({ page }) => {
  await page.setContent('<dialog><input aria-label="Modal input"></dialog>');
  await page.evaluate(() => document.querySelector('dialog')?.showModal());
  const strict = new NaviPlaywrightAdapter(page, { fallback: false });
  await expect(strict.pressKey('Escape')).rejects.toMatchObject({ code: 'FALLBACK_DISABLED' });
  await expect(page.locator('dialog')).toBeVisible();
  const adapter = new NaviPlaywrightAdapter(page);
  await adapter.pressKey('Escape');
  await expect(page.locator('dialog')).not.toBeVisible();
});

test('MCP keyboard input returns refusals and a verifiable form outcome', async ({ baseURL }) => {
  const client = new Client({ name: 'keyboard-check', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['bin/navi-mcp.js'], env: { ...process.env, NAVI_ALLOW_LOCAL_NETWORK: '1' } });
  /** @param {any} response */
  const body = response => JSON.parse(response.content[0].text);
  await client.connect(transport);
  try {
    expect(body(await client.callTool({ name: 'navi_press_key', arguments: { key: 'Enter' } })).error.code).toBe('NO_PAGE');
    await client.callTool({ name: 'navi_navigate', arguments: { url: baseURL } });
    const unfocused = body(await client.callTool({ name: 'navi_press_key', arguments: { key: 'Enter', target_id: 'checkout-email' } }));
    expect(unfocused.error.code).toBe('KEY_TARGET_NOT_FOCUSED');
    expect(unfocused.may_have_applied).toBe(false);
    const typed = body(await client.callTool({ name: 'navi_execute_action', arguments: { target_id: 'checkout-email', action_type: 'type', payload: { text: 'keys@example.test' } } }));
    expect(typed.dispatched).toBe(true);
    const pressed = body(await client.callTool({ name: 'navi_press_key', arguments: { key: 'Enter', target_id: 'checkout-email' } }));
    expect(pressed.pressed).toBe(true);
    expect(pressed.mode).toBe('native-driver');
    const outcome = body(await client.callTool({ name: 'navi_read_text', arguments: { selector: '#status' } }));
    expect(outcome.text).toBe('Sandbox checkout complete — no payment was made.');
    expect(body(await client.callTool({ name: 'navi_press_key', arguments: { key: 'F99' } })).error.code).toBe('INVALID_KEY');
  } finally {
    await client.close();
  }
});
