# Autonomous LLM task benchmark

**Status: measured — live endpoint trials, including all failures.** Model: gemma4:31b-cloud. Node v24.21.0. Paired local sandbox tasks; real provider requests. This file holds empirical model results and never the fixture baseline, which stays in [LLM-TCR-BENCHMARK.md](LLM-TCR-BENCHMARK.md).

Endpoint: http://127.0.0.1:11434/v1 (preset `ollama`); the endpoint was preflighted before the first task — it served 5 model(s) and answered a tool-calling probe in 349ms.

| Path | Completed | TCR | Mean tool steps | Input tokens | Cached input tokens | Output tokens | Turn latency mean / p50 / p95 (ms) | Cost USD (supplied rates) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| raw-playwright | 10/10 | 100.0% | 20.9 | 341456 | 312416 | 6181 | [572ms, 509ms, 906ms] | unknown |
| navi-differential | 10/10 | 100.0% | 13.0 | 265928 | 236832 | 3987 | [605ms, 455ms, 925ms] | unknown |

Failure buckets by path: raw-playwright {"SELECTOR_HALLUCINATION":60} · navi-differential {}

Provider-reported tokens include replayed conversation/tool schemas; unknown usage is not estimated, and cached reads are reported by the provider as a subset of input tokens rather than subtracted. Cost uses explicitly supplied rates only and is not a provider invoice. All trials/errors are retained, with no hidden reruns, and the failures of each path are grouped by taxonomy bucket rather than by prose. An unresolved identifier is not proof of model intent, and a Navi refusal does not imply execution; success requires a correct committed order. No external purchases. These measurements are local task/model-specific, not universal agent reliability. [Raw results](llm-benchmark-live.json)
