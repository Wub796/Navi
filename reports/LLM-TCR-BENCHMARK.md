# Autonomous LLM task benchmark

**Status: fixture baseline — no model was called.** The model side of this run was the local fixture in `tests/fixtures/mock-llm-server.mjs`, which drives the MCP server, the browser, the differential action maps and the settlement receipts exactly as a model would. It measures this repository's harness and its accounting path. Its token figures are *simulated* provider usage derived from the request body, so they are not a provider invoice, and no model capability, success rate or cost is claimed by this file. The two paths below are driven by scripts that are deliberately not the same length, so their step counts describe the fixture's plan and are **not** a comparison between the paths: the paired path comparison is [benchmark-agent-tcr.spec.mjs](../tests/benchmark-agent-tcr.spec.mjs) (deterministic, no model) or a run with a real `LLM_ENDPOINT`/`LLM_MODEL` (see [LLM-TCR-BENCHMARK-LIVE.md](LLM-TCR-BENCHMARK-LIVE.md)).

Model id: navi-mock-fixture-v1. Node v22.23.3.

| Path | Completed | TCR | Mean tool steps | Input tokens | Cached input tokens | Output tokens | Cost USD (supplied rates) |
|---|---:|---:|---:|---:|---:|---:|---:|
| raw-playwright | 10/10 | 100.0% | 9.0 | 79634 | 34110 | 2090 | unknown |
| navi-differential | 10/10 | 100.0% | 12.0 | 231911 | 96240 | 2660 | unknown |

Failure buckets by path: raw-playwright {} · navi-differential {}

Provider-reported tokens include replayed conversation/tool schemas; unknown usage is not estimated, and cached reads are reported by the provider as a subset of input tokens rather than subtracted. Cost uses explicitly supplied rates only and is not a provider invoice. All trials/errors are retained, with no hidden reruns, and the failures of each path are grouped by taxonomy bucket rather than by prose. An unresolved identifier is not proof of model intent, and a Navi refusal does not imply execution; success requires a correct committed order. No external purchases. These measurements are local task/model-specific, not universal agent reliability. [Raw results](llm-benchmark.json)
