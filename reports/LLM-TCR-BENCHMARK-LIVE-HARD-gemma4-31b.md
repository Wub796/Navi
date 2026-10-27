# Autonomous LLM hard-task benchmark: gemma4:31b

**Status: measured — live Ollama Cloud trials.** Model: `gemma4:31b`. Endpoint: `https://ollama.com/v1`. Node: v24.22.1. Recorded 2026-10-26T01:21:43.353Z. 40 matched iterations, 80 total path trials.

## Completion

| Path | Completed | Mean tool steps |
|---|---:|---:|
| Navi | 40/40 (100.0%) | 14.5 |
| Playwright | 38/40 (95.0%) | 20.4 |

Paired difference (Navi minus Playwright): 5.0 percentage points; paired 95% interval [0.0, 12.5]; discordants 2 Navi-only / 0 Playwright-only; exact McNemar p=0.500000. Verdict: **not worse than baseline (within 10 points)**.

The pair unit is iteration/fixture seed. This is one model on one local hard-checkout fixture and should not be generalized to real sites or other tasks. It is an empirical comparison of the model through two tool surfaces, not a claim of universal model capability. Provider/harness failures are retained in the raw record; they do not disappear from the trial count.

Failure event buckets: {"raw-playwright":{"SELECTOR_HALLUCINATION":33,"TIMEOUT_UNSETTLED":40,"TASK_INCOMPLETE":2},"navi-differential":{"TIMEOUT_UNSETTLED":9,"SCHEMA_VIOLATION":1}}. Buckets count events, not mutually-exclusive failed trials.

[Raw record](llm-benchmark-live-hard-gemma4-31b.json).
