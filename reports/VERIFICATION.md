# Navi Protocol v0.2 · package v0.4.0 final verification

Recorded 2026-10-09. Supersedes the earlier v0.1 synchronous classification report and the v0.3.0 report. The protocol stays 0.2.0; package 0.4.0 adds deterministic settlement, the tenant embed loader, authenticated and bounded MCP transports, session hydration, the host service and the release gate.

Every figure below comes from an artifact in this directory or from a command replayed on this workstation. The one thing that did **not** happen is a GitHub-hosted run: the repository has no remote configured, so the pipelines were replayed locally in workflow order ([SMOKE.md](SMOKE.md) records that replay), and the release tag is local.

## Final passing checks

- `npm run typecheck`: strict JavaScript, tooling, tests and public API types passed.
- `npm test`: final built artifacts, **61 Chromium tests passed** (18 protocol + 10 distribution/CLI + 3 CSP compliance + 2 prototype hardening + 3 MCP over stdio + 1 MCP over SSE + 5 SSE auth/concurrency + 1 session hydration + 8 host service + 7 settlement + 3 tenant loader), zero failures, 0 skipped.
- The same suite was re-run on **Node 20.20.2**, the runtime the pipeline declares: typecheck passed, the build reproduced a **byte-identical 14,265-byte artifact** with the same SRI, the gate self-test held 19/19, all **61 tests passed** (including settlement and the 10,000-element long-task specification), the external smoke suite passed, and the ingestion suite passed through its `log` store fallback because `node:sqlite` is unavailable there.
- Client artifact: **14,265 raw UTF-8 bytes** (<15,000 strict budget), **5,560 bytes gzip**. No runtime dependencies/source map.
- The shipped bundle is provably CSP-clean (no `eval`/`Function`/inline style injection) and runs inside a document served with `default-src 'self'; script-src 'self' 'nonce-…'; style-src 'self'`, completing a two-field flow with zero `securitypolicyviolation` events and zero refused CSP requests.
- Prototype isolation is verified adversarially: after Navi loads, a host script replaces `Element.prototype.getBoundingClientRect`/`getComputedStyle`, freezes and nulls observers and schedulers, and replaces `attachShadow`; discovery, occlusion state, execution and late mutation indexing keep working through the pinned originals.
- `dist/sri.txt` carries the SHA-384 of the shipped bundle, and the CSP suite re-derives it from the served bytes so the published hash cannot drift from the artifact (the same hash is recorded in `reports/build.json` and `reports/verification.json`).
- The demo checkout was re-verified end to end through both the local demo origin and the shipped artifacts after every change in this revision; screenshots were refreshed and the 390px viewport had no horizontal overflow.

## Deterministic settlement

An action returning "dispatched" is not the page having reacted, so `navi_execute_action` and `NaviPlaywrightAdapter.execute()` now accept an optional settlement request and answer with a receipt `{ executed, settled, elapsed_ms, final_url }`.

- `mutation_settle` holds when the document, its open shadow roots and its same-origin frames record **no DOM mutation for 100ms**, with observation armed *before* dispatch so a mutation the click itself causes counts. Navi's own generated-id writes simply extend the quiet window rather than being mistaken for the effect.
- `target_hidden` holds when the dispatched target leaves the action map or Navi reports it invisible or occluded — the modal-dismissal case. A truncated map cannot prove absence and is never read as "hidden", so a capped map fails closed instead of reporting a false settlement.
- `navigation` holds when the top-level URL changed or the document reloaded. A reload that **destroys the execution context mid-dispatch** is treated as the receipt rather than surfaced as a transport error, because the navigation is the evidence the action applied.
- Honesty is asserted in both directions: an action that hides nothing reports `settled: false` with `reason: 'timeout'` while still reporting `executed: true` and its dispatch, an invalid request is refused with `INVALID_SETTLE` **before** anything is dispatched, and a call without a settle request carries no receipt fields at all, so an unverified dispatch cannot be mistaken for a verified one.
- Scope limit retained in the docs: settlement is a scheduling signal, not proof of completion. A mutation inside a *closed* shadow root is invisible to the driver, `target_hidden` trusts Navi's own state, and `navigation` is satisfied by a same-page redirect. Nothing here proves a network write or a server-side transaction finished.

## Tenant embed loader

`dist/loader.min.js` is the whole embed — **480 bytes**, strictly under its 500-byte gate, configured only by `data-key` and `data-sri` on its own tag.

- It injects `/v1/navi.js?key=…` **asynchronously**, resolved against the loader's own origin so the snippet can be served from a CDN while the page runs on the tenant's domain, and appends the published `integrity` hash plus `crossorigin="anonymous"` so the browser verifies the bytes before executing them.
- Late-binding `window.Navi` queues every call made above it and replays it against the real SDK, and the shipped bundle recognizes its own stub and installs over it — no other pre-existing `Navi` is touched, so a page that already has one is left alone.
- It fails **closed**: a refused tenant key rejects every queued call instead of leaving them pending, and an integrity mismatch is the browser's refusal, not a silent downgrade.
- The 71-byte hash travels in the embed tag rather than inside the snippet, because baking it would push the snippet past its budget. `npm run build` prints the exact tag with the current hash; the budget is a build failure, not a warning.
- The loader suite serves its fixture from a **loopback** origin while loader and bundle come from the host service, so the test performs a genuine cross-origin, CORS-mode, integrity-verified fetch. A non-loopback page origin fetching a loopback host is blocked by Chromium's Private Network Access policy, which is why the fixture is where it is rather than an assertion being dropped.

## Remote transport: authentication and resource bounds

- The official SDK's `SSEClientTransport` connects to `navi-mcp --transport sse`, receives the `endpoint` frame, runs a multi-step flow including a dynamic re-render, and the process stops on `SIGTERM`. The transport is `node:http`-only, with one browser session per connection, so two clients never share a page.
- `--auth-token <token>` (or `NAVI_MCP_TOKEN`) requires `Authorization: Bearer <token>` on **both** `/sse` and `/message`, compared in constant time. A missing, wrong or unschemed credential is `401 UNAUTHORIZED` with a `WWW-Authenticate` challenge, decided **before** the session is looked up so an anonymous caller cannot probe for live session ids, and the credential appears in no response body and no log. The test asserts the token never reaches the child's stderr.
- `--max-sessions <n>` (default 10) answers a stream past the ceiling with `503 TOO_MANY_SESSIONS` and `Retry-After` **without starting a session**, and the count is live: closing a stream frees the slot, which the suite proves by reconnecting afterwards.
- `--idle-timeout <seconds>` (default 300; `0` disables) reaps a session that receives nothing for that long and closes its browser, while a session with a call in flight is never reaped — both halves are asserted with a stub session so that *the session being closed* is observable rather than only the stream ending.
- A `--host` that is not loopback with no token is **refused** with exit code `2` rather than warned about. An empty `--host` is included in that refusal, because Node reads an empty host as every interface — a fail-open path found while reviewing this change and closed before the final replay. `--max-sessions` below 1, a non-numeric `--idle-timeout` and a valueless `--auth-token` are usage errors (`2`).
- The hardened server was then driven by the **official client** end to end (list tools, navigate, discover, execute, assert) while an anonymous caller on the same port was refused, so the auth path is verified with the protocol's own SDK and not only with `curl`.
- Scope limit retained in the docs: this is a **gate, not an identity**. Session ids stay anonymous as the MCP SSE binding specifies, one credential covers every caller, there is no per-user account, no rate limiting beyond the stream ceiling and no TLS; exposure beyond loopback still means an authenticating proxy in front of the port.

## Session hydration

`navi_set_session` was verified against a fixture whose gated controls are produced from session state rather than a URL parameter: anonymous discovery offers only `sign-in`, inline cookies plus per-origin localStorage unlock `account-balance` and `sign-out` **before the document starts**, a `storageState.json` file produces the same result, a gated control is genuinely drivable afterwards, no session value is echoed back, and seven malformed payloads are refused with `INVALID_SESSION` without disturbing the live session. Honest limit: this validates the **shape** of what the caller supplies, not its safety or provenance.

## Host service and MCP server

- The host service was driven entirely over HTTP: keyed distribution with the exact cache headers, a quoted SHA-384 `ETag`, byte-for-byte equality with `dist/navi.min.js`, `304` on `If-None-Match`, `401` for missing and unknown keys, a beacon-shaped `text/plain` post reflected in the tenant aggregate, deterministic ordering, eleven rejection cases, raw-DOM rejection proving nothing was stored, and `no-store` on tenant data. `GET /v1/loader.js` serves the loader unmodified with the same policy.
- The MCP server was driven end to end by the **official `@modelcontextprotocol/sdk` client** over stdio JSON-RPC: `tools/list`, `navi_navigate`, `navi_get_actions` (viewport subset and `all:true`), `navi_execute_action` including a trusted-input fallback, `navi_assert_state`, and a structured `NO_PAGE` refusal carrying actionable guidance. A `data-navi-trusted="true"` control is driven automatically by real hardware input in a default session (`mode: native-driver`), and the same call in a strict session (`--no-fallback`) is refused with `FALLBACK_DISABLED` while synthetic dispatch keeps working. The server ships with zero runtime dependencies.
- `dist/index.mjs` and `dist/index.cjs` both load and expose `NaviPlaywrightAdapter`; both resolve the shipped `navi.min.js` to an existing file. `dist/index.d.ts` is copied from the authored `types/index.d.ts`; `dist/navi.d.ts` carries the `window.Navi` global augmentation for the `./navi.min.js` subpath's `types` condition.
- Agent CLI (`bin/navi-agent.js`) executed the shipped [example flow](../flows/example-checkout.json) end to end against the local demo: 14/14 steps passed, including the closed-shadow gift control, the framed payment control, an opt-in `scrollTo` step, and the consequential submit gate.
- Live loopback server at `http://127.0.0.1:4173/`: expected HTML/JS/frame content types; protocol v0.2; 8 initial demo actions.

## 10,000-element benchmark

20 fresh-page runs, Apple M5 Pro / macOS arm64, Chromium 156.0.8078.4 headless, unthrottled. 10,000 elements in the main fixture including 1,000 controls, plus one open root, one captured closed root and a loaded same-origin iframe (3 additional controls). Observed interval covers injection, initial indexing, rich metadata for all 1,003 controls, and cleanup after removing the closed host; fixture construction and initial layout are settled before it. Long Tasks API support is required by the test, not silently treated as zero if absent.

| Metric | Final result | Gate |
|---|---:|---:|
| Maximum SDK work tick, all runs | **2.7ms** | ≤6ms and <16ms |
| Sampled tick p95 (1,333 samples) | **2.0ms** | reported |
| Observed tasks >50ms | **0** | 0 |
| Elapsed completion p50 | **1,502.5ms** | reported, not a latency SLA |
| Elapsed completion p95 | **1,717.1ms** | reported |
| Maximum elapsed completion | **1,763.3ms** | reported |
| Complete action count before removal | **1,003** | 1,003 |
| Roots after closed-host cleanup | **3** | 3 |

Tick instrumentation covers scheduled granular operations and maintains an all-tick maximum; raw samples are bounded to the most recent 512 ticks per run. Elapsed percentiles are linear-interpolation percentiles over the 20 recorded run totals in [verification.json](verification.json). The result is non-blocking measured work slices, **not** a 10× speedup. JavaScript cannot preempt layout, GC or application event handlers, so this is not a universal frame/INP guarantee; host callbacks triggered by execution are not constrained by Navi's indexing scheduler.

## Release gate and pipelines

- `scripts/verify-release.mjs` is the release gate and is exercised locally, not just authored: the worktree must be clean apart from `dist/`, `reports/`, `test-results/` and `playwright-report/`; the version tag must agree with `package.json` at HEAD; `dist/sri.txt`, `reports/build.json` and `reports/verification.json` must describe the exact bytes of `dist/navi.min.js`; a **rebuild must reproduce the shipped artifacts byte for byte**; the suite must report zero failures and at least 61 passing tests; both byte budgets, the CI gates and the publish allowlist must pass. Only then does `--tag` create the annotated `v<version>` tag.
- `.github/workflows/release.yml` runs the same gate on a `v*` tag push or on dispatch, checking out with `fetch-depth: 0` because the tag has to be visible, and can create and push the tag itself. A tag push re-runs verification with tag creation off, so the two triggers cannot loop. Publishing to a registry is deliberately not automated: the npm name, license and provenance are the owner's decisions.
- The gates are self-tested (`npm run test:gates`, **19 expectations**), including a missing MCP bundle, a missing loader bundle, a missing global type declaration and the byte/percentile boundaries. Missing input is a failure, never a skip. The artifact gate now requires all eight shipped artifacts, so a missing `dist/loader.min.js`, `dist/mcp.mjs` or `dist/navi.d.ts` fails CI instead of shipping green.
- This repository is initialized on `main`; the revision this report describes is committed, the release tag is local, and no remote exists, so nothing was pushed or published anywhere.
- CI composition, the local replay of every workflow step with exit codes, and the reasoning for excluding the external smoke suite from `ci.yml` are recorded in [SMOKE.md](SMOKE.md).

## Regression coverage

- Rich action schema, accessible-name approximation, native roles, fingerprints and bounded/truncated maps.
- Structural replacement, authored/clone ambiguities, hostile target strings without selector interpolation.
- **Actual React 19** controlled input state, keyed sorting, remounted elements and target stability.
- Nested captured closed roots, pre-hook root exclusion, original attachShadow semantics and stop restoration.
- Same-origin frame capture/navigation, sandbox exclusion and stale-index cleanup.
- Modal backdrop occlusion, partial frame overlay at the actual target point, hidden/disabled/inert/readonly/offscreen refusal.
- Native event sequence, textarea/select behavior, canceled keydown and payload limits.
- Repeated SPA unmount cleanup, mutation bursts/eligibility changes, mutations during active traversal and BUSY rejection.
- IntersectionObserver viewport priority and idle/IO-unavailable frame + microtask fallback.
- Stop/reinjection lifecycle, no SDK telemetry/field values or CSS/ARIA rewrites.
- Bridge-only transaction including closed root + iframe and domain outcome validation.
- Viewport-only maps, top-level iframe coordinates, trusted driver click/type including clearing input, certified dispatch failures, and no fallback for unknown/already-dispatched/occluded cases.
- Strict-CSP positive path (SDK boots from the page origin, discovers, types, clicks, trusted fallback fires) and negative path (a page policy blocking scripts refuses injection with a documented error rather than silently degrading).
- Adversarial prototype tampering: poisoned geometry/style primitives, frozen prototypes, nulled observers, replaced `attachShadow`, and a late-tampered frame document.
- MCP transport conformance: five tools with object schemas, viewport-default vs `all:true` maps, `--version`/`--help`, stderr-only diagnostics, JSON-RPC error objects for malformed input, a parse error that does not kill the server, notifications that never consume a response slot, and an exit code of 0 when stdin closes.
- **Settlement**: the DOM insert caused by an action, self-hiding targets, modal self-dismissal, an honest `settled: false` that still reports the dispatch, an invalid request refused before dispatch, and a context-destroying navigation treated as the receipt.
- **Transport bounds**: token required on both endpoints and never echoed, `503` past the session ceiling with the slot released, idle reaping that spares a session with a call in flight, refusal of a non-loopback or empty `--host` without a token, and invalid flag values exiting `2`.
- **Tenant loader**: the integrity/CORS handshake, the `0.0.0` stub observed before the real `0.2.0`, a queued call resolving with a real action map, a refused key rejecting queued calls, no double injection over an existing SDK, and the snippet's byte budget.

## Competitive comparison

The repeatable [comparison report](BENCHMARK.md) and [raw comparison metrics](benchmark-comparison.json) contain 20 iterations per method/fixture, using actual legacy `page.accessibility.snapshot()` from a pinned dev-only Playwright-core 1.48.2 alias against the same Chromium. Modern 1.64 removed that API; current MCP snapshot format is not claimed. The full 10,000-element Navi dictionary was slower than full AX in this comparison, despite a smaller payload. Viewport subset advantages are not equivalent full-information comparisons.

## Distribution packaging

| Artifact | Bytes | Notes |
|---|---:|---|
| `dist/navi.min.js` | 14,265 | Self-executing IIFE for `<script>`/CDN; gated <15,000 (5,560 gzip). |
| `dist/loader.min.js` | 480 | Tenant embed snippet; injects the bundle with `integrity` + `crossorigin="anonymous"`; gated <500. |
| `dist/index.mjs` | 41,207 | ESM entry: adapter, flow runner, install helpers. |
| `dist/index.cjs` | 42,504 | CJS entry; `import.meta.url` replaced via a build-time define plus a `__filename` banner. |
| `dist/index.d.ts` | 6,228 | Self-contained types; no Playwright types required by consumers. |
| `dist/navi.d.ts` | 1,602 | `window.Navi` global augmentation for the `./navi.min.js` subpath. |
| `dist/cli.mjs` | 50,051 | Node ESM with a shebang, invoked by `bin/navi-agent.js`. |
| `dist/mcp.mjs` | 67,073 | Node ESM with a shebang, invoked by `bin/navi-mcp.js`; serves both transports. |
| `dist/sri.txt` | Integrity | `sha384-Tba+et2p7MlxplPN6L2jxAC/v50mtJKWVF7Jdsivrk2d2YpePdlQopXUmxWTyhdC` for the exact `navi.min.js` bytes. |
| `server/index.js` | Host service | Tenant-keyed distribution of the bundle and loader plus beacon ingestion and per-tenant aggregates; `node:http` only, no build step. |
| `server/store.js` | Aggregates | `node:sqlite` where available, append-only JSONL otherwise, so Node 20 keeps working. |
| `server/tenants.js` | Keys | `NAVI_TENANTS` (`key:tenantId,…`); the built-in pair is a documented local development value, not a secret. |

The build fails on three contracts rather than warning about them: the two byte budgets, and a forbidden-construct scan that rejects `eval`, the `Function` constructor, `document.write`, `insertAdjacentHTML`, `<style>` creation and `style` attribute writes. The construct scan exists because the CSP promise is load-bearing for enterprise embedding, and a silent regression there would only surface on a customer's page.

`package.json` declares `exports` (`.` → ESM/CJS/types, `./navi.min.js`), `bin`, `files`, `main`/`module`/`types`, an optional `playwright` peer dependency and `sideEffects: ["./dist/navi.min.js"]` so bundlers do not tree-shake the browser bundle. `private` was removed so the kit can be published, but **nothing was published** to any registry.

## Limitations and failed attempts

- **The SSE transport is gated, not identified.** One shared bearer token, a session ceiling and idle reaping ship and are tested, and a non-loopback or empty `--host` without a token is refused. What it still has no concept of is a *caller*: no per-user identity, no rate limiting beyond the stream ceiling, and no TLS. MCP's SSE binding keeps session ids anonymous by design, so exposure to a network you do not control still means an authenticating proxy in front of the port.
- **`navi_set_session` validates shape, not safety.** Whatever cookies and storage state the caller supplies are installed, with no credential check, consent step or provenance, so an operator must decide which callers may hydrate which origins.
- **Settlement is a signal, not a proof.** `mutation_settle` cannot see inside a closed shadow root, `target_hidden` believes Navi's own state, and `navigation` can be satisfied by a same-page redirect. No network write, payment or server-side transaction is proven complete.
- **The host service is a reference implementation, not a hardened edge.** No user authentication, rate limiting, quotas, deduplication, retention policy or TLS; tenant keys live in the environment and are the only authorization. Aggregate telemetry is attacker-controlled input whose shape is constrained, not its truthfulness. `store.mode` is `sqlite` on this workstation; the append-only fallback is exercised by re-running the same suite on Node 20.20.2, so both paths are covered by the same assertions rather than by inspection.
- **The SDK still ships no telemetry.** The ingestion endpoint accepts a beacon that the hosting page or tenant snippet sends; `dist/navi.min.js` gained no network calls and stayed at 14,265 bytes, which the existing no-network test and the budget gate both hold. gzip size is not stable across Node versions for identical input (5,560 bytes on Node 24, 5,580 on Node 20), which is why the budget is enforced on raw bytes.
- **No hosted CI run.** The workflows parse and every command in them was replayed locally with its exit code captured, but checkout, Node setup, cache restore, Ubuntu browser dependencies, artifact upload and hosted-runner timings are unverified.
- Automated tests use Chromium/Playwright only. The Puppeteer adapter is documented but not separately run; Safari, Firefox, a full Vue application and customer frameworks are not verified.
- Synthetic events are untrusted; user-activation APIs, CAPTCHAs, real pointer sequences and arbitrary controlled/custom widgets are not promised. Two animation frames do not establish network or business completion.
- Earlier closed roots, declarative closed roots and cross-origin/opaque frames remain inaccessible. Stable sortable business identity requires authored keys. Hashes are non-cryptographic and ambiguity fails closed.
- **MCP tool calls are not gated by `--allow-consequential`.** An agent holding the server can dispatch a marked transaction directly; this is a deliberate scope limit, not a security boundary.
- The MCP server is verified against the vendored official SDK client on this workstation. No third-party MCP host (a desktop client, an IDE, a remote HTTP transport) has driven it; streamable HTTP is not implemented.
- No official WebMCP registration, zero-token guarantee, 100% universal determinism, vision-model/current-MCP benchmark, backend implementation or public deployment.
- Nothing was published to npm and no license file was added: the registry name, license and repository metadata remain the owner's decision.
- The CLI was exercised against the local demo and its Chromium only; it was not run against an external production site, behind authentication, or with a real third-party agent planner. `scrollTo` addresses top-document targets only.
- One earlier full-suite run timed out in the benchmark, which a diagnostic run traced to unnecessary label lookup and duplicate background classification; those were repaired and every run since has passed. An orphaned owned test server caused one port-in-use run, which was stopped. No test was skipped and no threshold was weakened.
- Shared desktop Preview screenshot failed because the webview produced no composited frames; the DOM was verified instead and standalone Chromium captured the pages. This does not prove the shared panel visibly composited correctly.

## Artifacts

- [Raw measured results and checks](verification.json) · [build record](build.json) · [workflow replay timings](ci-timing.json)
- [Desktop screenshot](demo-desktop.png) · [mobile screenshot](demo-mobile.png)
- [Final client source](../src/navi.js) · [built artifact](../dist/navi.min.js) · [tenant loader](../src/loader.js) · [built loader](../dist/loader.min.js)
- [Protocol acceptance](../docs/ACCEPTANCE.md) · [adapter/migration guide](../docs/AGENT-INTEGRATION.md) · [backend plan](../docs/BACKEND.md)
- [Browser tests](../tests/navi.spec.mjs) · [distribution + CLI tests](../tests/distribution.spec.mjs) · [CSP compliance](../tests/csp-compliance.spec.mjs) · [hardening](../tests/hardening.spec.mjs) · [MCP end-to-end](../tests/mcp-server.spec.mjs)
- [MCP over SSE](../tests/mcp-sse.spec.mjs) · [auth/concurrency suite](../tests/mcp-auth-concurrency.spec.mjs) · [session hydration](../tests/session-hydration.spec.mjs) · [host service ingestion](../tests/backend-ingest.spec.mjs) · [settlement](../tests/settlement.spec.mjs) · [tenant loader](../tests/loader.spec.mjs)
- [SSE transport](../src/mcp/sse.js) · [settlement engine](../src/settle.js) · [host service](../server/index.js) · [aggregate store](../server/store.js) · [tenant keys](../server/tenants.js)
- [Adapter](../src/adapter.js) · [flow runner](../src/flow.js) · [CLI](../src/cli.js) · [published types](../types/index.d.ts) · [example flow](../flows/example-checkout.json)
- [Release gate](../scripts/verify-release.mjs) · [CI pipeline](../.github/workflows/ci.yml) · [release workflow](../.github/workflows/release.yml) · [smoke workflow](../.github/workflows/smoke.yml)
