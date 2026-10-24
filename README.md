# Navi

**Structured interaction for teams building browser workflow agents.** Navi maps indexed controls to named targets with live actionability checks, including captured closed shadow roots and same-origin frames. Its adapter dispatches guarded actions and can wait for a requested page condition. Verify the saved record or completed transaction separately.

[![npm](https://img.shields.io/npm/v/navi-interaction-bridge)](https://www.npmjs.com/package/navi-interaction-bridge) [![License: AGPL-3.0 + commercial](https://img.shields.io/badge/license-AGPL--3.0%20%2B%20commercial-blue)](LICENSING.md) [![Discussions](https://img.shields.io/github/discussions/Wub796/Navi)](https://github.com/Wub796/Navi/discussions)

## Quickstart: try locally for free

Use Node 22+ and install Chromium with `npx playwright install chromium`. No hosted API key or payment is required for local Community evaluation under the [AGPL license](LICENSING.md).

Add this to your MCP client config (Claude Desktop, Cursor, or any MCP host):

```json
{
  "mcpServers": {
    "navi": { "command": "npx", "args": ["-y", "-p", "navi-interaction-bridge", "-p", "playwright", "navi-mcp"] }
  }
}
```

Restart your MCP client, then ask your agent: *"Open https://example.com with Navi and list the actions you can take."* It calls `navi_navigate`, then `navi_get_actions`, and gets back stable target ids such as `learn-more-940adfaa` that `navi_execute_action` accepts.

## Where Navi fits

Use Navi for discovering controls, checking actionability, and executing click/type/select actions. `navi_read_text` provides a bounded read of one top-document element for workflows that need page text. Keep your existing browser driver for screenshots, keyboard shortcuts, and scrolling inside frames or shadow roots. The MCP `navi_scroll_to` tool scrolls top-document controls only.

- **Closed roots:** capture starts when Navi is loaded; inject it before the application's scripts. Already-created closed roots and cross-origin frames are not generally accessible.
- **Differential reads:** a controlled 100-mutation fixture used 96.9% fewer estimated tokens than repeatedly sending Navi's own full map. This is not a comparison with another agent product. [Raw fixture](reports/differential-mutations.json).
- **Current checkout result:** both paths completed 10/10 server-verified orders. Navi used 2,890.2 observation tokens/task versus 1,025.7 for Playwright; mean times were 1.772 s and 1.968 s. The baseline included explicit 300 ms waits, and no LLM planner was used. This does not establish general savings or superiority. [Methodology](reports/TCR-BENCHMARK.md).
- **Outcome checks:** optional settlement waits for DOM quiet, navigation, or target disappearance. `navi_read_text` can read the resulting UI, but neither a settlement nor rendered text proves a server-side transaction completed. Use an independent business assertion before declaring success.
- **Data handling:** action maps omit input values. Accessible names, labels, URLs, and page text can still contain sensitive information. Review what your agent host and optional hosted publishing endpoint receive.

Evaluate Navi alongside your current browser stack on the same workflows. The [pilot guide](docs/PILOT-GUIDE.md) defines the measurements and a two-week customer validation plan.

Questions or integration feedback: [GitHub Discussions](https://github.com/Wub796/Navi/discussions). Community is AGPL-3.0-or-later; commercial use is governed by the [commercial terms](COMMERCIAL-TERMS.md). Those terms let you embed Navi in products you sell and use it for your own customers, and exclude reselling Navi itself or shipping a competing fork. Evaluation, including a one-workflow pilot, needs no subscription.

## Run from source

Node ≥22 (`engines.node` is `>=22.0.0`; the pinned container runtime is 22.23.3), npm, and Playwright Chromium:

```sh
git clone https://github.com/Wub796/Navi.git
cd Navi
npm ci --no-audit --no-fund
npx playwright install chromium
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
    "navi": { "command": "npx", "args": ["-y", "-p", "navi-interaction-bridge", "-p", "playwright", "navi-mcp"] }
  }
}
```

| Tool | Purpose |
|---|---|
| `navi_navigate` | Open an http(s) URL and wait for Navi initialization. Reports which SDK install strategy was used. |
| `navi_get_actions` | Return the current action map. Viewport-filtered by default; `all: true` returns the whole document. |
| `navi_scroll_to` | Scroll a unique top-document `target_id` into view and return fresh state. Use `navi_get_actions({all:true})` to discover off-screen targets first. |
| `navi_execute_action` | Run `click`/`type`/`select` on a `target_id`. Falls back to trusted native input at live coordinates for `data-navi-trusted="true"` controls. Pass `settle` to wait for a requested page condition before the call returns. |
| `navi_read_text` | Read normalized, untrusted text from one top-level element, bounded to 2,000 characters by default and 4,000 maximum. |
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
| `mutation_settle` (default) | the document, its open shadow roots and same-origin frames record no DOM mutation for 100 ms, or the action replaces the document outright, which settles as `settle_reason: "document_replaced"` |
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

`target_url` is stripped to `origin + pathname`, so credentials, query strings and fragments never reach a log. The counters are incremented before the line is written, and a log sink that has gone away cannot change the outcome: the refusal still fails closed, and the missing line shows up as a gap between `violations_total` and the lines a pipeline received. `violations_total` counts every refusal while `violations_by_category` covers the classified ones, so a malformed or credentialed URL is counted in the total and logged as `unclassified` rather than forced into a bucket. With `NAVI_ALLOW_LOCAL_NETWORK=1` the policy is off: `enforced` reports `0` and nothing is counted.

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

The edge Worker (`wrangler.toml`, `src/worker.ts`) serves the same two scripts at the same paths, so the embed snippet on its landing page works: `GET /v1/loader.js` is anonymous and cacheable, and `GET /v1/navi.js?key=…` checks the tenant key and charges one unit from the hosted-site quota before returning bytes. A refused or suspended tenant cannot obtain the runtime. The bundle is served `private, max-age=0, must-revalidate`; a `304` also consumes one unit. Accepted writes to `/v1/sitemap/update` consume from the same quota. The self-hosted telemetry host below serves the files unmetered and uses a separate quota configuration for beacon ingestion.

`server/` is a standalone, zero-dependency service that distributes the bundle to registered tenants and collects agent-usage aggregates:

```sh
npm run build && npm run serve          # http://127.0.0.1:8790
NAVI_TENANTS="live_key_abc:acme" node server/index.js --port 8790 --store server/telemetry.db
```

| Endpoint | Behaviour |
|---|---|
| `GET /` | The product landing page — the same document the edge serves, including the pure-CSS 3D stage, the receipt inspector, the integration tabs, the recorded benchmark comparison and the four-tier pricing grid. `text/html; charset=utf-8`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, and `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src 'self'` (the one image source is the page's own favicon); the page carries no script. Payment Links come from `STRIPE_PAYMENT_LINK_STARTER`, `STRIPE_PAYMENT_LINK_PRO` (or the legacy `STRIPE_PAYMENT_LINK_URL`) and `STRIPE_PAYMENT_LINK_ENTERPRISE`, exactly as on the edge. |
| `GET /v1/navi.js?key=<tenant_key>` | Self-hosted service serves `dist/navi.min.js` unmetered with `Cache-Control: public, max-age=3600, stale-while-revalidate=86400`, an `ETag` equal to the SRI SHA-384, and `304` on `If-None-Match`. `401` without a valid key. |
| `GET /v1/loader.js` | Serves `dist/loader.min.js`, the tenant embed snippet. Carries no tenant key of its own. |
| `GET /favicon.svg`, `GET /logo.svg` | The brand assets the landing and onboarding documents link, and the social-card image. Anonymous `image/svg+xml`, cached `public, max-age=86400`, served under `default-src 'none'` and `nosniff` like every other public read. |
| `GET /robots.txt`, `GET /sitemap.xml` | Crawl policy (`Allow: /`, `Disallow: /v1/billing/`, and the sitemap line) and the canonical root for indexers. Anonymous, `public, max-age=3600`, `text/plain` and `application/xml` respectively. |
| `POST /v1/telemetry` | Ingests the beacon payload `{ tenant_id, url_origin, actions_indexed, actions_executed, execution_failures }`, as `application/json` or beacon-shaped `text/plain`. Strict schema, ≤ 2 KB, canonical origins only. |
| `GET /v1/telemetry?key=<tenant_key>` | The tenant's aggregate: totals, per-origin and per-tenant event counts, plus its `quota` window (`max_events_per_window`, `window_seconds`, `window_start_ms`, `event_count`) or `null` when the tenant is unmetered. `Authorization: Bearer <tenant_key>` names the same tenant. `no-store`. |
| `POST /v1/billing/webhook` | Stripe event receiver: a signed `checkout.session.completed` / `customer.subscription.created` / `customer.subscription.updated` provisions a tenant (key, `allowed_origins`, quota) and a `customer.subscription.deleted` sets its ceiling to `0` so ingestion answers `429` instead of `401`. HMAC-SHA256 over `${t}.${body}`, a 300-second replay window, constant-time compare, and an atomic 24-hour event-id ledger so a redelivered `evt_…` is `200 {"ok":true,"duplicate":true}` instead of a second provision. `503` when `NAVI_STRIPE_WEBHOOK_SECRET` is unset, `401` on any signature failure. |
| `GET /v1/billing/session?session_id=cs_…` | One-time post-checkout API-key retrieval for customers redirected from a Stripe Payment Link (`checkout.session.completed` with `cs_…`). Valid for 15 minutes; consumes the claim on the first read and returns `200 {"ok":true,"tenant_id":…,"api_key":…}` (`Cache-Control: no-store`), or `404 {"error":"Session not found or already claimed"}` when missing, expired, or already claimed. |
| `GET /v1/billing/success?session_id=cs_…` | The same one-time claim, rendered as the page a Stripe `success_url` redirects to: the provisioned key, the tenant id, and copy-ready loader-embed and `Authorization: Bearer` snippets, or a plain explanation that the link expired or was already used. Identical claim semantics — whichever surface is opened first shows the key and the other answers `404` — with `text/html`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and `Content-Security-Policy: default-src 'none'`, because the page carries the secret and runs no script. |
| `POST /v1/telemetry/violations` | Ingests one containment violation — `{ session_id, category, target_url, resolved_ip }` — filed against the tenant the request's key resolves to. `application/json`, ≤ 2 KB, six documented categories, and a `target_url` that must already be a sanitized origin plus path. `401 UNKNOWN_TENANT` for an unregistered key or a body naming another tenant, `400 INVALID_PAYLOAD`, `415`, `413`. |
| `GET /v1/tenants/<tenant_id>/security-audit` | That tenant's persisted violations, newest first, `?limit=` (default 50, max 200) and `?since=` (ISO-8601). Requires `Authorization: Bearer <tenant_key>` — a query-string key is refused here — and answers `403` for any path tenant but the key's own. `Cache-Control: no-store, private`. |
| `POST /v1/tenants/<tenant_id>/maintenance/prune` | Deletes that tenant's violations older than a window: `{ "max_age_days": 30 }` (`1`…`36500`), or no body to use `NAVI_RETENTION_DAYS` (default 30). Bearer key only, `403` for another tenant's path, and the answer is `{ ok, tenant_id, max_age_days, pruned_count, remaining_count }`. |
| `GET /healthz` | `{ ok, mode, tenants, retention_days }`, where `mode` is `sqlite` or `log` and `retention_days: 0` means nothing is pruned automatically. |
| `GET /metrics` | Prometheus `text/plain; version=0.0.4`: `navi_host_requests_total{route,status}`, `navi_host_rate_limited_total{tenant_id}`, `navi_host_prune_events_total`, `navi_host_pruned_records_total`, `navi_host_active_tenants`, `navi_host_store_bytes`, and per metered tenant `navi_host_tenant_quota_limit`, `navi_host_tenant_quota_events`, `navi_host_tenant_quota_window_start_seconds` and `navi_host_quota_exceeded_total`. Open like `/healthz` until `NAVI_METRICS_TOKEN` is set, after which a scrape needs `Authorization: Bearer <token>` and a missing or wrong one is `401`. Aggregate-only, `no-store`, and the `route` label comes from a closed set so an unmatched path is one `other` series rather than one per path a scanner tries. |
| `GET /.well-known/navi.json` | The agent discovery document — `{ version, protocol, status, capabilities, endpoints, source }` — served `public, max-age=300` with a strong `ETag` and `304` on `If-None-Match`. Every response on this service carries both relations in one header — `Link: </.well-known/navi.json>; rel="agent-bridge", <https://github.com/Wub796/Navi>; rel="source"` — so an agent that can reach any route can find the document, and every reader is offered its source. |
| `GET /v1/source` | Redirects (`302`) to the Corresponding Source of the version answering — `https://github.com/Wub796/Navi`, or `NAVI_SOURCE_URL` when this host runs a modified version. Unauthenticated, and cached like the discovery document. This is the offer AGPL-3.0 section 13 requires a network service to make. |

### Commercial plans

The hosted edge sells four tiers, and `GET /` renders them as a pricing grid whose paid cards link to the Stripe Payment Links this deployment configured. The self-hosted host serves the same `GET /` document (`server/public-routes.js`), so a local deployment is documented out of the box; its links stay relative because it does not know its own public origin.

| Plan | Price | 30-day hosted-site quota |
|---|---|---|
| Community | $0 | Self-hosted under AGPL-3.0, unmetered |
| Starter | $29/mo | 10,000 quota units |
| Pro | $49/mo | 50,000 quota units, plus a commercial licence exempting the buyer from AGPL-3.0 |
| Enterprise | $199/mo | 250,000 quota units, plus a commercial self-hosted Docker licence |

Each authorized edge serve of `navi.js` (including a `304` revalidation) and each accepted sitemap write consumes one unit from the same 30-day quota window. Quota is enforced: after it is exhausted, both operations return `429` until the window resets or the plan changes. There is no automatic overage billing. The local self-hosted telemetry host has a separate ingest quota configuration; its beacon counts do not feed the hosted-site plan quota.

A Payment Link created in Stripe's hosted editor carries no metadata, so the webhook infers the plan from the amount billed — `amount_subtotal`/`amount_total` on a checkout, the first line item's `price.unit_amount` or `plan.amount` on a subscription — and defaults to Pro when no amount is present. Explicit metadata still wins: `unmetered: "true"` grants no ceiling, `max_events_per_window` (with `window_seconds`) sets one, and `tier`/`plan` of `starter`, `pro` or `enterprise` selects a named plan. Configure the links as Worker secrets:

```sh
wrangler secret put STRIPE_PAYMENT_LINK_STARTER      # $29/mo
wrangler secret put STRIPE_PAYMENT_LINK_PRO          # $49/mo
wrangler secret put STRIPE_PAYMENT_LINK_ENTERPRISE   # $199/mo
```

`STRIPE_PAYMENT_LINK_URL` remains honoured as the pre-tier name for the Pro link.

Both scripts are served with `Access-Control-Allow-Origin: *`, because the supported embed is a `crossorigin="anonymous"` script with an `integrity` hash: the browser then fetches in CORS mode and verifies the bytes before executing them.

Containment violations are the second record type and live in their own `containment_violations` table, indexed on `(tenant_id, created_at)`, so an audit question can never skew an aggregate: in JSONL mode a violation line carries `kind: "containment_violation"` and is skipped by the summarizer. A tenant reads its own back through the audit route; nothing there is a page URL, a query value or a credential, because the reporting MCP server sanitizes the destination before it leaves the browser process.

That trail is pruned rather than accumulated. `NAVI_RETENTION_DAYS` (default **30**, `0` disables it) sweeps expired violations at startup and every six hours, and a tenant can prune its own on demand through the maintenance route above; both delete only their own rows, and `GET /healthz` reports the window so "nothing is being pruned" is as visible as "the store is up". SQLite deletes with a `julianday()` comparison — the stored timestamps are ISO-8601 with a `T` and a `Z` where SQLite's own `datetime()` renders a space and no zone, and comparing those as text would spare every row on the cutoff's own day. Log mode compacts instead: it streams the file to a temporary and renames over the original, so a reader sees the old file or the new one and never a mixture, keeping aggregate lines verbatim and writing the surviving violation ids explicitly — a pruned row cannot renumber the rows around it, and a `navi_store_meta` line records the highest id ever issued so the next append continues past it, before or after a restart.

Ingestion is bounded per tenant as well, on both ingest routes, by an in-memory token bucket of **120 requests per minute with a burst of 30** (`NAVI_RATE_LIMIT_PER_MINUTE`, `NAVI_RATE_LIMIT_BURST`, `0` disables). Beyond the ceiling the answer is `429 RATE_LIMITED` with `Retry-After`, `X-RateLimit-Limit` and `X-RateLimit-Remaining: 0`, and nothing is parsed or stored; accepted responses carry the same two counters so a client can pace itself. A key-authenticated request is charged before its body is read, an unauthenticated beacon once its payload names a tenant, so one page cannot spend another tenant's allowance. Buckets are forgotten after ten idle minutes, which is what keeps the map a function of who is active rather than of who has ever been seen — and being per process, two replicas each allow the full rate, so enforcement belongs at the shared edge once there is more than one.

The SQLite backend runs in write-ahead-logging mode — `journal_mode = WAL` with `synchronous = NORMAL`, the documented pairing, so a commit survives a process crash without a file sync on every append — and `auto_vacuum = INCREMENTAL` is set **before** the journal switches to WAL, because in WAL mode SQLite accepts that pragma and silently ignores it; the mode is read back from the live connection rather than assumed, and the ordering is what `tests/host-metrics-lifecycle.spec.mjs` asserts. A delete leaves its pages in the write-ahead log, so `checkpoint({ truncate: true })` (`PRAGMA wal_checkpoint(TRUNCATE)`) follows every prune that removed a row and runs once more at teardown: the file an operator measures is the file that actually shrank. Log mode answers the same call with zeros, so no caller branches on the backend, and a clean `close()` checkpoints and lets SQLite remove the `-wal` and `-shm` sidecars.

Two operational artifacts ship with the service, and both are held to the metric names the expositions actually serve rather than to a list in a README: [deploy/prometheus/alerts.yml](deploy/prometheus/alerts.yml) carries the rules (containment attempts by category, a queue that is losing audit events, host rate-limit pressure, a stalled retention sweep, session saturation, a target that is down, and state-based unclean shutdowns and recently started processes), and [deploy/grafana/dashboard.json](deploy/grafana/dashboard.json) the dashboard that imports without per-panel editing. `npm test` parses YAML/JSON and PromQL and fails on a renamed series, an unbounded counter comparison, or a missing severity. Both services export `process_start_time_seconds` and a 0/1 unclean-shutdown counter from the preceding owner's lifecycle state. Clean markers are consumed at startup and written only after teardown succeeds.

**Shutdown is a deadline, not a hope.** `SIGTERM` and `SIGINT` stop accepting new connections, let in-flight requests finish within a strict **5 seconds** (`SHUTDOWN_DEADLINE_MS`, deliberately the same number the MCP transports declare, so a container's stop timeout is sized against one value), destroy whatever is still open when that deadline passes, clear the retention interval, checkpoint and close the store, and exit `0` with no orphaned journal or lockfile for the next start. The handlers are removed once one fires, so a second signal reaches the default action and an operator who insists is not held by a drain that is already stuck. stdout carries only the readiness line; drains, failed requests and retention sweeps go to stderr.

Aggregates are appended to `node:sqlite` wherever the runtime can import it — from Node 22.5, and without `--experimental-sqlite` from 22.13, which is what the pinned base is — and to an append-only JSONL log at the same path when that import is not available. The choice is made by the **file**, not by the runtime: both backends share one path, so an existing JSONL log keeps the log backend even where SQLite is available (a runtime change must not reopen an operator's audit trail as a database, whose first statement would fail with `SQLITE_NOTADB`), a file that already holds the SQLite header keeps SQLite, and a runtime that cannot see the module **refuses** a database rather than reading it as an empty log. `store.mode` reports which is live, and both answer with an identical summary shape, violations included. Rejected payloads — unknown keys, wrong types, negative or non-integer counters, a `url_origin` carrying a path, query, fragment, trailing slash or credentials, an unregistered tenant, or raw DOM/HTML text — never reach the store.

**The client SDK sends no telemetry.** Its no-network guarantee is enforced by a test at 14,929 bytes; the beacon is built and dispatched by the hosting page or tenant script, and `demo/` shows the shape. Treat this service as a reference implementation: it has tenant keys, not user auth; per-tenant ingest ceilings and a retention window are in place, but there are no quotas, no deduplication, no warehouse export and no TLS termination.

To make refusals durable, point the MCP server at this service with `NAVI_TELEMETRY_ENDPOINT` (for example `http://127.0.0.1:8790`) and `NAVI_TENANT_KEY` (`NAVI_TENANT_ID` is optional; the key already resolves the tenant). Every classified refusal is then queued and posted in the background, never on the path of the request it describes: a host that is slow, down, unconfigured — or `429`-ing the tenant for exceeding its ingest ceiling — drops the event and increments a counter instead of delaying the refusal, changing its error code, unblocking the destination, or retrying. A tenant that legitimately refuses more than 30 destinations a minute therefore needs `NAVI_RATE_LIMIT_PER_MINUTE` raised on the host, or the operator's alerting will see `navi_containment_forward_failed_total` climb. The queue holds **256** events, `GET /healthz` reports `containmentForwarding`, and `GET /metrics` exposes `navi_containment_forwarded_total`, `navi_containment_forward_failed_total`, `navi_containment_forward_dropped_total` and `navi_containment_forward_queued` — a climbing failure count is the signal that the audit trail has holes.

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

[verify-release.mjs](scripts/verify-release.mjs) is the release gate. It requires a worktree clean apart from build output and generated reports, an SRI that hashes to the bytes of `dist/navi.min.js`, a suite with zero failures and at least 264 passing tests, a clean-room tarball canary (`cleanroom-package-canary`) that verifies the unpacked package layout, SRI byte parity, zero leaks, and a live stdio JSON-RPC handshake, a rebuild that reproduces the shipped artifacts byte for byte, both byte budgets, the CI gates and the publish allowlist — and only then, with `--tag`, creates the annotated `v<version>` tag. Its receipt records structured `evidence` beside the prose details: the revision, a digest of every tracked path outside `reports/`, the SRI, the artifact sizes, the container receipts, and the clean-room canary results it verified.

[release.yml](.github/workflows/release.yml) runs that gate on a tag push and then publishes the revision it just verified, with `--provenance --access public`, behind the `release` environment so required reviewers can hold any publish for a human. The publish job depends on two verification jobs by id: the release gate above, and a container verification that builds and exercises the image on both released architectures on their own hardware against `deploy/docker-compose.prod.yml` — the file an operator deploys — so a release whose runtime posture failed is never published. One further gate stands between a tag and the registry: [publish-preflight.mjs](scripts/publish-preflight.mjs) checks the decisions a pipeline must not make on an owner's behalf — a LICENSE file, a `license` field, the access and provenance settings, a tag matching `package.json`, a receipt that still describes the exact bytes being published, provenance parity (`provenance-parity`) — because the receipt is committed by a later commit than the one it names, the preflight proves that HEAD is that revision or an ancestor with nothing outside `reports/` changed, so a report commit that quietly carried a source edit cannot be published — container verification of a configuration this repository deploys recorded green in that receipt, and clean-room package canary verification (`evidence.canary` with 6/6 passing checks), so an image whose runtime posture or packaged tarball was never proven cannot be published on the strength of a receipt that is silent about it. **It passes today: the package ships a `LICENSE` file and declares `AGPL-3.0-or-later`.** Release notes are generated from those receipts by [release-notes.mjs](scripts/release-notes.mjs) rather than retyped, so a note cannot describe a different artifact than the one published.

### Required status checks

The CI checks `main` should require are `Quality gates (Node 22.x)`, `Benchmark gate (Node 22.x)`, the two container verification legs in [ci.yml](.github/workflows/ci.yml) — `Container verification (linux/amd64)` on `ubuntu-latest` and `Container verification (linux/arm64)` on `ubuntu-24.04-arm` — and the two native sandbox jobs from [containers.yml](.github/workflows/containers.yml) — `Sandboxed Chromium (linux/amd64)` on `ubuntu-24.04` and `Sandboxed Chromium (linux/arm64)` on `ubuntu-24.04-arm`, so each architecture is verified on its own kernel rather than through emulation. Branch protection, including "no force-push" and "no deletion", is a repository **setting** rather than a file, so it cannot be enforced from inside this tree; this paragraph is the contract to configure under Settings → Branches. [CODEOWNERS](.github/CODEOWNERS) is the in-repo half of the same intent: it requests review on the paths that define what a release *is*. The nightly `External smoke` job stays advisory, because it depends on a live third-party origin.

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

The edge Worker is deployed and its Payment Links are live; no end-to-end purchase has been exercised in this repository, and the reference host service (`server/`) has never been exposed or load-tested. Its ingestion API is plain HTTP with tenant keys as the only authorization. React dependencies are dev-only test fixtures; the production SDK has zero runtime dependencies.

## License

[AGPL-3.0-or-later](LICENSE), declared in `package.json` as `"license": "AGPL-3.0-or-later"` and detected from [LICENSE](LICENSE) itself.

This is copyleft with a network clause, and section 13 binds whoever *runs* it, not only whoever publishes it: if you run a modified version as a network service, you must offer its Corresponding Source to the people who interact with it. The host service implements its own half of that — `GET /v1/source` redirects to the source of the running version, the discovery document publishes the same URL as `source`, and every response advertises it as `rel="source"`. **A fork must set `NAVI_SOURCE_URL` to its own repository**, because upstream's source does not discharge section 13 for a version you have modified.

The copyleft choice is deliberate rather than incidental. A permissive grant on a published version cannot be withdrawn, so it forgoes the option of licensing this runtime on other terms later; copyleft keeps that option open, which is why the package is not MIT. That option is exercised: Navi is **dual-licensed**, and Pro and Enterprise customers receive a commercial licence that waives the AGPL obligations for their deployments. [LICENSING.md](LICENSING.md) draws the boundary between the open-source core, the commercial licence and the hosted service, and [CONTRIBUTING.md](CONTRIBUTING.md) holds the contributor terms that keep the dual licence grantable.

Settlement is a heuristic with a name, not a proof of completion. `mutation_settle` cannot see inside a *closed* shadow root, so a mutation that happens only there can read as silence; `target_hidden` believes Navi's own visibility/occlusion state, so a target that stays visible but inert times out; and `navigation` treats a URL change or a reload as the effect, which a same-page redirect can satisfy without the business outcome. Nothing here proves that a network write, a payment or a server-side transaction finished. The tenant loader inherits the browser's SRI/CORS rules: with `crossorigin="anonymous"` the script origin must send `Access-Control-Allow-Origin` (the reference host does), an `integrity` hash must match the bytes on the wire (a CDN that rewrites the bundle fails closed, which is the point), and a page that never supplies `data-sri` gets no verification at all.

The SSE transport is gated, not identified: one shared bearer token guards the port when you set one, session ids stay anonymous as the MCP binding specifies, there is no per-caller identity, no rate limiting beyond the session ceiling and no TLS. Loopback is the default and a non-loopback bind without a token is refused. The hosted-session feature stores whatever cookies or storage state the caller supplies — the tool validates their shape, not their safety, and the same is true of the tenant keys the ingestion service accepts. Telemetry from an untrusted page is attacker-controlled input; the schema limits its shape, not its truthfulness.
