import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAVI_PROTOCOL_VERSION } from '../src/adapter.js';
import { RESOLUTION_STRATEGY_MAP, assertResolutionParity } from '../src/mcp/server.js';

/**
 * Manifest negotiation checks.
 *
 * Phase 4 taught `navi_navigate` to notice that a page declares itself
 * instrumented; this suite covers what it does next — read the host's own
 * discovery document from the page origin, inject the asset that document
 * designates (verifying a declared subresource integrity hash before a byte of it
 * executes), and fall back to the packaged build with a reason whenever anything
 * about that negotiation is unusable.
 *
 * The fixture is a host origin that can be told to behave badly in one specific
 * way per case, and it logs every request with the user agent that made it. That
 * log is how these tests tell a server-side fetch of the declared asset from a
 * browser fetch of it, which is the difference between injecting verified bytes
 * and trusting a URL.
 */
const root = fileURLToPath(new URL('..', import.meta.url));

/** How the fixture's discovery document should behave for the next request. */
/** @typedef {'valid' | 'incompatible' | 'slow' | 'well-known-missing'} ManifestMode */
/** @typedef {'meta' | 'link' | 'cross-origin-link' | 'none'} Advertise */
/** @typedef {{url: string, agent: string}} Hit */

const state = /** @type {{
  fixture: import('node:http').Server | null,
  origin: string,
  advertise: Advertise,
  manifest: ManifestMode,
  integrity: 'correct' | 'tampered' | 'omitted',
  hits: Hit[],
  sdk: Buffer,
  sri: string,
  pending: NodeJS.Timeout | null
}} */ ({ fixture: null, origin: '', advertise: 'meta', manifest: 'valid', integrity: 'correct', hits: [], sdk: Buffer.alloc(0), sri: '', pending: null });

/** The tampered copy announces itself in the title, so a test can prove it never ran. */
const tampered = () => Buffer.concat([Buffer.from("document.title='tampered-runtime';\n"), state.sdk]);

test.beforeAll(async () => {
  state.sdk = await readFile(join(root, 'dist/navi.min.js'));
  state.sri = (await readFile(join(root, 'dist/sri.txt'), 'utf8')).trim();
  state.fixture = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    state.hits.push({ url: `${url.pathname}${url.search}`, agent: String(req.headers['user-agent'] ?? '') });
    /** @type {Record<string, string>} */
    const headers = { 'Cache-Control': 'no-store' };
    const html = (/** @type {string} */ body, /** @type {string} */ extra = '') => {
      res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8', ...(extra ? { Link: extra } : {}) });
      res.end(body);
    };
    const json = (/** @type {unknown} */ body) => {
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/host-runtime.js') {
      const bytes = state.integrity === 'tampered' ? tampered() : state.sdk;
      res.writeHead(200, { ...headers, 'Content-Type': 'application/javascript; charset=utf-8', 'Content-Length': String(bytes.length) });
      res.end(bytes);
      return;
    }
    if (url.pathname === '/.well-known/navi.json') {
      if (state.manifest === 'well-known-missing') {
        res.writeHead(404, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      const body = () => {
        const document = {
          version: state.manifest === 'incompatible' ? '0.2.0' : NAVI_PROTOCOL_VERSION,
          protocol: '2025-11-25',
          status: 'ready',
          capabilities: ['viewport_indexing', 'differential_actions', 'settlement_receipts'],
          endpoints: { mcp_sse: 'http://127.0.0.1:3001/sse', script: '/host-runtime.js' }
        };
        // The hash the host declares for the bytes it serves. 'correct' declares the
        // real hash of the real bundle, 'tampered' declares the real hash while the
        // fixture serves a rewritten copy, and 'omitted' declares none at all.
        return state.integrity === 'omitted' ? document : { ...document, integrity: state.sri };
      };
      // The 500ms budget is the whole point of 'slow': a host that cannot answer
      // inside it is treated as publishing nothing. The late write is guarded
      // because the client has already aborted by then.
      if (state.manifest === 'slow') {
        state.pending = setTimeout(() => {
          if (res.destroyed || res.writableEnded) return;
          try { json(body()); } catch { /* the caller is gone */ }
        }, 5000);
      } else json(body());
      return;
    }
    if (url.pathname === '/') {
      const marker = state.advertise === 'meta' ? `<meta name="agent-bridge" content="active" data-version="${NAVI_PROTOCOL_VERSION}">` : '';
      const link = state.advertise === 'cross-origin-link'
        ? '<http://127.0.0.1:1/.well-known/navi.json>; rel="agent-bridge"'
        : state.advertise === 'link' ? '</.well-known/navi.json>; rel="agent-bridge"' : '';
      html(`<!doctype html>
<html lang="en">
<head><title>manifest loop fixture</title>${marker}</head>
<body><button data-agent-target="probe">Probe</button></body>
</html>`, link);
      return;
    }
    res.writeHead(404, { ...headers });
    res.end();
  });
  await new Promise(/** @param {(value?: void) => void} resolve */ resolve => state.fixture?.listen(0, '127.0.0.1', () => resolve()));
  const address = state.fixture?.address();
  state.origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

test.afterAll(async () => {
  if (state.pending) clearTimeout(state.pending);
  await new Promise(/** @param {(value?: void) => void} resolve */ resolve => state.fixture?.close(() => resolve()) ?? resolve());
});

/** Reset the fixture to one exact behaviour and clear the request log. */
const configure = (/** @type {{advertise?: Advertise, manifest?: ManifestMode, integrity?: 'correct' | 'tampered' | 'omitted'}} */ next) => {
  state.advertise = next.advertise ?? 'meta';
  state.manifest = next.manifest ?? 'valid';
  state.integrity = next.integrity ?? 'correct';
  state.hits = [];
};

const assetHits = () => state.hits.filter(hit => hit.url === '/host-runtime.js');
const manifestHits = () => state.hits.filter(hit => hit.url === '/.well-known/navi.json');

/**
 * The receipt publishes the runtime source twice, and the two must agree. The table
 * is the contract between them, so this reads the published source back through the
 * table instead of asserting that the two fields merely equal each other: a source
 * that no decision maps to is exactly the drift this guards against.
 * @param {any} receipt
 */
const expectResolutionParity = receipt => {
  const source = receipt.sdk.source;
  expect(receipt.runtime_resolution.strategy, 'the receipt publishes its runtime source twice').toBe(source);
  const decisions = Object.entries(RESOLUTION_STRATEGY_MAP).filter(([, mapped]) => mapped === source).map(([decision]) => decision);
  expect(decisions, `${source} must be the published source of exactly one decision`).toHaveLength(1);
  expect(assertResolutionParity(source, /** @type {string} */ (decisions[0]))).toBe(source);
};

test('a declared host runtime is negotiated, verified and injected instead of the packaged build', async () => {
  test.setTimeout(180000);
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'bin/navi-mcp.js')], cwd: root, stderr: 'pipe', env: { ...process.env, NAVI_ALLOW_LOCAL_NETWORK: '1' } });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += String(chunk); });
  const client = new Client({ name: 'navi-manifest-e2e', version: '1.0.0' });
  await client.connect(transport);
  /** @param {any} result @returns {any} */
  const envelope = result => JSON.parse(result.content[0].text);
  /** @param {string} url @returns {Promise<any>} */
  const navigate = async url => {
    const started = Date.now();
    const result = await client.callTool({ name: 'navi_navigate', arguments: { url } });
    expect(stderr, `the MCP server must not fail: ${stderr}`).not.toContain('error:');
    return { ...envelope(result), elapsedMs: Date.now() - started, isError: result.isError === true };
  };
  try {
    // 1. A manifest that declares a hash: the bytes are fetched and checked by this
    //    process, so the browser never requests the asset at all.
    configure({});
    const verified = await navigate(`${state.origin}/`);
    expect(verified.isError).toBe(false);
    expect(verified.sdk).toEqual({ strategy: 'tag', injected: true, source: 'host_manifest' });
    expect(verified.protocolVersion).toBe(NAVI_PROTOCOL_VERSION);
    expect(verified.discovery).toEqual({
      instrumented: true,
      source: 'meta-tag',
      declared_version: NAVI_PROTOCOL_VERSION,
      manifest: `${state.origin}/.well-known/navi.json`,
      script: `${state.origin}/host-runtime.js`,
      integrity: 'verified'
    });
    expect(verified.warning).toBeUndefined();
    // The receipt says which runtime is running and where it came from, separately
    // from `discovery.source`, which only says how instrumentation was detected.
    expect(verified.runtime_resolution).toEqual({
      strategy: 'host_manifest',
      manifest_url: `${state.origin}/.well-known/navi.json`,
      script_origin: 'host'
    });
    expectResolutionParity(verified);
    expect(verified.actions).toBeGreaterThan(0);
    expect(manifestHits().length, 'the manifest is read once per navigation').toBe(1);
    expect(manifestHits()[0].agent, 'a same-origin manifest is read by this process, not the page').not.toContain('Mozilla');
    expect(assetHits().length).toBe(1);
    expect(assetHits()[0].agent, 'verified bytes are injected as a body, so the browser never fetches the asset').not.toContain('Mozilla');

    // 2. The same manifest without a hash: nothing can be verified, so the browser
    //    loads the declared URL itself and the receipt says so.
    configure({ integrity: 'omitted' });
    const urlLoaded = await navigate(`${state.origin}/`);
    expect(urlLoaded.sdk).toEqual({ strategy: 'tag', injected: true, source: 'host_manifest' });
    expect(urlLoaded.discovery.integrity).toBe('not_declared');
    expect(urlLoaded.discovery.script).toBe(`${state.origin}/host-runtime.js`);
    expect(assetHits().length).toBe(1);
    expect(assetHits()[0].agent, 'an unverified asset is loaded by the browser as a URL').toContain('Mozilla');
    expect(urlLoaded.actions).toBeGreaterThan(0);

    // 3. A rewritten asset that no longer matches the declared hash is refused: the
    //    packaged runtime runs instead, and the tampered copy never executes. Its
    //    first statement renames the document, which is how that is observable.
    configure({ integrity: 'tampered' });
    const mismatched = await navigate(`${state.origin}/`);
    expect(mismatched.title).toBe('manifest loop fixture');
    expect(mismatched.sdk).toEqual({ strategy: 'tag', injected: true, source: 'bundled_fallback' });
    expect(mismatched.discovery.integrity).toBe('failed');
    // A document that was read but not adopted is still a document that was read, so
    // the receipt names it while reporting that the running script is the packaged one.
    expect(mismatched.runtime_resolution).toEqual({
      strategy: 'bundled_fallback',
      manifest_url: `${state.origin}/.well-known/navi.json`,
      script_origin: 'bundled'
    });
    expect(mismatched.discovery.script).toBe(`${state.origin}/host-runtime.js`);
    expectResolutionParity(mismatched);
    expect(mismatched.warning?.code).toBe('HOST_ASSET_MISMATCH');
    expect(mismatched.warning?.message).toContain('subresource integrity');
    expect(mismatched.protocolVersion).toBe(NAVI_PROTOCOL_VERSION);
    expect(mismatched.actions).toBeGreaterThan(0);

    // 4. A manifest declaring another protocol version is declined before anything
    //    is injected from it.
    configure({ manifest: 'incompatible' });
    const incompatible = await navigate(`${state.origin}/`);
    expect(incompatible.sdk.source).toBe('bundled_fallback');
    expect(incompatible.warning?.code).toBe('MANIFEST_INCOMPATIBLE');
    expect(incompatible.warning?.message).toContain('0.2.0');
    expect(incompatible.discovery.script, 'nothing off a declined manifest is adopted').toBeNull();
    expect(incompatible.runtime_resolution).toEqual({
      strategy: 'bundled_fallback',
      manifest_url: `${state.origin}/.well-known/navi.json`,
      script_origin: 'bundled'
    });
    expectResolutionParity(incompatible);
    expect(assetHits().length, 'a declined manifest is not followed').toBe(0);
    expect(incompatible.actions).toBeGreaterThan(0);

    // 5. A manifest that does not answer inside the budget is abandoned, and the
    //    navigation does not wait for it: the fixture holds the response for five
    //    seconds and the call still returns in a fraction of that.
    configure({ manifest: 'slow' });
    const slow = await navigate(`${state.origin}/`);
    expect(slow.sdk.source).toBe('bundled_fallback');
    expect(slow.warning?.code).toBe('MANIFEST_UNREACHABLE');
    // Nothing was read, so nothing is named: a manifest that never answered must not
    // appear in the receipt as though it had.
    expect(slow.runtime_resolution).toEqual({ strategy: 'bundled_fallback', manifest_url: null, script_origin: 'bundled' });
    expectResolutionParity(slow);
    expect(slow.warning?.message).toContain('500ms');
    expect(slow.elapsedMs, `the manifest budget must not hold up the navigation (took ${slow.elapsedMs}ms)`).toBeLessThan(4000);
    expect(slow.actions).toBeGreaterThan(0);

    // 6. A host that publishes its document elsewhere is refused outright: a page
    //    must not be able to point the agent's own network at an arbitrary origin.
    configure({ advertise: 'cross-origin-link' });
    const crossOrigin = await navigate(`${state.origin}/`);
    expect(crossOrigin.sdk.source).toBe('bundled_fallback');
    expect(crossOrigin.warning?.code).toBe('MANIFEST_CROSS_ORIGIN');
    expect(manifestHits().length, 'the off-origin document is never fetched').toBe(0);
    expect(crossOrigin.discovery.manifest).toBe('http://127.0.0.1:1/.well-known/navi.json');
    // The advertised URL is reported by `discovery`, and the refused fetch leaves
    // `manifest_url` null: the two fields are not the same question.
    expect(crossOrigin.runtime_resolution).toEqual({ strategy: 'bundled_fallback', manifest_url: null, script_origin: 'bundled' });
    expectResolutionParity(crossOrigin);
    expect(crossOrigin.actions).toBeGreaterThan(0);

    // 7. A page that declares nothing is not probed at all: no manifest request is
    //    made on its behalf, and the reason names the missing marker.
    configure({ advertise: 'none' });
    const uninstrumented = await navigate(`${state.origin}/`);
    expect(uninstrumented.warning?.code).toBe('UNINSTRUMENTED_HOST');
    expect(manifestHits().length, 'an uninstrumented host is not probed').toBe(0);
    expect(uninstrumented.discovery.instrumented).toBe(false);
    expect(uninstrumented.runtime_resolution).toEqual({ strategy: 'bundled_fallback', manifest_url: null, script_origin: 'bundled' });
    expect(uninstrumented.sdk.source).toBe('bundled_fallback');
    expectResolutionParity(uninstrumented);
    expect(uninstrumented.actions).toBeGreaterThan(0);

    // 8. A 404 on the advertised path is the same answer as no document at all, and
    //    the fetch is not retried.
    configure({ advertise: 'link', manifest: 'well-known-missing' });
    const missing = await navigate(`${state.origin}/`);
    expect(missing.warning?.code).toBe('MANIFEST_UNREACHABLE');
    expect(missing.warning?.message).toContain('404');
    expect(manifestHits().length).toBe(1);
    expect(missing.runtime_resolution).toEqual({ strategy: 'bundled_fallback', manifest_url: null, script_origin: 'bundled' });
    expect(missing.sdk.source).toBe('bundled_fallback');
    expectResolutionParity(missing);
    expect(missing.actions).toBeGreaterThan(0);
  } finally {
    await client.close();
  }
});

test('every runtime decision maps to exactly one published source, and a divergent pair fails closed', async () => {
  // The invariant `navi_navigate` enforces before it returns: one decision per
  // navigation, one published source, and a frozen table that is the only thing
  // allowed to say which source a decision publishes. The E2E test above proves the
  // branches reach a consistent receipt; this pins the table itself, including the
  // paths a browser cannot be driven into.
  expect(Object.isFrozen(RESOLUTION_STRATEGY_MAP)).toBe(true);
  expect(RESOLUTION_STRATEGY_MAP).toEqual({ page: 'host_inline', host_manifest: 'host_manifest', bundled: 'bundled_fallback' });

  // Every valid decision resolves to its own source and returns it, and the mapping
  // is injective: a published source names exactly one decision, so a receipt can be
  // read back to the branch that produced it.
  for (const [decision, expected] of Object.entries(RESOLUTION_STRATEGY_MAP)) {
    expect(assertResolutionParity(expected, decision)).toBe(expected);
  }
  expect(new Set(Object.values(RESOLUTION_STRATEGY_MAP)).size).toBe(Object.keys(RESOLUTION_STRATEGY_MAP).length);

  /** @param {() => unknown} call @returns {unknown} */
  const codeOf = call => {
    try {
      call();
      return null;
    } catch (error) {
      return /** @type {{code?: unknown}} */ (error).code;
    }
  };

  // A decision that resolves to the wrong source is a receipt that contradicts
  // itself, so it throws rather than being reported - with the code the navigation
  // envelope carries, not an anonymous failure.
  for (const [decision, expected] of Object.entries(RESOLUTION_STRATEGY_MAP)) {
    const wrong = /** @type {string} */ (Object.values(RESOLUTION_STRATEGY_MAP).find(source => source !== expected));
    expect(codeOf(() => assertResolutionParity(wrong, decision))).toBe('NAVI_RESOLUTION_DIVERGED');
    expect(() => assertResolutionParity(wrong, decision)).toThrow(/NAVI_RESOLUTION_DIVERGED/);
  }
  // A source that is close to the right one is still divergent, and so is a missing
  // one: a guard that accepted either would not be a guard.
  expect(codeOf(() => assertResolutionParity('host_inline', 'host_manifest'))).toBe('NAVI_RESOLUTION_DIVERGED');
  // An absent source is not a wildcard either. The cast is the point: the types say a
  // string is always passed, and JavaScript callers are not bound by the types.
  expect(codeOf(() => assertResolutionParity(/** @type {string} */ (/** @type {unknown} */ (undefined)), 'page'))).toBe('NAVI_RESOLUTION_DIVERGED');

  // A decision added without extending the table would otherwise publish `undefined`
  // as a runtime source, so it is its own explicit failure.
  expect(codeOf(() => assertResolutionParity('host_inline', 'host-manifest'))).toBe('NAVI_RESOLUTION_UNMAPPED');
  expect(() => assertResolutionParity('bundled_fallback', 'bundled')).not.toThrow();

  // The guard is only worth anything if the navigation actually runs it, and the
  // receipt's own `strategy` is derived from the same table. Asserting both here is a
  // tripwire for rewiring the receipt, not a spelling check: moving or removing the
  // call, or publishing `source` straight through it, must fail this test so the
  // receipt cannot silently stop being validated.
  const serverSource = await readFile(join(root, 'src/mcp/server.js'), 'utf8');
  expect(serverSource, 'navi_navigate must validate the pair before returning a receipt')
    .toMatch(/assertResolutionParity\(\s*source\s*,\s*resolution\s*\)/);
  expect(serverSource, 'the receipt must publish the source the table derives, not the branch variable')
    .toMatch(/strategy:\s*RESOLUTION_STRATEGY_MAP\[resolution\]/);
});
