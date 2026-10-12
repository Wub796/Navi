import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  AGENT_BRIDGE_LINK,
  AGENT_CAPABILITIES,
  DEFAULT_MCP_SSE_URL,
  DISCOVERY_CACHE_CONTROL,
  MCP_PROTOCOL_REVISION,
  NAVI_PROTOCOL_VERSION as HOST_PROTOCOL_VERSION,
  SCRIPT_ENDPOINT_PATH,
  SOURCE_ENDPOINT_PATH,
  SOURCE_REPOSITORY_URL,
  createNaviHostServer
} from '../server/index.js';
import { DEV_TENANT_KEY } from '../server/tenants.js';
import { NAVI_PROTOCOL_VERSION } from '../src/adapter.js';
import { PROTOCOL_VERSION, SUPPORTED_PROTOCOLS } from '../src/mcp/server.js';
import { DEFAULT_SSE_PORT } from '../src/mcp/sse.js';

/**
 * Auto-discovery checks.
 *
 * The open-web contract has three parts and this file verifies all three against
 * the real artifacts rather than against the code that claims to implement them:
 *
 *   1. a host publishes `/.well-known/navi.json` and advertises it from every
 *      response with `Link: rel="agent-bridge"`, so an agent that can reach any
 *      route can find the document without a hard-coded path (driven over HTTP);
 *   2. the same responses offer the host's Corresponding Source - `rel="source"`,
 *      `GET /v1/source`, and a `source` field in the document - which is what
 *      AGPL-3.0 section 13 obliges a network service to do for the users who
 *      interact with it, including the ones who only ever see an error (driven
 *      over HTTP, and asserted for a fork serving its own source);
 *   3. `navi_navigate` reads the marker the tenant loader injects, binds to the
 *      Navi the host is already running, and - when the host publishes nothing, or
 *      publishes a marker whose runtime never ran - falls back to the packaged
 *      runtime while saying so in the envelope (driven through the real MCP
 *      server with a real browser).
 *
 * Nothing here calls an internal handler: every assertion is made over the wire
 * an external agent would use.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const binPath = join(root, 'bin', 'navi-mcp.js');

/** @type {{host: any, base: string, fixture: import('node:http').Server | null, pageBase: string, html: string, linkHeader: boolean}} */
const state = { host: null, base: '', fixture: null, pageBase: '', html: '', linkHeader: false };

test.beforeAll(async () => {
  state.host = await createNaviHostServer({ port: 0, storeFile: join(tmpdir(), `navi-discovery-${process.pid}-${Date.now()}.db`) });
  state.base = `http://127.0.0.1:${state.host.port}`;
  // A stand-in for a customer's page origin. It publishes whatever document the
  // test is currently interested in, and optionally the Link relation a real host
  // sends, so the two signalling paths stay independently testable.
  state.fixture = createServer((req, res) => {
    /** @type {Record<string, string>} */
    const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
    if (state.linkHeader) headers.Link = AGENT_BRIDGE_LINK;
    res.writeHead(200, headers);
    res.end(state.html);
  });
  await new Promise(/** @param {(value?: void) => void} resolve */ resolve => state.fixture?.listen(0, '127.0.0.1', () => resolve()));
  const address = state.fixture?.address();
  state.pageBase = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

test.afterAll(async () => {
  await state.host?.close();
  await new Promise(/** @param {(value?: void) => void} resolve */ resolve => state.fixture?.close(() => resolve()) ?? resolve());
});

const manifestUrl = () => `${state.base}/.well-known/navi.json`;

/**
 * Both `Link` relations on one header: the discovery document an agent follows and
 * the Corresponding Source AGPL-3.0 section 13 requires this service to offer.
 *
 * Asserted as containment rather than as one exact string, because the contract is
 * that both relations are advertised on every response - not that they are
 * serialized in a particular order. The single-relation form is still covered: the
 * fixture page below publishes `rel="agent-bridge"` alone and the MCP server has to
 * keep reading it.
 * @param {string | null} link
 */
const expectBothRelations = link => {
  expect(link, 'every response must advertise the discovery document').toContain(AGENT_BRIDGE_LINK);
  expect(link, 'and offer the Corresponding Source section 13 requires').toContain(`<${SOURCE_REPOSITORY_URL}>; rel="source"`);
};

/** One document, with the marker the loader injects and the real bundle. @param {boolean} marker @param {boolean} bundle */
const page = (marker, bundle) => `<!doctype html>
<html lang="en">
<head>
  <title>Discovery fixture</title>
  ${marker ? `<meta name="agent-bridge" content="active" data-version="${NAVI_PROTOCOL_VERSION}">` : ''}
  ${bundle ? `<script src="${state.base}/v1/navi.js?key=${DEV_TENANT_KEY}"></script>` : ''}
</head>
<body><button data-agent-target="probe">Probe</button></body>
</html>`;

test('a host publishes one discovery document, advertised by every response', async () => {
  const response = await fetch(manifestUrl());
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/json');
  const document = await response.json();

  // The published schema, asserted as a whole: an extra or renamed field is a
  // change to the contract, not an implementation detail.
  expect(document).toEqual({
    version: '0.3.0',
    protocol: '2025-11-25',
    status: 'ready',
    capabilities: ['viewport_indexing', 'differential_actions', 'settlement_receipts'],
    endpoints: { mcp_sse: 'http://127.0.0.1:3001/sse', script: '/v1/navi.js' },
    source: 'https://github.com/Wub796/Navi'
  });

  // The document cannot drift from the software it describes.
  expect(document.version).toBe(NAVI_PROTOCOL_VERSION);
  expect(document.version).toBe(HOST_PROTOCOL_VERSION);
  expect(document.protocol).toBe(PROTOCOL_VERSION);
  expect(SUPPORTED_PROTOCOLS).toContain(document.protocol);
  expect(document.protocol).toBe(MCP_PROTOCOL_REVISION);
  expect(document.capabilities).toEqual(AGENT_CAPABILITIES);
  expect(document.endpoints.mcp_sse).toBe(DEFAULT_MCP_SSE_URL);
  expect(document.endpoints.script).toBe(SCRIPT_ENDPOINT_PATH);
  // The source offer is part of the published metadata, so a fork that changed it
  // in one place and not the other would be caught here.
  expect(document.source).toBe(SOURCE_REPOSITORY_URL);
  expect(new URL(document.endpoints.mcp_sse).port).toBe(String(DEFAULT_SSE_PORT));

  // Caching: public, revalidated by ETag, and a conditional request costs no body.
  expect(response.headers.get('cache-control')).toBe(DISCOVERY_CACHE_CONTROL);
  const etag = response.headers.get('etag');
  expect(etag, 'the document must be revalidatable').toBeTruthy();
  const revalidated = await fetch(manifestUrl(), { headers: { 'If-None-Match': /** @type {string} */ (etag) } });
  expect(revalidated.status).toBe(304);
  expect(await revalidated.text()).toBe('');

  // An agent that can reach any route finds the document by relation alone: this
  // is the whole discovery flow, followed the way a client would follow it.
  const health = await fetch(`${state.base}/healthz`);
  expectBothRelations(health.headers.get('link'));
  const relation = /<([^>]+)>/.exec(AGENT_BRIDGE_LINK);
  const followed = await fetch(new URL(/** @type {string} */ (relation?.[1]), `${state.base}/healthz`));
  expect(followed.status).toBe(200);
  expect(await followed.json()).toEqual(document);

  // ...and the same relation on the distributable scripts and on an error, so a
  // client that only ever sees a 404 is still told where to look.
  const bundle = await fetch(`${state.base}${document.endpoints.script}?key=${DEV_TENANT_KEY}`);
  expect(bundle.status).toBe(200);
  expectBothRelations(bundle.headers.get('link'));
  expect(Buffer.from(await bundle.arrayBuffer())).toEqual(await readFile(join(root, 'dist/navi.min.js')));
  const loader = await fetch(`${state.base}/v1/loader.js`);
  expectBothRelations(loader.headers.get('link'));
  const missing = await fetch(`${state.base}/no-such-route`);
  expect(missing.status).toBe(404);
  expectBothRelations(missing.headers.get('link'));

  const wrongMethod = await fetch(manifestUrl(), { method: 'POST' });
  expect(wrongMethod.status).toBe(405);
});

test('a host offers its Corresponding Source to the users who reach it, on every response', async () => {
  // AGPL-3.0 section 13 is not discharged by a LICENSE file: it requires the running
  // service to offer the source of the version answering requests, to the users it
  // answers. So the offer is asserted where a user actually meets it, including on
  // the responses they never asked for - which is where an offer that lived only in
  // documentation would be missing.
  const offer = await fetch(`${state.base}${SOURCE_ENDPOINT_PATH}`, { redirect: 'manual' });
  expect(offer.status).toBe(302);
  const target = new URL(/** @type {string} */ (offer.headers.get('location')));
  expect(target.href).toBe(SOURCE_REPOSITORY_URL);
  expect(target.protocol, 'the offer must not hand a reader an insecure transport').toBe('https:');
  expectBothRelations(offer.headers.get('link'));

  // An offer you have to POST to receive is not an offer to a reader, so this is a
  // read route and says so.
  const wrongMethod = await fetch(`${state.base}${SOURCE_ENDPOINT_PATH}`, { method: 'POST' });
  expect(wrongMethod.status).toBe(405);

  // The document an agent reads first names the same source, so the offer is
  // discoverable without having to notice a response header.
  const document = await (await fetch(manifestUrl())).json();
  expect(document.source).toBe(SOURCE_REPOSITORY_URL);

  // Every route a reader might land on: the script a customer's page loads, the
  // loader, health, and a path that does not exist.
  for (const path of [`${SCRIPT_ENDPOINT_PATH}?key=${DEV_TENANT_KEY}`, '/v1/loader.js', '/healthz', '/no-such-route']) {
    expectBothRelations((await fetch(`${state.base}${path}`)).headers.get('link'));
  }

  // A 304 is still a response, and a cache revalidation must not be the one path
  // that loses the offer.
  const etag = (await fetch(manifestUrl())).headers.get('etag');
  const revalidated = await fetch(manifestUrl(), { headers: { 'If-None-Match': /** @type {string} */ (etag) } });
  expect(revalidated.status).toBe(304);
  expectBothRelations(revalidated.headers.get('link'));

  // A fork points the offer at its own source, because the obligation attaches to
  // the version that is actually running and not to upstream. Redirect and manifest
  // are asserted together so they cannot disagree about which source is being offered.
  process.env.NAVI_SOURCE_URL = 'https://git.example.com/tenant/navi-fork';
  const fork = await createNaviHostServer({ port: 0, storeFile: join(tmpdir(), `navi-source-${process.pid}-${Date.now()}.db`) });
  try {
    const forkBase = `http://127.0.0.1:${fork.port}`;
    const redirected = await fetch(`${forkBase}${SOURCE_ENDPOINT_PATH}`, { redirect: 'manual' });
    expect(redirected.headers.get('location')).toBe('https://git.example.com/tenant/navi-fork');
    expect((await (await fetch(`${forkBase}/.well-known/navi.json`)).json()).source).toBe('https://git.example.com/tenant/navi-fork');
    expect(String((await fetch(`${forkBase}/healthz`)).headers.get('link'))).toContain('<https://git.example.com/tenant/navi-fork>; rel="source"');
  } finally {
    await fork.close();
    delete process.env.NAVI_SOURCE_URL;
  }
});

test('a host that cannot serve its assets reports degraded, and its endpoints are configuration', async () => {
  const broken = await createNaviHostServer({
    port: 0,
    sdkPath: join(root, 'dist/does-not-exist.js'),
    mcpSseUrl: 'https://bridge.example.com/sse',
    storeFile: join(tmpdir(), `navi-discovery-degraded-${process.pid}-${Date.now()}.db`)
  });
  try {
    const document = await (await fetch(`http://127.0.0.1:${broken.port}/.well-known/navi.json`)).json();
    // `status` is a verdict, not decoration: this host has no bundle to distribute.
    expect(document.status).toBe('degraded');
    expect(document.endpoints.mcp_sse).toBe('https://bridge.example.com/sse');
  } finally {
    await broken.close();
  }

  // The documented environment override has to reach the document, otherwise an
  // operator following the README publishes a URL that is not the one they set.
  process.env.NAVI_MCP_SSE_URL = 'https://configured.example.com/sse';
  const configured = await createNaviHostServer({ port: 0, storeFile: join(tmpdir(), `navi-discovery-env-${process.pid}-${Date.now()}.db`) });
  try {
    const document = await (await fetch(`http://127.0.0.1:${configured.port}/.well-known/navi.json`)).json();
    expect(document.endpoints.mcp_sse).toBe('https://configured.example.com/sse');
    expect(document.status).toBe('ready');
  } finally {
    await configured.close();
    delete process.env.NAVI_MCP_SSE_URL;
  }

  // The hand-written reference page declares the marker itself, so it is the one
  // place the advertised version cannot be derived. Catch the drift here.
  const demo = await readFile(join(root, 'demo/index.html'), 'utf8');
  expect(demo).toContain(`<meta name="agent-bridge" content="active" data-version="${NAVI_PROTOCOL_VERSION}">`);
});

test('navi_navigate binds to an instrumented host, and falls back loudly when it cannot', async () => {
  test.setTimeout(180000);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [binPath],
    cwd: root,
    stderr: 'pipe',
    env: { ...process.env, NAVI_ALLOW_LOCAL_NETWORK: '1', NAVI_MCP_DEBUG: '0' }
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += String(chunk); });
  const client = new Client({ name: 'navi-discovery-e2e', version: '1.0.0' });
  await client.connect(transport);
  try {
    /** @param {any} result @returns {any} */
    const envelope = result => JSON.parse(result.content[0].text);
    /** @param {string} url @returns {Promise<any>} */
    const navigate = async url => {
      const result = await client.callTool({ name: 'navi_navigate', arguments: { url } });
      expect(stderr, `the MCP server must not report a failure: ${stderr}`).not.toContain('error:');
      return envelope(result);
    };

    // 1. A host that signals with the response header and runs its own runtime:
    //    the agent binds to that instance instead of injecting a second copy.
    state.linkHeader = true;
    state.html = page(false, true);
    const instrumented = await navigate(`${state.pageBase}/`);
    expect(instrumented.ok).toBe(true);
    expect(instrumented.protocolVersion).toBe(NAVI_PROTOCOL_VERSION);
    expect(instrumented.sdk).toEqual({ strategy: 'already-present', injected: false, source: 'host_inline' });
    expect(instrumented.discovery).toEqual({
      instrumented: true,
      source: 'link-header',
      declared_version: null,
      manifest: `${state.pageBase}/.well-known/navi.json`,
      script: null,
      integrity: 'not_declared'
    });
    expect(instrumented.warning).toBeUndefined();
    // A page already running its own Navi is running the host's build, so the script
    // origin is the host even though no manifest was read to find it.
    expect(instrumented.runtime_resolution).toEqual({ strategy: 'host_inline', manifest_url: null, script_origin: 'host' });
    // The decision `page` -> `host_inline`, published on both fields of the receipt.
    expect(instrumented.runtime_resolution.strategy).toBe(instrumented.sdk.source);
    expect(instrumented.actions).toBeGreaterThan(0);

    // 2. A page that publishes nothing: usable, but the envelope says the map did
    //    not come from a host instance the agent can trust to match the host.
    state.linkHeader = false;
    state.html = page(false, false);
    const uninstrumented = await navigate(`${state.pageBase}/`);
    expect(uninstrumented.ok).toBe(true);
    expect(uninstrumented.discovery).toEqual({ instrumented: false, source: 'none', declared_version: null, manifest: null, script: null, integrity: 'not_declared' });
    expect(uninstrumented.warning?.code).toBe('UNINSTRUMENTED_HOST');
    expect(uninstrumented.runtime_resolution).toEqual({ strategy: 'bundled_fallback', manifest_url: null, script_origin: 'bundled' });
    expect(uninstrumented.warning?.message).toContain('agent-bridge');
    expect(uninstrumented.sdk.source).toBe('bundled_fallback');
    expect(uninstrumented.runtime_resolution.strategy).toBe(uninstrumented.sdk.source);
    expect(['tag', 'evaluate']).toContain(uninstrumented.sdk.strategy);
    expect(uninstrumented.sdk.injected).toBe(true);
    expect(uninstrumented.actions).toBeGreaterThan(0);

    // 3. A marker whose runtime never ran - the loader was blocked, refused or
    //    stripped - and no discovery document to fall back on, because this fixture
    //    origin answers every path with HTML. The page is still automated, and the
    //    envelope says the map came from the packaged build rather than pretending
    //    the host answered. tests/manifest-loop.spec.mjs covers the case where the
    //    host does publish a usable document.
    state.html = page(true, false);
    const unusable = await navigate(`${state.pageBase}/`);
    expect(unusable.ok).toBe(true);
    expect(unusable.discovery).toEqual({
      instrumented: true,
      source: 'meta-tag',
      declared_version: NAVI_PROTOCOL_VERSION,
      manifest: null,
      script: null,
      integrity: 'not_declared'
    });
    expect(unusable.warning?.code).toBe('MANIFEST_UNREACHABLE');
    expect(unusable.runtime_resolution).toEqual({ strategy: 'bundled_fallback', manifest_url: null, script_origin: 'bundled' });
    expect(unusable.sdk.source).toBe('bundled_fallback');
    expect(unusable.runtime_resolution.strategy).toBe(unusable.sdk.source);
    expect(unusable.sdk.injected).toBe(true);
    expect(unusable.actions).toBeGreaterThan(0);
    expect(unusable.protocolVersion).toBe(NAVI_PROTOCOL_VERSION);

    // 4. A page running a different protocol version is refused rather than served a
    //    map the agent might misread. This is what has to hold across the 0.2 -> 0.3
    //    bump, and it is the reason the manifest advertises a version at all.
    state.html = `<!doctype html>
<html lang="en"><head><title>Stale protocol</title></head>
<body><button data-agent-target="probe">Probe</button>
<script>window.Navi = { version: '0.2.0', ready: async () => {}, actions: async () => ({ version: '0.2.0', state_version: 1, reset: true, truncated: false, actions: [] }) };</script>
</body></html>`;
    const stale = await client.callTool({ name: 'navi_navigate', arguments: { url: `${state.pageBase}/` } });
    expect(stale.isError).toBe(true);
    const staleBody = envelope(stale);
    expect(staleBody.ok).toBe(false);
    expect(staleBody.error?.code).toBe('NAVIGATION_FAILED');
    expect(staleBody.error?.message).toContain('0.2.0');
    expect(staleBody.error?.message).toContain(NAVI_PROTOCOL_VERSION);
  } finally {
    await client.close();
  }
});

test('the shipped client configs are runnable: an MCP client starts the command they give', async () => {
  test.setTimeout(60000);
  const placeholder = '/ABSOLUTE/PATH/TO/navi/bin/navi-mcp.js';
  const config = JSON.parse(await readFile(join(root, 'examples/claude-desktop-config.json'), 'utf8'));
  const entry = config.mcpServers?.navi;
  // The example is only turnkey if it is the shape the vendor documents and the
  // process it names actually exists. Cursor's stdio file is the same entry.
  expect(Object.keys(config.mcpServers)).toEqual(['navi']);
  expect(entry.command).toBe('node');
  expect(entry.args).toEqual([placeholder]);
  expect(JSON.parse(await readFile(join(root, 'examples/cursor-mcp.json'), 'utf8'))).toEqual(config);

  // Run literally what a reader gets after substituting the placeholder.
  const transport = new StdioClientTransport({
    command: entry.command,
    args: /** @type {string[]} */ (entry.args).map(arg => (arg === placeholder ? binPath : arg)),
    cwd: root,
    stderr: 'pipe',
    env: { ...process.env, NAVI_ALLOW_LOCAL_NETWORK: '1' }
  });
  const client = new Client({ name: 'navi-config-e2e', version: '1.0.0' });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    expect(listed.tools.map(/** @returns {string} */ tool => tool.name).sort())
      .toEqual(['navi_assert_state', 'navi_execute_action', 'navi_get_actions', 'navi_navigate', 'navi_set_session']);
    // ...and the protocol version the documentation states is the one it advertises.
    const navigate = listed.tools.find(/** @returns {boolean} */ tool => tool.name === 'navi_navigate');
    expect(navigate?.description).toContain(`protocol ${NAVI_PROTOCOL_VERSION}`);
    expect(navigate?.description).toContain('agent-bridge');
  } finally {
    await client.close();
  }
});
