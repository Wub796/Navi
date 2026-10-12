# Container operations and Phase 2 verification

## Build and run

```sh
docker build --progress=plain -t navi:local .
# Use independent, high-entropy values, supplied by your deployment secret store.
export NAVI_TENANTS='YOUR_DISTRIBUTION_KEY:YOUR_TENANT_ID'
export NAVI_MCP_TOKEN='YOUR_STRONG_BEARER_TOKEN'
docker compose up -d --no-build --wait
curl --fail http://127.0.0.1:3000/healthz
curl --fail http://127.0.0.1:3001/healthz
curl --fail http://127.0.0.1:3001/metrics   # containment counters, Prometheus text
```

Do not commit credentials. Compose fails variable interpolation when either required variable is missing or empty. The container entrypoint independently refuses missing tenant configuration in `host` mode and a missing token in `mcp` mode. Tokens are environment variables, never command arguments; Docker administrators can still inspect container environments. Use an authenticating TLS gateway and deployment-managed secrets before network exposure.

The same image defaults to the host service. `NAVI_MODE=mcp` selects MCP SSE. Explicit commands override mode selection for diagnostics (`docker run --rm navi:local node --version`). `NAVI_HOST` and `NAVI_PORT` select the container listener. MCP defaults to 2 concurrent sessions and 300 idle seconds, overridable using `NAVI_MCP_MAX_SESSIONS` / `NAVI_MCP_IDLE_TIMEOUT`. Size memory/process limits together with the session cap; a browser session can consume substantial memory.

### Network and storage

- Host service: **127.0.0.1:3000** on the Docker host, distribution and aggregate telemetry.
- MCP service: **127.0.0.1:3001** on the Docker host; both `GET /sse` and `POST /message` require a bearer token.
- Processes listen on `0.0.0.0` **inside their containers**, because an internal loopback listener cannot receive Docker-forwarded connections. Host port bindings are loopback-only; the MCP server's existing non-loopback token requirement remains enforced. Other containers on the Compose network can reach the internal ports, so this is not per-container identity isolation. Do not casually change the published bind address.
- The named `telemetry` volume persists `/data/telemetry.db`. On the pinned Node 22 runtime `node:sqlite` still emits an `ExperimentalWarning`, so [store.js](../server/store.js) deliberately selects the append-only **JSONL log backend** at that same path; `store.mode` reports which backend is live, and both answer with an identical summary shape. A newer runtime may open the same file with SQLite, so do not reuse it as a SQLite database without an explicit migration.
- `docker compose down` retains telemetry; `down --volumes` removes it. Back up and govern retention separately. The verification script uses a uniquely named disposable project/volume and never deletes your normal deployment's data.

## Image construction and runtime hardening

[Dockerfile](../Dockerfile) uses a multi-architecture digest-pinned `node:22.23.3-bookworm-slim` base, and `package.json` declares `engines.node: ">=22.0.0"`. A separate build stage runs `npm ci`, builds distributables and installs Chromium using the **lockfile's Playwright CLI** (currently 1.64.0, headless-shell revision 1248 / Chrome 156.0.8078.4). The runtime keeps only `playwright-core`, its matching browser, Playwright's declared Chromium system libraries, the built artifacts and the Node host service. No test runner, tokenizer or development build toolchain is copied to runtime. Apt package versions track the Debian repository at build time; this is not a fully snapshot-reproducible OS image.

The build context is an allowlist in [.dockerignore](../.dockerignore): no Git history, local dependencies, telemetry, credentials, environment files or generated local reports are sent. The same compiler configuration is copied into the build stage, so image and checkout SDK/SRI bytes agree.

[docker-compose.yml](../docker-compose.yml) configures:

- UID/GID 1000 as `pwuser:pwuser` — the base image's default user and group, renamed by the Dockerfile, not a privileged account; application and browser files remain root-owned/read-only.
- Read-only root filesystem, a bounded writable `/tmp` tmpfs and a host-only writable telemetry volume.
- All capabilities dropped and `no-new-privileges:true`. The host service keeps the default Docker seccomp policy; the MCP service additionally applies [security/chromium-seccomp.json](../security/chromium-seccomp.json), a default-derived profile extended with only the namespace and `chroot` permissions Chromium's own sandbox needs, so the renderer can install its filter without widening the container's capability set. No privileged mode, Docker socket, host networking, host PID or host IPC.
- An init process, bounded PIDs, CPU/memory limits, 512 MiB private Chromium shared memory, rotating logs, health probes and `SIGTERM` handling.

### Production deployment files

The file above is the local/verification deployment. [deploy/docker-compose.prod.yml](../deploy/docker-compose.prod.yml) is the production one, and [deploy/fly.toml](../deploy/fly.toml) is the same two services expressed as Fly.io process groups with the store on a Fly volume. Compose selects the two roles with `NAVI_MODE`; Fly supplies explicit process-group commands. Both use the image's `pwuser` (UID/GID 1000), mount the host store directory at `/data`, and define a `/healthz` probe per role. **Only Compose enforces** `cap_drop: [ALL]`, `no-new-privileges:true`, a read-only root, `/tmp` tmpfs and the renderer's [seccomp profile](../security/chromium-seccomp.json). Fly runs the image inside a Machine and has no documented equivalents for those Docker controls in [its configuration schema](https://docs.fly.io/reference/configuration); it is not hardening-equivalent. Verify Chromium sandbox behavior on the actual Fly Machine before production use. The private MCP process binds IPv6 (`::`) for 6PN access and has a process-scoped top-level health check, not an invalid portless proxy service; keep it running because direct 6PN does not proxy-autostart. Prepare a fresh Fly volume's ownership for UID/GID 1000 before the host starts.

Reproduce the production runtime check without publishing anything:

```sh
docker build -t navi:prod-verify .
NAVI_IMAGE=navi:prod-verify npm run test:containers -- --production
```

The verifier creates an isolated project/volume, runs authenticated SSE and telemetry persistence checks, removes only its own resources, and writes [production-container-verification.json](../reports/production-container-verification.json). Ports 3000/3001 must be free.

Three differences from the local file are deliberate. The image is not built by the deployment (`NAVI_IMAGE` is required, so a production host runs exactly the digest that was verified), the credentials are required rather than defaulted (`NAVI_TENANTS` and `NAVI_MCP_TOKEN` are interpolated with `:?`, so a missing value stops the deployment instead of starting a weaker one), and the published ports bind to `127.0.0.1` unless `NAVI_BIND_ADDRESS` says otherwise — a container is not a TLS gateway, and the bearer token is the only thing between a reachable SSE port and a real browser.

The telemetry store is mounted as the **directory** `/data`, not as the single file. On the pinned Node 22 runtime `store.mode` reports the append-only JSONL backend, whose whole state is that one path; a runtime that opens the same path with SQLite adds `-wal` and `-shm` companions beside it, and mounting a single file would silently lose them. `GET /healthz` reports which backend is live.

[tests/deploy-config.spec.mjs](../tests/deploy-config.spec.mjs) checks Compose's hardening against the file text and again against the configuration `docker compose config` resolves, resolves the seccomp profile path relative to the Compose file and parses it as JSON, and checks Fly's process commands, private check and shared store path. TOML parsing is a syntax check, not a Fly deployment or runtime security verification.

### Security limits that containerization does not resolve

**Node 22 is maintenance LTS, not active LTS.** As of October 2026 the 22.x line is a supported but maintenance-phase release, so it receives security fixes without new features; the Active-LTS line has moved on. This deployment is pinned to the exact `22.23.3` patch and its digest, which is what makes the image reproducible, not a claim that the line is the newest supported runtime. See [Node release lifecycle](https://nodejs.org/en/about/previous-releases).

**Chromium's own sandbox is enabled, and non-root is not a substitute for it.** Playwright's default is the opposite of what you want here: it appends `--no-sandbox` unless `chromiumSandbox: true` is passed explicitly, so every path that drives a browser for Navi asks for the sandbox by name — [MCP session](../src/mcp/server.js), [CLI](../src/cli.js), the container check and the LLM benchmark harness — and none of them passes a `--no-sandbox` or `--disable-*-sandbox` argument of its own. The two local measurement harnesses ([tests/benchmark-comparison.js](../tests/benchmark-comparison.js), [tests/benchmark-agent-tcr.spec.mjs](../tests/benchmark-agent-tcr.spec.mjs)) ask for the sandbox too, so a comparison run never measures a weaker browser than the deployed one. For that to work as an unprivileged UID the MCP service runs under the vendored [seccomp profile](../security/chromium-seccomp.json) described above: without those namespace and `chroot` permissions Chromium cannot create the namespaces its sandbox needs, and the alternative would be disabling the sandbox, which this tree does not do.

**The posture is verified, not asserted.** [scripts/check-sandbox.mjs](../scripts/check-sandbox.mjs) refuses to run outside UID 1000, reads the *launched* browser command line from `/proc/<browser-pid>/cmdline` — CDP's `Browser.getBrowserCommandLine` is empty because Playwright never sets `--enable-automation`, so the kernel's copy is the honest source — rejects any sandbox-disable argument, then requires every live renderer to sit in a **distinct user namespace**, a **nested PID namespace**, and to carry **at least one more seccomp filter** than the browser process. It finishes by re-checking `NoNewPrivs: 1` and `CapEff: 0`. A failure names the layer and the observed values.

Verification status per architecture, stated as measured:

- **linux/arm64 — verified natively on this host.** `npm run test:containers` passed all thirteen checks and wrote [container-verification.json](../reports/container-verification.json); the sandbox check records the browser started without a sandbox-disable flag, `Seccomp_filters` 1 for the browser versus **2** for the renderer, the renderer in user namespace `user:[4026532959]` rather than the container's `user:[4026531837]`, and a nested `NSpid`.
- **linux/amd64 — builds and runs unprivileged, sandbox layer incomplete under emulation.** The image builds for `linux/amd64`, runs as `pwuser` UID 1000 with capabilities dropped and `no-new-privileges`, passes no sandbox-disable flag, and its renderer is in a distinct user namespace and a nested PID namespace. On this ARM64 host the amd64 image only runs under QEMU, and under emulation Chromium does not install its extra renderer seccomp filter (observed: `Seccomp_filters` 1 for both the browser and the renderer), so the gate **refuses** that run. That is a failure of the emulated runtime, not a pass, and it is not evidence about native amd64.
- Native amd64 verification is delegated to [.github/workflows/containers.yml](../.github/workflows/containers.yml), whose matrix builds and checks each architecture on its own hardware: `ubuntu-24.04` (x86_64) for `linux/amd64` and `ubuntu-24.04-arm` for `linux/arm64`, each running the same `scripts/check-sandbox.mjs` under the same flags.

**Do not weaken the gate to make a run pass.** All three renderer layers stay required. Do not work around a failure with `--privileged`, `SYS_ADMIN`, `--no-sandbox`, a `--disable-*-sandbox` argument or a globally unconfined seccomp policy; either fix the runtime or report the architecture as unverified. See [Playwright Docker guidance](https://playwright.dev/docs/docker) and [browser launch options](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-option-chromium-sandbox).

The MCP driver now denies private, loopback and link-local destinations by default, checks DNS and routes, and pins proxy connections to validated addresses. Service workers and WebSockets are blocked, and sensitive permissions are denied. Refusals are counted and reported: `GET /healthz` carries the `containment` counters and `GET /metrics` serves them for Prometheus scraping, alongside one structured `SECURITY_CONTAINMENT_VIOLATION` line per refusal on stderr with the destination reduced to origin and path. Scrape those counters (rather than the audit lines) to alert on blocked egress; neither endpoint is authenticated and neither carries URLs or session identifiers.

To keep the audit trail past the life of the process, set `NAVI_TELEMETRY_ENDPOINT` (the host service, e.g. `http://navi-host:3000`) and `NAVI_TENANT_KEY` on the MCP service; a tenant then reads its own records from `GET /v1/tenants/<tenant_id>/security-audit`. Forwarding is opt-in and off the request path: an unreachable or unconfigured host drops the event and moves `navi_containment_forward_failed_total` (or `..._dropped_total` once the 256-event queue is full) instead of delaying a refusal. Neither variable is set in the shipped production file. `NAVI_ALLOW_LOCAL_NETWORK=1` disables that private-network policy for trusted fixtures; only the verifier's isolated override enables it, never the shipped production file. Browser controls are defense in depth: still apply a deployment outbound firewall (including direct UDP) and workload quotas before exposing it to less-trusted agents. The host service now prunes expired violations on a retention window (`NAVI_RETENTION_DAYS`, default 30 days) and caps each tenant's ingestion with a per-process token bucket (`NAVI_RATE_LIMIT_PER_MINUTE` 120, `NAVI_RATE_LIMIT_BURST` 30), both off the request path or cheap enough to sit on it; a rate-limited forward counts as `failed` on the MCP side rather than being retried. What remains absent is TLS, per-user authorization, quotas and billing, tenant browser isolation beyond one browser per SSE session, a limiter shared between replicas, and a container vulnerability scan. Health endpoints are unauthenticated by design.

## Verify the delivered container

```sh
npm run build
docker build --progress=plain -t navi:local .
npm run test:containers
```

Verify on the architecture you are actually running: only a native run can clear the renderer sandbox gate, so a cross-architecture emulated run is expected to refuse (see the per-architecture status above), and native CI runners cover both.

[verify-containers.mjs](../scripts/verify-containers.mjs) creates an isolated Compose project using random ephemeral credentials, waits for both health checks, verifies UID/version/capabilities, runs the sandbox check described above, compares distributed bytes with local artifacts, checks telemetry persistence through a host restart, rejects missing/wrong bearer tokens on both endpoints, drives an actual Chromium session through the official SSE MCP client, verifies fail-closed startup without a token, confirms the default containment guard still refuses a metadata destination with no local-network override, scrapes `/metrics` plus `/healthz` to require the containment counters to be exposed without a URL, files a violation with the tenant key to require it to round-trip through the tenant's own security-audit read (and to be refused without that key), and prunes that tenant's records through the maintenance route to require an in-window record to survive the log compaction with the same id while anonymous and cross-tenant callers are refused. It removes only its own test resources and writes [container-verification.json](../reports/container-verification.json). Ports 3000 and 3001 must be free; the script will not stop an existing service to take them.

## Task benchmark

```sh
npm run benchmark:tcr
```

This runs ten paired tasks per execution path against a disposable live, multi-step checkout, not a third-party commerce site. Every trial checks the committed order through an independent server API. [TCR-BENCHMARK.md](../reports/TCR-BENCHMARK.md) documents the measured table, exact tokenizer and limitations; [tcr-benchmark.json](../reports/tcr-benchmark.json) retains every trial. Both paths are deterministic semantic controllers, **not LLM planners**; observation token counts are exact `cl100k_base` counts, not billed model usage. Navi uses real MCP calls and settlement receipts. No real purchases or public deployments occur.

The checkout is also available through `npm run dev` at `/tcr-checkout.html` for UI review, using the same disposable fixture backend. SDK mutation silence is a scheduling signal, not proof of a server commit: the independent outcome oracle remains essential.

Package 0.5.0 identifies the Phase 2 candidate so the existing immutable `v0.4.0` release tag is not moved. No new release tag or publish is performed by this work.
