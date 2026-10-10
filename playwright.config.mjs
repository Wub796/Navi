import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // The hermetic suite must stay offline. The external smoke test runs against a
  // live third-party origin and is driven by playwright.smoke.config.mjs instead.
  testIgnore: ['**/external-smoke.spec.mjs'],
  timeout: 60000,
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  // The runner's own browser keeps the sandbox the shipped launch paths use:
  // Playwright appends --no-sandbox unless chromiumSandbox is requested, and a
  // test browser that is less locked down than production proves less.
  use: { baseURL: 'http://127.0.0.1:4174', browserName: 'chromium', headless: true, launchOptions: { chromiumSandbox: true } },
  webServer: {
    command: 'node scripts/dev.mjs --host 127.0.0.1 --port 4174',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: false,
    timeout: 10000
  }
});
