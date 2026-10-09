# Navi · CI gating and external verification

Recorded 2026-10-09. Apple M5 Pro (15 logical CPUs), darwin 27.0.0 arm64, Node v24.21.0, Chromium 156.0.8078.4 headless. Client artifact under test: **14,265 bytes** raw (budget 15,000), SRI `sha384-Tba+et2p7MlxplPN6L2jxAC/v50mtJKWVF7Jdsivrk2d2YpePdlQopXUmxWTyhdC`.

## What was and was not executed

The workflows are authored in this repository and every command they run was replayed locally in the same order with its exit code captured. **No GitHub-hosted run has occurred**: the repository is on `main` with **no remote configured**, so nothing could be pushed or triggered there.

Executed locally: `npm run test:gates`, `npm run build`, `node scripts/ci-gates.mjs --budget|--traversal|--benchmark`, `npm run typecheck`, `npm test`, `npm run benchmark`, `npm run test:smoke`, plus the transport, session and host-service suites on their own. The quality steps, the full suite, the ingestion suite and the smoke suite were additionally re-run on **Node 20.20.2** (see [Runtime support](#runtime-support)).

Not executed anywhere: `actions/checkout`, `actions/setup-node` (`20.x` resolution), `actions/cache` restore/save, `npx playwright install --with-deps chromium` on Ubuntu (the browser was already installed locally), artifact upload, runner scheduling and the `ubuntu-latest` image. Hosted timings in particular are **unknown** and will differ from the local figures below.

## Pipeline composition

| Workflow | Trigger | Jobs |
|---|---|---|
| [ci.yml](../.github/workflows/ci.yml) | every `pull_request`, every push to `main`, manual dispatch | `quality` (Gate 1 bundle budget, Gate 2 traversal long tasks), then `benchmark` (Gate 3) |
| [smoke.yml](../.github/workflows/smoke.yml) | nightly 06:17 UTC, manual dispatch | `external` (`tests/external-smoke.spec.mjs` against a live public SPA) |
| [release.yml](../.github/workflows/release.yml) | push of a `v*` tag, manual dispatch | `verify` runs `scripts/verify-release.mjs` on the exact revision, and with `create_tag` also creates and pushes the annotated `v<version>` tag. Nothing is published to a registry. |

All three workflows run on Node.js 20.x, install dependencies with `npm ci` from the committed lockfile, and cache `~/.cache/ms-playwright` keyed on `hashFiles('package-lock.json')`, so the Chromium build is pinned by the locked Playwright version and a lockfile change invalidates the cache. The `quality` job prints the locked `@playwright/test` version and Chromium executable path, and fails if the executable is missing. The release job checks out with `fetch-depth: 0` because the version tag has to be visible for the tag/`package.json` agreement check, and a tag push re-runs it with `create_tag` false so the two triggers cannot loop.

The external smoke suite is deliberately absent from `ci.yml`: it depends on a third-party origin, so it cannot gate pull requests without making them fail for reasons outside this repository. `npm test` stays hermetic and now runs exactly **61** tests.

## Measured local replay of the pipeline

| Stage | Step | Exit | Seconds |
|---|---|---:|---:|
| quality | Gate self-test (`npm run test:gates`, 19 expectations) | 0 | 0.2 |
| quality | Build release artifacts | 0 | 0.2 |
| quality | Gate 1 · bundle + loader budgets and artifacts | 0 | 0.0 |
| quality | Typecheck (strict) | 0 | 0.9 |
| quality | Chromium regression + distribution + security + transport + settlement suite (**61 passed**) | 0 | 53.3 |
| quality | Gate 2 · traversal long tasks | 0 | 0.0 |
| benchmark | Competitive benchmark (20 iterations × 3 fixtures × 4 methods) | 0 | 81.6 |
| benchmark | Gate 3 · traversal long tasks + viewport p95 | 0 | 0.1 |
| smoke | External smoke suite (**1 passed**) | 0 | 2.0 |

Job totals: **quality 54.6s**, **benchmark 81.7s**, **smoke 2.0s**. Raw record: [ci-timing.json](ci-timing.json). Browser-heavy steps dominate; the gates themselves are effectively free because they read reports rather than re-measuring.

The hermetic suite grew from 46 to 61 tests over this revision: 18 protocol + 10 distribution/CLI + 3 CSP compliance + 2 prototype hardening + 3 MCP over stdio + 1 MCP over SSE + 1 authenticated-session hydration + 8 host-service ingestion, then 5 transport auth/concurrency, 7 settlement and 3 loader. The 15 new tests cost a few seconds inside the same job rather than a second job, because they reuse the transport, host-service and demo fixtures that job already stands up. Benchmark runs vary enough between runs — 81.6s here, 78.7s, 77.1s, 86.2s and 98.5s observed for near-identical code — that its seconds must be read loosely.

## Gate results on real data

| Gate | Limit | Measured | Verdict |
|---|---|---|---|
| `bundle-budget` | strictly < 15,000 bytes | **14,265 bytes** raw (`dist/navi.min.js`) | pass |
| `loader-budget` | strictly < 500 bytes | **480 bytes** raw (`dist/loader.min.js`) | pass |
| `bundle-artifacts` | all release artifacts built | **8/8** present (`navi.min.js`, `loader.min.js`, `index.mjs`, `index.cjs`, `index.d.ts`, `navi.d.ts`, `cli.mjs`, `mcp.mjs`) | pass |
| `traversal-long-tasks` | 0 tasks over 50ms | **0** — 10,000-element traversal, 20 runs, injection → indexing → metadata → cleanup | pass |
| `benchmark-long-tasks` | 0 tasks over 50ms | **0** across all 3 probed fixtures | pass |
| `viewport-classification-p95` | ≤ 25ms p95 | **5.23ms** — 2,000-element fixture, `navi-viewport` | pass |

The artifact gate requires the loader, CLI and MCP server bundles and both type declarations as well as the library and browser artifacts. It previously listed four while the build emitted eight, so a broken `dist/cli.mjs`, `dist/mcp.mjs`, `dist/loader.min.js` or `dist/navi.d.ts` could have shipped with the gate green — each of those four is required now, and the self-test covers the MCP, loader and type-declaration cases explicitly. The loader has its own byte gate because the embed snippet is the artifact with the smallest budget and the most consumers.

Per-fixture traversal probe, measured inside the page while Navi re-scans the settled fixture and builds the full action map:

| Fixture | Traversal ms | Controls mapped | Long tasks >50ms | Idle-window long tasks |
|---|---:|---:|---:|---:|
| Local demo | 51.40 | 8 | 0 | 0 |
| 2,000 elements | 65.50 | 202 | 0 | 0 |
| 10,000 elements | 2060.50 | 1002 | 0 | 0 |

The 10,000-element figure is the substantive result: **2.06 seconds of scanning, indexing and rich metadata across 1,002 controls with no single main-thread task over 50ms**, and none in the idle window afterwards either. The elapsed figure itself moves a lot between runs on the same code — 1.54s, 1.76s and 2.06s were all observed for this revision — while the long-task count stayed at zero, which is precisely why the gate is written against tasks and not against wall-clock. That is the time-slicing claim holding under the gate rather than under an assertion the benchmark author chose.

Attribution is deliberate, and the three choices that make it honest are: the observer starts *after* fixture construction, so scaffolding is not charged to the SDK; only small metrics cross the process boundary, so Playwright's own serialization of a 244 KB action map cannot be mistaken for traversal cost; and the idle window after traversal is recorded separately rather than folded into the gate.

## The gates are themselves tested

An untested failure path is an untrustworthy gate, so `npm run test:gates` drives the real evaluators with synthetic reports (19 expectations, 0.1s, no browser). It asserts a healthy report passes and that each defect is *caught*: 15,000 bytes exactly (boundary), a missing bundle artifact, a **missing MCP server bundle**, an absent build report, a traversal long task, an absent verification report, a benchmark long task, an **unprobed fixture**, an unsupported Long Tasks API, a 27.1ms p95, a missing viewport fixture, and the 25ms/50ms boundaries.

Missing input is always a failure, never a skip. This caught a real defect during development: the first benchmark run left the `Local demo` fixture without a traversal probe, and Gate 3 failed with `no traversal probe recorded for Local demo` instead of passing quietly. The fix was to instrument that fixture, not to exempt it.

Failure output is CI-shaped. Running the gates against a synthetic oversize bundle with `GITHUB_ACTIONS=true`:

```
 FAIL  bundle-budget: 16000 bytes raw [limit: strictly < 15000 bytes]
::error title=Navi gate bundle-budget::16000 bytes raw (limit: strictly < 15000 bytes). dist/navi.min.js is the CDN/direct-embed artifact.
 FAIL  traversal-long-tasks: 3 long task(s) over 50ms [limit: 0 long tasks over 50ms]
::error title=Navi gate traversal-long-tasks::3 long task(s) over 50ms (limit: 0 long tasks over 50ms). Largest traversal: injection, indexing, metadata and cleanup.
...
One or more gates failed.
```

Exit code 1, and every failing gate is annotated on the workflow run. A missing report is reported as a failed input with the path that was not found.

## What the added suites prove inside that run

All of these are part of the 61 hermetic tests, so they gate pull requests rather than living in a separate job.

- **CSP compliance (3).** The shipped bundle is served behind `default-src 'self'; script-src 'self' 'nonce-naviCspNonce'; style-src 'self'; object-src 'none'; base-uri 'none'` — no `unsafe-inline`, no `unsafe-eval` — and the header is asserted present before anything else. The bundle boots from the page origin, discovers four controls, types into two fields and clicks submit to a verified outcome, drives a `data-navi-trusted` control through the native fallback, and produces **zero `securitypolicyviolation` events and zero CSP refusals**. A negative test proves the policy is real: `<script>` injection is refused and observable as a `script-src` violation, while the driver-evaluation strategy still installs the SDK. A third test re-derives the SHA-384 of the served bytes and fails if `dist/sri.txt` or `reports/build.json` disagrees.
- **Prototype hardening (2).** A host script replaces `getBoundingClientRect`, `getComputedStyle`, `attachShadow`, both observers and all three schedulers after load, and nulls and freezes prototypes. Geometry, occlusion, execution and post-tamper indexing keep working through the primitives pinned at initialization, with **zero uncaught page errors and zero calls reaching the poisoned `getBoundingClientRect`**; the second test covers a late, frozen frame document.
- **MCP over stdio (3).** The official `@modelcontextprotocol/sdk` client connects over stdio, lists the five tools, drives a multi-step demo checkout to a successful submit, and receives structured refusals for a disabled control (`UNAVAILABLE`, no `may_have_applied`), an unknown target (`NOT_FOUND` naming the recovery tool), credential-bearing URLs (`INVALID_URL`, credentials redacted rather than echoed) and an unknown tool. A `--no-fallback` session refuses a trusted control with `FALLBACK_DISABLED` while synthetic dispatch still works. Raw JSON-RPC frames cover pre-initialize rejection, parse errors that do not kill the server, version negotiation, unanswered notifications, unknown methods and a clean exit when stdin closes.
- **MCP over SSE (1).** The same SDK's `SSEClientTransport` connects to `navi-mcp --transport sse` on a free port, waits for the stream to become ready, receives the `endpoint` frame, exposes the same five-tool surface, refuses `navi_get_actions` with `NO_PAGE` before navigation, drives a flow in which a dynamic re-render is observed through the remote transport, and stops on `SIGTERM`. Independently, two concurrent streams were confirmed to hold **separate browser sessions** — one on the demo origin with 8 controls, one on the session fixture — with `/healthz` reporting two open sessions.
- **SSE transport hardening (5).** The remote transport's bounds are asserted against the transport itself, with a stub session in place of the browser so that *the session being closed* is observable rather than only the stream ending. A missing, wrong or unschemed credential is `401` on both `/sse` and `/message`, decided before the session is looked up and with the credential absent from the body; the session ceiling answers an excess stream with `503` and starts no session, and the slot is genuinely released when a stream closes; an idle session's stream ends by itself with its session closed while a call in flight is left alive past the window; a non-loopback bind without a token and each invalid flag value exit `2`; and the official SDK client still drives a full authenticated flow while an anonymous caller is refused. The token never reaches the child's stderr.
- **Transport auth and resource bounds (5).** The SSE transport is asserted against the transport itself rather than through a proxy: a bearer token is required on `/sse` and `/message` with the credential never echoed back, a stream past the session ceiling gets `503` with no session started and the slot genuinely released when a stream closes, an idle session is reaped and its browser closed while a session with a call in flight survives the window, a non-loopback bind without a token exits `2` (an **empty** `--host` included, since Node reads that as every interface), bad `--max-sessions`/`--idle-timeout` values exit `2`, and the official MCP client drives a complete authenticated flow once it presents the token.
- **Deterministic settlement (7).** Settlement is verified where it is hardest to fake: `mutation_settle` holds on the DOM insert the action itself causes, `target_hidden` resolves both when a control hides itself and when a modal dismisses its own trigger, and both are checked through the adapter and through `navi_execute_action`'s envelope. The honest failures are covered too — an action that hides nothing reports `settled: false` while still reporting `executed: true` and its dispatch, an invalid settle request is refused with `INVALID_SETTLE` **before** anything is dispatched, and a reload that destroys the execution context mid-dispatch is treated as the navigation receipt rather than a transport error.
- **Tenant loader (3).** A fixture page is served from its own loopback origin while the loader and bundle come from the host service, so the browser performs a genuine cross-origin, CORS-mode, integrity-verified fetch (a non-loopback page origin to a loopback host is blocked by Chromium's Private Network Access policy, which is why the fixture is where it is). The test asserts the injected tag carries the published `integrity` and `crossorigin="anonymous"`, that the page observed the `version '0.0.0'` stub before the real `0.2.0`, that a call written above the SDK resolved with a real action map, that a refused key rejects every queued call instead of hanging, that an already-installed SDK is not double-injected, and that the snippet itself stays under 500 bytes.
- **Session hydration (1).** On a fixture whose gated controls are rendered from session state rather than a URL, anonymous discovery offers only `sign-in`; inline cookies plus per-origin localStorage then unlock `account-balance` and `sign-out` **before the document starts**, a `storageState.json` file produces the same result, a gated control is really drivable, no session value is echoed back, and seven malformed payloads are refused with `INVALID_SESSION` without disturbing the live session.
- **Host service ingestion (8).** Driven entirely over HTTP: keyed distribution with the exact `Cache-Control`, a quoted SHA-384 `ETag`, `application/javascript` content type and byte-for-byte equality with `dist/navi.min.js`; `304` on `If-None-Match`; `401` for a missing and an unknown key; a beacon-shaped `text/plain` post reflected in the tenant aggregate; deterministic ordering; eleven rejection cases including non-canonical origins, unknown keys, non-integer and negative counters, oversize bodies and unknown tenants; raw DOM/HTML text rejected with nothing stored; `no-store` on tenant data; health and unknown routes.

The build reinforces the first of those: a forbidden-construct scan (`eval`, `Function`, `cssText`, `insertAdjacentHTML`, `document.write`, `<style>` creation, `style` attributes) fails `npm run build` outright, so the CSP promise cannot rot silently between test runs. The newer surfaces keep the same property in the other direction: the host service and the MCP transports were verified to ship **no new runtime dependencies**, and `dist/navi.min.js` gained nothing — it is still 14,265 bytes with its no-network behaviour asserted by the existing telemetry test.

## External smoke run log

Target `https://demo.playwright.dev/todomvc/#/` — HTTP 200, title `React • TodoMVC`, a real React single-page app with no relation to this project. Non-destructive: the app keeps state in `localStorage['react-todos']` and writes nothing to a server, and the test deletes the todo it creates, then clears only its own additions.

| Step | Detail | ms |
|---|---|---:|
| navigate | HTTP 200 `https://demo.playwright.dev/todomvc/#/` | 459 |
| initialize | injected `navi.min.js`, protocol v0.2.0 | 17 |
| connect | same-origin protocol 0.2.0 | 0 |
| traverse | `refresh()` + viewport map, 4 controls | 7.6 |
| discover | 4 controls: link, textbox, link, link | 0 |
| populate | typed into `What needs to be done?` via `Navi.execute`, mode `synthetic`, control left focused | 0 |
| dynamic-update | 1 list row rendered, **7 new controls indexed** (checkbox, checkbox, button, textbox, link, link, link) | 0 |
| cleanup | created todo removed via the UI `destroy` control; target left unchanged | 0 |

Assertions the run makes, beyond the DOM:

- the shipped browser bundle path ends in `navi.min.js`, so the adapter is driving built output rather than source, and that bundle is the 14,265-byte artifact the budget gate measures;
- the adapter reports protocol `0.2.0` on a third-party origin and its action map is not truncated;
- the value lands in a **React-controlled** input through the protocol, and the control is left focused so a subsequent real keypress reaches it;
- pressing Enter re-renders the list, and Navi then indexes 7 controls that did not exist during the initial discovery — dynamic updates are detected, not assumed;
- the newly indexed set includes the two filter checkboxes, the destroy button and a textbox, i.e. controls the app creates only after the first todo exists.

Result: **0 uncaught page errors, 0 console errors, 0 Long Tasks over 50ms**, `ok: true`. Raw record: [smoke-external.json](smoke-external.json).

## Runtime support

`package.json` declares `engines.node: ">=20"`, previously `>=22`. That change is measured, not optimistic, and it was re-measured on the current 61-test tree: on **Node 20.20.2** the strict typecheck passes, the build produces a **byte-identical 14,265-byte artifact** with the same SRI, the gate self-test holds 19/19, the full **61-test suite** passes including the 10,000-element long-task specification (`longTasksOver50ms: 0`) and the settlement suite, the external smoke suite passes against the live SPA, and the ingestion suite passes with `store.mode` falling back to `log` because `node:sqlite` raises `ERR_UNKNOWN_BUILTIN_MODULE` there. A scan of `src/`, `server/`, `scripts/`, `tests/` and `bin/` found no Node 22-only API (no `Promise.withResolvers`, `Object.groupBy`, `Array.fromAsync`, `toSorted`/`toReversed` or `import.meta.resolve`), which is consistent with the observed result. The CI pipeline's stated Node 20.x runtime is therefore true of the code, rather than an assumption carried in a YAML file.

One incidental finding stands, and the new bundle confirms it: gzip size is not stable across Node versions (5,560 bytes on Node 24, 5,580 on Node 20 for identical input), which is a further reason the bundle budget is enforced on raw bytes.

## Reproduce

```sh
npm ci --no-audit --no-fund
npx playwright install --with-deps chromium
npm run build
npm run test:gates          # gates test themselves
node scripts/ci-gates.mjs --budget
npm run typecheck
npm test                    # 61 hermetic tests, also regenerates reports/verification.json
node scripts/ci-gates.mjs --traversal
npm run dev -- --host 127.0.0.1 --port 4173 &   # benchmark and fixture origin
npm run benchmark
node scripts/ci-gates.mjs --benchmark
npm run test:smoke          # live public SPA, needs network
npm run mcp:sse             # remote MCP transport on 127.0.0.1:3001
npm run serve               # tenant script host + telemetry on 127.0.0.1:8790
```

`npm run gates` runs all three gates against whatever reports are on disk.

## Limitations

- **No hosted CI run.** The YAML parses (validated with a YAML parser) and every command in it was executed locally, but checkout, Node setup, caching, Ubuntu browser dependencies, artifact upload and runner performance are unverified. Treat the pipeline as authored-and-locally-validated, not as proven on GitHub.
- **Timings are one workstation.** 54.6s / 81.7s / 2.0s excludes any hosted runner overhead, and the benchmark varies enough between runs that these seconds are indicative only.
- **The smoke job can fail for external reasons.** A target outage, DNS failure or layout change fails the job rather than skipping it, by design. There is one retry, which separates a blip from a regression but does not make a third-party origin reliable; a retried pass is reported as flaky rather than clean.
- **The long-task gates measure main-thread blocking, not latency.** A traversal can be free of tasks over 50ms and still take 1.8 seconds end to end, which is exactly why elapsed time is reported alongside.
- **Gate thresholds are fixed to the published contract** (15,000 bytes, 50ms, 25ms). The environment variables that override them exist for deliberate re-runs, not for CI to relax the numbers.
- **The remote transport is gated, not identified.** A shared bearer token, a session ceiling and idle session reaping all ship and are tested, and a non-loopback bind without a token is refused. What it still has no concept of is a *caller*: one credential for everyone, no per-user identity, no rate limiting beyond the stream ceiling, and no TLS. MCP's SSE binding also keeps session ids anonymous, so exposing the port to a network you do not control still means an authenticating proxy in front of it.
- **The host service is a reference implementation.** Tenant keys are the only authorization, and there is no rate limiting, quota, deduplication, retention policy or TLS; the SQLite path is exercised as `sqlite` on Node 24 and the fallback as `log` on Node 20, but neither was load-tested, and telemetry is attacker-controlled input whose shape is constrained rather than its truthfulness.
- **Session hydration validates shape, not safety.** Whatever cookies or storage state the caller supplies are installed, with no credential check, consent step or provenance, so an operator must decide which callers may hydrate which origins.
- The benchmark's own comparison numbers carry the variance caveat documented in [BENCHMARK.md](BENCHMARK.md); only the within-run figures should be compared.
