# Autonomous LLM task benchmark

**Status: measured — live endpoint trials, including all failures.** Model: gemma4:31b-cloud. Node v22.23.3. Paired local sandbox tasks; real provider requests. This file holds empirical model results and never the fixture baseline, which stays in [LLM-TCR-BENCHMARK.md](LLM-TCR-BENCHMARK.md).

**Task variant: hard.** The shipping quote answers after a 2.5s delay and the first order submission is refused with a validation message while committing nothing, so a path that reads a quiet DOM as success fails. The easier variant is [LLM-TCR-BENCHMARK-LIVE.md](LLM-TCR-BENCHMARK-LIVE.md).

Endpoint: http://127.0.0.1:11434/v1 (preset `ollama`); the endpoint was preflighted before the first task — it served 7 model(s) and answered a tool-calling probe in 445ms.

| Path | Completed | TCR | Mean tool steps | Input tokens | Cached input tokens | Output tokens | Turn latency mean / p50 / p95 (ms) | Cost USD (supplied rates) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| raw-playwright | 38/40 | 95.0% | 18.2 | 1304057 | 1187712 | 19982 | [1317ms, 1059ms, 3549ms] | unknown |
| navi-differential | 40/40 | 100.0% | 14.9 | 1466901 | 1343360 | 15035 | [1306ms, 1051ms, 3123ms] | unknown |

Failure buckets by path: raw-playwright {"SELECTOR_HALLUCINATION":30,"UNCLASSIFIED":38,"PLANNER_STOPPED":2,"TASK_INCOMPLETE":2} · navi-differential {"TIMEOUT_UNSETTLED":13,"SCHEMA_VIOLATION":1}

Provider-reported tokens include replayed conversation/tool schemas; unknown usage is not estimated, and cached reads are reported by the provider as a subset of input tokens rather than subtracted. Cost uses explicitly supplied rates only and is not a provider invoice. All trials/errors are retained, with no hidden reruns, and the failures of each path are grouped by taxonomy bucket rather than by prose. An unresolved identifier is not proof of model intent, and a Navi refusal does not imply execution; success requires a correct committed order. No external purchases. These measurements are local task/model-specific, not universal agent reliability. [Raw results](llm-benchmark-live-hard-gemma4-31b-cloud.json)
