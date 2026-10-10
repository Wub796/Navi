# Phase 4 verification — agent auto-discovery, host-binding navigation, turnkey onboarding

Revision `42d633d` on `main`, plus the receipt commit that carries this report and
`reports/release-verification.json`. Every number below was produced by a command in this
working tree, not estimated.

## What shipped

| Deliverable | Path | Verified by |
|---|---|---|
| Discovery document | [server/index.js](../server/index.js) — `GET /.well-known/navi.json` | [tests/auto-discovery.spec.mjs](../tests/auto-discovery.spec.mjs), driven over HTTP |
| Discovery signalling | `Link: </.well-known/navi.json>; rel="agent-bridge"` on every response, including `404`/`405` | same |
| Page-side marker | [src/loader.js](../src/loader.js) injects `<meta name="agent-bridge" content="active" data-version="…">` | [tests/loader.spec.mjs](../tests/loader.spec.mjs) in a real browser |
| Host-binding navigation | [src/mcp/server.js](../src/mcp/server.js) `navi_navigate` | [tests/auto-discovery.spec.mjs](../tests/auto-discovery.spec.mjs) via the official MCP SDK client |
| Turnkey manifests | [docs/INTEGRATION-MATRIX.md](../docs/INTEGRATION-MATRIX.md), [examples/claude-desktop-config.json](../examples/claude-desktop-config.json), [examples/cursor-mcp.json](../examples/cursor-mcp.json) | the suite spawns the shipped config's own command and lists the five tools |
| Protocol bump | `0.2.0` → `0.3.0` in `src/navi.js`, `src/adapter.js`, `server/index.js`, docs, tests | release gate + suite assertions on the literal |

## The discovery contract, as served

```
GET /.well-known/navi.json                    200, application/json; charset=utf-8
Cache-Control: public, max-age=300, stale-while-revalidate=3600
ETag: "<sha256-base64url of the body>"        304 on a matching If-None-Match, no body
Link: </.well-known/navi.json>; rel="agent-bridge"

{"version":"0.3.0","protocol":"2025-11-25","status":"ready",
 "capabilities":["viewport_indexing","differential_actions","settlement_receipts"],
 "endpoints":{"mcp_sse":"http://127.0.0.1:3001/sse","script":"/v1/navi.js"}}
```

The spec asserts that body as a **whole**, so a renamed or extra key fails. Cross-checks
against other sources of the same facts (all in the spec, all passing):

- `version` = `NAVI_PROTOCOL_VERSION` in `src/adapter.js` = the literal inside the served
  bundle = the literal in `server/index.js`;
- `protocol` = `PROTOCOL_VERSION` in `src/mcp/server.js`, and a member of `SUPPORTED_PROTOCOLS`;
- the port in `endpoints.mcp_sse` = `DEFAULT_SSE_PORT` in `src/mcp/sse.js`;
- `endpoints.script` really serves `dist/navi.min.js`: the spec fetches that path with a
  tenant key and compares it byte for byte to the artifact;
- `status` is `degraded` when a host is pointed at a bundle that is not there — a test
  builds such a host rather than trusting the claim;
- `NAVI_MCP_SSE_URL` reaches the document, asserted by setting it on a live host;
- the hand-written marker in [demo/index.html](../demo/index.html) still equals the
  protocol version, so the one place the version cannot be derived cannot rot silently.

## Byte budgets

| Artifact | Before | After | Gate |
|---|---|---|---|
| `dist/navi.min.js` | 14,929 B | **14,929 B** | strictly < 15,000 |
| `dist/loader.min.js` | 464 B | **689 B** | strictly < 700 (raised from 500) |

`src/navi.js` gained **zero bytes**: the version literal changed in place from `'0.2.0'` to
`'0.3.0'`. The 71-byte headroom under the 15,000-byte ceiling is therefore intact — but the
bundle's *bytes* changed, so `dist/sri.txt` moved from `sha384-2Ed1SF5v…` to
`sha384-TmtbTx4Um3FaZ25htbR…`. **Every embed that pins `data-sri` must be updated**, which
is the intended behaviour of a hash-pinned embed rather than a defect.

The loader budget is the one published number this phase moved, and it buys the discovery
marker: the snippet is the only place a page can declare instrumentation without a header
it may never see. The gate is still a hard build failure, `npm run test:gates` still
self-tests the boundary at the new limit, and the measured 689 B is what the README,
acceptance document and CI table now state.

## Auto-negotiation semantics

`navi_navigate` reads the response's `Link` header and the document's
`meta[name="agent-bridge"]` after `load`, then reports and acts:

| Page state | `sdk.source` | Warning | Behaviour |
|---|---|---|---|
| Marker present, `window.Navi` live | `page` | none | binds to the page's own runtime; no second copy injected |
| No marker at all | `bundled` | `UNINSTRUMENTED_HOST` | injects the packaged runtime and says so |
| Marker present, no live runtime | `bundled` | `DISCOVERY_UNUSABLE` | injects the packaged runtime; the message names the broken loader |

The envelope also carries `discovery: { instrumented, source, declared_version, manifest }`
and keeps `sdk.strategy` in its existing `already-present | tag | evaluate` vocabulary, so
existing clients gain fields instead of having meanings redefined underneath them. The
manifest URL is **reported, never fetched**: a server-side fetch of a page-supplied URL
would make a hostile page an SSRF primitive against the agent's own network.

`UNINSTRUMENTED_HOST` also fires when a page runs Navi but publishes no marker — that is
still an uninstrumented host, and the envelope distinguishes the two cases through
`sdk.source` rather than through a second code.

## Receipts

```
npm run typecheck                     0 errors (tsc -p jsconfig.json, strict)
npm test                              81 passed, 0 failed (floor 81, Node v22.23.3)
npm run test:gates                    All selected gates passed (19 expectations)
npm run pack:check                    every published path is an intended release artifact
npm run verify:release                10/10 checks, 0 failing → reports/release-verification.json
  artifact-budget                     navi.min.js 14929 B (<15000), loader.min.js 689 B (<700)
  test-suite                          81 passed, 0 failed (floor 81)
  rebuild-stable                      rebuilt to identical bytes (14929 B bundle, 689 B loader)
```

The coverage floor moved 77 → 81 because this phase added four tests and removed none.

## Judgement calls, and what is not verified

- **Not in the npm tarball.** `docs/INTEGRATION-MATRIX.md` and `examples/` are repository
  documentation, not published files: the publish allowlist in
  [scripts/pack-check.mjs](../scripts/pack-check.mjs) is a deliberate security boundary and
  widening it is a release decision, not a side effect of writing docs. `pack-check` passes
  unchanged.
- **The `npx` form is labelled, not run.** The package is not published to any registry, so
  the matrix presents the locally verified `node …/bin/navi-mcp.js` form as the runnable one
  and the `npx -y -p navi-interaction-bridge navi-mcp` form as the intended published one.
  The spec executes the shipped example config's own `command`/`args` with the placeholder
  substituted, which is the strongest claim the repository can currently make.
- **Not verified:** a third-party MCP client over SSE (`mcp-remote`, Cursor, Claude Desktop
  schemas); a Next.js or Shopify deployment; the SHA-384 of a bundle served by a real CDN;
  `linux/amd64` runtime sandboxing (unchanged from Phase 3 — QEMU skips Chromium's renderer
  seccomp layer, so the strict gate refuses it and native verification stays with the
  `ubuntu-24.04` job in [containers.yml](../.github/workflows/containers.yml)); and any live
  model run, since no `LLM_ENDPOINT` is configured in this workspace.
- **A protocol bump fails closed across versions.** An agent or adapter pinned at `0.2.0`
  driving a `0.3.0` page is refused by the existing protocol check instead of being served a
  map it might misinterpret; the discovery document is how a client learns the version
  before it tries.
- **Historic labels left alone.** [tests/benchmark-comparison.js](../tests/benchmark-comparison.js)
  and [reports/BENCHMARK.md](BENCHMARK.md) say `v0.2` because that report is a measurement
  made under the `0.2` protocol; renaming it would misdate evidence. The migration heading in
  [docs/BACKEND.md](../docs/BACKEND.md) was made version-neutral instead.
- **A double-embedded loader is still correct.** It leaves two markers; the first in
  document order — the one a `querySelector` reader sees — is the one whose `data-version` is
  filled in from the SDK that executed. The second marker is inert.
