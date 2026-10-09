# Navi v0.2 vs Playwright accessibility · measured comparison

Recorded 2026-10-09T20:40:42.091Z. 20 iterations per method/fixture, Chromium 156.0.8078.4, Apple M5 Pro, darwin 27.0.0 arm64, Node v24.21.0.

**API compatibility:** current Playwright 1.64.0 removed page.accessibility. The benchmark uses pinned playwright-core 1.48.2 via a dev-only alias and the current installed Chromium executable for both methods. It calls the actual legacy snapshot API; this is not a claim to reproduce current Playwright MCP's locator.ariaSnapshot format.

| Fixture | Method | Payload KB | Est. tokens | p50 ms | p95 ms | Nested open / closed success |
|---|---|---:|---:|---:|---:|---|
| Local demo | AX full snapshot | 30.30 | 7575 | 4.02 | 4.36 | open 100% / closed 0%* |
| Local demo | AX default filtered | 5.80 | 1450 | 3.04 | 3.28 | open 100% / closed 0%* |
| Local demo | Navi viewport map | 2.10 | 524 | 0.67 | 1.18 | open 100% / closed 100%* |
| Local demo | Navi full map | 2.10 | 524 | 0.62 | 0.84 | open 100% / closed 100%* |
| 2,000 elements | AX full snapshot | 657.62 | 164405 | 78.88 | 88.00 | open 100% / closed 0%* |
| 2,000 elements | AX default filtered | 172.36 | 43091 | 58.70 | 61.52 | open 100% / closed 0%* |
| 2,000 elements | Navi viewport map | 7.22 | 1805 | 2.53 | 5.23 | open 100% / closed 100%* |
| 2,000 elements | Navi full map | 48.87 | 12217 | 8.24 | 9.76 | open 100% / closed 100%* |
| 10,000 elements | AX full snapshot | 3296.02 | 824005 | 439.09 | 470.00 | open 100% / closed 0%* |
| 10,000 elements | AX default filtered | 865.96 | 216491 | 355.52 | 385.70 | open 100% / closed 0%* |
| 10,000 elements | Navi viewport map | 7.22 | 1805 | 213.46 | 518.66 | open 100% / closed 100%* |
| 10,000 elements | Navi full map | 243.96 | 60989 | 725.55 | 1340.98 | open 100% / closed 100%* |

*Separate nested-shadow fixture trials, not measured independently for every latency row.

## Token footprint results

- **Local demo / Navi viewport map**: token reduction vs full AX **93.08%**; vs filtered AX **63.86%**. Negative means Navi costs more.
- **Local demo / Navi full map**: token reduction vs full AX **93.08%**; vs filtered AX **63.86%**. Negative means Navi costs more.
- **2,000 elements / Navi viewport map**: token reduction vs full AX **98.90%**; vs filtered AX **95.81%**. Negative means Navi costs more.
- **2,000 elements / Navi full map**: token reduction vs full AX **92.57%**; vs filtered AX **71.65%**. Negative means Navi costs more.
- **10,000 elements / Navi viewport map**: token reduction vs full AX **99.78%**; vs filtered AX **99.17%**. Negative means Navi costs more.
- **10,000 elements / Navi full map**: token reduction vs full AX **92.60%**; vs filtered AX **71.83%**. Negative means Navi costs more.

## Cold completion (indexing + full dictionary)

- 2,000 elements: p50 **96.15ms**, p95 **98.03ms** (20 fresh fixtures, injection + indexing + full map; main fixture only, no added shadow controls).
- 10,000 elements: p50 **825.45ms**, p95 **998.52ms** (20 fresh fixtures, injection + indexing + full map; main fixture only, no added shadow controls).

## Traversal long-task probe

Long Tasks measured inside the page while Navi re-scans the settled fixture and builds the full action map (`refresh()` + `actions({limit:5000})`). The Long Tasks API reports only tasks above 50ms. Fixture construction is excluded as test scaffolding; tasks observed while the page is idle after the traversal are listed separately and are not part of any gate.

| Fixture | Traversal ms | Controls mapped | Long tasks >50ms | Idle-window long tasks |
|---|---:|---:|---:|---:|
| Local demo | 51.40 | 8 | 0 | 0 |
| 2,000 elements | 65.50 | 202 | 0 | 0 |
| 10,000 elements | 2060.50 | 1002 | 0 | 0 |

## Nested shadow discovery + execution

| Method | Root | Discovered | Verified action success |
|---|---|---:|---:|
| AX full snapshot | open | 20/20 | 20/20 (100%) |
| AX full snapshot | closed | 20/20 | 0/20 (0%) |
| Navi execute | open | 20/20 | 20/20 (100%) |
| Navi execute | closed | 20/20 | 20/20 (100%) |

## Methodology and trade-offs

- **Run-to-run variance is significant.** Wall-clock figures depend on host load and garbage collection; comparing two separate runs of this script has shifted p50 values by several hundred milliseconds on the largest fixture. Trust the within-run comparison (same process, alternating order) over cross-run differences, and re-run rather than comparing an old report to a new one. Small windows must be represented by less than 10 of the 20 iterations before being treated as meaningful; the small demo window is shown partly to make that limitation visible.
- Default CLI target is the live local demo. Controlled fixtures are installed on that same origin with exactly 2,000/10,000 elements in main (10% buttons), descriptive static spans, and two nested shadow controls. The local demo is separately measured; its rendered map text is cleared to avoid counting duplicate diagnostic JSON as page content.
- Warmups precede 20 timed iterations; method order alternates forward/reverse. Timers include awaited browser API transport and scheduler idle waits but exclude subsequent JSON serialization for footprint. Warm Navi indexing is complete before query timings; cold completion is reported separately. All full maps assert exact counts, and truncation is rejected.
- Full AX uses snapshot({interestingOnly:false}); filtered AX uses snapshot() default. Viewport-only Navi is a subset, not equivalent full-page information: it scans indexed references but computes rich state only for intersecting controls. Full Navi includes disabled/offscreen controls, state and coordinates; AX includes document semantics/text and can contain input values. Fixtures contain no personal data.
- Payload size is UTF-8 serialized JSON bytes (table KB uses 1,000 bytes). Estimated tokens are ceil(JSON string characters/4), not real tokenizer usage. Payload footprints/timings are saved per run. Signed reductions are reported even when Navi is worse; no positive-gain assertion or 10× claim.
- Shadow success is separate from discovery timing: AX name/role tree discovery followed by native getByRole click versus Navi dictionary discovery followed by execute. Both verify a resettable business counter. Browser AX can see closed-root buttons even when Playwright locators cannot pierce closed roots; that limitation belongs to this execution adapter, not accessibility discovery itself. No LLM planner, vision model, network checkout or agent token generation is measured.
- The traversal long-task probe is a separate gate input: `npm run benchmark` records it per fixture and `node scripts/ci-gates.mjs --benchmark` fails if any traversal produces a task over 50ms or if the 2,000-node viewport classification p95 exceeds 25ms. A missing probe, or a browser without the Long Tasks API, fails the gate rather than passing it.
- The fallback adapter is covered by regression tests for explicit trusted-only click/input, frame top-coordinate conversion, certified no-dispatch errors, occlusion refusal and unknown-error no-retry. Native fallback does not magically infer ignored synthetic actions or reconcile business success.
- These local static-fixture results depend on layout, viewport, text density and hardware. Sparse or filtered AX can be more compact. Rich action maps trade extra bytes/time for explicit state, coordinates and direct execution; they are not inherently zero-token or universally faster.

## Reproduce

```sh
npm ci --no-audit --no-fund
npx playwright install chromium
npm run build
npm run dev -- --host 127.0.0.1 --port 4173
# In a second terminal:
npm run benchmark
```

Set NAVI_BENCHMARK_URL only for another authorized local demo origin. The script fails if the demo is unavailable; it does not publish or create a server.

[Raw measurements](benchmark-comparison.json) · [Adapter guide](../docs/AGENT-INTEGRATION.md)
