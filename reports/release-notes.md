## Navi 0.6.1

Distributed browser runtime for agent-driven pages: deterministic action maps, differential
updates, guarded execution and settlement receipts. Protocol version `0.3.0` — read out of
the shipped `dist/navi.min.js` below, not retyped here, so a protocol bump cannot leave these
notes describing the previous one.

### Artifacts

| Artifact | Bytes | Budget | Integrity |
|---|---:|---:|---|
| `dist/navi.min.js` | 14929 | < 15000 | `sha384-TmtbTx4Um3FaZ25htbRgiApDW48G3G8321WSwpRCRvAvbvad2hGkA8aOMWiod1Tv` |
| `dist/loader.min.js` | 689 | < 700 | — |

`dist/navi.min.js` is self-executing and dependency-free; it makes no network request of its
own. The tenant embed is the loader, served from the same host:

```html
<script src="https://YOUR-ASSET-HOST/v1/loader.js"
        data-key="YOUR_TENANT_KEY"
        data-sri="sha384-TmtbTx4Um3FaZ25htbRgiApDW48G3G8321WSwpRCRvAvbvad2hGkA8aOMWiod1Tv"></script>
```

The loader resolves `/v1/navi.js` against its own origin, appends the key, verifies the
bundle against `data-sri` in CORS mode, and publishes the `agent-bridge` marker agents
auto-discover on. Anything embedding the bundle directly must pin the SRI above.

### Container verification

The image is the deployed runtime, and the properties that matter are only visible inside a
running container under the deployment's own restrictions. Each released architecture is
built and exercised natively on its own runner, and every value below is read from those
container receipts rather than restated here.

| Platform | Compose file | Runtime identity | Capabilities | Store | Lifecycle recovery | Checks |
|---|---|---|---|---|---|---:|
| linux/arm64 | `deploy/docker-compose.prod.yml` | uid 1000 (v22.23.3) | dropped (`CapEff 0`, `NoNewPrivs 1`) | sqlite, `-wal` sidecar present | SIGKILL 137 → counter 1; graceful stop → 0 | 18/18 pass |
| linux/arm64 | `docker-compose.yml` | uid 1000 (v22.23.3) | dropped (`CapEff 0`, `NoNewPrivs 1`) | sqlite, `-wal` sidecar present | SIGKILL 137 → counter 1; graceful stop → 0 | 18/18 pass |

### Clean-Room Package Canary Attestation

The image is not the only artifact a consumer installs: the packed tarball is the other, and
packing can drop a manifest export, ship a stale hash or sweep a source file into the archive
without a single source file changing. This is that artifact's verification — the tarball
unpacked into an empty directory with no `node_modules` and no link back to this checkout,
its layout, hash and leak boundary checked on the extracted files, and the packed
`bin/navi-mcp.js` then driven through a live stdio JSON-RPC handshake and a `SIGTERM`
teardown. Every row is read out of `evidence.canary` in the verification receipt.

| Check | Description | Status |
| :--- | :--- | :--- |
| `manifest-layout` | all 13 required manifest exports present (dist/navi.min.js, dist/loader.min.js, dist/mcp.mjs, bin/navi-mcp.js, …) | Passed |
| `sri-and-budgets` | dist/navi.min.js (14929 B) matches sha384-TmtbTx4Um3FaZ25ht…; dist/loader.min.js is 689 B (<=700 B) | Passed |
| `zero-leak-isolation` | 0 forbidden/source/test files, 0 outside package.json allowlist, 0 runtime/bundled dependencies (19 files total) | Passed |
| `mcp-initialize` | negotiated protocolVersion 2024-11-05 with navi-mcp-server@0.6.1 (Navi protocol 0.3.0) | Passed |
| `mcp-tools-list` | tools/list declared navi_navigate, navi_get_actions, navi_execute_action, navi_assert_state, navi_set_session (Navi protocol 0.3.0) | Passed |
| `mcp-sigterm-teardown` | clean teardown on SIGTERM with exit code 0 | Passed |

### Verification

Provenance: `evidence.revision` is `4dfe5fb7f6e14a905e18d62b77c3cf6e321abb68` and `evidence.sourceTree` is `sha256:1cae16a33773c43cb55db0f6fc5407603d0f14a22eeeab440b1b1d38a0d2d1f1` — a digest of every tracked
path outside `reports/`. This receipt is published by the generated-reports commit that follows the
gate run, so the revision it names is one step behind the tag; the digest is what shows the tagged
commit carries exactly the source tree the gate verified, allowing a rewrite under `reports/` and
nothing else. The publish preflight refuses on any other difference, and on a recorded digest that
does not match the tagged tree.

Recorded by `npm run verify:release` at 2026-10-14T23:08:34.366Z: **11/11 checks passed**, receipt `ok: true`.

| Check | Result | Detail |
|---|---|---:|
| `node-runtime` | pass | v22.23.3; release verification requires Node 22.x and engines >=22.0.0 |
| `git-repository` | pass | on main |
| `git-clean` | pass | clean apart from 7 generated path(s) |
| `version-tag` | pass | v0.6.1 does not exist yet (create it with --tag once this gate is green) |
| `artifact-budget` | pass | navi.min.js 14929 B (<15000), loader.min.js 689 B (<700) |
| `subresource-integrity` | pass | sha384-TmtbTx4Um3FaZ25ht… matches dist/sri.txt and reports/build.json |
| `test-suite` | pass | 209 passed, 0 failed (floor 209) |
| `ci-gates` | pass | All selected gates passed. |
| `pack-check` | pass | every published path is an intended release artifact |
| `cleanroom-package-canary` | pass | 6/6 clean-room canary checks passed (manifest exports, SRI match, zero leaks, stdio JSON-RPC handshake) |
| `rebuild-stable` | pass | rebuilt to identical bytes (14929 B bundle, 689 B loader) |

### Discovery

A host that serves this runtime publishes `GET /.well-known/navi.json` and advertises it from
every response with `Link: </.well-known/navi.json>; rel="agent-bridge"`, so an agent handed
only a URL can find the runtime, bind to the instance the host already runs, and inject the
host's own designated asset — verifying a declared subresource integrity hash first. Client
configuration for Claude Desktop, Cursor and page embeds: [docs/INTEGRATION-MATRIX.md](docs/INTEGRATION-MATRIX.md).

### Honest limits

These notes are generated from this repository's own gate receipts on v0.6.1. The npm publish
is verified by the workflow, not by a hosted CI run reproduced here; the remote SSE transport
is exercised against this repository's own SSE tests rather than a third-party client; and
each architecture's container verification is recorded only where a receipt exists — a
platform absent from the table above is unverified, not implied, and the canary table is only
as green as the record it reads. See
[reports/PHASE5-VERIFICATION.md](reports/PHASE5-VERIFICATION.md) for the phase record.
