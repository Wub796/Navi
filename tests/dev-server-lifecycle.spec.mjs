import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { test, expect } from '@playwright/test';

// The webServer this suite runs against is `scripts/dev.mjs --port 4174`, and an
// interrupted pre-push hook used to strand that process re-parented to pid 1: the
// next run died on `EADDRINUSE` before the suite could say anything else. The
// lifecycle is a contract and is tested here without a browser — the three rules:
// SIGTERM must end the process; the next instance must reclaim the port held by a
// stale instance of the script itself; and a listener that is *not* this script
// must never be touched, only refused cleanly.

/** One free port, bound and released again, chosen the way `net` does it. */
async function freePort() {
  const server = createServer();
  await new Promise(/** @param {(value?: void) => void} resolve */ resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

/**
 * Spawn the script the way the runner does, and wait for its announce line — that
 * line is how every other consumer learns the server is up, so a test that polled
 * the port instead would pass with a half-listening socket this contract forbids.
 * @param {number} port
 * @returns {{child: import('node:child_process').ChildProcess, ready: Promise<string>, output: () => string}}
 */
function startDev(port) {
  const child = spawn(process.execPath, ['scripts/dev.mjs', '--port', String(port)], { stdio: /** @type {['ignore', 'pipe', 'pipe']} */ (['ignore', 'pipe', 'pipe']) });
  let text = '';
  const ready = new Promise((resolve, reject) => {
    child.stdout?.on('data', chunk => {
      text += String(chunk);
      if (text.includes('Navi demo')) resolve('ready');
    });
    child.stderr?.on('data', chunk => { text += String(chunk); });
    child.on('exit', code => { text += `\n[exit ${code}]`; reject(new Error(`dev.mjs exited ${code} before announcing: ${text}`)); });
  });
  return { child, ready, output: () => text };
}

test('SIGTERM stops the server cleanly with exit code 0', async () => {
  const port = await freePort();
  const { child, ready } = startDev(port);
  await expect(ready).resolves.toBe('ready');
  const page = await fetch(`http://127.0.0.1:${port}/`);
  expect(page.status).toBe(200);
  child.kill('SIGTERM');
  const [code] = await new Promise(resolve => child.on('exit', (c, signal) => resolve([c, signal])));
  expect(code).toBe(0);
});

test('a fresh instance reclaims the port a stale instance of the script holds', async () => {
  const port = await freePort();
  const stale = startDev(port);
  await expect(stale.ready).resolves.toBe('ready');
  // The replacement boots despite the holder: it must reclaim the stale instance
  // itself, not merely refuse and leave the runner to debug the next EADDRINUSE.
  const fresh = startDev(port);
  const settled = await Promise.race([fresh.ready.then(() => 'ready'), new Promise(resolve => setTimeout(() => resolve('timeout'), 10_000))]);
  console.log('FRESH_CHILD_OUTPUT:', JSON.stringify(fresh.output()));
  console.log('STALE_ALIVE:', stale.child.exitCode, 'EXIT:', settled);
  if (settled !== 'ready') throw new Error('fresh instance did not become ready; output above');
  const page = await fetch(`http://127.0.0.1:${port}/`);
  expect(page.status).toBe(200);
  // And the stale instance goes away rather than living on as a zombie socket.
  expect(await exited(stale.child, 5_000)).toBe(true);
  fresh.child.kill('SIGKILL');
});

test('a listener that is not this script is never reclaimed, only refused', async () => {
  const held = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('foreign'); });
  await new Promise(/** @param {(value?: void) => void} resolve */ resolve => held.listen(0, '127.0.0.1', () => resolve()));
  const port = /** @type {import('node:net').AddressInfo} */ (held.address()).port;
  try {
    const child = spawn(process.execPath, ['scripts/dev.mjs', '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    child.stderr?.on('data', chunk => { text += String(chunk); });
    const exit = new Promise(resolve => child.on('exit', code => resolve(code)));
    // The refusal is a decision, not a crash and not a hang on the busy port.
    expect(await exit).toBe(1);
    expect(text).toContain('not reclaimed');
    // And the foreign listener survives untouched — it is still the one answering.
    const page = await fetch(`http://127.0.0.1:${port}/`);
    expect(await page.text()).toBe('foreign');
  } finally {
    await new Promise(resolve => held.close(resolve));
  }
});

/** @param {import('node:child_process').ChildProcess} child @param {number} withinMs @returns {Promise<boolean>} */
async function exited(child, withinMs) {
  // An 'exit' listener has to be attached before the event fires, and the stale
  // child may already have been reaped by the time the assertion runs, so the
  // check is on the recorded exit code with the listener attached only to catch
  // a child that is still shutting down.
  if (child.exitCode !== null) return true;
  return Promise.race([
    new Promise(resolve => child.once('exit', () => resolve(true))),
    new Promise(resolve => setTimeout(() => resolve(false), withinMs))
  ]);
}
