# Phase 5 verification — host-manifest negotiation, a zero-cost inference benchmark, and the publish pipeline

Revision `818b07d` on `main`, plus the receipt commit that carries this report and
`reports/release-verification.json`. Every number below was produced by a command in this
working tree, not estimated.

This report supersedes [PHASE4-VERIFICATION.md](PHASE4-VERIFICATION.md) for the current protocol
version (`0.3.0`), byte budgets (14,929 B bundle, 689 B loader under a 700-byte gate), SRI hash
and published test floor (**88**). Those documents remain accurate as dated receipts of the
revisions they name, including their `0.2.0` protocol strings and the 480-byte loader they
shipped.

## What shipped

| Deliverable | Path | Verified by |
|---|---|---|
| Manifest negotiation | [src/mcp/server.js](../src/mcp/server.js) — `fetchHostManifest`, `fetchHostAsset`, `negotiateHostRuntime` | [tests/manifest-loop.spec.mjs](../tests/manifest-loop.spec.mjs) (8 scenarios), [tests/auto-discovery.spec.mjs](../tests/auto-discovery.spec.mjs) |
| Failure vocabulary | `GUIDANCE` in the same file: `DISCOVERY_UNUSABLE` replaced by `MANIFEST_UNREACHABLE`, `MANIFEST_CROSS_ORIGIN`, `MANIFEST_INCOMPATIBLE`, `HOST_ASSET_MISMATCH`, `HOST_ASSET_BLOCKED` | both suites assert the codes; the sentence for each is the one that table holds |
| Local model fixture | [tests/fixtures/mock-llm-server.mjs](../tests/fixtures/mock-llm-server.mjs) | [tests/llm-harness.spec.mjs](../tests/llm-harness.spec.mjs) |
| Fixture-driven benchmark | [tests/llm-agent-benchmark.mjs](../tests/llm-agent-benchmark.mjs) (`npm run benchmark:llm`) | the run itself: [LLM-TCR-BENCHMARK.md](LLM-TCR-BENCHMARK.md), [llm-tcr-benchmark.json](llm-tcr-benchmark.json) |
| Publish preflight | [scripts/publish-preflight.mjs](../scripts/publish-preflight.mjs) (`npm run publish:preflight`) | [tests/release-pipeline.spec.mjs](../tests/release-pipeline.spec.mjs) |
| Generated release notes | [scripts/release-notes.mjs](../scripts/release-notes.mjs) (`npm run release:notes`) | same |
| Tag-triggered publish | [.github/workflows/release.yml](../.github/workflows/release.yml) | authored and reviewed, **never executed** — no remote, no `NPM_TOKEN` (see limits) |
| Manifest-driven allowlist | [scripts/pack-check.mjs](../scripts/pack-check.mjs) | `npm run pack:check` |
| Receipt evidence | [scripts/verify-release.mjs](../scripts/verify-release.mjs) | [tests/release-pipeline.spec.mjs](../tests/release-pipeline.spec.mjs) |

## The negotiation loop, as implemented

`navi_navigate` asks the host for its runtime **only** when the page already declares
instrumentation (a `Link: rel="agent-bridge"` header or the loader's `<meta name="agent-bridge">`
tag). The request is bounded in four ways, each of which is a scenario in the spec:

| Bound | Value | Why | Scenario |
|---|---|---|---|
| Origin | the page's own origin, re-checked after redirects | a page-supplied URL must not make the agent's network a fetcher for other hosts | cross-origin `Link` target refused |
| Time | `MANIFEST_TIMEOUT_MS = 500` | metadata must not be able to hang a navigation | host holding the response for 5 s |
| Size | `MAX_MANIFEST_BYTES = 16 KiB` | a discovery document is a few hundred bytes | asserted by the reader, not the fixture |
| Retry | none | a failed negotiation has a working answer already | a `404` is one attempt |

Everything else resolves to the packaged runtime, with the reason in the envelope:

| Host state | `sdk.source` | Warning | Behaviour |
|---|---|---|---|
| Runtime already live on the page | `host_inline` | none | binds to it; nothing is fetched |
| Manifest read, `endpoints.script` injected | `host_manifest` | none | the host's build produced the map |
| Manifest unusable | `bundled_fallback` | one of the five codes above, each with the detail that caused it | packaged runtime injected |
| Nothing declared | `bundled_fallback` | `UNINSTRUMENTED_HOST` | packaged runtime injected, **no request made** |

`sdk.strategy` keeps its previous `already-present \| tag \| evaluate` vocabulary, so existing
clients gain fields instead of having meanings redefined underneath them, and `discovery` now
carries `script` (the URL that was designated, redacted) and `integrity`
(`verified | not_declared | failed`).

**The injection differs by whether the host declared a hash, and that is the point.** A manifest
that declares a valid `integrity` has its asset fetched *by the server* and injected as a script
**body**: the hash covers exactly those bytes, so nothing unverified can execute. A manifest with
no hash is injected as a **URL** and the browser fetches it, because no hash exists to check it
against — the receipt then says `integrity: "not_declared"` rather than implying a guarantee that
was never made. `tests/manifest-loop.spec.mjs` distinguishes the two by recording the user agent
of every request the fixture sees: the browser's asset request is present in the second case and
absent in the first.

Two consequences worth stating plainly:

- **A host that publishes no `integrity` is not protected by this loop.** It is injected only if
  it is the page's own origin, which is the trust boundary the same-origin rule already draws;
  the hash adds verification *within* that origin, it does not substitute for it.
- **`HOST_ASSET_BLOCKED` is not a security failure.** A `script-src` that refuses the asset is
  reported and the packaged runtime is used, rather than the session failing.

## The benchmark

`npm run benchmark:llm` with no `LLM_ENDPOINT`/`LLM_MODEL` starts the local fixture instead of
exiting `2`. One run, `reports/llm-tcr-benchmark.json`, `status: fixture-baseline`, `recordedAt`
`2026-10-10T23:50:52.059Z` — 20 trials, 210 model turns served, no third-party request:

| Path | Completed | TCR | Mean tool steps | Input tokens | Cached input | Output tokens | Cost |
|---|---:|---:|---:|---:|---:|---:|---|
| raw-playwright | 10/10 | 100.0% | 9.0 | 79,634 | 34,110 | 2,090 | unknown |
| navi-differential | 10/10 | 100.0% | 12.0 | 223,031 | 87,360 | 2,660 | unknown |

The per-trial record keeps all 20 trials with `usageComplete: true` and `cachedComplete: true`
for each, and is the artifact a future live run is compared against.

What this run does and does not mean is written into the report itself rather than only here:
the token figures are the fixture's deterministic derivation from the request body, so they are
not a provider invoice, and the two paths are driven by scripts of deliberately different length,
so their step counts describe the fixture's plan and are **not** a comparison between the paths.
The paired path comparison remains
[tests/benchmark-agent-tcr.spec.mjs](../tests/benchmark-agent-tcr.spec.mjs) (deterministic, no
model) or a run with a real endpoint.

Two things the fixture proved about the harness rather than about itself:

- **The first run exited `1`, and the failure was real.** `navi_execute_action` takes
  `payload: { text | value }`; the fixture had been nesting the action payload as sibling keys, so
  the executed actions were refused. The harness caught it, the fixture was corrected, and both
  paths then completed 10/10. A benchmark that had reported success on malformed tool calls would
  have been measuring nothing.
- **A failed step is retried, not skipped.** The fixture replays its own emitted calls, matches
  each to its tool result by `tool_call_id`, and treats only a non-error result as succeeded — so
  the script follows what actually happened rather than what it intended.

## The publish pipeline

Two independent gates now stand between a tag and a registry, and the first of them is the
existing release gate, unchanged in spirit:

```
tag push v*  →  verify (Node 22.x): clean worktree · SRI hashes to the shipped bytes ·
                zero failures and ≥88 passing · both byte budgets · ci-gates ·
                allowlist · byte-identical rebuild  →  receipt artifact
             →  publish (Node 22.x, environment: release, id-token: write):
                rebuild from the tagged sources → publish-preflight (refuses on any unmet
                requirement) → pack:check → npm publish --provenance --access public →
                release notes generated from the receipts → GitHub release
```

The preflight is a repository script rather than shell inside the workflow, so it can be run and
tested locally, and every job step runs the documented command (`npm run verify:release -- --tag`,
`npm run publish:preflight`, `npm run release:notes`) rather than a private copy of what it
expands to — a script that stopped working in a maintainer's checkout would stop working here too. Run against the verified revision it still refuses, by design, with exit 1 — one
unmet requirement per decision left to the owner, and nothing else:

```
publish preflight for navi-interaction-bridge@0.5.0 (v0.5.0)
  fail license-file: no LICENSE/LICENSE.md/LICENSE.txt/LICENCE file at the repository root. npm publishes whatever license the package declares; choosing one is the owner's decision, not this pipeline's, so the publish stops here.
  fail license-field: package.json declares no `license` field, so the published package would carry no license at all
  ok   not-private: the package is publishable
  ok   public-access: publishConfig.access is "public"; this repository publishes a public package, and --access public must agree with it
  ok   provenance: publishConfig.provenance is true, so the workflow passes --provenance (which also requires a public source repository and id-token: write)
  ok   tag-matches-version: v0.5.0 matches package.json version 0.5.0
  ok   verification-receipt: reports/release-verification.json records 10/10 checks for 818b07d9c3b3, ok: true
  ok   receipt-matches-artifacts: the receipt describes exactly these bytes (sha384-TmtbTx4Um3FaZ…, 14929 B bundle, 689 B loader)

Not publishing: 2 requirement(s) unmet (license-file, license-field).
```

Before the release gate had passed on this revision the same command reported a third:
`verification-receipt` refused a receipt recording `7/10 checks … ok: false`, which is the
pipeline declining to publish a revision it had not verified rather than a formality.

**Three decisions are deliberately left to the owner, and the pipeline stops rather than guessing
them.** The license is the substantive one: choosing a license for someone else's project is not a
pipeline's decision, so no LICENSE file was created and no `license` field was added; everything
else about publishing was built, and the refusal is the deliverable. The same is true of the
registry name and of whether the source repository is public — and that last one is now a hard
requirement rather than a note: `--provenance` is requested unconditionally, and npm can only
produce provenance for a public source repository.

Failures are loud and specific because a publish is not repeatable:

- The notes generator refuses to write anything at all unless the receipt records a passing
  release (`release-notes: reports/release-verification.json does not record a passing release`,
  exit 1). When it does write, the SRI, the embed tag a tenant pastes, both byte budgets, every
  recorded check verdict and the protocol version are read from `reports/build.json`, the receipt
  and the shipped `dist/navi.min.js` — the protocol version in particular is extracted from the
  bundle, and the generator fails rather than guess if it finds anything other than exactly one
  version literal.
- **A stale receipt cannot authorise a publish.** The preflight compares the receipt's recorded
  SRI and artifact sizes against `dist/` on disk; a rebuild after verification changes the bytes
  and invalidates the receipt, which a timestamp comparison would miss. The receipt is written on
  failure as well as on success, so a blocked release is auditable.
- The publish job runs in a `release` environment with required reviewers available, so the one
  irreversible action in this repository can be made to wait for a person.
- **npm versions are immutable.** There is no rollback path in this pipeline and none was
  invented: a bad publish is superseded with a new version. `gh release create --verify-tag` and
  `npm publish` both fail on a version that already exists, so a re-run after a partial failure
  stops instead of double-publishing.

`scripts/pack-check.mjs` now reads the allowlist from `package.json`'s `files` array at run time
instead of holding a second copy, so the check and the manifest cannot drift apart. The allowlist
itself was left as it was — it is a security boundary, not a side effect of writing docs — and
`npm run pack:check` passes unchanged. `LICENSE` is accepted as an implicit npm inclusion rather
than added to `files`, because npm includes it whether or not it is listed and the preflight is
what insists there is one to include.

## Receipts

```
npm run typecheck                    0 errors (tsc -p jsconfig.json, strict)
npm test                             88 passed, 0 failed (floor 88, Node v22.23.3)
npm run benchmark:llm                exit 0 — fixture-baseline, 210 model turns, 20 trials
npm run verify:release               10/10 checks, 0 failing → reports/release-verification.json
  node-runtime                       v22.23.3 (Node 22.x is required)
  artifact-budget                    navi.min.js 14929 B (<15000), loader.min.js 689 B (<700)
  subresource-integrity              sha384-TmtbTx4Um3FaZ25ht… matches dist/sri.txt and reports/build.json
  test-suite                         88 passed, 0 failed (floor 88)
  ci-gates                           All selected gates passed
  pack-check                         every published path is an intended release artifact
  rebuild-stable                     rebuilt to identical bytes (14929 B bundle, 689 B loader)
npm run publish:preflight            exit 1 — 2 requirements unmet, by design (the license decision)
npm run release:notes                wrote 3109 bytes for v0.5.0 — SRI, budgets, 10/10 verdicts
```

The notes above were written from the receipt of the run in the same block, and reading them back
is how the format was verified: the protocol version comes from `dist/navi.min.js`, the SRI and
both budgets from `reports/build.json`, the embed tag a tenant pastes from the same record, and
the check table from the receipt — `10/10 checks passed`, `receipt ok: true` — with nothing
averaged, rounded or retyped.

The suite moved 81 → **88** (+7: four release-pipeline, two LLM-harness, one manifest-loop) and
the floor moved with it. **Neither published artifact changed bytes in this phase**: the manifest
loop is Node-side, so `dist/navi.min.js` is still 14,929 B, `dist/loader.min.js` still 689 B and
the SRI still `sha384-TmtbTx4Um3FaZ25htbRgiApDW48G3G8321WSwpRCRvAvbvad2hGkA8aOMWiod1Tv` — every
existing embed keeps working, and this report's SRI is the same one Phase 4 published.

**This shell's default Node is v24.21.0, and the release gate requires Node 22.x.** The gate was
therefore run as `npm exec --package=node@22 -- npm run verify:release`, which resolves
v22.23.3 — the same runtime the workflow installs and the same one the receipt records. Running
the gate on v24 fails its `node-runtime` check, which is the gate working as designed rather
than a defect to work around.

## Judgement calls, and what is not verified

- **A self-referential assertion was removed, not softened.** The receipt check originally
  asserted `receipt.evidence.tests[0] >= MIN_PASSING_TESTS`. A receipt is written *after* the
  suite it summarises, so the run that raises the floor can never satisfy that comparison against
  the receipt it is about to write — the first run of this phase failed for exactly that reason.
  It now records the floor it was measured against and asserts the two numbers agree with each
  other plus that the published floor has not been *lowered* beneath a receipt measured against
  more. That keeps the regression it was for and removes the deadlock.
- **No publish, no tag, no hosted CI.** The workflow was authored and read, and every step of it
  was replayed locally (build → preflight → pack-check → notes), but no `v*` tag was pushed, no
  remote exists, and `NPM_TOKEN` / the `release` environment are repository settings this
  workspace cannot see. The publish job is **unverified in execution**; the preflight it depends
  on is verified.
- **The benchmark measures the harness, not a model.** No live endpoint was configured, so no
  model capability, success rate, step count or cost is claimed anywhere — the report says so in
  its own first line, and `NAVI_LLM_FIXTURE=0` restores the fail-closed exit `2` for anyone who
  needs a run that must be a real model.
- **The manifest fixture is loopback, not a CDN.** A real host asset served by a CDN with a real
  `integrity` declaration, a real CDN's `Content-Type`, and a browser's response to a
  `Content-Security-Policy` that blocks the asset are not verified. `HOST_ASSET_BLOCKED` is
  exercised through the injection path, not through a policy the browser enforced.
- **No third-party MCP client was exercised** — unchanged from Phase 4: `mcp-remote`, Cursor and
  Claude Desktop schemas remain unverified, as does a Next.js or Shopify deployment.
- **`linux/amd64` sandboxing** stays with the native `ubuntu-24.04` job in
  [containers.yml](../.github/workflows/containers.yml), unchanged from Phase 3.
- **The discovery document still does not advertise an integrity hash**, because the reference
  host's `/v1/navi.js` route returns the published hash as its `ETag` instead. The negotiation
  supports one; no host in this repository declares one. A host that mirrors the bundle to a CDN
  should declare it, and the matrix now says so.
- **Historic labels left alone.** `0.2.0` strings and the 480-byte loader in the earlier phase
  reports are dated evidence; renaming them would misdate it.
