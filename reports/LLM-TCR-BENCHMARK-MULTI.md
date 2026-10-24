# Hard checkout benchmark across 3 models

**Status: measured — live endpoint trials, including every failure.** Models: beam:cloud, gemma4:31b-cloud, qwen2.5:7b. Node v22.23.3. 40 matched iterations per model (240 trials in total). Recorded 2026-10-24T23:15:04.444Z.

## What this can and cannot establish

The outcome is paired completion of the same local sandbox checkout: the same fixture, the same seed schedule, the same system prompt and the same two tool surfaces, alternating which path runs first. A pair is matched by iteration, so a model that failed the task failed it on both paths unless the paths differ.

The decision rule was fixed before the run. A model is **not worse** when the paired 95% interval's lower bound is above −10 points; it is **superior** only when the exact McNemar test on the discordant pairs is below 0.05 in Navi's favour. Anything else is reported as inconclusive rather than rounded into a win. The interval's width is the study's resolution: a true difference inside it cannot be distinguished from zero here, and its lower bound is the number the non-inferiority rule reads. Completion counts are unaffected by wall-clock contention, but per-turn latency is not a controlled comparison and is not used here.

This is one fixture, one machine, and 3 models. It says how these models did on this task. It is not a claim about model capability, real websites, logins, uploads or multi-tab flows.

## Completion on the hard task

| Model | Navi | Playwright | Δ (points) | 95% CI (paired) | Navi-only / Playwright-only | Exact McNemar p | Verdict |
|---|---:|---:|---:|---:|---:|---:|---|
| beam:cloud | 23/40 (57.5%) | 33/40 (82.5%) | -25.0 | [-42.5, -7.5] | 3 / 13 | 0.021 | worse than baseline |
| gemma4:31b-cloud | 40/40 (100.0%) | 38/40 (95.0%) | 5.0 | [0.0, 12.5] | 2 / 0 | 0.500 | not worse than baseline (within 10 points) |
| qwen2.5:7b | 0/40 (0.0%) | 0/40 (0.0%) | 0.0 | [0.0, 0.0] | 0 / 0 | 1.000 | inconclusive (both paths failed every trial) |

## Tool steps

| Model | Navi mean steps | Playwright mean steps |
|---|---:|---:|
| beam:cloud | 15.7 | 19.5 |
| gemma4:31b-cloud | 14.9 | 18.2 |
| qwen2.5:7b | 11.7 | 12.6 |

## Pooled (descriptive)

Across 120 matched pairs, the pair-weighted difference is -6.7 points, with a cluster-bootstrap 95% interval of [-13.3, 0.0]. This interval resamples iterations inside each model and weights models by their pair count; it is descriptive, not a claim that the models are interchangeable, and it is not a substitute for the per-model rows above.


## Method

- 40 matched iterations per model; the iteration number is the fixture seed and is shared by both paths, so every pair ran the same task schedule.
- Each model was preflighted with a real tool-calling request before any task started.
- The hard variant answers the shipping quote after a 2.5s delay and refuses the first order submission with a validation message while committing nothing.
- Both paths are driven from the same event loop and the same browser; the raw path uses Playwright role locators and the Navi path uses discovery plus guarded execution.
- All trials are retained, including failures. Raw records:

- **beam:cloud** — [report](LLM-TCR-BENCHMARK-LIVE-HARD-beam-cloud.md) · [raw record](llm-benchmark-live-hard-beam-cloud.json)
- **gemma4:31b-cloud** — [report](LLM-TCR-BENCHMARK-LIVE-HARD-gemma4-31b-cloud.md) · [raw record](llm-benchmark-live-hard-gemma4-31b-cloud.json)
- **qwen2.5:7b** — [report](LLM-TCR-BENCHMARK-LIVE-HARD-qwen2-5-7b.md) · [raw record](llm-benchmark-live-hard-qwen2-5-7b.json)

Provider tokens, cached prompt tokens and per-turn latency are in each per-model report. No external purchases were made.
