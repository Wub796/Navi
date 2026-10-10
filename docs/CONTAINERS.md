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
```

Do not commit credentials. Compose fails variable interpolation when either required variable is missing or empty. The container entrypoint independently refuses missing tenant configuration in `host` mode and a missing token in `mcp` mode. Tokens are environment variables, never command arguments; Docker administrators can still inspect container environments. Use an authenticating TLS gateway and deployment-managed secrets before network exposure.

The same image defaults to the host service. `NAVI_MODE=mcp` selects MCP SSE. Explicit commands override mode selection for diagnostics (`docker run --rm navi:local node --version`). `NAVI_HOST` and `NAVI_PORT` select the container listener. MCP defaults to 2 concurrent sessions and 300 idle seconds, overridable using `NAVI_MCP_MAX_SESSIONS` / `NAVI_MCP_IDLE_TIMEOUT`. Size memory/process limits together with the session cap; a browser session can consume substantial memory.

### Network and storage

- Host service: **127.0.0.1:3000** on the Docker host, distribution and aggregate telemetry.
- MCP service: **127.0.0.1:3001** on the Docker host; both `GET /sse` and `POST /message` require a bearer token.
- Processes listen on `0.0.0.0` **inside their containers**, because an internal loopback listener cannot receive Docker-forwarded connections. Host port bindings are loopback-only; the MCP server's existing non-loopback token requirement remains enforced. Other containers on the Compose network can reach the internal ports, so this is not per-container identity isolation. Do not casually change the published bind address.
- The named `telemetry` volume persists `/data/telemetry.db`. Node 20 uses the existing **JSONL log fallback**, not SQLite. Do not change Node major and reuse this file as SQLite without an explicit migration.
- `docker compose down` retains telemetry; `down --volumes` removes it. Back up and govern retention separately. The verification script uses a uniquely named disposable project/volume and never deletes your normal deployment's data.

## Image construction and runtime hardening

[Dockerfile](../Dockerfile) uses a multi-architecture digest-pinned `node:20.20.2-bookworm-slim` base. A separate build stage runs `npm ci`, builds distributables and installs Chromium using the **lockfile's Playwright CLI** (currently 1.64.0, headless-shell revision 1248 / Chrome 156.0.8078.4). The runtime keeps only `playwright-core`, its matching browser, Playwright's declared Chromium system libraries, the built artifacts and the Node host service. No test runner, tokenizer or development build toolchain is copied to runtime. Apt package versions track the Debian repository at build time; this is not a fully snapshot-reproducible OS image.

The build context is an allowlist in [.dockerignore](../.dockerignore): no Git history, local dependencies, telemetry, credentials, environment files or generated local reports are sent. The same compiler configuration is copied into the build stage, so image and checkout SDK/SRI bytes agree.

[docker-compose.yml](../docker-compose.yml) configures:

- UID/GID 1000 (`node:node`); application and browser files remain root-owned/read-only.
- Read-only root filesystem, a bounded writable `/tmp` tmpfs and a host-only writable telemetry volume.
- All capabilities dropped and `no-new-privileges:true`; default Docker seccomp policy retained. No privileged mode, Docker socket, host networking, host PID or host IPC.
- An init process, bounded PIDs, CPU/memory limits, 512 MiB private Chromium shared memory, rotating logs, health probes and `SIGTERM` handling.

### Security limits that containerization does not resolve

**Node 20 is end-of-life.** The exact 20.x runtime is retained to satisfy the requested compatibility constraint, not endorsed as a maintained production runtime. Upgrade to a supported LTS before calling this deployment production-security-complete. See [Node release lifecycle](https://nodejs.org/en/about/previous-releases).

**Non-root is not Chromium's sandbox.** Navi's existing Playwright launch configuration retains Playwright's `chromiumSandbox:false` default. The image/Compose hardening isolates a trusted, authenticated browser worker; it does not establish Chromium's namespace sandbox for hostile websites. Do not use this as a strong multi-tenant/untrusted-browser isolation boundary. Enabling Chromium sandboxing requires explicitly changing the launch policy, compatible unprivileged user namespaces, a reviewed seccomp profile and verification on the target kernel. Do not work around failures with `--privileged`, `SYS_ADMIN` or a globally unconfined seccomp policy. See [Playwright Docker guidance](https://playwright.dev/docs/docker) and [browser launch options](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-option-chromium-sandbox).

The authenticated MCP driver still accepts arbitrary credential-free HTTP(S) destinations; token holders can reach internal addresses available to the container. Apply network-layer egress controls/SSRF policy and isolate workloads before exposing it to less-trusted agents. There is no TLS, per-user authorization, tenant browser isolation beyond one browser per SSE session, host-service quota/retention policy, or container vulnerability scan in this change. Health endpoints are unauthenticated by design.

## Verify the delivered container

```sh
npm run build
docker build --progress=plain -t navi:local .
npm run test:containers
```

[verify-containers.mjs](../scripts/verify-containers.mjs) creates an isolated Compose project using random ephemeral credentials, waits for both health checks, verifies UID/version/capabilities, compares distributed bytes with local artifacts, checks telemetry persistence through a host restart, rejects missing/wrong bearer tokens on both endpoints, drives an actual Chromium session through the official SSE MCP client, and verifies fail-closed startup without a token. It removes only its own test resources and writes [container-verification.json](../reports/container-verification.json). Ports 3000 and 3001 must be free; the script will not stop an existing service to take them.

## Task benchmark

```sh
npm run benchmark:tcr
```

This runs ten paired tasks per execution path against a disposable live, multi-step checkout, not a third-party commerce site. Every trial checks the committed order through an independent server API. [TCR-BENCHMARK.md](../reports/TCR-BENCHMARK.md) documents the measured table, exact tokenizer and limitations; [tcr-benchmark.json](../reports/tcr-benchmark.json) retains every trial. Both paths are deterministic semantic controllers, **not LLM planners**; observation token counts are exact `cl100k_base` counts, not billed model usage. Navi uses real MCP calls and settlement receipts. No real purchases or public deployments occur.

The checkout is also available through `npm run dev` at `/tcr-checkout.html` for UI review, using the same disposable fixture backend. SDK mutation silence is a scheduling signal, not proof of a server commit: the independent outcome oracle remains essential.

Package 0.5.0 identifies the Phase 2 candidate so the existing immutable `v0.4.0` release tag is not moved. No new release tag or publish is performed by this work.
