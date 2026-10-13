
> navi-interaction-bridge@0.6.1 release:notes
> node scripts/release-notes.mjs

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

### Verification

Recorded by `npm run verify:release` at 2026-10-13T23:32:26.431Z: **11/11 checks passed**, receipt `ok: true`.

| Check | Result | Detail |
|---|---|---:|
| `node-runtime` | pass | v22.23.3; release verification requires Node 22.x and engines >=22.0.0 |
| `git-repository` | pass | on main |
| `git-clean` | pass | clean apart from 0 generated path(s) |
| `version-tag` | pass | v0.6.1 does not exist yet (create it with --tag once this gate is green) |
| `artifact-budget` | pass | navi.min.js 14929 B (<15000), loader.min.js 689 B (<700) |
| `subresource-integrity` | pass | sha384-TmtbTx4Um3FaZ25ht… matches dist/sri.txt and reports/build.json |
| `test-suite` | pass | 199 passed, 0 failed (floor 199) |
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
platform absent from the table above is unverified, not implied. See
[reports/PHASE5-VERIFICATION.md](reports/PHASE5-VERIFICATION.md) for the phase record.
