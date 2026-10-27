# Hard checkout benchmark across 3 models

**Status: measured — live endpoint trials, including every failure.** Models: beam, gemma4:31b, gpt-oss:20b. Node v24.22.1. 40 matched iterations per model (240 trials in total). Recorded 2026-10-27T00:41:15.365Z.

## What this can and cannot establish

The outcome is paired completion of the same local sandbox checkout: the same fixture, the same seed schedule, the same system prompt and the same two tool surfaces, alternating which path runs first. A pair is matched by iteration, so a model that failed the task failed it on both paths unless the paths differ.

The decision rule was fixed before the run. A model is **not worse** when the paired 95% interval's lower bound is above −10 points; it is **superior** or **worse than baseline** only when the exact McNemar test on discordant pairs is below 0.05 in that path's favour. An observed difference without directional evidence is not described as an established win or regression. The interval's width is the study's resolution: a true difference inside it cannot be distinguished from zero here, and its lower bound is the number the non-inferiority rule reads. Completion counts are unaffected by wall-clock contention, but per-turn latency is not a controlled comparison and is not used here.

This is one fixture, one machine, and 3 models. It says how these models did on this task. It is not a claim about model capability, real websites, logins, uploads or multi-tab flows.

## Completion on the hard task

| Model | Navi | Playwright | Δ (points) | 95% CI (paired) | Navi-only / Playwright-only | Exact McNemar p | Verdict |
|---|---:|---:|---:|---:|---:|---:|---|
| beam | 34/40 (85.0%) | 39/40 (97.5%) | -12.5 | [-25.0, 0.0] | 1 / 6 | 0.125 | inconclusive |
| gemma4:31b | 40/40 (100.0%) | 38/40 (95.0%) | 5.0 | [0.0, 12.5] | 2 / 0 | 0.500 | not worse than baseline (within 10 points) |
| gpt-oss:20b | 21/40 (52.5%) | 5/40 (12.5%) | 40.0 | [22.5, 57.5] | 18 / 2 | 0.000402 | superior |

## Tool steps

| Model | Navi mean steps | Playwright mean steps |
|---|---:|---:|
| beam | 17.7 | 19.6 |
| gemma4:31b | 14.5 | 20.4 |
| gpt-oss:20b | 19.3 | 23.6 |

## Pooled (descriptive)

Across 120 matched pairs, the pair-weighted difference is 10.8 points, with a cluster-bootstrap 95% interval of [3.3, 18.3]. This interval resamples iterations inside each model and weights models by their pair count; it is descriptive, not a claim that the models are interchangeable, and it is not a substitute for the per-model rows above.


## Method

- 40 matched iterations per model; the iteration number is the fixture seed and is shared by both paths, so every pair ran the same task schedule.
- Each model was preflighted with a real tool-calling request before any task started. Each turn had a 4096-token output budget so a thinking model could finish reasoning and still emit its tool call; with the earlier 1200-token cap, one model repeatedly returned empty turns with no tool call, and raising the budget removed them, so the runs that used the cap were discarded rather than counted as model failures.
- One gpt-oss:20b Playwright trial failed before making progress with HTTP 500 from the model endpoint; it remains in the 40-pair raw data, marked as a provider/harness error rather than hidden or replaced.
- The hard variant answers the shipping quote after a 2.5s delay and refuses the first order submission with a validation message while committing nothing.
- Both paths are driven from the same event loop and the same browser; the raw path uses Playwright role locators and the Navi path uses discovery plus guarded execution.
- A settlement that did not confirm keeps its full receipt, with its page messages, navigated flag and settle hint, and also carries the failure marker the planner acts on; it is not replaced by an opaque error. The Navi action-map cursor is then reset so the next read is a full snapshot instead of an empty delta. Both paths are given the same chance to read the page and recover. A recovered timeout is still recorded in the failure buckets, so a bucket counts events rather than failed trials; completion is the independent order oracle alone.
- All trials are retained, including failures. Raw records:

- **beam** — [report](LLM-TCR-BENCHMARK-LIVE-HARD-beam.md) · [raw record](llm-benchmark-live-hard-beam.json)
- **gemma4:31b** — [report](LLM-TCR-BENCHMARK-LIVE-HARD-gemma4-31b.md) · [raw record](llm-benchmark-live-hard-gemma4-31b.json)
- **gpt-oss:20b** — [report](LLM-TCR-BENCHMARK-LIVE-HARD-gpt-oss-20b.md) · [raw record](llm-benchmark-live-hard-gpt-oss-20b.json)

Provider tokens, cached prompt tokens and per-turn latency are in each per-model report. No external purchases were made.
