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
  use: { baseURL: 'http://127.0.0.1:4174', browserName: 'chromium', headless: true },
  webServer: {
    command: 'node scripts/dev.mjs --host 127.0.0.1 --port 4174',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: false,
    timeout: 10000
  }
});
