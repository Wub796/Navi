# Autonomous LLM task benchmark

**Status: blocked — no live model configured.** LLM_ENDPOINT and LLM_MODEL were not both set, so no model request was made and no mock model was substituted. No LLM success, step-count or billing results are claimed.

## Run with a configured model

```sh
# A local OpenAI-compatible tool-capable endpoint (no key needed for most local servers):
export LLM_ENDPOINT=http://127.0.0.1:11434/v1
export LLM_MODEL=YOUR_TOOL_CAPABLE_MODEL
npm run benchmark:llm
# Hosted: an HTTPS LLM_ENDPOINT plus LLM_API_KEY in this shell only. The key is
# never written to a report and is stripped from every child process it spawns.
```

Optional: LLM_ITERATIONS=10 (default), LLM_MAX_TURNS=25 (default), LLM_INPUT_USD_PER_MILLION and LLM_OUTPUT_USD_PER_MILLION for explicitly supplied prices. Hosted runs incur charges.

The harness compares actual model-driven Playwright ARIA/locator tools with actual Navi MCP differential maps and required settlement receipts. Both receive the same task and independent server-side order oracle. It records first-attempt TCR, tool steps, request count, wall time, provider-reported prompt, cached-input and completion tokens, and failures classified with the five-bucket taxonomy in [failure-classifier.js](../src/failure-classifier.js) — selector hallucination, deterministic refusal, untrusted-gesture-required, timeout-unsettled and schema violation — plus an explicit UNCLASSIFIED sink. A bucket is assigned only from a structured code or receipt field, so an unresolved identifier is observable evidence while model intent is never claimed. Missing usage stays unknown, never estimated as billed.

No mock execution is presented as a model benchmark. Contract tests exercise the transport/accounting separately. [Harness](../tests/llm-agent-benchmark.mjs) · [Raw status/results](llm-tcr-benchmark.json)
