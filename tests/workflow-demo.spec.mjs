import { test, expect } from '@playwright/test';

for (const viewport of [{ width: 1360, height: 900 }, { width: 390, height: 844 }]) {
 test(`the visible demo verifies and resets at ${viewport.width}px`, async ({ page }) => {
  await page.setViewportSize(viewport);
  await page.goto('/');
  await page.getByRole('button', { name: 'Run sample workflow' }).click();
  await expect(page.locator('#demo-result')).toHaveAttribute('data-state', 'passed');
  await expect(page.locator('#demo-progress .passed')).toHaveCount(8);
  await expect(page.locator('#email')).toHaveValue('demo@example.test');
  await expect(page.locator('#shipping')).toHaveValue('Send me a link');
  await expect(page.locator('#promo')).toHaveValue('DEMO');
  await expect(page.locator('#shadow-host')).toHaveAttribute('data-selected', 'true');
  await expect(page.frameLocator('iframe').locator('[data-agent-target="payment-demo"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#demo-result')).toContainText('no real order or payment');
  await expect(page.getByRole('button', { name: 'Run sample workflow' })).toBeDisabled();
  await page.getByRole('button', { name: 'Reset demo' }).click();
  await expect(page.getByRole('button', { name: 'Run sample workflow' })).toBeEnabled();
  await expect(page.locator('#email')).toHaveValue('');
  await expect(page.locator('#status')).toHaveText('Ready for an agent.');
});

}

test('the visible demo stops on a guarded refusal without claiming success', async ({ page }) => {
  await page.goto('/');
  await page.locator('#email').evaluate(/** @param {HTMLInputElement} input */ input => { input.disabled = true; });
  await page.getByRole('button', { name: 'Run sample workflow' }).click();
  await expect(page.locator('#demo-result')).toHaveAttribute('data-state', 'failed');
  await expect(page.locator('#demo-result')).toContainText('No step was retried');
  await expect(page.locator('#demo-progress .failed')).toContainText('UNAVAILABLE');
  await expect(page.locator('#demo-progress .passed')).toHaveCount(0);
  await expect(page.locator('#status')).toHaveText('Ready for an agent.');
});
