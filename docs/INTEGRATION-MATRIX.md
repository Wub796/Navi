# Integration matrix · discovery, MCP clients, page embeds

The three places Navi meets somebody else's system — a host's discovery metadata, an MCP client's server configuration, and a page embed — collected in one file, with the reference implementation's values and an explicit note on what this repository does and does not verify. Substitute your own origins; nothing here is a deployed service.

Versions in play: Navi protocol **0.3.0**, MCP protocol revision **2025-11-25**, package `navi-interaction-bridge` **0.6.9**. The Navi protocol version is the value in `dist/navi.min.js`; the MCP revision is the transport revision, negotiated separately.

## Discovery: how an agent finds Navi without being told

Three signals, cheapest first. An agent that only has a URL can use all three without configuration.

| Signal | Where it comes from | What it means |
|---|---|---|
| `Link: </.well-known/navi.json>; rel="agent-bridge", <https://github.com/Wub796/Navi>; rel="source"` | every response of the host service | this origin publishes Navi discovery metadata, and offers the Corresponding Source of the version answering it (AGPL-3.0 section 13) |
| `GET /.well-known/navi.json` | host service | the machine-readable manifest below |
| `<meta name="agent-bridge" content="active" data-version="0.3.0">` | injected into the page by the tenant loader | this document is instrumented and the runtime that executed it is `data-version` |

The manifest is fixed-shape and cacheable:

```json
{
  "version": "0.3.0",
  "protocol": "2025-11-25",
  "status": "ready",
  "capabilities": ["viewport_indexing", "differential_actions", "settlement_receipts"],
  "endpoints": {
    "mcp_sse": "http://127.0.0.1:3001/sse",
    "script": "/v1/navi.js"
  },
  "source": "https://github.com/Wub796/Navi"
}
```

| Field | Meaning |
|---|---|
| `version` | Navi protocol version of the running SDK. |
| `protocol` | MCP protocol revision the advertised `mcp_sse` endpoint speaks. |
| `status` | `ready` when the host can serve both distributables; `degraded` when it cannot (the bundle or loader is missing on that host). `degraded` is a verdict about the host's own assets, not about the page. |
| `capabilities` | Capability names an agent may gate its own behaviour on. |
| `endpoints.mcp_sse` | Absolute URL of the remote MCP transport. Defaults to the loopback SSE endpoint; set `NAVI_MCP_SSE_URL` when the transport is reachable elsewhere. |
| `endpoints.script` | Path of the distributed bundle. Key-gated: the loader appends `?key=<tenant key>`. |
| `source` | Absolute URL of the Corresponding Source for the running version, offered at `GET /v1/source` and advertised as `rel="source"` on every response. Defaults to `https://github.com/Wub796/Navi`; `NAVI_SOURCE_URL` overrides it, which is what a fork serving a modified version must set, because AGPL-3.0 section 13 attaches to the version actually answering requests. |

Caching is the one thing worth reproducing exactly: the manifest answers with `Cache-Control: public, max-age=300, stale-while-revalidate=3600` and a strong `ETag`, and honours `If-None-Match` with `304`. It is not `no-store`, because a discovery document that cannot be cached is a discovery document an agent will not consult. A five-minute `max-age` keeps `status` and `mcp_sse` honest.

The meta marker's `data-version` is derived, not hardcoded: the loader writes it from the SDK that actually executed, so it cannot drift from the protocol the page is running. A page that installs `navi.min.js` directly (rather than through the loader) publishes no marker — add the same meta tag yourself, next to the bundle tag, if you want that page discoverable.

A host MAY also publish a top-level `integrity` field: the SRI hash of the bytes served at `endpoints.script`. When it is present, an agent fetches that asset itself, verifies it against the declared hash, and injects those exact bytes — so a rewritten bundle is refused before anything executes. The reference host does not declare one today, because its `/v1/navi.js` route already returns the published hash as its `ETag`; a host that mirrors the bundle to a CDN should declare it.

What Navi's own MCP server does with these signals:

- `navi_navigate` reads the navigation response's `Link` header and the document's `meta[name="agent-bridge"]` after `load`.
- A marker is reported back under `discovery` (whether instrumentation was declared, which signal declared it, where the host's manifest lives, and — once negotiated — the script it designated and whether its hash was verified) so a planner can tell "this host speaks Navi" from "we injected the runtime ourselves".
- If a marker is present and `window.Navi` is live, the server binds to the instance the page is already running instead of injecting a second copy. Nothing is fetched in that case.
- If a marker is present and no runtime is live — the loader was blocked by CSP, its tenant key was refused, or its hash did not match — the server reads the host's own manifest and injects the asset it designates, verifying a declared hash first.
- The manifest is only ever read from the page's own origin, inside a 500ms budget, and a redirect that leaves that origin is treated as a refusal. A page cannot point the agent's network at another host.
- If the manifest is missing, unreachable, malformed, off-origin or declares a different protocol version, the server falls back to the packaged runtime and says which of those happened (`MANIFEST_UNREACHABLE`, `MANIFEST_CROSS_ORIGIN`, `MANIFEST_INCOMPATIBLE`), including the served-versus-declared hashes for a mismatch, and the number of milliseconds it waited for a timeout.
- If a declared asset fails its hash check, is blocked by the page's CSP, or cannot be fetched, the packaged runtime is used and the reason is reported (`HOST_ASSET_MISMATCH`, `HOST_ASSET_BLOCKED`, `MANIFEST_UNREACHABLE`).
- If no marker is present at all, the server never probes for a manifest: it warns `UNINSTRUMENTED_HOST` and injects the packaged runtime.
- Every outcome is reported as `sdk.source` — `host_manifest`, `host_inline` or `bundled_fallback` — and discovery never changes the tool set and never fails a navigation: it only decides where the SDK came from, and the reason is always in the envelope rather than implicit.

## MCP client configuration

### Claude Desktop, stdio

macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows `%APPDATA%\Claude\claude_desktop_config.json`. Restart the client after editing it.

```json
{
  "mcpServers": {
    "navi": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/navi/bin/navi-mcp.js"]
    }
  }
}
```

The shipped example is [examples/claude-desktop-config.json](../examples/claude-desktop-config.json), and it points at a checkout so a contributor runs the code they are editing. Everyone else runs the published package:

```json
{
  "mcpServers": {
    "navi": {
      "command": "npx",
      "args": ["-y", "-p", "navi-interaction-bridge", "-p", "playwright", "navi-mcp"]
    }
  }
}
```

`-p` is required rather than optional: the package ships two bins (`navi`, `navi-mcp`), so `npx navi-mcp` would look for a package of that name, and none exists. Playwright is an optional peer dependency, so it needs its own `-p`, and Chromium needs one `npx playwright install chromium`.

Environment goes in the `env` key of the same entry — that is where `NAVI_MCP_DEBUG=1` (trace every tool call to stderr) and `NAVI_MCP_TOKEN` belong:

```json
{
  "mcpServers": {
    "navi": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/navi/bin/navi-mcp.js"],
      "env": { "NAVI_MCP_DEBUG": "1" }
    }
  }
}
```

### Claude Desktop, remote SSE

Claude Desktop configures stdio servers natively. Reaching a remote SSE endpoint from it currently means a bridge such as the community `mcp-remote` shim, which turns the remote stream into a stdio server:

```json
{
  "mcpServers": {
    "navi": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://127.0.0.1:3001/sse", "--header", "Authorization: Bearer ${NAVI_MCP_TOKEN}"]
    }
  }
}
```

Start the transport it connects to:

```sh
node bin/navi-mcp.js --transport sse --port 3001 --host 127.0.0.1 --auth-token "$NAVI_MCP_TOKEN"
```

That serves `GET /sse` (event stream; the first frame carries the POST URL), `POST /message?sessionId=<id>` (one JSON-RPC message, answered `202`), and `GET /healthz` (liveness, open sessions, ceiling, auth mode).

**Treat the SSE port as a browser, because that is what it is.** Whoever can reach it can drive a real Chromium: navigate, read a page, and dispatch actions. Only loopback is served without a bearer token, and a non-loopback `--host` without one is refused rather than warned about. The token belongs in the client's `env`/config, never in a page or a public repository. There is no TLS on this transport — bind it to loopback, or put an authenticating proxy in front of it. `--max-sessions` (default 10) and `--idle-timeout` (default 300s) bound the resource, not the trust.

### Cursor

Cursor reads the same `mcpServers` shape from its own MCP configuration file; [examples/cursor-mcp.json](../examples/cursor-mcp.json) is the stdio entry above. Cursor also documents a URL form for remote servers, which is the direct equivalent of the SSE block:

```json
{
  "mcpServers": {
    "navi": {
      "url": "http://127.0.0.1:3001/sse",
      "headers": { "Authorization": "Bearer ${env:NAVI_MCP_TOKEN}" }
    }
  }
}
```

Client configuration schemas change between releases, and this repository does not test against either vendor's schema — check your client's own documentation for the current key set. The stdio command line is the part that is stable, because it is just a process: `bin/navi-mcp.js` with no arguments speaks MCP over stdio, and `--version` prints `0.5.0 (protocol 2025-11-25, navi 0.3.0)`.

## Frontend snippets

Both the loader and the bundle are served by the host service; `npm run serve` listens on `127.0.0.1:8790` by default with the routes below. In production this is your CDN or edge — the same three files, on a long-lived immutable versioned path, as described in [BACKEND.md](BACKEND.md).

| Route | Purpose |
|---|---|
| `GET /v1/loader.js` | The embed snippet. Carries no key of its own; reads `data-key` from its tag. |
| `GET /v1/navi.js?key=<tenant_key>` | The bundle, tenant-gated, with `Access-Control-Allow-Origin: *` and the SRI hash as its `ETag`. |
| `GET /.well-known/navi.json` | The discovery manifest. |
| `GET /v1/source` | Redirects (`302`) to the Corresponding Source of the running version. Unauthenticated, and cached with the same public policy as the manifest. |
| `GET /healthz` | Liveness, store mode, tenant count. |

`data-sri` is the published `sha384-…` of `navi.min.js` (`dist/sri.txt`; `npm run build` prints the exact tag with the current hash). The loader appends it as `integrity` and sets `crossorigin="anonymous"` on the tag it injects, so the browser verifies the bytes before executing them — which also means the loader's own origin must send `Access-Control-Allow-Origin`, and a CDN that rewrites the bundle fails closed.

### Vanilla HTML

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Checkout</title>
  <!-- Resolves /v1/navi.js against this script's own origin, appends ?key=,
       verifies integrity, and injects <meta name="agent-bridge" content="active">. -->
  <script src="https://YOUR-ASSET-HOST/v1/loader.js"
          data-key="YOUR_TENANT_KEY"
          data-sri="sha384-…"></script>
  <script>
    // Written above the SDK on purpose: the loader's stub defers it and resolves
    // it with the real result once the bundle has executed.
    window.Navi.ready().then(() => console.log('navi', window.Navi.version));
  </script>
</head>
<body>
  <button data-agent-target="checkout-submit">Complete Purchase</button>
</body>
</html>
```

Place the loader in `<head>` before the application's own scripts: closed shadow roots created before the loader runs are not capturable afterwards.

### Next.js (App Router)

```jsx
import Script from 'next/script';

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <Script
          src="https://YOUR-ASSET-HOST/v1/loader.js"
          data-key="YOUR_TENANT_KEY"
          data-sri="sha384-…"
          strategy="afterInteractive"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
```

The loader reads `data-key` and `data-sri` from its own tag, so those attributes have to survive onto the emitted `<script>` element: check in your Next.js version that `next/script` forwards unknown `data-*` props, because no Next.js build is exercised by this repository's tests and the whole embed fails silently if they are dropped. `afterInteractive` (classic, in-place execution) is what the loader expects. Use `beforeInteractive` instead when the page creates closed shadow roots during hydration. `data-sri` is the hash of the *bundle* the loader will fetch, not of the loader file; if you mirror the loader yourself and want it hash-pinned too, compute its hash at build time and add `integrity` to this tag as well.

If the app host should advertise discovery itself rather than only through the loader's meta marker, serve the `Link` header from `next.config.mjs`:

```js
const nextConfig = {
  async headers() {
    return [{ source: '/:path*', headers: [{ key: 'Link', value: '</.well-known/navi.json>; rel="agent-bridge"' }] }];
  }
};
```

### Shopify `theme.liquid`

```liquid
{%- comment -%}
  theme.liquid, inside <head> and before the theme's own scripts.
  Shopify's script_tag helper cannot emit data-* attributes, so the tag is literal.
{%- endcomment -%}
<script src="https://YOUR-ASSET-HOST/v1/loader.js"
        data-key="YOUR_TENANT_KEY"
        data-sri="sha384-…"></script>
```

A tenant key in a page is not a secret: it travels in the bundle request as `?key=`, and the host checks it on every request. It is a routing gate, not an authorization token, so keep it where it is readable and rotate it only if you need to cut a tenant off. For a distributed app, prefer a theme app extension app-embed block over editing the theme; it emits the same tag without a theme fork. Shopify does not let a theme set response headers, so the loader's `<meta name="agent-bridge">` marker is the discovery signal a Shopify page can actually publish.

## What is and is not verified here

Verified by this repository's tests:

- The manifest's exact schema, its caching headers, and the `304` path (`tests/auto-discovery.spec.mjs`), plus both `Link` relations on host responses — `rel="agent-bridge"` and the `rel="source"` offer, asserted on the scripts, on `/healthz`, on a `404`, on a `304` and on the `302` from `/v1/source`, with `NAVI_SOURCE_URL` checked to reach both the redirect target and the manifest's `source` field.
- The loader's meta marker and its strict byte budget.
- stdio registration as an MCP client uses it: a real `@modelcontextprotocol/sdk` client spawns `examples/claude-desktop-config.json`'s own entry — command and args, with only the placeholder path substituted — and lists the eight tools (`navi_navigate`, `navi_get_actions`, `navi_scroll_to`, `navi_execute_action`, `navi_read_text`, `navi_assert_state`, `navi_set_session`).
- Auto-negotiation itself: an instrumented page is bound to its own runtime, an uninstrumented page warns and still works, and a page reporting a different protocol version is refused rather than driven.
- The manifest loop (`tests/manifest-loop.spec.mjs`): a declared runtime is fetched, hash-verified and injected instead of the packaged build; an unhashed asset is loaded by the browser as a URL; a rewritten asset is refused; an incompatible or slow or missing or off-origin manifest falls back with the documented code; and an uninstrumented page is not probed at all.

Not verified here:

- The remote SSE transport driven by a third-party client (`mcp-remote`, Cursor, Claude Desktop). Its endpoints and auth rules are built on `node:http` and covered by this repository's own SSE tests only.
- The vendor configuration schemas above. They are configuration, not protocol; they change without notice.
- The published `npx` form, because the package is not published yet.
- A Shopify theme or app-embed deployment.

Also not implemented: streamable HTTP. The MCP transport is stdio or SSE.
