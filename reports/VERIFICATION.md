# Navi Protocol v0.2 · package v0.3.0 final verification

Recorded 2026-10-09. Supersedes the earlier v0.1 synchronous classification report. The protocol stays 0.2.0; package 0.3.0 adds the distribution kit, agent CLI, the MCP server and the enterprise CSP/prototype hardening.

## Final passing checks

- `npm run typecheck`: strict JavaScript, tooling, tests and public API types passed.
- `npm test`: final built artifacts, **46 Chromium tests passed** (18 protocol + 10 distribution/CLI + 3 CSP compliance + 2 prototype hardening + 3 MCP over stdio + 1 MCP over SSE + 1 session hydration + 8 host service), zero failures.
- Client artifact: **14,246 raw UTF-8 bytes** (<15,000 strict budget), **5,553 bytes gzip**. No runtime dependencies/source map.
- The shipped bundle is provably CSP-clean (no `eval`/`Function`/inline style injection) and runs inside a document served with `default-src 'self'; script-src 'self' 'nonce-…'; style-src 'self'`, completing a two-field flow with zero `securitypolicyviolation` events and zero refused CSP requests.
- Prototype isolation is verified adversarially: after Navi loads, a host script replaces `Element.prototype.getBoundingClientRect`/`getComputedStyle`, freezes and nulls observers and schedulers, and replaces `attachShadow`; discovery, occlusion state, execution and late mutation indexing keep working through the pinned originals.
- `dist/sri.txt` carries the SHA-384 of the shipped bundle, and the CSP suite re-derives it from the served bytes so the published hash cannot drift from the artifact (the same hash is recorded in `reports/build.json` and `reports/verification.json`).
- The remote transport was verified the same way: the official SDK's `SSEClientTransport` connects to `navi-mcp --transport sse`, receives the `endpoint` frame, runs a multi-step flow including a dynamic re-render, and the process stops on `SIGTERM`. The transport is `node:http`-only, with one browser session per connection.
- `navi_set_session` was verified against a fixture whose gated controls are produced from session state rather than a URL parameter: anonymous discovery offers only `sign-in`, inline cookies plus per-origin localStorage unlock `account-balance` and `sign-out` before the document starts, a `storageState.json` file produces the same result, no session value is echoed back, and seven malformed payloads are refused without disturbing the live session.
- The host service was driven entirely over HTTP: keyed distribution with the exact cache headers, a quoted SHA-384 `ETag`, byte-for-byte equality with `dist/navi.min.js`, `304` on `If-None-Match`, `401` for missing and unknown keys, a beacon-shaped `text/plain` post reflected in the tenant aggregate, deterministic ordering, eleven rejection cases, raw-DOM rejection proving nothing was stored, and `no-store` on tenant data.
- The MCP server was driven end to end by the **official `@modelcontextprotocol/sdk` client** over stdio JSON-RPC: `tools/list`, `navi_navigate`, `navi_get_actions` (viewport subset and `all:true`), `navi_execute_action` including a trusted-input fallback, `navi_assert_state`, and a structured `NO_PAGE` refusal carrying actionable guidance. A `data-navi-trusted="true"` control is driven automatically by real hardware input in a default session (`mode: native-driver`), and the same call in a strict session (`--no-fallback`) is refused with `FALLBACK_DISABLED` while synthetic dispatch keeps working — so both halves of the fallback contract are exercised through the tool rather than described. The server itself ships with zero runtime dependencies.
- `dist/index.mjs` and `dist/index.cjs` both load and expose `NaviPlaywrightAdapter`; both resolve the shipped `navi.min.js` to an existing file. `dist/index.d.ts` is copied from the authored `types/index.d.ts` and exports the client-side SDK surface (`NaviAPI`, `NaviAction`, `NaviActionMap`) alongside the adapter and flow schema. The `./navi.min.js` subpath carries a `types` condition, so `import 'navi-interaction-bridge/navi.min.js'` resolves the `window.Navi` global augmentation instead of being untyped.
- Agent CLI (`bin/navi-agent.js`) executed the shipped [example flow](../flows/example-checkout.json) end to end against the local demo: 14/14 steps passed, including the closed-shadow gift control, the framed payment control, an opt-in `scrollTo` step, and the consequential submit gate.
- Live loopback server at `http://127.0.0.1:4173/` (owned Node PID 77421): expected HTML/JS/frame content types; protocol v0.2; 8 initial demo actions.
- Full checkout performed exclusively with `window.Navi.execute()` via `page.evaluate()`, including a captured **closed** root and same-origin frame. Business outcome verified, zero uncaught page errors.
- Live desktop/mobile screenshots refreshed; 390px mobile viewport had no horizontal overflow.

## 10,000-element benchmark

20 fresh-page runs, Apple M5 Pro / macOS arm64, Chromium 156.0.8078.4 headless, unthrottled. 10,000 elements in the main fixture including main, 1,000 controls, plus one open root, one captured closed root and a loaded same-origin iframe (3 additional controls).

Observed interval covers injection, initial indexing, rich metadata for all 1,003 controls, and cleanup after removing the closed host. Fixture construction and initial layout are settled before that interval. Long Tasks API support is required by the test; it is not silently treated as zero if absent.

| Metric | Final result | Gate |
|---|---:|---:|
| Maximum SDK work tick, all runs | **2.7ms** | ≤6ms and <16ms |
| Sampled tick p95 | **2.0ms** | reported |
| Observed tasks >50ms | **0** | 0 |
| Elapsed completion p50 | **1,932.4ms** | reported, not a latency SLA |
| Elapsed completion p95 | **2,230.5ms** | reported |
| Maximum elapsed completion | **2,262.7ms** | reported |
| Complete action count before removal | **1,003** | 1,003 |
| Roots after closed-host cleanup | **3** | 3 |

Tick instrumentation covers scheduled granular operations and maintains an all-tick maximum; raw samples are bounded to the most recent 512 ticks per run. The result is non-blocking measured work slices, **not** a 10× speedup. The former ~49ms result timed a different synchronous operation; idle waits and rich state work are now included in elapsed timing. JavaScript cannot preempt layout, GC or application event handlers, so this is not a universal frame/INP guarantee. Host callbacks triggered by execution are not constrained by Navi's indexing scheduler.

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
- MCP transport conformance: four tools with object schemas, viewport-default vs `all:true` maps, `--version`/`--help`, stderr-only diagnostics, JSON-RPC error objects for malformed input, a parse error that does not kill the server, notifications that never consume a response slot, and an exit code of 0 when stdin closes.

## Competitive comparison

The repeatable [comparison report](BENCHMARK.md) and [raw comparison metrics](benchmark-comparison.json) contain 20 iterations per method/fixture, using actual legacy `page.accessibility.snapshot()` from a pinned dev-only Playwright-core 1.48.2 alias against the same Chromium. Modern 1.64 removed that API; current MCP snapshot format is not claimed. The full 10,000-element Navi dictionary was slower than full AX in this comparison, despite a smaller payload. Viewport subset advantages are not equivalent full-information comparisons.

## Distribution packaging

| Artifact | Bytes | Notes |
|---|---:|---|
| `dist/navi.min.js` | 14,246 | Self-executing IIFE for `<script>`/CDN; gated <15,000. |
| `dist/index.mjs` | ESM entry | Adapter, flow runner, install helpers. |
| `dist/index.cjs` | CJS entry | Same surface; `import.meta.url` replaced via a build-time define plus a `__filename` banner. |
| `dist/index.d.ts` | Types | Self-contained; no Playwright types required by consumers. |
| `dist/cli.mjs` | CLI bundle | Node ESM with a shebang, invoked by `bin/navi-agent.js`. |
| `dist/mcp.mjs` | MCP bundle | Node ESM with a shebang, invoked by `bin/navi-mcp.js`; shares `src/browser.js` with the CLI. |
| `dist/sri.txt` | Integrity | `sha384-…` for the exact `navi.min.js` bytes, for enterprise `<script integrity>`. |
| `server/index.js` | Host service | Tenant-keyed distribution of the bundle plus beacon ingestion and per-tenant aggregates; `node:http` only, no build step. |
| `server/store.js` | Aggregates | `node:sqlite` where available, append-only JSONL otherwise, so Node 20 keeps working. |
| `server/tenants.js` | Keys | `NAVI_TENANTS` (`key:tenantId,…`); the built-in pair is a documented local development value, not a secret. |

The build fails on two contracts rather than warning about them: the bundle budget, and a forbidden-construct scan that rejects `eval`, the `Function` constructor, `document.write`, `insertAdjacentHTML`, `<style>` creation and `style` attribute writes. The second guard exists because the CSP promise is load-bearing for enterprise embedding, and a silent regression there would only surface on a customer's page.

`package.json` declares `exports` (`.` → ESM/CJS/types, `./navi.min.js`), `bin`, `files`, `main`/`module`/`types`, an optional `playwright` peer dependency and `sideEffects: ["./dist/navi.min.js"]` so bundlers do not tree-shake the browser bundle. `private` was removed so the kit can be published, but **nothing was published** to any registry.

Two regressions were found and fixed by the existing suite during this packaging work: the adapter refactor briefly reported unknown in-page failures as success, and anticipated refusals (occlusion, unavailable fallback targets) now return a structured `{ok:false,error}` result instead of throwing, so only transport failures propagate. The flow schema also gained an explicit, non-implicit `scrollTo` step after a short-viewport run proved that below-the-fold controls correctly refuse to execute.

## Limitations and failed attempts

- The first full suite timed out in the benchmark. A diagnostic run exposed expensive unnecessary button-label lookup and duplicate background classification; these were repaired and the **final full suite rerun passed**. An orphaned owned test server also caused one port-in-use run; it was stopped and final verification succeeded. No tests were skipped or thresholds weakened.
- Shared desktop Preview screenshot failed because the webview produced no composited frames. Preview was registered/reopened, and its DOM evaluation confirmed title/version/action count. Standalone Chromium captured the actual local page. This does not prove the shared panel visibly composited correctly.
- Automated tests use Chromium/Playwright only. Puppeteer adapter is documented but not separately run; full Vue app, Safari, Firefox and customer frameworks are not verified. Native Vue-style input/change listeners are tested.
- Synthetic events are untrusted; user-activation APIs, CAPTCHAs, real pointer sequences, and arbitrary controlled/custom widgets are not promised. Two frames do not establish network or business completion.
- Earlier closed roots, declarative closed roots and cross-origin/opaque frames remain inaccessible. Stable sortable business identity requires authored keys. Hashes are non-cryptographic and ambiguity fails closed.
- No official WebMCP registration, zero-token guarantee, 100% universal determinism, vision-model/current-MCP benchmark, backend implementation or public deployment.
- Nothing was published to npm and no license file was added: the registry name, license and repository metadata remain the owner's decision.
- The CLI was exercised against the local demo and its Chromium only; it was not run against an external production site, behind authentication, or with a real third-party agent planner. `scrollTo` addresses top-document targets only.
- **MCP tool calls are not gated by `--allow-consequential`.** The CLI's consequential-step gate has no MCP equivalent in this version, so an agent holding the server can dispatch a marked transaction directly. This is a deliberate scope limit, documented in the README, not a security boundary.
- The MCP server is only verified against the vendored official SDK client on this workstation; no third-party MCP host (Claude Desktop, an IDE client, a remote HTTP transport) has driven it. The transport is stdio only; streamable HTTP is not implemented.
- CSP compliance is proven for the *shipped* bundle's own behavior. A page whose policy blocks inline script injection cannot be automated through `addScriptTag`; the evaluator strategy works because driver evaluation is not subject to the document policy, and the fixture that proves it is local.
- **The SSE transport has no authentication.** MCP's SSE binding uses anonymous session ids, so the transport is reachability-only: it was tested bound to `127.0.0.1`, and exposing it requires an authenticating proxy. Sessions are per connection but unbounded — no session cap, no idle timeout beyond the heartbeat, no TLS termination.
- **`navi_set_session` validates shape, not safety.** It stores whatever cookies and storage state the caller supplies. A hostile or mistaken caller can hydrate a session for an origin the operator did not intend; unlike a real login there is no credential check, no consent step, and no provenance on the values.
- **The host service is a reference implementation, not a hardened edge.** No user authentication, rate limiting, quotas, deduplication, retention policy or TLS; tenant keys live in the environment and are the only authorization. Aggregate telemetry is attacker-controlled input whose shape is constrained, not its truthfulness, so the numbers are dashboard-grade rather than billable. On this workstation `store.mode` is `sqlite`; the append-only fallback is exercised by re-running the same suite on Node 20.20.2, where `node:sqlite` is unavailable, so both paths are covered by the same assertions rather than by inspection.
- **The SDK still ships no telemetry.** The ingestion endpoint accepts a beacon that the hosting page or tenant snippet sends; `dist/navi.min.js` gained no network calls and stayed at 14,246 bytes, which the existing no-network test and the budget gate both hold.

## Artifacts

- [Raw measured results and checks](verification.json)
- [Desktop screenshot](demo-desktop.png) · [mobile screenshot](demo-mobile.png)
- [Final client source](../src/navi.js) · [built artifact](../dist/navi.min.js)
- [Protocol acceptance](../docs/ACCEPTANCE.md) · [adapter/migration guide](../docs/AGENT-INTEGRATION.md)
- [Browser tests](../tests/navi.spec.mjs) · [distribution + CLI tests](../tests/distribution.spec.mjs) · [CSP compliance](../tests/csp-compliance.spec.mjs) · [hardening](../tests/hardening.spec.mjs) · [MCP end-to-end](../tests/mcp-server.spec.mjs)
- [MCP over SSE](../tests/mcp-sse.spec.mjs) · [session hydration](../tests/session-hydration.spec.mjs) · [host service ingestion](../tests/backend-ingest.spec.mjs)
- [SSE transport](../src/mcp/sse.js) · [host service](../server/index.js) · [aggregate store](../server/store.js) · [tenant keys](../server/tenants.js)
- [Adapter](../src/adapter.js) · [flow runner](../src/flow.js) · [CLI](../src/cli.js) · [published types](../types/index.d.ts) · [example flow](../flows/example-checkout.json)
