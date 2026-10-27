# Autonomous LLM hard-task benchmark: beam

**Status: measured — live Ollama Cloud trials.** Model: `beam`. Endpoint: `https://ollama.com/v1`. Node: v24.22.1. Recorded 2026-10-26T00:58:24.617Z. 40 matched iterations, 80 total path trials.

## Completion

| Path | Completed | Mean tool steps |
|---|---:|---:|
| Navi | 34/40 (85.0%) | 17.7 |
| Playwright | 39/40 (97.5%) | 19.6 |

Paired difference (Navi minus Playwright): -12.5 percentage points; paired 95% interval [-25.0, 0.0]; discordants 1 Navi-only / 6 Playwright-only; exact McNemar p=0.125000. Verdict: **inconclusive**. Playwright completed more orders in this sample, but the paired interval overlaps zero and the directional paired test was not significant (p=0.125); the observed deficit is not established beyond this fixture.

The pair unit is iteration/fixture seed. This is one model on one local hard-checkout fixture and should not be generalized to real sites or other tasks. It is an empirical comparison of the model through two tool surfaces, not a claim of universal model capability. Provider/harness failures are retained in the raw record; they do not disappear from the trial count.

Failure event buckets: {"raw-playwright":{"SELECTOR_HALLUCINATION":12,"TIMEOUT_UNSETTLED":24,"SCHEMA_VIOLATION":1,"UNCLASSIFIED":2,"TASK_INCOMPLETE":1},"navi-differential":{"SELECTOR_HALLUCINATION":45,"TIMEOUT_UNSETTLED":44,"SCHEMA_VIOLATION":15,"PLANNER_STOPPED":1,"TASK_INCOMPLETE":6}}. Buckets count events, not mutually-exclusive failed trials.

[Raw record](llm-benchmark-live-hard-beam.json).
