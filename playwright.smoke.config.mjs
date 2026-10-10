import { defineConfig } from '@playwright/test';

// External smoke suite: a non-destructive check of the shipped SDK against a
// live, public, dynamic SPA. It intentionally has no webServer and no local
// fixtures, so it is kept out of the hermetic suite (see playwright.config.mjs)
// and run on its own schedule or on demand.
export default defineConfig({
  testDir: './tests',
  testMatch: 'external-smoke.spec.mjs',
  timeout: 120000,
  expect: { timeout: 15000 },
  workers: 1,
  fullyParallel: false,
  // A third-party origin can be transiently unavailable; one retry separates a
  // real regression from a blip, and a retried pass is still reported as flaky.
  retries: 1,
  reporter: 'list',
  use: { browserName: 'chromium', headless: true, trace: 'retain-on-failure', launchOptions: { chromiumSandbox: true } }
});
