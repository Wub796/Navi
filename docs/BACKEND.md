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
| Account/session identity, ownership verification, dashboards | planned | not implemented |
| Rate limiting, quotas, billing, TLS termination | planned | not implemented |
| Warehouse/ETL, alerting, retention and purge jobs | planned | not implemented |
| On-prem/edge deployment story | planned | not implemented |

Run the service with `npm run serve` (defaults to `127.0.0.1:8790`, store `server/telemetry.db`) or embed it with `createNaviHostServer(options)`, which listens and resolves `{ server, port, host, store, tenants, close }`.

## Protocol v0.2 migration note

The async execution SDK exposes time-sliced indexing/metadata. `stats().initialMs` is **elapsed time including idle waits**, not CPU classification duration; `maxTickMs`/`tickSamplesMs` describe bounded work ticks. Native `execute` is local tool dispatch, not proof of transaction success or authenticated billable usage.

The SDK dispatches **no telemetry of any kind** — not on load, not during traversal, not on unload. That is enforced rather than promised: the client bundle is scanned at build time for forbidden constructs, and a browser test asserts zero automatic network requests during indexing and execution. Anything in this document that describes a client-side beacon is describing a **hosting-page or tenant snippet** that reads `window.Navi.stats()` out of band, which is also how the ingestion tests exercise the service (`navigator.sendBeacon`-shaped `text/plain` bodies). The core artifact therefore still ships at **14,929 raw bytes** under its 15,000-byte gate, with its zero-telemetry guarantee intact.

## Recommendation

Use a current **Node.js LTS** — at least this package's declared floor, `engines.node >= 22.0.0`, verified on Node 22.23.3 — for a small ingestion/dashboard API. Start with one process and SQLite in WAL mode on durable local storage. Node's built-in `node:sqlite` avoids another database client dependency. A single SQLite writer is fine for an MVP; never place its file on ephemeral serverless storage or a shared network drive.

**Implemented**, with one deliberate softening: the store resolves `node:sqlite` lazily and falls back to an **append-only JSONL log at the same path** when the built-in module is not importable on the running Node release. `store.mode` reports `sqlite` or `log` so an operator can see which path is live rather than assume. WAL pragmas and the “never on a network drive” rule apply to the SQLite mode; a log-backed MVP is even less interesting to a network filesystem, but it has no transactional dedup, so it is a local-demo and single-writer mode only.

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
- Long-lived immutable URLs such as `/v0.2.0/navi.min.js` with `Cache-Control: public, max-age=31536000, immutable`. That is the right shape for a public CDN distribution; the implemented route is a key-gated delivery path, not a replacement for it. Never change bytes under an immutable URL: release a new version for every change, and keep an explicit rollback version.
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
- `GET /v1/telemetry?key=<tenant_key>` returns that tenant's aggregate; `GET /healthz` returns `{ ok, mode, tenants }`.

What is *not* there: no batch id, no deduplication, no SDK-version dimension, no day buckets, no per-route keys, and no Origin/CORS enforcement on ingestion (a non-browser client can post). The counts are honest aggregates for a dashboard experiment, not billable usage — see the warning below.

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
| `POST /v1/telemetry` | aggregate counts | strict schema + canonical origin + 2048-byte cap | implemented |
| `GET /v1/telemetry?key=…` | tenant aggregate | tenant key; private, no-store | implemented |
| `POST /v1/events` | versioned batched metrics with dedup | verified exact Origin + site match + limits | planned |
| `GET /v1/sites/:id/daily?from=…&to=…` | tenant metrics | session + membership; capped range | planned |
| `POST /v1/sites` | register website | session + CSRF/origin + ownership proof | planned |

For planned ingestion, validate `Origin`, allow CORS **only** for the registered site origin, emit `Vary: Origin`, and do not allow credentials. Reject missing/`null` origins unless a separately authenticated server-to-server API is introduced. `sendBeacon` with JSON can require CORS preflight; alternatively send a strict JSON body with the safelisted `text/plain` content type and parse it after body validation — which is why the implemented route accepts `text/plain` today. Use HTTPS and a CSP `connect-src` allowance for the ingestion origin.

**Important:** Origin/CORS does not authenticate analytics, and neither does a tenant key embedded in a web page. Non-browser clients can forge the key, the tenant id and the Origin. Never bill customers, trigger money movement, or claim fraud-proof counts from this telemetry. Reconcile consequential state server-side instead.

## 4. MVP tables and transaction boundary — planned

**Implemented today** (deliberately smaller than the schema below): `server/store.js` appends `{ tenant_id, url_origin, actions_indexed, actions_executed, execution_failures, received_at }` and summarizes them. Under `node:sqlite` that is a `telemetry` table; otherwise one JSON line per event in the same file. `summarize()` returns `{ events, totals, byTenant, byOrigin }` with deterministic ordering, and `reset()` exists for tests. There is **no dedup**, so a retried beacon double-counts.

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

## 5. Cost and abuse controls — planned

None of this is implemented. The service has no rate limiting, no quotas, no IP or per-key token buckets, no request deadlines beyond the body cap, and no operational counters beyond its log lines. Anyone with the tenant key can read that tenant's aggregate, and anyone at all can post telemetry for a registered tenant id.

Planned controls:

- Browser integration batches counts (for example once per minute with randomized jitter); do not emit one request per DOM mutation or tagged node. Initial/manual instrumentation and a best-effort unload beacon can lose events; do not promise exactly-once client delivery.
- Apply IP and per-tenant token buckets, a shared budget, body limits, connection/request deadlines and bounded dedup cardinality. Trust proxy IP headers only from your actual reverse proxy. On `429`, honor `Retry-After`; bounded exponential backoff with jitter and no indefinitely growing browser queue.
- In a one-process MVP, in-memory token buckets are bounded and reset on restart. Before running multiple replicas, enforce limits at the shared edge or introduce a shared limiter; independent counters do not provide a global limit.
- Record operational counters: accepted/rejected events, queue/write latency, DB busy errors, event loss estimate, asset cache-hit ratio, script failure rate. Logs must redact payloads, credentials and full request URLs. Minimize IP retention and explain analytics data handling in the privacy policy.
- Expose liveness separately from store readiness (`GET /healthz` reports only the store mode and tenant count today). Graceful shutdown must drain accepted writes; backups must use SQLite's backup mechanism or a safe snapshot, not a blind copy of an active WAL database. Encrypt disks/backups, test restores, and cap aggregate queries.

## 6. Scale only when measured

1. **First customers:** one API process plus a persistent store; a static cache absorbs asset traffic. Back up daily; measure storage/write contention and customer activity. No invented capacity number without a load test. Partly available: the process and the store exist, the measurement does not.
2. **Growing writes:** move aggregation to managed PostgreSQL when sustained lock/write latency or HA needs justify it. Keep the schema and transactional dedup contract; index by tenant and day. This is a future technology option, not a chosen provider.
3. **Burst absorption:** add a durable queue only when traffic regularly exceeds write capacity. Bound queue retention and dead-letter handling; preserve idempotency at the database even with at-least-once delivery. Acknowledge only once the event is durable.
4. **Large-scale analytics:** time-partition aggregates and introduce an analytical store only for queries PostgreSQL cannot meet economically. Keep transactional tenancy/auth separate.

Before accepting production traffic, load-test representative batched payloads and abusive ids/bodies, verify exact Origin handling, dedup concurrency, retention cleanup, two-account isolation, CSRF, backup restore, and script availability during API failure. **None of those backend checks has been run**, because no backend deployment exists: the service and its wire contract are tested locally on one workstation, and everything above that is design.

## Product scope decision

Do not target every website first. Start with one difficult, repeatable flow (for example a SaaS signup or commerce checkout), prove reliability with a browser-agent partner, and support the frameworks/controls used there. Ship a deterministic contract and observable failures, not a claim that a heuristic can infer every site's business semantics with 100% accuracy. The same rule applies to this service: it is a small, inspectable ingestion and delivery edge whose limits are written down, not a platform.
