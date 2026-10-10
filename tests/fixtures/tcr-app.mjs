import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

/** A local sandbox: no payment provider, external network, or real orders. */
export async function createTcrApp() {
  /** @type {Map<string, {seed: number, quantity: number, email: string, shipping: string, order: string | null}>} */
  const carts = new Map();
  const html = await readFile(new URL('../../demo/tcr-checkout.html', import.meta.url));
  const sdk = await readFile(new URL('../../dist/navi.min.js', import.meta.url));
  const server = createServer((req, res) => {
    void handle().catch(error => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(error) }));
    });
    async function handle() {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const json = (/** @type {number} */ status, /** @type {unknown} */ body) => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'GET' && url.pathname === '/checkout') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html); return;
      }
      if (url.pathname === '/navi.min.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' }); res.end(sdk); return;
      }
      if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      const cartId = url.searchParams.get('cart') ?? '';
      const cart = carts.get(cartId);
      if (req.method === 'GET' && url.pathname === '/api/order') {
        return cart?.order ? json(200, { order: cart.order, product: 'Trail backpack', quantity: cart.quantity, email: cart.email, shipping: cart.shipping, totalCents: cart.quantity * 4900 + 900 }) : json(404, { error: 'No committed order' });
      }
      if (req.method !== 'POST' || !url.pathname.startsWith('/api/')) return json(404, { error: 'Not found' });
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 2048) return json(413, { error: 'Too large' });
      }
      const body = JSON.parse(raw || '{}');
      const seed = cart?.seed ?? Number(body.seed);
      if (!Number.isInteger(seed) || seed < 1 || seed > 10) return json(400, { error: 'Invalid trial seed' });
      // Paired paths get the same reproducible 60–260ms response schedule.
      const delay = 60 + ((seed * 37 + url.pathname.length * 19) % 201);
      await new Promise(resolve => setTimeout(resolve, delay));
      if (url.pathname === '/api/cart') {
        if (body.product !== 'Trail backpack' || !Number.isInteger(body.quantity) || body.quantity < 1 || body.quantity > 3) return json(400, { error: 'Invalid cart' });
        const id = randomUUID();
        carts.set(id, { seed, quantity: body.quantity, email: '', shipping: '', order: null });
        return json(201, { cart: id, quantity: body.quantity });
      }
      if (!cart) return json(404, { error: 'Unknown cart' });
      if (url.pathname === '/api/shipping') {
        if (body.shipping !== 'express') return json(400, { error: 'Choose express shipping' });
        cart.shipping = body.shipping;
        return json(200, { totalCents: cart.quantity * 4900 + 900 });
      }
      if (url.pathname === '/api/order') {
        if (cart.order || cart.shipping !== 'express' || body.email !== 'agent@example.test') return json(409, { error: 'Invalid or duplicate order' });
        cart.email = body.email;
        cart.order = randomUUID();
        return json(201, { order: cart.order });
      }
      return json(404, { error: 'Not found' });
    }
  });
  await new Promise(/** @param {(value?: void) => void} resolve */ resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture address');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise(/** @param {(value?: void) => void} resolve */ resolve => server.close(() => resolve()))
  };
}
