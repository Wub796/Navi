# Autonomous LLM hard-task benchmark: gpt-oss:20b

**Status: measured — live Ollama Cloud trials.** Model: `gpt-oss:20b`. Endpoint: `https://ollama.com/v1`. Node: v24.22.1. Recorded 2026-10-26T02:23:41.095Z. 40 matched iterations, 80 total path trials.

## Completion

| Path | Completed | Mean tool steps |
|---|---:|---:|
| Navi | 21/40 (52.5%) | 19.3 |
| Playwright | 5/40 (12.5%) | 23.6 |

Paired difference (Navi minus Playwright): 40.0 percentage points; paired 95% interval [22.5, 57.5]; discordants 18 Navi-only / 2 Playwright-only; exact McNemar p=0.000402. Verdict: **superior**.

The pair unit is iteration/fixture seed. This is one model on one local hard-checkout fixture and should not be generalized to real sites or other tasks. It is an empirical comparison of the model through two tool surfaces, not a claim of universal model capability. Provider/harness failures are retained in the raw record; they do not disappear from the trial count.

Failure event buckets: {"raw-playwright":{"SELECTOR_HALLUCINATION":191,"TIMEOUT_UNSETTLED":7,"SCHEMA_VIOLATION":137,"UNCLASSIFIED":105,"HARNESS_OR_PROVIDER_ERROR":1,"PLANNER_STOPPED":4,"TASK_INCOMPLETE":34},"navi-differential":{"SELECTOR_HALLUCINATION":22,"DETERMINISTIC_REFUSAL":10,"TIMEOUT_UNSETTLED":36,"SCHEMA_VIOLATION":132,"PLANNER_STOPPED":6,"TASK_INCOMPLETE":19}}. Buckets count events, not mutually-exclusive failed trials.

[Raw record](llm-benchmark-live-hard-gpt-oss-20b.json).
