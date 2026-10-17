# Dynamic checkout task completion benchmark

Recorded 2026-10-17T19:25:18.609Z. darwin arm64, Apple M5 Pro, Node v22.23.3, Playwright 1.64.0.

| Execution path | Completed | TCR | DOM-context tokens total (10 trials) | Tokens/task mean | Wall time/task mean | Wall time/task p95 |
|---|---:|---:|---:|---:|---:|---:|
| Playwright role locators + explicit waits | 10/10 | 100% | 10,273 | 1027.3 | 2.003s | 2.389s |
| Navi MCP + settlement receipts | 10/10 | 100% | 28,917 | 2891.7 | 1.776s | 1.968s |

## Methodology and boundaries

- Live, disposable local HTTP application with actual fetch requests, debounced product filtering, cart creation, shipping quotes, full-document navigation and server-side order commits. No public site, payment, or external service is contacted. Both paths order two Trail backpacks with Express shipping for $107.00; an independent HTTP oracle checks every committed field and order identifier.
- Ten fresh-browser trials per path, paired on deterministic latency seeds (60–260ms responses); path order alternates to reduce warm-cache/order bias. No retries, ignored failures or discarded samples. TCR means a fully correct server-side order on the first attempt, not merely a successful click.
- Native baseline uses current Playwright role locators, normal actionability auto-waits, 300ms explicit sleeps after non-navigation actions, 3s action timeouts and 5s navigation timeouts. It is not deliberately weakened with stale selectors or ambiguous locators.
- Navi uses the official MCP SDK over stdio and real navi_get_actions/navi_execute_action calls. Every target is resolved from a fresh map by accessible name, role and actionable state, not a fixture ID. Every execution must return executed/dispatched/settled:true and the requested mutation_settle or navigation receipt. Navigation is followed by SDK reinitialization through navi_navigate; its cost is included.
- DOM-context tokens are exact cl100k_base counts of each observed Playwright body ARIA snapshot or complete MCP action-map text envelope, including repeated observations. Tokens are counted using the same tokenizer, not characters/4. These are observation-payload tokens that a planner would receive, **not actual billed agent/LLM consumption**. No LLM planner is connected: both autonomous paths use the same deterministic semantic task controller. Prompt, tool-schema, execution-receipt and generated reasoning tokens are excluded.
- Wall time includes cold Chromium launch, context creation, initial navigation, all observations/actions/waits, SDK reinjection and independent outcome verification; excludes MCP client process startup/handshake, browser shutdown, tokenizer construction and report I/O. Observation tokenization itself is included for both. p95 is nearest rank (with n=10, the maximum). Failures retain their elapsed time and error in the raw report.
- The app visibly mutates a progress indicator throughout asynchronous work. Thus DOM quiet can follow its visible completion; settlement alone cannot prove arbitrary network/business completion on applications without such signals. The server oracle is still required.
- This controlled checkout is a reproducible real-browser integration benchmark, not evidence of performance on external production applications or general LLM task-planning ability. Ten trials are too few to establish a universal flakiness rate; 10/10 does not prove zero failure probability. Rich action maps can cost more tokens than a compact ARIA snapshot; no positive speedup or token-reduction assertion is imposed.

## Reproduce

```sh
npm ci --no-audit --no-fund
npx playwright install chromium
npm run benchmark:tcr
```

The benchmark starts and stops its own application; the Playwright suite also owns its configured demo server. [Raw per-trial measurements](tcr-benchmark.json) · [Application](../demo/tcr-checkout.html) · [Benchmark source](../tests/benchmark-agent-tcr.spec.mjs)
