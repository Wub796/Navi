import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createTcrApp } from '../tests/fixtures/tcr-app.mjs';

if (process.argv.includes('--help')) {
  console.log('Usage: npm run dev -- [--host 127.0.0.1] [--port 4173]');
  process.exit(0);
}
/** @param {string} flag @param {string} fallback */
function option(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1] || fallback;
}
const host = option('--host', '127.0.0.1');
const port = Number(option('--port', '4173'));
// Strict policy for the CSP compliance fixture: no inline scripts, no inline styles
// and no eval relaxation. The nonce is present so the header matches a real
// enterprise deployment, though this fixture deliberately needs no inline script.
const csp = "default-src 'self'; script-src 'self' 'nonce-naviCspNonce'; style-src 'self'; object-src 'none'; base-uri 'none'";
/** @type {Map<string, [string, string, string?]>} */
const routes = new Map([
  ['/', ['demo/index.html', 'text/html; charset=utf-8']],
  ['/workflow-demo.js', ['demo/workflow-demo.js', 'application/javascript; charset=utf-8']],
  ['/frame.html', ['demo/frame.html', 'text/html; charset=utf-8']],
  ['/auth.html', ['demo/auth.html', 'text/html; charset=utf-8']],
  ['/settlement.html', ['demo/settlement.html', 'text/html; charset=utf-8']],
  ['/navi.min.js', ['dist/navi.min.js', 'application/javascript; charset=utf-8']],
  ['/favicon.ico', ['', 'image/x-icon']],
  ['/csp.html', ['demo/csp.html', 'text/html; charset=utf-8', csp]],
  ['/csp.css', ['demo/csp.css', 'text/css; charset=utf-8', csp]],
  ['/csp-lab.js', ['demo/csp-lab.js', 'application/javascript; charset=utf-8', csp]],
  // Both no-script URLs serve the same fixture on purpose: behaviour must not depend
  // on which of them a caller reaches for.
  ['/csp-none.html', ['demo/csp-none.html', 'text/html; charset=utf-8', csp]],
  ['/csp-no-script.html', ['demo/csp-none.html', 'text/html; charset=utf-8', csp]]
]);
/** Start the disposable checkout backend only when its review URL is opened. @type {ReturnType<typeof createTcrApp> | undefined} */
let checkout;

/**
 * Run a command, resolving errors into the result rather than rejecting, so a missing
 * binary or a nonzero exit is data for the caller instead of an unhandled rejection.
 * @param {string} file @param {string[]} args @param {number} timeoutMs
 * @returns {Promise<{ok: boolean, out: string}>}
 */
function execText(file, args, timeoutMs) {
  return new Promise(resolve => {
    execFile(file, args, { timeout: timeoutMs }, (error, stdout) => {
      resolve({ ok: error === null, out: error ? String(stdout ?? '') + String(/** @type {any} */ (error).message ?? '') : String(stdout ?? '') });
    });
  });
}

/**
 * The pids listening on the port — `lsof` where installed, `ss -ltnp` where only the
 * iproute2 pair is. Empty when neither binary answers or nothing listens; the caller
 * treats that unknown the same as an unblocked port.
 * @param {number} port @returns {Promise<string[]>}
 */
async function listenerPids(port) {
  const lsof = await execText('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], 5_000);
  if (lsof.ok && lsof.out.trim()) return lsof.out.trim().split(/\s+/);
  const ss = await execText('ss', ['-ltnp'], 5_000);
  const pids = [];
  for (const line of ss.ok ? ss.out.split('\n') : []) {
    if (!line.includes(`:${port} `)) continue;
    for (const group of line.match(/pid=(\d+)/g) ?? []) pids.push(group.slice(4));
  }
  return pids;
}

/**
 * Which instances of this script the listeners are. A dev server left over from a run
 * whose whole process tree was killed outright — an interrupted pre-push hook whose
 * webServer is re-parented to pid 1 — reappears on the next run as an EADDRINUSE the
 * runner cannot see into. The first process to answer a probe, however, could be any
 * application, so this matches on the command line and only ever reclaims a process
 * running this exact file.
 * @param {string[]} pids @returns {Promise<string[]>}
 */
async function ownStalePids(pids) {
  const self = fileURLToPath(import.meta.url).split('/').slice(-2).join('/');
  const own = [];
  for (const pid of pids) {
    const ps = await execText('ps', ['-p', pid, '-o', 'command='], 5_000);
    if (ps.ok && ps.out.replace(/\.mjs$/, '').includes(self)) own.push(pid);
  }
  return own;
}

/**
 * Effect of a reclaim attempt on the port: 'reclaimed' and 'unblocked' authorize a
 * rebind, 'unclaimed' means the holder is not this script or would not die.
 * @returns {Promise<'reclaimed' | 'unclaimed' | 'unblocked'>}
 */
async function reclaimStaleListener() {
  const pids = await listenerPids(port);
  if (pids.length === 0) return 'unblocked';
  const own = await ownStalePids(pids);
  if (own.length === 0) return 'unclaimed';
  for (const pid of own) process.kill(Number(pid), 'SIGTERM');
  // Killing is not freeing: the SIGTERM handler closes sockets first, so the port
  // polls until it is actually free before the listener rebinds.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await listenerPids(port)).length === 0) return 'reclaimed';
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return 'unclaimed';
}

const server = createServer(async (req, res) => {
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  if (pathname === '/tcr-checkout.html') {
    try {
      checkout ??= createTcrApp();
      res.writeHead(302, { Location: `${(await checkout).origin}/checkout?seed=1` });
      res.end();
    } catch { res.writeHead(500); res.end('Checkout fixture unavailable'); }
    return;
  }
  const route = routes.get(pathname);
  if (!route) { res.writeHead(404); res.end('Not found'); return; }
  if (!route[0]) { res.writeHead(204); res.end(); return; }
  try {
    const body = await readFile(fileURLToPath(new URL(`../${route[0]}`, import.meta.url)));
    const headers = /** @type {Record<string, string>} */ ({ 'Content-Type': route[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    if (route[2]) headers['Content-Security-Policy'] = route[2];
    res.writeHead(200, headers);
    res.end(body);
  } catch (error) {
    console.error(error);
    res.writeHead(500); res.end('Build assets first with npm run build');
  }
});

server.listen(port, host, () => console.log(`Navi demo: http://${host}:${port} (PID ${process.pid})`));

 /**
  * After the EADDRINUSE probe, a rebinding attempt fired exactly once through the
  * same listen invocation — so the success surfaces as the ordinary announce
  * callback. There is no chain of retries. The reclaim has one shot, because
  * looping on 'reclaimed' stops being a signal, and any new 'error' is over.
  */
server.on('error', async error => {
  if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EADDRINUSE') {
    console.error(error);
    process.exit(1);
  }
  const outcome = await reclaimStaleListener();
  if (outcome !== 'reclaimed' && outcome !== 'unblocked') {
    console.error(`Port ${port} on ${host} is held by a process that is not this dev server, so it was not reclaimed. Free the port or pass a different --port.`);
    process.exit(1);
  }
  server.listen(port, host);
});

/**
 * Stop the socket and the disposable checkout fixture, then exit for real. Without
 * the explicit exit, a keep-alive connection or the checkout child keeps the event
 * loop alive, and the process outlives the run that started it — exactly the way
 * interrupted pre-push hooks left PPID-1 orphans on this port in v0.6.8.
 */
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  server.close();
  if (checkout) await (await checkout).close();
  // A drained socket closes the listener, but a client's keep-alive request can
  // hold one open for up to Node's default timeout, so the cleanup above gets a
  // one-second deadline after which the process leaves regardless.
  setTimeout(process.exit, 1_000).unref();
  process.exit(0);
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, shutdown);
