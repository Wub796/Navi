# Phase 3 · Node 22, sandboxed Chromium and differential action maps

Every number below came from a command run on this revision, on Node `v22.23.3`, on an Apple-silicon host
(`linux/arm64` natively, `linux/amd64` under QEMU). Where a check could not be completed, the limitation is
stated in the same place as the passing results.

## Delivered

- **Node 22 baseline.** `engines.node >= 22.0.0`; `Dockerfile` base pinned by digest to `node:22.23.3-bookworm-slim`;
  `ci.yml`, `release.yml` and `smoke.yml` run `22.x`. Node 22 is **Maintenance** LTS in October 2026, not Active LTS.
- **Non-root sandboxed Chromium.** The image creates and runs as `pwuser` (UID/GID 1000); nothing passes `--no-sandbox`;
  the `navi-mcp` service applies the vendored `security/chromium-seccomp.json` while keeping `cap_drop: ALL`,
  `no-new-privileges` and a read-only rootfs. Every launch path asks for the sandbox by name (`chromiumSandbox: true`):
  the MCP session, the CLI, the container check, the LLM harness, both local benchmark harnesses, and the Playwright test
  and smoke runners' own browser — each of which previously inherited Playwright's `--no-sandbox` default.
- **Multi-arch gate.** `.github/workflows/containers.yml` builds and runs the sandbox check natively on `ubuntu-24.04`
  (x86_64) and `ubuntu-24.04-arm`.
- **Differential action maps.** `window.Navi.actions()` and `navi_get_actions` take an optional `since_version` cursor and
  return a delta plus `state_version` / `reset` / `truncated`; removals are `{ target_id, removed: true }` tombstones.
- **Live-model harness.** `tests/llm-agent-benchmark.mjs` is configured from the environment only, fails closed without
  a model, and accounts provider-reported prompt, completion and cached tokens. `tests/llm-harness.spec.mjs` tests the
  contract; no live model was configured, so no model result is claimed.
- **Failure taxonomy.** `src/failure-classifier.js` assigns one of five buckets — selector hallucination, deterministic
  refusal, untrusted-gesture-required, timeout-unsettled, schema violation — plus an explicit `UNCLASSIFIED` sink, and only
  from a structured code or receipt field. It is imported by the harness and nothing else: no built artifact references it,
  and `dist/navi.min.js` is byte-identical with and without it. `tests/failure-classifier.spec.mjs` covers every bucket and
  asserts that ambiguous failures are never promoted into a claim bucket.

## Measured checks

| Check | Command | Result |
|---|---|---|
| Full suite on Node 22 | `node node_modules/@playwright/test/cli.js test` | **77 passed, 0 failed** (1.8m) |
| Typecheck | `npm run typecheck` (`tsc -p jsconfig.json`) | **0 errors** |
| Deprecation-clean build | `NODE_OPTIONS="--throw-deprecation --pending-deprecation" npm run build` | **exit 0**, no warning thrown |
| Deprecation-free suite output | grep of the 77-test log for `DeprecationWarning`/`ExperimentalWarning` | **0 matches** |
| Zero client-bundle impact | `shasum -a 256 dist/navi.min.js` before and after adding `src/failure-classifier.js`, plus `grep -l SELECTOR_HALLUCINATION dist/*` | **byte-identical** (`b24a31d6…`, 14,929 B, SRI unchanged); the module is referenced by **no** built artifact |
| Strict artifact import | `NODE_OPTIONS=--throw-deprecation node` importing `dist/index.mjs`, `dist/mcp.mjs`, `dist/cli.mjs`, `dist/index.cjs` | **exit 0**, 9/12/4/9 exports |
| SDK byte budget | `node scripts/ci-gates.mjs --budget` | **14,929 bytes < 15,000** (71 bytes of headroom); loader 480 < 500 |
| Gate self-test | `npm run test:gates` | **19/19 expectations held** |
| Publish allowlist | `npm run pack:check` | every published path is an intended artifact |
| Container runtime, arm64 | `npm run test:containers` (native) | **9/9 checks** — [container-verification.json](container-verification.json) |
| Container runtime, amd64 | `docker build --platform linux/amd64` + in-container `scripts/check-sandbox.mjs` | **build passes; sandbox gate refuses** — see limitations |
| Harness fail-closed | `env -u LLM_ENDPOINT -u LLM_MODEL node tests/llm-agent-benchmark.mjs` | **exit 2**, no model call, blocked status recorded |
| Release gate | `npm run verify:release` at the committed revision | **10 of 10 checks pass** — [release-verification.json](release-verification.json) |

The release gate reports `test-suite: 77 passed, 0 failed (floor 77)`, `artifact-budget: 14929 B < 15000`, a matching SRI,
`rebuild-stable: rebuilt to identical bytes`, `ci-gates` and `pack-check` green, and `version-tag: v0.5.0 does not exist yet`,
and it writes that receipt to [release-verification.json](release-verification.json) on failure as well as success. Its only
failure before the phase was committed was `git-clean`, which by design fails while changes are uncommitted; the receipt committed
alongside this report is from the run at that clean revision.

The Chromium sandbox evidence is process-level, not a page claim: the verifier reads the launched argv from
`/proc/<browser-pid>/cmdline`, rejects any sandbox-disable flag, and requires each live renderer to be in a distinct
user namespace, in a nested PID namespace, and to carry at least one more seccomp filter than the browser process.
The passing arm64 run recorded `ownFilters: 1`, renderer `filters: 2`, `user:[4026532959]` (≠ the browser's
`user:[4026531837]`), nested `NSpid`, `NoNewPrivs: 1`, `CapEff: 0`, and a 45-argument browser command line with no
sandbox-disable flag.

## Token measurements

Both numbers are aggregate context over the same task, tokenized with `cl100k_base`, on both paths with identical
observation cadence.

| Workload | Full polling | Differential | Reduction |
|---|---:|---:|---:|
| MCP checkout, 7 actions, 3 observations each (21 observations) | 8,703 tokens | 2,871 tokens | **67.0%** |
| 100 sequential single-target mutations, 24-control list | 311,066 tokens | 9,699 tokens | **96.9%** |

Raw data: [differential-tokens.json](differential-tokens.json) · [differential-mutations.json](differential-mutations.json).
Both paths complete the order and are verified by a server-side oracle, so the reduction is not bought with failures.

Cursor contract verified in `tests/differential-actions.spec.mjs`: additions, removals, state, geometry, name changes and
same-id remounts; two independent cursors; empty deltas when nothing changed; and `reset: true` with a full snapshot — never
an error, never a silent partial answer — for purged cursors (8 snapshots retained), a different filter or limit under the
same cursor, truncated reads (which are never cached), and negative, fractional, out-of-range or non-numeric cursors.

## Failures found and resolved

1. **CDP could not report the browser command line** — `Browser.getBrowserCommandLine` is empty unless `--enable-automation`
   is set, which Playwright never does, so the sandbox check crashed with a protocol error instead of verifying anything.
   It now reads `/proc/<browser-pid>/cmdline`.
2. **Four browser launches ran unsandboxed** — `tests/benchmark-comparison.js`, `tests/benchmark-agent-tcr.spec.mjs` and both
   Playwright runner configs omitted `chromiumSandbox`, so Playwright appended `--no-sandbox` while the deployed paths
   enabled it. All request the sandbox now; the paired TCR benchmark still completes 10/10 trials per path and the full suite
   still passes 73/73 under the sandboxed runner browser.
3. **The 100-mutation workload measured layout shift, not mutation** — changing a row's label reflowed its 23 siblings and
   produced 24 "changed" targets per step. The fixture now uses fixed-geometry rows so exactly one target mutates per step,
   which is the measurement the reduction is actually about.
4. **An unusable `since_version` used to throw** — `INVALID_VERSION` failed the call instead of recovering, which is the
   worst outcome for an agent that lost its cursor. Negative, fractional, out-of-range and non-numeric cursors now answer
   `reset: true` with a full snapshot, at both the SDK and the MCP tool layer.
5. **Cached usage was left "complete" after a missing usage block** — the early return marked only the prompt/completion
   counters unknown; it now marks cache accounting unknown too.

## Limitations

- **linux/amd64 was not verified at runtime on this host.** The image builds and runs as `pwuser` UID 1000 with no
  sandbox-disable flag, and the renderer is in a distinct user namespace and nested PID namespace, but under QEMU
  emulation Chromium installs **no** extra renderer seccomp filter (`ownFilters: 1`, renderer `filters: 1`), so the strict
  gate refuses the run. This is an emulation artifact, not evidence about native amd64; native verification is delegated to
  the `ubuntu-24.04` job in `containers.yml`. The gate was deliberately not weakened to make the emulated run pass.
- **No live model was configured**, so there is no model success, step-count or billing result for either path. The harness
  and its transport/accounting contract are tested; [LLM-TCR-BENCHMARK.md](LLM-TCR-BENCHMARK.md) records the blocked status.
- **SDK headroom is thin**: 14,929 of 15,000 bytes (71 bytes). The budget is enforced, but the next feature needs a
  re-measurement rather than an assumption.
- Node 22 is Maintenance LTS; the `node:sqlite` store path stays behind the JSONL fallback on this runtime, and the
  container check runs on Docker Desktop, whose macOS user-namespace emulation differs from a Linux host kernel.

## Artifacts

[release-verification.json](release-verification.json) · [container-verification.json](container-verification.json) · [differential-tokens.json](differential-tokens.json) ·
[differential-mutations.json](differential-mutations.json) · [llm-tcr-benchmark.json](llm-tcr-benchmark.json) ·
[LLM-TCR-BENCHMARK.md](LLM-TCR-BENCHMARK.md) · [build.json](build.json) ·
[verify-containers.mjs](../scripts/verify-containers.mjs) · [check-sandbox.mjs](../scripts/check-sandbox.mjs) ·
[differential-actions.spec.mjs](../tests/differential-actions.spec.mjs) · [llm-agent-benchmark.mjs](../tests/llm-agent-benchmark.mjs)
