# Navi Protocol v0.3 · in-page execution infrastructure

Dependency-free browser tools for predictable target discovery and guarded native execution, including captured closed shadow roots and same-origin iframe controls. This is a custom protocol, **not an official WebMCP registration**, authorization boundary, or trusted-input replacement.

## Run

Node ≥22 (`engines.node` is `>=22.0.0`; the pinned container runtime is 22.23.3), npm, and Playwright Chromium:

```sh
npm ci --no-audit --no-fund
npx playwright install chromium
npm run typecheck
npm test
npm run build
npm run dev -- --host 127.0.0.1 --port 4173
```

Open `http://127.0.0.1:4173`. No real payment occurs. Test server uses port 4174; keep it free. After SDK edits, rebuild and reload; the small static server does not implement HMR.

## Protocol

Load Navi **before application scripts** to capture future closed roots:

```html
<script src="/navi.min.js"></script>
<script defer src="/app.js"></script>
```

```js
await window.Navi.ready();
const map = await window.Navi.actions({ limit: 1000 });
await window.Navi.execute('search-input', 'type', { text: 'shoes' });
await window.Navi.execute('checkout-submit', 'click'); // requires external authorization!
await window.Navi.refresh();
window.Navi.stats();
window.Navi.stop();
```

For a warm viewport subset use `actions({viewportOnly:true})`. For driver fallback request `coordinateSpace:'top'`. Mark trusted-only controls with `data-navi-trusted="true"` and use the [tested adapter](src/adapter.js), which rejects unsafe/unknown retries.

With the local demo running, `npm run benchmark` runs 20 iterations per fixture/method and writes [BENCHMARK.md](reports/BENCHMARK.md) and [raw comparison metrics](reports/benchmark-comparison.json). The benchmark uses an isolated pinned legacy Playwright-core alias for the removed accessibility snapshot API; the modern test runner remains unchanged.

- Idle-scheduled TreeWalker indexing with a 2ms internal work cutoff and a measured ≤6ms acceptance gate. `requestAnimationFrame` + microtask fallback yields between frames.
- IntersectionObserver viewport priority, background discovery and time-sliced metadata/cleanup. No whole-document DOM scrape or per-element network request.
- MurmurHash3 deterministic fingerprints; explicit `data-agent-target` for critical actions, `data-navi-key` + `data-navi-action` for reorder-stable repeated entities. No arbitrary collision suffixes. Ambiguous live IDs are rejected.
- Weak control index and incremental SPA unmount cleanup; hook restoration respects ownership.
- Rich names/roles/coordinates and live visible/enabled/viewport/occlusion metadata. No field values returned. Names can still contain PII; don't upload maps by default.
- Native `click`, `type` and `select`, controlled-input native setters, realm-correct events and two-frame/index settling. The whole sandbox transaction is exercised exclusively via execute.

## Distributed developer kit

The package publishes one browser bundle plus a dual-module library and an agent CLI.

```sh
npm install            # or: npm install navi-interaction-bridge
npx navi --help
npx navi discover --url https://example.com
npx navi run --url https://example.com --action-file ./flows/checkout.json
```

Release artifacts in `dist/`:

| File | Purpose |
|---|---|
| `navi.min.js` | Self-executing `<script>` bundle (CDN/direct embed). Strictly under 15KB uncompressed. |
| `index.mjs` | ESM exports: `NaviPlaywrightAdapter`, `naviAdapter`, `runFlow`, `validateFlow`, `installNavi`, `connectNavi`. |
| `index.cjs` | CommonJS build of the same surface (`require('navi-interaction-bridge')`). |
| `index.d.ts` | Published types for both sides: client SDK (`NaviAPI`, `NaviAction`, `NaviActionMap`) and adapter/flow (`NaviPlaywrightAdapter`, `NaviFlowDocument`, `NaviStepResult`). The `./navi.min.js` subpath resolves `dist/navi.d.ts` for the `window.Navi` global. |
| `cli.mjs` | The agent harness implementation behind `bin/navi-agent.js`. |
| `mcp.mjs` | The Model Context Protocol server behind `bin/navi-mcp.js`. |
| `sri.txt` | `sha384-…` Subresource Integrity for `navi.min.js`, for enterprise `<script integrity>` tags. |

```js
import { NaviPlaywrightAdapter, runFlow, installNavi } from 'navi-interaction-bridge';

await installNavi(page);
const tools = new NaviPlaywrightAdapter(page);
const map = await tools.discover();          // { version, truncated, actions[] }
const result = await tools.execute('checkout-submit', 'click');
if (!result.ok) throw new Error(result.error.code);
```

### Agent flow files

Flows are reviewable JSON, schema-validated before anything executes, and never eval'd. See [flows/example-checkout.json](flows/example-checkout.json).

```json
{
  "name": "checkout",
  "steps": [
    { "target": "checkout-email", "action": "type", "text": "agent@example.com" },
    { "target": "checkout-delivery", "action": "select", "value": "Send me a link" },
    { "target": "checkout-submit", "action": "click", "consequential": true },
    { "assert": "text", "selector": "#status", "contains": "complete" },
    { "assert": "name", "target": "checkout-gift", "equals": "Add gift wrapping" }
  ]
}
```

Step kinds: `action` (`click`/`type`/`select`, optional `expect`), `assert` (`text`, `value`, `name`, `visible`, `exists`, `url`), `wait` (ms), `waitFor` (`selector`, `text`, `urlIncludes`) and `scrollTo` (a target id).

Navi never scrolls implicitly, because an off-screen control is not actionable. A flow that needs a below-the-fold control says so with an explicit `{ "scrollTo": "checkout-submit" }` step, which scrolls, then proves through the action map that the target is now in the viewport. Top-document targets only.

`assert: "name"` resolves through the action map instead of the DOM, so it also covers closed shadow roots and same-origin frames that plain CSS selectors cannot reach. Other assertions evaluate a top-document CSS selector and therefore do not pierce shadow boundaries.

Exit codes: `0` success, `1` flow/assertion failure, `2` usage or invalid flow, `3` environment failure (missing browser or SDK). Steps marked `"consequential": true` require `--allow-consequential`, and failed or timed-out actions are reported, never retried automatically, because they may already have applied.

### MCP server

`navi-mcp` speaks the Model Context Protocol over stdio, so an MCP client can drive a browser through the same guarded adapter the CLI uses. It is dependency-free: the transport is newline-delimited JSON-RPC 2.0, and conformance is verified against the official `@modelcontextprotocol/sdk` client in [the MCP suite](tests/mcp-server.spec.mjs) (a dev-only dependency; the shipped server needs no MCP package at runtime).

```json
{
  "mcpServers": {
    "navi": { "command": "npx", "args": ["-y", "navi-mcp"] }
  }
}
```

| Tool | Purpose |
|---|---|
| `navi_navigate` | Open an http(s) URL and wait for Navi initialization. Reports which SDK install strategy was used. |
| `navi_get_actions` | Return the current action map. Viewport-filtered by default; `all: true` returns the whole document. |
| `navi_execute_action` | Run `click`/`type`/`select` on a `target_id`. Falls back to trusted native input at live coordinates for `data-navi-trusted="true"` controls. Pass `settle` to wait for the action's effect before the call returns. |
| `navi_assert_state` | Check that a target exists, is visible/enabled/in-viewport, and matches an expected accessible name. |
| `navi_set_session` | Seed cookies and localStorage from an inline payload or a Playwright `storageState.json` path, so `navi_navigate` opens a pre-authenticated page instead of a sign-in screen. |

Every tool answers with the structured envelope `{ content: [{ type: "text", text }], isError }`, where the text is JSON. Refusals carry the failure code and actionable guidance: `UNAVAILABLE` says the control is hidden, disabled, off-screen or covered, `NOT_FOUND` says to re-read the action map because ids change with re-renders, and `INVALID_URL` never echoes embedded credentials.

#### Deterministic settlement

An action returns when it is *dispatched*, which is not the same moment as the page having reacted. Pass `settle` to wait for one of three conditions before the call answers; the envelope then carries the receipt `{ executed: true, settled: true, elapsed_ms, final_url }`:

```jsonc
{ "target_id": "open-modal", "action_type": "click",
  "settle": { "wait_for": "mutation_settle", "timeout_ms": 3000 } }
```

| `wait_for` | Waits until |
|---|---|
| `mutation_settle` (default) | the document, its open shadow roots and same-origin frames record no DOM mutation for 100 ms |
| `navigation` | the top-level URL changed, or the document reloaded |
| `target_hidden` | the dispatched target left the action map, or Navi now reports it invisible or occluded (a dismissed modal) |

A settlement is a **receipt, never a retry**. `settled: false` with `settle_reason: "timeout"` still reports `executed: true` and never re-dispatches; an invalid request (`INVALID_SETTLE`) is refused *before* anything is dispatched; and a call made without `settle` omits the receipt fields, so it cannot be mistaken for a verified one. `mutation_settle` observes the same surfaces Navi indexes — a mutation inside a *closed* root is invisible to the driver, so those actions should settle on `target_hidden` or be confirmed by re-reading the map. The adapter exposes the same option as a fourth argument: `tools.execute('open-modal', 'click', {}, { wait_for: 'target_hidden' })`.

```sh
npx navi-mcp --version      # server and protocol version
NAVI_MCP_DEBUG=1 npx navi-mcp   # log every tool call to stderr
npx navi-mcp --no-fallback  # synthetic dispatch only; refuse trusted native input
```

#### Remote transport (SSE)

For agent hosts that cannot spawn a subprocess, the same server speaks the MCP SSE binding instead of stdio:

```sh
npx navi-mcp --transport sse --port 3001 --host 127.0.0.1
NAVI_MCP_TOKEN="$TOKEN" npx navi-mcp --transport sse --max-sessions 4 --idle-timeout 120
```

| Endpoint | Purpose |
|---|---|
| `GET /sse` | Event stream. The first frame is `event: endpoint` carrying the POST URL for this connection. |
| `POST /message?sessionId=<id>` | One JSON-RPC message per request, answered `202` immediately; the reply arrives on the stream. |
| `GET /healthz` | Liveness, open-session count, the ceiling, the auth mode and the live containment counters. |
| `GET /metrics` | The same counters in Prometheus text format, for a scraper. |

It is implemented on `node:http` alone — no Express, Hono or SSE library — and each SSE connection gets its **own browser session**, so two clients cannot drive each other's pages.

An open SSE port is an open browser: whoever reaches it can steer a real Chromium. Four bounds apply, and the last is a refusal rather than a warning.

| Bound | Default | Effect |
|---|---|---|
| `--auth-token <token>` or `NAVI_MCP_TOKEN` | off | Requires `Authorization: Bearer <token>` on both `/sse` and `/message`. A missing or wrong token is `401` with a `WWW-Authenticate` challenge, decided *before* the session is looked up, so an anonymous caller cannot probe which session ids are live. The token is compared in constant time and never echoed into a response or a log. |
| `--max-sessions <n>` | 10 | Concurrent event streams. A request beyond the ceiling is `503 TOO_MANY_SESSIONS` with `Retry-After`, and no session or browser is started for it. Slots are a live count, so closing a stream frees one. |
| `--idle-timeout <seconds>` | 300 | A session that receives nothing for this long is reaped and its browser closed. Idle reaping waits for in-flight calls. The independent 30-minute hard TTL still closes busy sessions. `0` disables only idle reaping. |
| `--host` that is not loopback | — | **Refused** unless a token is set: the server exits `2` instead of exposing a browser driver. |

`GET /healthz` reports the posture — `{ ok, transport, sessions, maxSessions, auth, idleTimeoutMs, sessionMaxTtlMs, maxPendingMessages, containment }` — so an operator can see which mode is live. Anonymous session ids remain what the MCP SSE binding specifies, so a token is a **gate, not an identity**: it is one shared credential rather than an account system. stdout stays empty while diagnostics go to stderr.

Neither `/healthz` nor `/metrics` requires the bearer token, exactly like any other liveness probe, so both carry **aggregate counters only** — never a refused URL or a session identifier.

#### Browser-session containment

MCP defaults to public HTTP(S) destinations only. Navigation and subresources reject private/loopback/link-local addresses (including DNS answers and redirects) with `ERR_BLOCKED_BY_CONTAINMENT`. A session-owned proxy pins the validated IP at connection time; host-runtime fetches use the same policy. WebSockets and service workers are blocked. Set `NAVI_ALLOW_LOCAL_NETWORK=1` **only for explicitly trusted local fixtures**; production files do not enable it.

Each session owns an ephemeral context and private `navi-downloads-<sessionId>-<random>` directory beneath the OS temporary directory (`/tmp` in the container). Context/session disposal deletes downloads and closes Chromium. Camera, microphone, geolocation, notifications and clipboard permissions are explicitly denied. Popups beyond **3 pages** are closed; SSE has a non-disableable **30-minute TTL**, **16 pending messages** maximum and cleanup-aware session slots. State-file paths are accepted only with the trusted local override; otherwise hydration accepts inline state.

These are browser-driver controls, not an OS network sandbox or disk/CPU quota. Keep the Chromium sandbox, container limits and outbound firewall; disable direct UDP/non-proxy egress at the deployment boundary. See [containment tests](tests/session-containment.spec.mjs).

#### Containment observability

A refusal is never silent. Every blocked destination increments process-lifetime counters, published as `containment` on `GET /healthz` and in Prometheus text on `GET /metrics`:

```jsonc
// GET /healthz (truncated)
{ "ok": true, "sessions": 0, "containment": {
  "enforced": true,
  "violations_total": 3,
  "violations_by_category": { "metadata_endpoint": 1, "private_ipv4": 0, "loopback_or_local": 2,
    "cgnat_or_multicast": 0, "ipv6_special": 0, "dns_rebinding_rejected": 0 } } }
```

```text
# TYPE navi_containment_violations counter
navi_containment_violations{category="metadata_endpoint"} 1
navi_containment_violations_total 3
navi_containment_enforced 1
navi_mcp_sessions 0
```

The same refusal is written to stderr as one JSON line, so a log pipeline can alert on `SECURITY_CONTAINMENT_VIOLATION` without scraping the process:

```jsonc
{ "level": "WARN", "type": "SECURITY_CONTAINMENT_VIOLATION", "timestamp": "2026-10-11T20:31:07.482Z",
  "session_id": "4e1c...", "target_url": "http://169.254.169.254/latest/meta-data/", "resolved_ip": "169.254.169.254",
  "category": "metadata_endpoint", "action": "BLOCKED" }
```

`target_url` is stripped to `origin + pathname`, so credentials, query strings and fragments never reach a log. `violations_total` counts every refusal while `violations_by_category` covers the classified ones, so a malformed or credentialed URL is counted in the total and logged as `unclassified` rather than forced into a bucket. With `NAVI_ALLOW_LOCAL_NETWORK=1` the policy is off: `enforced` reports `0` and nothing is counted.

#### Authenticated sessions

`navi_set_session` exists so an agent does not have to type a login form:

```jsonc
// Inline: cookies plus per-origin localStorage, applied before navigation.
{ "cookies": [{ "name": "sid", "value": "…", "url": "https://shop.example.com" }],
  "origins": [{ "origin": "https://shop.example.com", "localStorage": [{ "name": "token", "value": "…" }] }],
  "url": "https://shop.example.com/account" }
```

Or pass `"storage_state": "/path/to/storageState.json"` — the file `npx playwright codegen --save-storage` produces. Hydration rebuilds the browser context (localStorage only takes effect at document start), so call it **before** `navi_navigate`; passing `url` does both in one step. Session values are validated, never echoed back, and a state that hydrates nothing is refused rather than accepted as a silent no-op.

## Script hosting and telemetry ingestion

`server/` is a standalone, zero-dependency service that distributes the bundle to registered tenants and collects agent-usage aggregates:

```sh
npm run build && npm run serve          # http://127.0.0.1:8790
NAVI_TENANTS="live_key_abc:acme" node server/index.js --port 8790 --store server/telemetry.db
```

| Endpoint | Behaviour |
|---|---|
| `GET /v1/navi.js?key=<tenant_key>` | Serves `dist/navi.min.js` with `Cache-Control: public, max-age=3600, stale-while-revalidate=86400`, an `ETag` equal to the SRI SHA-384, and `304` on `If-None-Match`. `401` without a valid key. |
| `GET /v1/loader.js` | Serves `dist/loader.min.js`, the tenant embed snippet. Carries no tenant key of its own. |
| `POST /v1/telemetry` | Ingests the beacon payload `{ tenant_id, url_origin, actions_indexed, actions_executed, execution_failures }`, as `application/json` or beacon-shaped `text/plain`. Strict schema, ≤ 2 KB, canonical origins only. |
| `GET /v1/telemetry?key=<tenant_key>` | The tenant's aggregate: totals, per-origin and per-tenant event counts. `no-store`. |
| `GET /healthz` | `{ ok, mode, tenants }`, where `mode` is `sqlite` or `log`. |
| `GET /.well-known/navi.json` | The agent discovery document — `{ version, protocol, status, capabilities, endpoints, source }` — served `public, max-age=300` with a strong `ETag` and `304` on `If-None-Match`. Every response on this service carries both relations in one header — `Link: </.well-known/navi.json>; rel="agent-bridge", <https://github.com/Wub796/Navi>; rel="source"` — so an agent that can reach any route can find the document, and every reader is offered its source. |
| `GET /v1/source` | Redirects (`302`) to the Corresponding Source of the version answering — `https://github.com/Wub796/Navi`, or `NAVI_SOURCE_URL` when this host runs a modified version. Unauthenticated, and cached like the discovery document. This is the offer AGPL-3.0 section 13 requires a network service to make. |

Both scripts are served with `Access-Control-Allow-Origin: *`, because the supported embed is a `crossorigin="anonymous"` script with an `integrity` hash: the browser then fetches in CORS mode and verifies the bytes before executing them.

Aggregates are appended to `node:sqlite` where the runtime provides it without an experimental warning, and to an append-only JSONL log at the same path otherwise — which is the backend the pinned Node 22 runtime selects, because `node:sqlite` is still experimental there. `store.mode` reports which is live, and both answer with an identical summary shape. Rejected payloads — unknown keys, wrong types, negative or non-integer counters, a `url_origin` carrying a path, query, fragment, trailing slash or credentials, an unregistered tenant, or raw DOM/HTML text — never reach the store.

**The client SDK sends no telemetry.** Its no-network guarantee is enforced by a test at 14,929 bytes; the beacon is built and dispatched by the hosting page or tenant script, and `demo/` shows the shape. Treat this service as a reference implementation: it has tenant keys, not user auth; no rate limiting, quotas, deduplication or retention policy; and it does not terminate TLS.

### Tenant embed loader

A tenant does not hand-wire the script: `dist/loader.min.js` (689 bytes, held under a strict 700-byte gate) is the whole embed.

```html
<script src="https://cdn.example.com/v1/loader.js"
        data-key="YOUR_TENANT_KEY"
        data-sri="sha384-…"></script>
```

* `data-key` is appended to the bundle request as `?key=`, where the host checks it; a refused key rejects every queued call instead of hanging.
* `data-sri` is the published `dist/sri.txt` hash. The loader appends it as `integrity` and sets `crossorigin="anonymous"` on the tag it injects, so the browser verifies the bytes it runs. `npm run build` prints the exact snippet with the current hash filled in.
* The bundle URL resolves from the loader's own origin, so the loader can be served from a CDN while the page runs on the tenant's domain. The hash is deliberately *not* baked into the snippet: 71 bytes of it would push the snippet past its budget, so it travels in the embed tag the way standard SRI embeds do.
* Until the bundle executes, `window.Navi` is a stub (`Navi.stub === true`, `Navi.version === '0.0.0'`) that defers every API call and resolves it with the real result, so `await Navi.actions()` written above the SDK behaves the same as after it loads. The SDK recognises the stub and installs over it; any other pre-existing `Navi` is left alone.
* The loader also injects `<meta name="agent-bridge" content="active" data-version="…">`, the page-side half of agent auto-discovery: a client that never saw the host's `Link` response header — a cached document, a nested frame, a proxy that strips headers — still learns that this page runs Navi. `data-version` is read from the SDK that actually executed rather than hardcoded, and a refused key leaves the marker with no version, which is how a client tells "instrumented" from "instrumented and running".

`navi_navigate` follows that marker: it reads the host's own discovery document from the page origin, injects the runtime that document designates — verifying a declared subresource integrity hash before a byte of it executes — binds to a Navi instance the page is already running rather than injecting a second copy, and otherwise falls back to the packaged runtime with a reason (`UNINSTRUMENTED_HOST`, `MANIFEST_UNREACHABLE`, `MANIFEST_CROSS_ORIGIN`, `MANIFEST_INCOMPATIBLE`, `HOST_ASSET_MISMATCH` or `HOST_ASSET_BLOCKED`). Every outcome is reported as `sdk.source` — `host_manifest`, `host_inline` or `bundled_fallback` — so an agent always knows which build produced the map it holds, and the negotiation is bounded twice over: the document is only read from the page's own origin (including across redirects) and only within a 500ms budget, so a hostile page cannot turn the agent's network into a fetcher for arbitrary hosts. [INTEGRATION-MATRIX.md](docs/INTEGRATION-MATRIX.md) is the turnkey version of all of this.

Diagnostics go to stderr only, so stdout stays a clean JSON-RPC stream. Unlike the flow runner, MCP tool calls are **not** gated by `--allow-consequential`: an agent holding this server can dispatch a consequential control directly. Use the CLI for reviewed flows with that gate, or leave this server off for destinations where an irreversible click matters. For a stricter posture, `--no-fallback` keeps the session synthetic-only, so a `data-navi-trusted` control is refused with `FALLBACK_DISABLED` instead of being driven by real mouse and keyboard input.

## Enterprise deployment and CSP hardening

Navi runs unmodified under a strict policy such as `default-src 'self'; script-src 'self' 'nonce-…'; style-src 'self'`. Three properties are enforced rather than assumed:

1. **No `eval` and no inline code.** The bundle uses no `eval()`, `Function()` constructor, `document.write`, `insertAdjacentHTML`, `<style>` creation or `style` attribute writes. [scripts/build.mjs](scripts/build.mjs) fails the build if any of those reappear, and the [CSP suite](tests/csp-compliance.spec.mjs) re-checks the served bytes.
2. **Pinned DOM primitives.** Geometry, style, observers, tree walking, point hit-testing and schedulers are captured in a closure at initialization, so a host script that later replaces, wraps, nulls or freezes those prototypes cannot bend discovery, occlusion checks or execution. A frozen prototype no longer breaks initialization: hook installation and restoration are guarded. See [the hardening suite](tests/hardening.spec.mjs).
3. **Subresource Integrity.** `npm run build` writes `dist/sri.txt`.

```html
<script src="/navi.min.js" integrity="sha384-…" crossorigin="anonymous"></script>
```

Two honest limits: a host that replaces `attachShadow` *after* Navi hooks it takes closed-root capture with it, and a page policy that blocks inline scripts rejects `addScriptTag` injection — serve `navi.min.js` from the page origin as above, or let the harness install it through driver evaluation (`installNavi(page, { strategy: 'evaluate' })`), which is not subject to the document's CSP.

## Containers and task completion benchmark

Phase 2 adds a digest-pinned, multi-stage [Dockerfile](Dockerfile) and loopback-published [Compose services](docker-compose.yml) for the host on port 3000 and authenticated MCP SSE on 3001, now on a pinned `node:22.23.3-bookworm-slim` base. Both run as the unprivileged `pwuser` (UID 1000) with a read-only filesystem, dropped capabilities, resource limits and health checks, and **Chromium's own sandbox is enabled**: no launch passes `--no-sandbox`, the MCP service applies a vendored [seccomp profile](security/chromium-seccomp.json) so the renderer can build its namespaces as a non-root user, and [scripts/check-sandbox.mjs](scripts/check-sandbox.mjs) requires each live renderer to be in a distinct user namespace, a nested PID namespace and to carry an extra seccomp filter. See [container operations, the sandbox gate and its per-architecture status](docs/CONTAINERS.md): linux/arm64 is verified natively, while linux/amd64 is built and run here only under QEMU, where Chromium skips its extra renderer filter and the gate refuses the run — that architecture is verified natively by [containers.yml](.github/workflows/containers.yml).

```sh
docker build -t navi:local .
# Supply NAVI_TENANTS and NAVI_MCP_TOKEN from your secret store, then:
docker compose up -d --no-build --wait
# Separate, isolated runtime smoke test (ports 3000/3001 must be free):
npm run test:containers
npm run benchmark:tcr
```

The [task benchmark report](reports/TCR-BENCHMARK.md) compares ten paired, independently verified checkouts via Playwright role locators versus actual MCP discovery/execution with settlement receipts. It records exact tokenized DOM-context payloads and end-to-end timings, not billed model usage or general LLM planning performance. [Raw trials](reports/tcr-benchmark.json) include every outcome; there are no retries or discarded failures. The application is a local sandbox with real HTTP requests, not a public store or real payment flow.

### Local model benchmark (no hosted billing)

Start an OpenAI-compatible daemon and choose the exact tool-capable model it serves:

```sh
LLM_ENDPOINT=ollama LLM_MODEL=YOUR_MODEL npm run benchmark:llm -- --preflight
LLM_ENDPOINT=ollama LLM_MODEL=YOUR_MODEL npm run benchmark:llm
# Also supported: LLM_ENDPOINT=vllm, lmstudio, or a full /v1 base URL.
```

Preflight validates `/models` and a real tool-calling response before opening a task browser. Setup failures exit `2` without changing any report. Successful live runs write `reports/LLM-TCR-BENCHMARK-LIVE.md` and `reports/llm-benchmark-live.json` with provider token counts, cached prompt tokens, per-turn latency and TCR; missing usage stays unknown. The [fixture baseline](reports/LLM-TCR-BENCHMARK.md) remains separate. With no endpoint/model configured, the existing fixture mode still runs, so use `NAVI_LLM_FIXTURE=0` when a run must use a model.

## Continuous integration

[ci.yml](.github/workflows/ci.yml) runs on every pull request and push to `main` with Node 22.x. Its gates read machine-readable reports rather than re-deriving numbers, and a missing report fails the gate instead of skipping it:

| Gate | Source | Fails when |
|---|---|---|
| Bundle budget + artifacts | `reports/build.json` | `dist/navi.min.js` is ≥ 15,000 bytes, or any of the eight release artifacts (`navi.min.js`, `loader.min.js`, `index.mjs`, `index.cjs`, `index.d.ts`, `navi.d.ts`, `cli.mjs`, `mcp.mjs`) is missing |
| Loader budget | `reports/build.json` | `dist/loader.min.js` is ≥ 700 bytes |
| Traversal Long Tasks | `reports/verification.json` | the 10,000-element traversal records a Long Task over 50ms |
| Benchmark | `reports/benchmark-comparison.json` | any measured traversal records a Long Task over 50ms, or 2,000-node viewport classification p95 exceeds 25ms |

The benchmark gates run in a second job that starts the local demo origin on `127.0.0.1:4173`, waits for it to answer, and always stops it again.

```sh
npm run test:gates   # self-test the gates themselves (19 expectations, no browser)
npm run gates        # run all three gates against the current reports
npm run pack:check   # assert what `npm publish` would actually upload
npm run test:smoke   # non-destructive check against a live public SPA
npm run verify:release                 # the release gate: git, SRI, tests, gates, pack
node scripts/verify-release.mjs --tag    # ...and create the annotated v<version> tag
```

[verify-release.mjs](scripts/verify-release.mjs) is the release gate. It requires a worktree clean apart from build output and generated reports, an SRI that hashes to the bytes of `dist/navi.min.js`, a suite with zero failures and at least 91 passing tests, a rebuild that reproduces the shipped artifacts byte for byte, both byte budgets, the CI gates and the publish allowlist — and only then, with `--tag`, creates the annotated `v<version>` tag. Its receipt records structured `evidence` beside the prose details: the revision, the SRI and the artifact sizes it verified.

[release.yml](.github/workflows/release.yml) runs that gate on a tag push and then publishes the revision it just verified, with `--provenance --access public`, behind the `release` environment so required reviewers can hold any publish for a human. One further gate stands between a tag and the registry: [publish-preflight.mjs](scripts/publish-preflight.mjs) checks the decisions a pipeline must not make on an owner's behalf — a LICENSE file, a `license` field, the access and provenance settings, a tag matching `package.json`, and a receipt that still describes the exact bytes being published. **It passes today: the package ships a `LICENSE` file and declares `AGPL-3.0-or-later`.** Release notes are generated from those receipts by [release-notes.mjs](scripts/release-notes.mjs) rather than retyped, so a note cannot describe a different artifact than the one published.

### Required status checks

The CI checks `main` should require are `Quality gates (Node 22.x)`, `Benchmark gate (Node 22.x)`, and the two native sandbox jobs from [containers.yml](.github/workflows/containers.yml) — `Sandboxed Chromium (linux/amd64)` on `ubuntu-24.04` and `Sandboxed Chromium (linux/arm64)` on `ubuntu-24.04-arm`, so each architecture is verified on its own kernel rather than through emulation. Branch protection, including "no force-push" and "no deletion", is a repository **setting** rather than a file, so it cannot be enforced from inside this tree; this paragraph is the contract to configure under Settings → Branches. [CODEOWNERS](.github/CODEOWNERS) is the in-repo half of the same intent: it requests review on the paths that define what a release *is*. The nightly `External smoke` job stays advisory, because it depends on a live third-party origin.

`npm run pack:check` resolves the real tarball file list and fails if anything outside package.json's `files` allowlist (plus the few files npm always includes) would ship — a test, a report, a probe or a captured session must never ride along with a release. The allowlist is read from the manifest at run time, so the check and the manifest cannot drift apart.

`npm run test:smoke` validates the shipped `dist/` bundle on a real dynamic single-page app: the adapter initializes on a third-party origin, types into a React-controlled field through the protocol, and proves Navi indexes controls that only exist after the app re-renders. It is excluded from `npm test` so the hermetic suite never depends on the network, and it runs nightly in [smoke.yml](.github/workflows/smoke.yml). See [SMOKE.md](reports/SMOKE.md).

## Artifacts

- [Client source](src/navi.js) · [built classic script](dist/navi.min.js) · [browser types](types/navi.d.ts)
- [Adapter source](src/adapter.js) · [flow runner](src/flow.js) · [CLI](src/cli.js) · [bin launcher](bin/navi-agent.js) · [published types](types/index.d.ts)
- [Example agent flow](flows/example-checkout.json)
- [Execution lab](demo/index.html)
- [Playwright/Puppeteer tool adapter and migration guide](docs/AGENT-INTEGRATION.md)
- [Architecture and analytics plan](docs/BACKEND.md) (backend is not implemented)
- [Acceptance contract](docs/ACCEPTANCE.md) · [browser tests](tests/navi.spec.mjs)
- [Verification summary](reports/VERIFICATION.md) · [raw measurements](reports/verification.json)
- [Competitive benchmark script](tests/benchmark-comparison.js) · [comparison report](reports/BENCHMARK.md)
- [CI gates](scripts/ci-gates.mjs) · [release gate](scripts/verify-release.mjs) · [PR/push pipeline](.github/workflows/ci.yml) · [release pipeline](.github/workflows/release.yml) · [nightly external smoke](.github/workflows/smoke.yml) · [external smoke test](tests/external-smoke.spec.mjs)
- [MCP server](src/mcp/server.js) · [SSE transport](src/mcp/sse.js) · [MCP launcher](bin/navi-mcp.js) · [MCP suite](tests/mcp-server.spec.mjs) · [SSE suite](tests/mcp-sse.spec.mjs) · [auth/concurrency suite](tests/mcp-auth-concurrency.spec.mjs)
- [Session hydration suite](tests/session-hydration.spec.mjs) · [session fixture](demo/auth.html)
- [Settlement engine](src/settle.js) · [settlement + adapter suite](tests/settlement.spec.mjs) · [settlement fixture](demo/settlement.html)
- [Tenant loader](src/loader.js) · [built snippet](dist/loader.min.js) · [loader suite](tests/loader.spec.mjs)
- [Integration matrix](docs/INTEGRATION-MATRIX.md) · [Claude Desktop config](examples/claude-desktop-config.json) · [Cursor config](examples/cursor-mcp.json) · [auto-discovery suite](tests/auto-discovery.spec.mjs) · [manifest negotiation suite](tests/manifest-loop.spec.mjs)
- [Mock model fixture](tests/fixtures/mock-llm-server.mjs) · [LLM harness contract](tests/llm-harness.spec.mjs) · [LLM benchmark report](reports/LLM-TCR-BENCHMARK.md) · [raw metrics](reports/llm-benchmark.json)
- [v0.5.0 release notes](docs/RELEASES/v0.5.0.md) · [production Compose file](deploy/docker-compose.prod.yml) · [Fly.io configuration](deploy/fly.toml)
- [Publish preflight](scripts/publish-preflight.mjs) · [release notes generator](scripts/release-notes.mjs) · [release pipeline spec](tests/release-pipeline.spec.mjs)
- [Host service](server/index.js) · [aggregate store](server/store.js) · [tenant keys](server/tenants.js) · [ingestion suite](tests/backend-ingest.spec.mjs)
- [CSP compliance suite](tests/csp-compliance.spec.mjs) · [hardening suite](tests/hardening.spec.mjs) · [shared browser helpers](src/browser.js)
- [External smoke report](reports/SMOKE.md) · [raw smoke log](reports/smoke-external.json)

## Truthful limits

Closed roots created **before** interception remain inaccessible; early scripts in child frames may run before discovery. Cross-origin/sandboxed frames require a cooperating in-frame installation and authorized executor. Browser/event-handler/prototype conflicts are possible; test the host app. No click-listener enumeration or accessibility repair.

A positional fingerprint cannot preserve business identity across arbitrary sorting. Stable keys must be authored in the DOM; React's private key is not enough. Non-cryptographic hashes can collide, and duplicated author IDs are not automatically fixed.

Actionability uses composed-ancestor styles and center-point hit tests. It is conservative around transformed frames and not a complete browser actionability algorithm. Native synthetic events have `isTrusted=false`; apps needing real gestures/pointer sequences must use browser automation. Two frames do not prove network/business completion. Page metadata and `window.Navi` are untrusted; executor authorization and outcome reconciliation remain necessary.

The benchmark gates raw bytes <15,000, SDK ticks ≤6ms/<16ms and zero observed >50ms long tasks on the documented 10,000-element local fixture. It reports **elapsed completion as well as slices**: yielding reduces blocking, not necessarily end-to-end latency. No universal INP guarantee, zero-token claim, 100% determinism or 10× speedup is made. See final measured results in the report.

Real React 19 state/sorting/replacement, closed roots, iframe navigation, occlusion and execution regressions are verified with Chromium. Vue-style native listeners are exercised, not a complete Vue app. Puppeteer adapter uses the same evaluate API but is not separately integration-tested. Firefox/Safari and customer frameworks remain rollout work.

No service account, public deployment or hosted environment was created; the ingestion service runs locally over plain HTTP and was never exposed or load-tested. React dependencies are dev-only test fixtures; the production SDK has zero runtime dependencies.

## License

[AGPL-3.0-or-later](LICENSE), declared in `package.json` as `"license": "AGPL-3.0-or-later"` and detected from [LICENSE](LICENSE) itself.

This is copyleft with a network clause, and section 13 binds whoever *runs* it, not only whoever publishes it: if you run a modified version as a network service, you must offer its Corresponding Source to the people who interact with it. The host service implements its own half of that — `GET /v1/source` redirects to the source of the running version, the discovery document publishes the same URL as `source`, and every response advertises it as `rel="source"`. **A fork must set `NAVI_SOURCE_URL` to its own repository**, because upstream's source does not discharge section 13 for a version you have modified.

The copyleft choice is deliberate rather than incidental. A permissive grant on a published version cannot be withdrawn, so it forgoes the option of licensing this runtime on other terms later; copyleft keeps that option open, which is why the package is not MIT.

Settlement is a heuristic with a name, not a proof of completion. `mutation_settle` cannot see inside a *closed* shadow root, so a mutation that happens only there can read as silence; `target_hidden` believes Navi's own visibility/occlusion state, so a target that stays visible but inert times out; and `navigation` treats a URL change or a reload as the effect, which a same-page redirect can satisfy without the business outcome. Nothing here proves that a network write, a payment or a server-side transaction finished. The tenant loader inherits the browser's SRI/CORS rules: with `crossorigin="anonymous"` the script origin must send `Access-Control-Allow-Origin` (the reference host does), an `integrity` hash must match the bytes on the wire (a CDN that rewrites the bundle fails closed, which is the point), and a page that never supplies `data-sri` gets no verification at all.

The SSE transport is gated, not identified: one shared bearer token guards the port when you set one, session ids stay anonymous as the MCP binding specifies, there is no per-caller identity, no rate limiting beyond the session ceiling and no TLS. Loopback is the default and a non-loopback bind without a token is refused. The hosted-session feature stores whatever cookies or storage state the caller supplies — the tool validates their shape, not their safety, and the same is true of the tenant keys the ingestion service accepts. Telemetry from an untrusted page is attacker-controlled input; the schema limits its shape, not its truthfulness.
