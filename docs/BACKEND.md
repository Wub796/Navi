# Navi: lean backend and scaling plan

## Status at a glance

This document is both a record of what was built and a plan for what was not. Every section below is tagged **implemented**, **partly implemented** or **planned**. A reader must never mistake a plan for shipped code: the ingestion service exists and is tested; the analytics product, accounts, abuse controls, retention and deployment story do not.

| Area | Status | Where |
|---|---|---|
| Key-gated script distribution with SRI ETag | implemented | `server/index.js`, `GET /v1/navi.js` |
| Aggregate telemetry ingestion with a strict schema | implemented | `server/index.js`, `POST /v1/telemetry` |
| Append-only aggregate store, SQLite or log | implemented | `server/store.js` |
| Tenant key registry | implemented | `server/tenants.js` |
| Remote MCP transport (SSE) and session hydration | implemented | `src/mcp/sse.js`, `src/mcp/server.js` |
| Verified per-request service tests | implemented | `tests/backend-ingest.spec.mjs`, `tests/mcp-sse.spec.mjs`, `tests/session-hydration.spec.mjs` |
| Stripe webhook tenant provisioning | implemented | `POST /v1/billing/webhook`, `server/index.js`, `server/store.js`, `src/worker.ts` |
| Per-tenant ingest rate limiting | implemented | `server/index.js`, `POST /v1/telemetry`, `POST /v1/telemetry/violations` |
| Violation retention and log compaction | implemented | `server/store.js`, `POST /v1/tenants/:id/maintenance/prune` |
| Account/session identity, ownership verification, dashboards | planned | not implemented |
| Quotas, billing, shared limiter across replicas, TLS termination | planned | not implemented |
| Warehouse/ETL and alerting | planned | not implemented |
| On-prem/edge deployment story | planned | not implemented |

Run the service with `npm run serve` (defaults to `127.0.0.1:8790`, store `server/telemetry.db`) or embed it with `createNaviHostServer(options)`, which listens and resolves `{ server, port, host, store, tenants, close }`.

## Async execution migration note

The async execution SDK exposes time-sliced indexing/metadata. `stats().initialMs` is **elapsed time including idle waits**, not CPU classification duration; `maxTickMs`/`tickSamplesMs` describe bounded work ticks. Native `execute` is local tool dispatch, not proof of transaction success or authenticated billable usage.

The SDK dispatches **no telemetry of any kind** — not on load, not during traversal, not on unload. That is enforced rather than promised: the client bundle is scanned at build time for forbidden constructs, and a browser test asserts zero automatic network requests during indexing and execution. Anything in this document that describes a client-side beacon is describing a **hosting-page or tenant snippet** that reads `window.Navi.stats()` out of band, which is also how the ingestion tests exercise the service (`navigator.sendBeacon`-shaped `text/plain` bodies). The core artifact therefore still ships at **14,929 raw bytes** under its 15,000-byte gate, with its zero-telemetry guarantee intact.

## Recommendation

Use a current **Node.js LTS** — at least this package's declared floor, `engines.node >= 22.0.0`, verified on Node 22.23.3 — for a small ingestion/dashboard API. Start with one process and SQLite in WAL mode on durable local storage. Node's built-in `node:sqlite` avoids another database client dependency. A single SQLite writer is fine for an MVP; never place its file on ephemeral serverless storage or a shared network drive.

**Implemented**, with one deliberate softening: the store resolves `node:sqlite` lazily and falls back to an **append-only JSONL log at the same path** when the built-in module is not importable on the running Node release. That import is not gated on the Node version: `node:sqlite` exists from 22.5 and has been importable without `--experimental-sqlite` since 22.13 ([nodejs/node#55890](https://github.com/nodejs/node/pull/55890)), so a runtime either can reach it or says so itself — and the image passes `--experimental-sqlite` for the 22.5–22.12 window. What decides an existing store, though, is the **file**: a non-empty path without the SQLite header keeps the log backend, a path with the header keeps SQLite, and a runtime that cannot import the module **refuses** a database rather than formatting it as an empty log. That guard is the difference between an upgrade and a silently empty audit trail; `tests/node22-sqlite-container.spec.mjs` asserts all three cases. Both backends carry two record types: aggregates, and containment violations in their own `containment_violations` table (indexed on `(tenant_id, created_at)`) or, in log mode, as JSONL lines tagged `kind: "containment_violation"` that the summarizer skips. `store.mode` reports `sqlite` or `log` so an operator can see which path is live rather than assume. WAL pragmas and the “never on a network drive” rule apply to the SQLite mode; a log-backed MVP is even less interesting to a network filesystem, but it has no transactional dedup, so it is a local-demo and single-writer mode only.

Serve the SDK as a **static asset** from a caching reverse proxy or CDN in front of a read-only build directory, keeping the backend off the script-loading critical path. This is a vendor-neutral architecture, not a recommendation or integration of a specific hosting/database provider. Choose vendors only after measuring traffic and deployment constraints.

```text
Customer website ─── pinned navi.min.js ──> static cache ──> read-only artifact
       │                        ▲
       │                        └── GET /v1/navi.js?key=<tenant_key>   [implemented]
       │                             Cache-Control: max-age=3600, stale-while-revalidate=86400
       │                             ETag: "<sha384 of the served bytes>"
       │
       └── opt-in aggregate counts ──> POST /v1/telemetry ──> exact-schema / origin / size guards
                                                               │              [implemented]
                                                          SQLite or JSONL
                                                               │
Account owner ── authenticated dashboard API ───────────────────┘        [planned]
```

No LLM calls, queue service, microservices, Redis, or event warehouse for the first customer. The ingestion half of this diagram is running, tested code; the dashboard half, identity, and everything that would make it multi-tenant-safe in production are still a plan.

## 1. Secure asset delivery — asset route implemented, edge and supply chain planned

Implemented today, in `server/index.js`:

- `GET /v1/navi.js?key=<tenant_key>` serves `dist/navi.min.js` with `Content-Type: application/javascript; charset=utf-8`, `X-Content-Type-Options: nosniff`, `Vary`, `Cache-Control: public, max-age=3600, stale-while-revalidate=86400`, and `ETag` equal to the quoted SHA-384 recorded in `dist/sri.txt` — so the validator a client holds is the same hash an enterprise `<script integrity>` tag pins. `If-None-Match` returns `304` with no body. A missing or unknown key is `401 UNAUTHORIZED`; a missing build artifact is `503 SCRIPT_UNAVAILABLE`, never a truncated script.
- The short max-age is deliberate: a key-gated URL is revocable, so the shipped default revalidates daily rather than promising immutability it cannot keep.
- The route reads the built file, not source, and the test asserts the served byte length equals `dist/navi.min.js`.

Still **planned**, and not provided by the service above:

- HTTPS termination. The service speaks plain HTTP and assumes a TLS-terminating proxy in front of it; nothing here redirects, upgrades or pins certificates.
- Long-lived immutable URLs such as `/v0.3.0/navi.min.js` with `Cache-Control: public, max-age=31536000, immutable`. That is the right shape for a public CDN distribution; the implemented route is a key-gated delivery path, not a replacement for it. Never change bytes under an immutable URL: release a new version for every change, and keep an explicit rollback version.
- The build/CI half of the pipeline: gating raw size under 15,000 bytes, scanning dependencies, and publishing only the built script already exist in this repository's CI, but nothing publishes the artifact to a host, signs it beyond the recorded SHA-384, or manages a rollback.
- Asset serving independence from database outages. The implemented distribution route does not touch the store, so an analytics failure cannot delay script delivery, but the two run in one process today; separating them is deployment work.

CSP guidance for integrators: allow the exact asset origin plus, if telemetry is used, the exact ingestion origin — never wildcard domains. A pinned third-party script runs with the customer page's privileges: treat releases as supply-chain-sensitive, require review, and use least-privilege deploy credentials. That guidance is advice to the integrator; nothing in this repository enforces it.

## 2. Identity and tenancy — tenant keys implemented, accounts planned

Implemented today, in `server/tenants.js`:

- A tenant key registry. `loadTenants(env)` reads `NAVI_TENANTS` as comma-separated `key:tenantId` pairs; a key maps to exactly one tenant id, and an unknown `tenant_id` in a payload is rejected with `401 UNKNOWN_TENANT`.
- With `NAVI_TENANTS` unset, the service falls back to a single **local development** key, `dev-tenant-key` for `demo-tenant`. It is a published fixture value, not a secret, and it must not be used in production. Production keys belong in the environment, not in a file this repository ships.
- The key gates both script distribution and reading a tenant summary, so one tenant cannot read another tenant's aggregate through the HTTP surface.

Keep these identifiers separate, as designed but not yet built:

- **Account/session identity**: secret server-side auth used only by the dashboard. Planned.
- **`site_id` / tenant id**: an unguessable public identifier that is not a password or trustworthy authentication. The implemented tenant key is closer to a capability than to an identity, which is exactly why it is rotatable and revocable in principle and why losing it must not be treated as an account compromise.
- **Verified website origin**: an exact normalized `https://host[:port]` allowlist, verified by DNS TXT or a well-known file before ingestion is enabled, and re-verified when ownership changes. Only the *canonical-origin validation* exists today (see §3) — it proves a payload names a well-formed origin, not that the tenant owns it.
- For every planned dashboard read/mutation: authenticate the account, check membership for the requested site, then scope SQL by authorized account/site ids; never trust a client-supplied tenant id alone; use bound parameters, secure/HttpOnly/SameSite cookies, same-origin/CSRF protection for mutations, and audited two-account authorization tests. **None of this exists yet.**

## 3. Minimal event contract — implemented contract is narrow, richer design planned

Telemetry stays **off by default and separate from the tagging SDK**: the SDK sends nothing at all, and an explicitly enabled site-owner snippet reports aggregates out of band. That separation is implemented; what follows is the wire contract that actually exists.

### Implemented: `POST /v1/telemetry`

```json
{
  "tenant_id": "demo-tenant",
  "url_origin": "https://shop.example.com",
  "actions_indexed": 7,
  "actions_executed": 3,
  "execution_failures": 1
}
```

- Bodies are accepted as `application/json` **or** as `text/plain`, because `navigator.sendBeacon(string)` sends the latter; anything else is `415 UNSUPPORTED_MEDIA_TYPE`.
- **Hard cap 2048 bytes.** A body over the cap is rejected with `413 PAYLOAD_TOO_LARGE`, checked against a declared `Content-Length` where present and mid-stream otherwise, so an oversized body cannot hold memory open.
- **Exact schema.** Exactly those five keys and nothing else; unknown keys, non-string ids, wrong types, and non-integer or negative counters are `400 INVALID_PAYLOAD` with the offending field named. Counters are bounded at 0…1,000,000.
- **`url_origin` must be a bare canonical origin.** `new URL(value).origin === value` on http/https, which rejects paths, query strings, fragments, trailing slashes and embedded `user:pass@` credentials. This is what keeps raw addresses, search terms and referrers out of the store by construction rather than by review.
- Raw DOM/HTML text is rejected as `INVALID_PAYLOAD` and provably not stored: the test asserts the tenant's event count is unchanged after such a post.
- Accepted payloads are appended with a **server-generated** `received_at` timestamp and answered `202` with `{ ok: true, accepted: true, tenant_id, url_origin }`. Server timestamps define the buckets, never the client clock.
- `GET /v1/telemetry?key=<tenant_key>` (or the same read with `Authorization: Bearer <tenant_key>`) returns that tenant's aggregate beside its `quota` window — `max_events_per_window`, `window_seconds`, `window_start_ms`, `event_count` — or `quota: null` for an unmetered tenant; `GET /healthz` returns `{ ok, mode, tenants, retention_days }` and `GET /metrics` the same process's counters in Prometheus text.

### Implemented: `POST /v1/telemetry/violations` and the tenant audit read

A containment refusal is the one event this service must be able to show a tenant after the fact: it is a destination the agent was stopped from reaching, which is exactly the kind of thing a security team asks about a week later. It is stored separately from aggregates and read back through its own route.

```json
{
  "session_id": "8f0c1f5e-...",
  "category": "metadata_endpoint",
  "target_url": "http://169.254.169.254/latest/meta-data/",
  "resolved_ip": "169.254.169.254"
}
```

- **The tenant comes from the credential.** `Authorization: Bearer <tenant_key>` (or `?key=` for parity with the beacon route) resolves through `server/tenants.js`; an unregistered key is `401 UNKNOWN_TENANT` before the body is read. A body may also name `tenant_id`, and then it must be registered **and** equal the key's tenant — a record cannot be filed against somebody else (`401 UNKNOWN_TENANT`).
- **`category` is one of six:** `metadata_endpoint`, `private_ipv4`, `loopback_or_local`, `cgnat_or_multicast`, `ipv6_special`, `dns_rebinding_rejected`. The list is duplicated from the MCP server's taxonomy rather than imported, because this service is dependency-free and must not load the agent runtime; `tests/containment-persistence.spec.mjs` asserts the two lists are equal so the copy cannot drift.
- **`target_url` must already be sanitized:** an absolute http(s) URL equal to `origin + pathname`, so credentials, query strings and fragments are `400 INVALID_PAYLOAD`. This route cannot become a second ingestion path for page data.
- **`session_id`** is 1–128 characters of letters, digits, dot, underscore, colon or hyphen, or absent; **`resolved_ip`** is an IP literal or null.
- `application/json` only (this is machine-to-machine), cap 2048 bytes, `413`/`415` as on the beacon route, and the answer is `202 { ok, accepted, tenant_id, id }`.

`GET /v1/tenants/<tenant_id>/security-audit` returns `{ ok, tenant_id, count, limit, since, violations }`, newest first, with `?limit=` (default 50, hard maximum 200) and `?since=` (ISO-8601, inclusive). It is `no-store, private` and authenticated with a **Bearer** key only: a key in a query string is one that ends up in URLs, referrers and proxy logs. A key that resolves to a different tenant than the path names is `403 FORBIDDEN`, decided after the key is checked so an anonymous caller cannot probe which tenants exist.

**Trust model, stated plainly:** as with the beacon route, a caller who can reach this host and knows a tenant id can file a record for it — the key is the stronger form of the two, and a key presented with a disagreeing body is refused. There is no per-user auth and no TLS; treat these records as operator-visible audit evidence, not as a compliance system.

What is *not* there: no batch id, no deduplication, no SDK-version dimension, no day buckets, no per-route keys, and no Origin/CORS enforcement on ingestion (a non-browser client can post). The counts are honest aggregates for a dashboard experiment, not billable usage — see the warning below.

### Implemented: retention, compaction and ingestion ceilings

An audit trail that grows forever stops being readable and starts being a liability, so the store prunes what it keeps:

- **Window.** `pruneViolations({ max_age_days, tenant_id })` deletes violations older than the window, for one tenant or for all. The window is validated rather than trusted: zero, negative, `NaN` and anything above `MAX_RETENTION_DAYS` (36,500) are refused, because SQLite's date modifier returns `NULL` for a value it cannot parse and a `NULL` comparison deletes nothing at all — a silent no-op is worse than an error.
- **SQLite.** One bound `DELETE` per scope. The comparison is `julianday(created_at) < julianday('now', '-' || ? || ' days')` and not a text comparison against `datetime('now', …)`: `created_at` is ISO-8601 with a `T` separator and a `Z`, `datetime()` renders a space and no zone, and `T` sorts above the space — so the text form would spare every row on the day the cutoff falls in. A database this code creates is opened `PRAGMA auto_vacuum = INCREMENTAL`, and a prune that removed rows runs `PRAGMA incremental_vacuum`; on an older file that pragma is a no-op and `VACUUM` is the operator's tool.
- **JSONL.** The log is compacted, not rewritten in place: it is streamed line by line to a temporary file that is then renamed over the original, so a reader sees the old file or the new one and never a mixture, and a failed rewrite leaves the original untouched. Aggregate lines are copied verbatim. Surviving violation lines gain an explicit `id` — the id a reader already holds for them — so a prune cannot renumber an audit trail, and a final `navi_store_meta` line records the highest id ever issued so the next append continues past it across a restart. Mutations are serialized within the process, so an append lands either before the rewrite or after it; the backend remains single-writer by design.
- **Scheduling.** `NAVI_RETENTION_DAYS` (default **30**, `0` disables) sweeps at startup and every six hours (`RETENTION_SWEEP_INTERVAL_MS`), off the request path. A sweep that fails is logged and retried on the next tick rather than thrown: ingestion is unaffected by a prune that did not happen. `GET /healthz` reports `retention_days`, so a disabled sweep is visible rather than silent.
- **On demand.** `POST /v1/tenants/<tenant_id>/maintenance/prune` deletes the authenticated tenant's expired records and answers `{ ok, tenant_id, max_age_days, pruned_count, remaining_count }`. Bearer only (a query-string key is refused here for the same reason the audit read refuses one), `403` for another tenant's path, an optional `{ "max_age_days": n }` body of an integer `1…36,500`, and the configured retention as its default — never `0`, which would read as "prune nothing" while looking like "prune everything". Only violations are deleted; aggregates and other tenants are untouched.

Ingestion is bounded per tenant from the other side, on `POST /v1/telemetry` and `POST /v1/telemetry/violations` alike:

- **A token bucket per tenant:** `NAVI_RATE_LIMIT_PER_MINUTE` (default **120**) refilled continuously, with a burst allowance of `NAVI_RATE_LIMIT_BURST` (default **30**); either set to `0` disables limiting. Tenants are keyed independently, so one noisy page cannot silence another.
- **A refusal that costs nothing:** over the ceiling the answer is `429 RATE_LIMITED` with `Retry-After` (whole seconds, floor 1), `X-RateLimit-Limit` and `X-RateLimit-Remaining: 0`. Nothing is parsed or stored for it. Accepted responses carry `X-RateLimit-Limit` and `X-RateLimit-Remaining` so a client can pace itself.
- **When the charge happens:** a request that presents a tenant key is charged before its body is read, so a caller over its ceiling cannot make this service parse anything; an unauthenticated beacon is charged once its payload names a tenant, after validation, so a malformed body is still a `400` rather than a quota answer. Both routes share one bucket per tenant, so switching routes is not an escape.
- **A persistent window ceiling:** a tenant may also set `max_events_per_window` and `window_seconds` (per tenant, or `NAVI_MAX_EVENTS_PER_WINDOW` / `NAVI_QUOTA_WINDOW_SECONDS` for the deployment). The window is a fixed interval persisted in the store — the `tenant_quotas` table in SQLite, a `tenant_quota` line in the log backend — so it survives a restart and a second process never sees an empty window beside a configured ceiling. An event past the ceiling is `429 {\"error\":\"Quota exceeded\"}` with `Retry-After`, `X-Quota-Limit` and `X-Quota-Remaining: 0`, charged before anything is written; the window rolls over on the first accepted event after it expires. `GET /v1/telemetry` reports the same window and `GET /metrics` exposes it as `navi_host_tenant_quota_limit`, `navi_host_tenant_quota_events`, `navi_host_tenant_quota_window_start_seconds` and `navi_host_quota_exceeded_total`, read from the store on every scrape rather than from process memory.
- **Bounded memory:** a bucket is forgotten after ten idle minutes (`RATE_LIMIT_IDLE_MS`), swept on a timer and again on demand when the map passes `RATE_LIMIT_SWEEP_THRESHOLD`, so the map tracks active tenants rather than every tenant ever seen. Being per process, two replicas each allow the full rate — this is a bound on one process, not a global quota, and the shared edge is where a fleet-wide limit belongs.
- **The audit consequence:** the MCP forwarder posts violations through this same route, so a tenant whose refusals exceed its ceiling has those forwards answered `429`, which the forwarder counts as `failed` rather than retrying. Raise the ceiling for such a tenant or alert on that counter; the alternative — an unbounded retry — is exactly what the fail-safe boundary exists to prevent.

### Implemented: Stripe billing webhook

A subscription has to become a tenant without a human running SQL. `POST /v1/billing/webhook` receives Stripe events, verifies them against the endpoint secret, and writes the tenant through the same store the ingest routes already use. It is dependency-free on both deployments: `node:crypto` here, Web Crypto in the Worker.

- **Verification before parsing.** The signature covers the exact bytes that arrived, so the body is read as text and checked before `JSON.parse` runs. `Stripe-Signature` is `t=<unix seconds>,v1=<hex hmac>`; the digest is HMAC-SHA256 over `${t}.${rawBody}`, the timestamp sits inside the signed string and is refused when it is more than **300 seconds** away in either direction, and the comparison is `timingSafeEqual` on the host and a fixed-length XOR in the Worker. A missing or malformed header, a wrong HMAC, a tampered body or a skewed timestamp is `401 {"error":"Invalid signature"}`. With `NAVI_STRIPE_WEBHOOK_SECRET` unset the route answers `503 {"error":"Billing webhook not configured"}`: a webhook without a secret cannot tell Stripe from anyone who found the URL.
- **Provisioning.** `checkout.session.completed`, `customer.subscription.created` and `customer.subscription.updated` read `metadata` (`tenant_id`, else `client_reference_id`, else `tenant_${customer}`), `api_key`, `allowed_origins` (JSON array, comma- or pipe-separated list, default `["*"]`), and a quota — `max_events_per_window`/`window_seconds` when set, otherwise the plan inferred from the amount billed by `server/pricing.js` (`$199+` Enterprise, `$49-$198.99` Pro, a smaller charge Starter, and no amount Pro) — and answer `{ ok, tenant_id, api_key }`. A key is minted as `navi_live_<64 hex>` only when the tenant has none, so an update cannot rotate the credential a page already embeds. Missing `tenant_id` is `400 {"error":"Missing tenant_id"}`.
- **Persistence and immediate effect.** The host upserts `tenant_definitions` in the SQLite WAL store (or appends a `tenant_definition` line in the log backend) and registers the definition into the live registry, so the key authenticates the very next request and every provisioned key is re-registered at startup from the store. The Worker provisions through one PostgREST call to `public.apply_stripe_webhook`, a `security definer` function that commits the ledger claim, the tenant upsert and any checkout claim as one transaction; a failed call is a transaction that aborted, so there is no half-applied state to compensate for.
- **A redelivery is a no-op, and the ledger is bounded.** Stripe retries any delivery it did not see acknowledged, so each verified event with a string `id` claims a row in a 24-hour event-id ledger (`received_at_ms < Date.now() - 86_400_000` pruned on write and compaction, and at the edge pruned inside the same function that claims the row). On the host in SQLite WAL, `applyWebhookEvent` wraps the ledger claim, the `tenant_definitions` upsert, and any `checkout_claims` write inside a single `BEGIN IMMEDIATE ... COMMIT` transaction so a crash cannot leave an `event_id` claimed without the tenant state applied. A duplicate returns `200 {"ok":true,"duplicate":true}` without rotating a key or mutating state.
- **Self-serve post-checkout API-key claim.** When `checkout.session.completed` carries a Checkout Session ID (`data.object.id` starting with `cs_`), a one-time claim record (`session_id -> { tenant_id, api_key, expires_at }`, valid for 15 minutes) is written to `checkout_claims` (SQLite WAL / JSONL log) or `public.checkout_claims` (Supabase, a `timestamptz`). `GET /v1/billing/session?session_id=<cs_id>` consumes the claim on the first valid read within 15 minutes and answers `200 {"ok":true,"tenant_id":...,"api_key":...}` with `Cache-Control: no-store`; missing, unknown, expired, or already-claimed sessions answer `404 {"error":"Session not found or already claimed"}`.
- **The claim has a page, and it is the same claim.** `GET /v1/billing/success?session_id=<cs_id>` is what a Stripe `success_url` redirects a customer to. It consumes the same one-time claim and renders the key, the tenant id and copy-ready loader-embed and `Authorization: Bearer` snippets as `text/html; charset=utf-8` with `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and `Content-Security-Policy: default-src 'none'` — the document carries a secret and runs no script, so there is nothing for an injected line to do. Missing, malformed, expired or already-claimed sessions answer `404` with an HTML page saying so. Because it is one claim, whichever surface is opened first reveals the key and the other answers `404`; a session id that does not start with `cs_` is refused before any RPC, so a scanner cannot burn a customer's link by guessing at it.
- **Revocation is a ceiling, not a deletion.** `customer.subscription.deleted` keeps the row and the key and sets `max_events_per_window` to `0`, answering `{ ok, tenant_id, status: "suspended" }`. Ingestion then answers `429 {"error":"Quota exceeded"}` with `X-Quota-Limit: 0`, because a tenant whose key is still correct must not be told `401` and invited to retry with another one. Unhandled event types answer `{ ok: true, ignored: true }`.

### Implemented: scraped metrics, journal checkpointing and bounded shutdown

Operating this service is meant to be boring, which is three properties:

- **What it is doing is scrapeable.** `GET /metrics` is Prometheus `text/plain; version=0.0.4`, `no-store`, and aggregate-only: `navi_host_requests_total{route,status}`, `navi_host_rate_limited_total{tenant_id}`, `navi_host_prune_events_total`, `navi_host_pruned_records_total`, `navi_host_active_tenants`, `navi_host_store_bytes`, and the per-tenant quota gauges and refusal counter above. It is open like `/healthz` until `NAVI_METRICS_TOKEN` is set: then a missing or wrong `Authorization: Bearer <token>` is `401 {\"error\":\"Unauthorized\"}` (compared in constant time) while `/healthz` stays open for probes. The `route` label comes from a closed set, so an unmatched path lands on one `other` series instead of minting a series per path a scanner probes. A counter moves when a response finishes, refusals included, so the numbers reconcile against what the service actually answered. Alert on `navi_host_rate_limited_total` for a tenant whose refusals have outgrown its ceiling, on a flat `navi_host_prune_events_total` (the sweep was disabled or stopped running), and on `navi_host_store_bytes` climbing while `navi_host_pruned_records_total` stays put.
- **The journal does not grow without bound.** SQLite is opened `journal_mode = WAL` with `synchronous = NORMAL` — the documented pairing, since a crash is survivable without paying for a file sync on every append — and `auto_vacuum = INCREMENTAL` is set **before** the journal switches to WAL, because in WAL mode SQLite accepts that pragma and silently ignores it. A delete leaves its pages in the write-ahead log, so `checkpoint({ truncate: true })` (`PRAGMA wal_checkpoint(TRUNCATE)`) follows every prune that removed a row and runs once at teardown, while `{ truncate: false }` runs `PASSIVE` for a caller that only wants the frames flushed. Measuring the `-wal` file is therefore meaningful: after a prune that removed anything it is empty, and after a clean `close()` neither `-wal` nor `-shm` exists. The log backend answers the same call with zeros, so nothing downstream branches on the backend.
- **Stopping is bounded.** `SIGTERM` and `SIGINT` stop accepting, drain in-flight requests for a strict **5 seconds**, then destroy whatever is still open, clear the retention interval, checkpoint and close the store, and exit `0`; a `202` this process accepted is still readable after a reopen. Point a container's `stop_grace_period` (Fly) or `stop_grace_period`/`stopTimeout` (Compose) a little above those 5 seconds — `deploy/docker-compose.prod.yml` and `deploy/fly.toml` are the shipped examples — and note that the MCP transports declare the same constant, so a stop timeout is sized against one number for all three services rather than three. Diagnostics go to stderr; stdout carries only the readiness line.

### Planned: the richer versioned event contract

The design below adds dedup, versioning and batching. It is **not implemented**; `POST /v1/telemetry` is what exists.

```json
{
  "v": 1,
  "site_id": "public-random-site-id",
  "batch_id": "random-uuid-per-batch",
  "sdk_version": "0.1.0",
  "tagged_delta": 12,
  "scan_ms": 3.7
}
```

`tagged_delta` is **newly generated tagged element identities**, not all elements with authored tags, not unique actions, and not clicks or successful transactions. Replacements can increase it. Report that metric accurately. Use a `stats().tagged` baseline subtraction; use a new `batch_id` after each acknowledged batch and keep the same id for retries; partition a legitimately larger delta into bounded batches rather than widening the bound. Never accept raw HTML, selectors, action labels, field values, cookies, full URLs, query strings, referrers, or client timestamps. If route analytics become necessary, use customer-defined non-PII route keys, not the address bar.

Planned endpoints:

| Route | Purpose | Security | Status |
|---|---|---|---|
| `GET /v1/navi.js?key=…` | key-gated asset | tenant key; no DB call | implemented |
| `POST /v1/billing/webhook` | provision or revoke a tenant | Stripe HMAC-SHA256 signature, 300 s replay window, 24 h event-id ledger, `metadata.tenant_id` | implemented |
| `GET /v1/billing/session` | one-time post-checkout key claim | `?session_id=cs_…`, 15 min TTL, consumed on first read, `no-store` | implemented |
| `GET /v1/billing/success` | the same claim, rendered for a `success_url` redirect | `?session_id=cs_…`, `text/html`, script-free page, CSP `default-src 'none'`, `no-store` | implemented |
| `GET /` | the edge root: what the service is and how to call it | anonymous, `text/html`, script-free page, CSP `default-src 'none'; style-src 'unsafe-inline'`, `no-store`, no `Referer` | implemented |
| `GET /healthz` | edge liveness | anonymous, `no-store`, no storage access; `405` + `Allow: GET` for any other method | implemented |
| `POST /v1/telemetry` | aggregate counts | strict schema + canonical origin + 2048-byte cap | implemented |
| `GET /v1/telemetry?key=…` | tenant aggregate | tenant key; private, no-store | implemented |
| `POST /v1/telemetry/violations` | one containment violation | tenant key; six categories; sanitized origin+path; 2048-byte cap | implemented |
| `GET /v1/tenants/:id/security-audit` | that tenant's blocked destinations | Bearer key; own tenant only; limit/since | implemented |
| `POST /v1/tenants/:id/maintenance/prune` | delete that tenant's expired violations | Bearer key; own tenant only; `max_age_days` 1…36500 | implemented |
| `POST /v1/events` | versioned batched metrics with dedup | verified exact Origin + site match + limits | planned |
| `GET /v1/sites/:id/daily?from=…&to=…` | tenant metrics | session + membership; capped range | planned |
| `POST /v1/sites` | register website | session + CSRF/origin + ownership proof | planned |

For planned ingestion, validate `Origin`, allow CORS **only** for the registered site origin, emit `Vary: Origin`, and do not allow credentials. Reject missing/`null` origins unless a separately authenticated server-to-server API is introduced. `sendBeacon` with JSON can require CORS preflight; alternatively send a strict JSON body with the safelisted `text/plain` content type and parse it after body validation — which is why the implemented route accepts `text/plain` today. Use HTTPS and a CSP `connect-src` allowance for the ingestion origin.

**Important:** Origin/CORS does not authenticate analytics, and neither does a tenant key embedded in a web page. Non-browser clients can forge the key, the tenant id and the Origin. Never bill customers, trigger money movement, or claim fraud-proof counts from this telemetry. Reconcile consequential state server-side instead.

## 4. MVP tables and transaction boundary — planned

**Implemented today** (deliberately smaller than the schema below): `server/store.js` appends `{ tenant_id, url_origin, actions_indexed, actions_executed, execution_failures, received_at }` and summarizes them. Under `node:sqlite` that is a `telemetry` table opened in WAL mode; otherwise one JSON line per event in the same file, chosen by what the file already is rather than by which runtime opened it. `summarize()` returns `{ events, totals, byTenant, byOrigin }` with deterministic ordering, and `reset()` exists for tests. There is **no dedup**, so a retried beacon double-counts.

The following is the **planned** production shape, kept because the constraints are the reason it looks like this:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE sites (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  verified_at TEXT
);
CREATE TABLE site_origins (
  site_id TEXT NOT NULL REFERENCES sites(id),
  origin TEXT NOT NULL,
  PRIMARY KEY (site_id, origin)
);
CREATE TABLE daily_metrics (
  site_id TEXT NOT NULL REFERENCES sites(id),
  day TEXT NOT NULL, -- server-derived UTC YYYY-MM-DD
  sdk_version TEXT NOT NULL,
  tagged_count INTEGER NOT NULL DEFAULT 0,
  batches INTEGER NOT NULL DEFAULT 0,
  scan_ms_sum REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, day, sdk_version)
);
CREATE TABLE event_dedup (
  site_id TEXT NOT NULL REFERENCES sites(id),
  batch_id TEXT NOT NULL,
  received_at INTEGER NOT NULL, -- server epoch seconds
  PRIMARY KEY (site_id, batch_id)
);
CREATE INDEX event_dedup_expiry ON event_dedup(received_at);
CREATE INDEX sites_account ON sites(account_id);
```

Provision account/membership tables through the selected auth design; the schema above is analytics-only. For each accepted event, use **one transaction**:

1. Check verified origin and site eligibility.
2. `INSERT ... ON CONFLICT DO NOTHING` into `event_dedup` using bound values.
3. If that insert changed zero rows, acknowledge the duplicate without incrementing metrics.
4. Otherwise upsert the matching daily bucket, adding count/batches/scan duration.
5. Commit before returning `202`/`204`. On failure, roll back and return a retryable `503`, not fake success.

Store raw dedup ids for 24 hours, aggregate daily buckets for an initially documented 90-day window. Retry only inside the dedup window; very old retries must be discarded by the client or can double count after expiry. Purge in bounded indexed batches, not unbounded locks during peak traffic. `scan_ms_sum/batches` gives a mean, **not p95**; add bounded histograms only if users need latency percentiles.

### Implemented: alerts and a dashboard worth importing

Operational config is code that only runs during an incident, so it lives in the repository and is checked like anything else:

- [deploy/prometheus/alerts.yml](../deploy/prometheus/alerts.yml) holds the rules, grouped by signal: one alert instance per containment **category** (a summed rule could report that something was refused but not what), the forwarder queue saturation that means the audit trail has holes, failed forwards before they become drops, host rate-limit pressure per tenant, a retention sweep that has not run in a day, MCP session saturation, a target that is not scrapeable, state-based unclean shutdown detection, and recent process starts.
- Event counters are windowed with `rate`/`increase`; the two 0/1 boot counters may also be compared directly inside an uptime-bounded ten-minute branch. `increase` alone cannot observe a first scrape at 1 or consecutive unclean boots (1 → 1). Tests reject every other unbounded counter comparison and parse all PromQL with the Prometheus UI grammar.
- Both services export `process_start_time_seconds` as a module-initialization gauge. The host consumes `${store.file}.clean` before opening its SQLite/JSONL store: an existing store without that marker reports `navi_host_unclean_shutdowns_total 1`; first boot or a clean predecessor reports 0. Teardown joins socket/request/background drain, checkpoints and closes the store, then atomically publishes the marker. A failed/busy checkpoint or failed close does not publish it. This is evidence of completed teardown, not the previous OS exit code; one process must exclusively own a state path.
- [deploy/grafana/dashboard.json](../deploy/grafana/dashboard.json) binds every panel to one datasource template variable, so it imports without editing. There is **no latency histogram** in either exposition, so the closest panel is request throughput and it is described as a proxy rather than titled as latency.

## 5. Cost and abuse controls — partly implemented

Implemented: a per-tenant token bucket on both ingest routes, with `429` and `Retry-After` once a tenant exceeds `120` requests a minute and a burst of `30`. Not implemented: quotas and billing, an IP-level bucket for unauthenticated beacons, a budget shared across replicas, request deadlines beyond the body cap, and operational counters beyond the log lines. Anyone with the tenant key can read that tenant's aggregate, and anyone at all can post telemetry for a registered tenant id.

Planned controls:

- Browser integration batches counts (for example once per minute with randomized jitter); do not emit one request per DOM mutation or tagged node. Initial/manual instrumentation and a best-effort unload beacon can lose events; do not promise exactly-once client delivery.
- The per-tenant bucket ships; what remains is an IP-level bucket for the unauthenticated beacon route, a shared budget across replicas, body limits per tenant, connection/request deadlines and bounded dedup cardinality. Trust proxy IP headers only from your actual reverse proxy. On `429`, honor `Retry-After`; bounded exponential backoff with jitter and no indefinitely growing browser queue.
- In a one-process MVP, in-memory token buckets are bounded and reset on restart. Before running multiple replicas, enforce limits at the shared edge or introduce a shared limiter; independent counters do not provide a global limit.
- Record operational counters: accepted/rejected events, queue/write latency, DB busy errors, event loss estimate, asset cache-hit ratio, script failure rate. `GET /metrics` carries host request, rate-limit, prune and store-size counters today, but request latency, store readiness and busy errors are still log lines rather than series. Logs must redact payloads, credentials and full request URLs. Minimize IP retention and explain analytics data handling in the privacy policy.
- Expose liveness separately from store readiness: `GET /healthz` reports the store mode, tenant count and retention window, and *not* a query against the store, so it is still a liveness answer rather than a readiness one. Graceful shutdown drains accepted writes within its deadline and checkpoints before closing, which is what keeps an accepted `202` from being lost — but backups must still use SQLite's backup mechanism or a safe snapshot rather than a blind copy: under `journal_mode = WAL` the newest commits can live only in the `-wal` sidecar, so a file copied mid-write can be missing frames the checkpoint would have folded in. Encrypt disks/backups, test restores, and cap aggregate queries.

## 6. Scale only when measured

1. **First customers:** one API process plus a persistent store; a static cache absorbs asset traffic. Back up daily; measure storage/write contention and customer activity. No invented capacity number without a load test. Partly available: the process and the store exist, the measurement does not.
2. **Growing writes:** move aggregation to managed PostgreSQL when sustained lock/write latency or HA needs justify it. Keep the schema and transactional dedup contract; index by tenant and day. This is a future technology option, not a chosen provider.
3. **Burst absorption:** add a durable queue only when traffic regularly exceeds write capacity. Bound queue retention and dead-letter handling; preserve idempotency at the database even with at-least-once delivery. Acknowledge only once the event is durable.
4. **Large-scale analytics:** time-partition aggregates and introduce an analytical store only for queries PostgreSQL cannot meet economically. Keep transactional tenancy/auth separate.

Before accepting production traffic, load-test representative batched payloads and abusive ids/bodies, verify exact Origin handling, dedup concurrency, retention cleanup, two-account isolation, CSRF, backup restore, and script availability during API failure. **None of those backend checks has been run**, because no backend deployment exists: the service and its wire contract are tested locally on one workstation, and everything above that is design.

## Product scope decision

Do not target every website first. Start with one difficult, repeatable flow (for example a SaaS signup or commerce checkout), prove reliability with a browser-agent partner, and support the frameworks/controls used there. Ship a deterministic contract and observable failures, not a claim that a heuristic can infer every site's business semantics with 100% accuracy. The same rule applies to this service: it is a small, inspectable ingestion and delivery edge whose limits are written down, not a platform.
