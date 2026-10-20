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
    // True, deliberately: an interrupted pre-push hook once left this server
    // re-parented to pid 1 (its whole process tree was killed outright, so
    // SIGTERM cleanup never ran), and the next run stopped at Playwright's own
    // TCP port probe — `4174 is already used` — before the command could ever
    // run, which is why no reclaim inside scripts/dev.mjs could help. With
    // reuse enabled the probe and the contract agree: a stale instance answers
    // HTTP by reading its fixtures from disk on every request, so reuse serves
    // the current checkout; a listener that is not this script gets refused by
    // the command below instead of being adopted silently. The one weaker guarantee
    // reuse brings is that something unrelated on 4174 -- this suite's dedicated
    // port, not a shared one -- would answer the probe as if it were the demo
    // server; that is the trade, and tests/dev-server-lifecycle.spec.mjs is where
    // the rest of the contract is priced.
    reuseExistingServer: true,
    timeout: 10000
  }
});
