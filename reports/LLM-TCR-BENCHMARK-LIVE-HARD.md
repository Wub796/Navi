# Autonomous LLM task benchmark

**Status: measured — live endpoint trials, including all failures.** Model: gemma4:31b-cloud. Node v24.21.0. Paired local sandbox tasks; real provider requests. This file holds empirical model results and never the fixture baseline, which stays in [LLM-TCR-BENCHMARK.md](LLM-TCR-BENCHMARK.md).

Endpoint: http://127.0.0.1:11434/v1 (preset `ollama`); the endpoint was preflighted before the first task — it served 5 model(s) and answered a tool-calling probe in 364ms.

| Path | Completed | TCR | Mean tool steps | Input tokens | Cached input tokens | Output tokens | Turn latency mean / p50 / p95 (ms) | Cost USD (supplied rates) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| raw-playwright | 26/30 | 86.7% | 22.0 | 1397230 | 1282944 | 16224 | [552ms, 427ms, 731ms] | unknown |
| navi-differential | 28/30 | 93.3% | 14.3 | unknown | 959904 | unknown | [3168ms, 438ms, 715ms] | unknown |

Failure buckets by path: raw-playwright {"SELECTOR_HALLUCINATION":56,"UNCLASSIFIED":25,"PLANNER_STOPPED":1,"TASK_INCOMPLETE":4} · navi-differential {"SELECTOR_HALLUCINATION":1,"TIMEOUT_UNSETTLED":14,"SCHEMA_VIOLATION":2,"HARNESS_OR_PROVIDER_ERROR":2}

Provider-reported tokens include replayed conversation/tool schemas; unknown usage is not estimated, and cached reads are reported by the provider as a subset of input tokens rather than subtracted. Cost uses explicitly supplied rates only and is not a provider invoice. All trials/errors are retained, with no hidden reruns, and the failures of each path are grouped by taxonomy bucket rather than by prose. An unresolved identifier is not proof of model intent, and a Navi refusal does not imply execution; success requires a correct committed order. No external purchases. These measurements are local task/model-specific, not universal agent reliability. [Raw results](llm-benchmark-live.json)
