# Competitive benchmark acceptance

## Deliverables

- `tests/benchmark-comparison.js`: standalone repeatable Node ESM CLI, default demo `http://127.0.0.1:4173`, exactly 20 timed iterations per fixture/method; stdout formatted table.
- `reports/BENCHMARK.md` + `reports/benchmark-comparison.json`: generated measured results, raw timings/payloads, browser/runtime/hardware, methodology and limitations. No invented gains.
- `scripts/navi-adapter.mjs`: tested reusable Playwright adapter; documented in `docs/AGENT-INTEGRATION.md` with explicit trusted-input fallback.
- Retain strict `<15,000` uncompressed client build gate and all protocol regression checks.

## Baselines

Installed Playwright 1.64 removed `page.accessibility.snapshot()`. Add a pinned **dev-only alias of Playwright 1.48.2**, which retains the real API; use its API for both snapshot and Navi calls against the same installed current Chromium executable. Do not downgrade the existing test runner or silently substitute CDP/ariaSnapshot data. Record versions. Report both `snapshot({interestingOnly:false})` (full tree) and legacy default `snapshot()` (filtered interesting nodes). Neither is literally the current Playwright MCP snapshot format; no claim otherwise.

Fixtures: actual local demo plus controlled 2,000/10,000 main-element fixtures (10% native controls), created after navigation on that same local origin. Deterministic static content, one nested open shadow target and one nested captured closed shadow target. No sample is truncated; assert complete counts. Warm indexing/layout first; run each method once as warmup, then alternate order across 20 iterations. Measure end-to-end Node awaited API latency using monotonic performance timer; serialization for footprint happens outside that timer. Separately measure cold Navi indexing + full map on fresh fixtures; do not hide idle/indexing costs in warm comparisons.

Each sample measures full returned JSON bytes using UTF-8, JSON characters and `ceil(characters/4)` estimated tokens. Calculate signed reduction `(AX tokens - Navi tokens)/AX tokens *100`; negative means Navi is larger. Report warm full maps and actual `actions({viewportOnly:true})` which computes rich state only for intersecting indexed controls; a viewport subset is not equivalent information to the full tree. Also compare the legacy filtered baseline. Report p50/p95 (nearest-rank) over 20, payload mean bytes/tokens and raw samples. Coordinates/state make full Navi maps potentially larger than AX. No real tokenizer or LLM/vision speed claim.

Nested shadow success is a distinct discover-and-execute trial: AX tree name/role discovery + native Playwright getByRole click versus Navi target discovery + execute, with resettable business counter verified. Test nested open and captured closed roots separately, 20 trials each. AX snapshot discovery is not itself a locator; report when discovery succeeds but Playwright cannot pierce a closed root. This is not an autonomous-planner success benchmark.

## Fallback safety

Extend `actions` with opt-in `viewportOnly` and `coordinateSpace:'top'` so the adapter receives CSS viewport coordinates usable by `page.mouse.click`; default remains own-document coordinates. Parent frame offsets/borders are applied for top coordinates; transformed frames remain conservatively unavailable. Adapter requests an untruncated fresh dictionary, validates a unique live target and current visible/enabled/viewport/unoccluded state before driver input.

Add `data-navi-trusted="true"` host declaration: execute returns `{success:false,reason:'untrusted_gesture_required',dispatched:false}` **before** synthetic dispatch. Adapter also recognizes an explicit `dispatch_failed` response/error only when `dispatched:false` is certified. A failure containing the specific untrusted reason implies host cooperation reporting no side effect; do not infer it from generic exceptions/timeouts or successful ignored events. No automatic retry of unknown/possibly dispatched operations, cancellations, unavailable/ambiguous targets or business-effect failures. Fallback supports click and text entry via real driver mouse/keyboard only; preserve external authorization and outcome checks. Test trusted-only event handler, iframe top-coordinate fallback, occlusion refusal and no double-dispatch for unknown errors. No universal detector of untrusted requirements is possible.
