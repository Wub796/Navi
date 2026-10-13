# Deterministic process lifecycle verification

Verified on Node **22.23.3**, macOS arm64, after v0.6.0. The existing release tag and release receipt remain historical artifacts and are not moved or rewritten by this change.

## Checks performed

- `PATH=/tmp/node22/bin:$PATH npm run typecheck`: passed.
- `PATH=/tmp/node22/bin:$PATH npm test`: **188 passed, 0 failed**, 2.1 minutes; asserted passing count **>= 168** and command exit code 0.
- Actual shipped files: `dist/navi.min.js` **14,929 bytes** (< 15,000); `dist/loader.min.js` **689 bytes** (<= 700). Computed SHA-384 matches `dist/sri.txt`; SDK/loader bytes are unchanged.
- `promtool check rules deploy/prometheus/alerts.yml`: passed, **10 rules**.
- `promtool test rules tests/fixtures/lifecycle-alerts.test.yml`: passed. Evaluates first scrape at 1, clean boot at 0, consecutive dirty boots at 1, target-label matching, missing startup series, range increases, ten-minute expiry and the strict two-minute uptime threshold.

Promtool commands ran in the official Prometheus **v3.6.0** image pinned to digest:

```sh
IMAGE=prom/prometheus@sha256:76947e7ef22f8a698fc638f706685909be425dbe09bd7a2cd7aca849f79b5f64
docker run --rm --entrypoint /bin/promtool -v "$PWD:/work:ro" -w /work "$IMAGE" check rules deploy/prometheus/alerts.yml
docker run --rm --entrypoint /bin/promtool -v "$PWD:/work:ro" -w /work "$IMAGE" test rules tests/fixtures/lifecycle-alerts.test.yml
```

## Behavior verified through real entry points

[Host/MCP lifecycle tests](../tests/host-metrics-lifecycle.spec.mjs) start real child processes and read their live HTTP `/metrics` endpoints:

- First boot exports 0; SIGTERM and SIGINT publish `.clean`, the next boot consumes it and exports 0.
- SIGKILL leaves no `.clean`; the next boot exports 1. Consecutive host SIGKILL restarts still export 1; a successful teardown restores 0 on the following boot.
- Host cases exercise both SQLite and existing JSONL stores; WAL/checkpoint and accepted-record survival tests remain green.
- Startup gauges are typed as gauges and bounded by timestamps before process spawn and after HTTP readiness.
- Failed/busy host checkpoints and failed store close never publish clean state.
- Failed MCP cleanup, deadline expiry, and an earlier failed disconnect cleanup never publish clean state.
- Host background pruning and MCP session cleanup must complete before clean state is published. Concurrent close calls join the same promise.
- A real Playwright SSE session is terminated and its download directory removed before the clean marker is observed after process exit.

[Alerting tests](../tests/ops-alerting.spec.mjs) validate live series declarations, parse rule/dashboard PromQL with the pinned dev-only Prometheus UI grammar, and include negative parser and unbounded-counter controls.

## Semantics and limits

These metrics attest whether the prior owner completed graceful teardown, **not an OS exit code**. Counters are deliberately 0/1 per boot, not durable cumulative crash counts. As approved, the warning retains `increase(...[10m])` and adds uptime-bounded startup-value branches: `increase` alone misses first scrape at 1 and consecutive dirty boots (1 → 1). A direct comparison without that bound is still rejected by the tests.

State paths require a single exclusive owner and must survive the restart being measured. The host uses its persistent store plus `${store.file}.clean`. MCP defaults to `/tmp/navi-mcp-state` and `/tmp/navi-mcp-state.clean`; use `NAVI_MCP_STATE_FILE` on persistent storage for container-restart detection. That value is a path, not a prefix: when it already ends in `.clean` it names the marker itself and dirty evidence is the sibling `.dirty` file, so the shipped `/var/lib/navi/mcp/state.clean` never publishes `state.clean.clean`. The production Compose `/tmp` tmpfs does **not** retain lifecycle evidence after container stop/replacement. Production volume changes and a live production Prometheus deployment were not performed.

A process must be scraped within ten minutes of the dirty boot for the startup branch to fire. Sentinels are flushed and atomically published, but this is not a filesystem/power-loss durability guarantee or a count of crashes that occur entirely between scrapes. Initial rollout against an existing store without a marker is classified as dirty, per the specified startup rule.
