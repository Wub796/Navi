import { createServer } from 'node:http';
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
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
  server.close();
  if (checkout) await (await checkout).close();
});
