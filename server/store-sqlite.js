// SQLite WAL backend for the telemetry store.
//
// Write-ahead logging is the mode this backend is built around: an append, a prune
// and a checkpoint stop serializing behind a rollback journal, and a reader never
// blocks the writer. The transactional guarantees the billing path depends on live
// here: `BEGIN IMMEDIATE ... COMMIT` around a webhook event, its tenant definition
// and its checkout claim, so two concurrent deliveries of one event cannot both be
// told they were first.

import {
  asNumber,
  normalizeCheckoutClaim,
  normalizeLimit,
  normalizeRetention,
  normalizeTenantDefinition,
  normalizeViolation,
  normalizeWebhookEvent,
  summarizeRecords,
  toTenantDefinition,
  WEBHOOK_EVENT_TTL_MS
} from './store-schema.js';

/** @param {string} path @param {any} sqlite @returns {import('./store-schema.js').TelemetryStore} */
export function createSqliteStore(path, sqlite) {
  const db = new sqlite.DatabaseSync(path);
  // Write-ahead logging is the mode this store is built around: an append, a
  // prune and a checkpoint stop serializing behind a rollback journal, and a
  // reader never blocks the writer. `synchronous = NORMAL` is the documented
  // pairing for it - a process crash is still survivable without paying for a
  // file sync on every commit, which is what an ingestion route cannot afford.
  // Incremental auto-vacuum has to be chosen before the first table exists, and it
  // has to be chosen before the journal switches to WAL as well: with WAL already
  // on, this pragma is accepted and ignored, and a store that quietly stopped
  // reclaiming the pages a prune frees is a leak no operator can see. The order of
  // the two statements is the difference, so `tests/host-metrics-lifecycle.spec.mjs`
  // reads the mode back rather than trusting it. A file created by an earlier
  // version keeps the mode it was created with; VACUUM is the operator's tool.
  db.exec('PRAGMA auto_vacuum = INCREMENTAL');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  // Read back rather than restated, because the two pragmas have different
  // scopes: `journal_mode` is recorded in the file, while `synchronous` is a
  // property of *this* connection and cannot be observed from any other one. An
  // operator asking a store how durable its writes are has to ask here.
  const pragmas = Object.freeze({
    journal_mode: String(db.prepare('PRAGMA journal_mode').get()?.journal_mode ?? '').toLowerCase(),
    synchronous: asNumber(db.prepare('PRAGMA synchronous').get()?.synchronous),
    auto_vacuum: asNumber(db.prepare('PRAGMA auto_vacuum').get()?.auto_vacuum)
  });
  db.exec(`CREATE TABLE IF NOT EXISTS telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    url_origin TEXT NOT NULL,
    actions_indexed INTEGER NOT NULL,
    actions_executed INTEGER NOT NULL,
    execution_failures INTEGER NOT NULL,
    received_at TEXT NOT NULL
  )`);
  // Refusals live in their own table rather than in the aggregate table: an
  // audit question ("what did this tenant try to reach?") and a metric question
  // ("how many controls were indexed?") must not be able to skew each other.
  db.exec(`CREATE TABLE IF NOT EXISTS containment_violations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    session_id TEXT,
    category TEXT NOT NULL,
    target_url TEXT NOT NULL,
    resolved_ip TEXT,
    created_at TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_violations_tenant_created ON containment_violations(tenant_id, created_at)');
  db.exec(`CREATE TABLE IF NOT EXISTS navigation_maps (
    site_id TEXT NOT NULL,
    url TEXT NOT NULL,
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (site_id, url)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS tenant_quotas (
    tenant_id TEXT PRIMARY KEY,
    window_start_ms INTEGER NOT NULL,
    event_count INTEGER NOT NULL
  )`);
  // Provisioned tenants are configuration, not telemetry: a row here is what makes
  // a key bought through the billing webhook survive a restart. The key is unique
  // because it is the lookup the ingest routes perform; two tenants sharing one
  // would silently hand each other's quota to whichever was read first.
  db.exec(`CREATE TABLE IF NOT EXISTS tenant_definitions (
    tenant_id TEXT PRIMARY KEY,
    api_key TEXT NOT NULL,
    allowed_origins TEXT NOT NULL,
    max_events_per_window INTEGER NOT NULL,
    window_seconds INTEGER NOT NULL,
    status TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_definitions_key ON tenant_definitions(api_key)');
  // The billing ledger. The primary key is what makes "first delivery wins" a
  // database decision: `DO NOTHING` reports zero changed rows for a retry, so two
  // concurrent deliveries of one event cannot both be told they were first.
  db.exec(`CREATE TABLE IF NOT EXISTS webhook_events (
    event_id TEXT PRIMARY KEY,
    received_at_ms INTEGER NOT NULL
  )`);
  const insertWebhookEvent = db.prepare('INSERT INTO webhook_events (event_id, received_at_ms) VALUES (?, ?) ON CONFLICT(event_id) DO NOTHING');
  const deleteWebhookEvent = db.prepare('DELETE FROM webhook_events WHERE event_id = ?');
  const deleteExpiredWebhookEvents = db.prepare('DELETE FROM webhook_events WHERE received_at_ms < ?');
  db.exec(`CREATE TABLE IF NOT EXISTS checkout_claims (
    session_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    api_key TEXT NOT NULL,
    expires_at_ms INTEGER NOT NULL
  )`);
  const upsertCheckoutClaim = db.prepare('INSERT INTO checkout_claims (session_id, tenant_id, api_key, expires_at_ms) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET tenant_id = excluded.tenant_id, api_key = excluded.api_key, expires_at_ms = excluded.expires_at_ms');
  const selectCheckoutClaim = db.prepare('SELECT session_id, tenant_id, api_key, expires_at_ms FROM checkout_claims WHERE session_id = ?');
  const deleteCheckoutClaim = db.prepare('DELETE FROM checkout_claims WHERE session_id = ?');
  const deleteExpiredCheckoutClaims = db.prepare('DELETE FROM checkout_claims WHERE expires_at_ms <= ?');
  const upsertNavigationMap = db.prepare('INSERT INTO navigation_maps (site_id, url, payload, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(site_id, url) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at');
  const selectNavigationMap = db.prepare('SELECT site_id, url, payload, updated_at FROM navigation_maps WHERE site_id = ? AND url = ?');
  const selectTenantQuota = db.prepare('SELECT window_start_ms, event_count FROM tenant_quotas WHERE tenant_id = ?');
  const upsertTenantQuota = db.prepare('INSERT INTO tenant_quotas (tenant_id, window_start_ms, event_count) VALUES (?, ?, ?) ON CONFLICT(tenant_id) DO UPDATE SET window_start_ms = excluded.window_start_ms, event_count = excluded.event_count');
  const upsertTenantDefinition = db.prepare('INSERT INTO tenant_definitions (tenant_id, api_key, allowed_origins, max_events_per_window, window_seconds, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id) DO UPDATE SET api_key = excluded.api_key, allowed_origins = excluded.allowed_origins, max_events_per_window = excluded.max_events_per_window, window_seconds = excluded.window_seconds, status = excluded.status, updated_at = excluded.updated_at');
  const selectTenantDefinition = db.prepare('SELECT tenant_id, api_key, allowed_origins, max_events_per_window, window_seconds, status, updated_at FROM tenant_definitions WHERE tenant_id = ?');
  const selectTenantDefinitions = db.prepare('SELECT tenant_id, api_key, allowed_origins, max_events_per_window, window_seconds, status, updated_at FROM tenant_definitions ORDER BY tenant_id');
  const insert = db.prepare('INSERT INTO telemetry (tenant_id, url_origin, actions_indexed, actions_executed, execution_failures, received_at) VALUES (?, ?, ?, ?, ?, ?)');
  const insertViolation = db.prepare('INSERT INTO containment_violations (tenant_id, session_id, category, target_url, resolved_ip, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const lastViolationId = db.prepare('SELECT last_insert_rowid() AS id');
  // An empty `since` sorts before every ISO-8601 timestamp, so one prepared
  // statement serves both the bounded and the unbounded read.
  const selectViolations = db.prepare('SELECT id, tenant_id, session_id, category, target_url, resolved_ip, created_at FROM containment_violations WHERE tenant_id = ? AND created_at >= ? ORDER BY created_at DESC, id DESC LIMIT ?');
  // Compared as Julian days rather than as text: `created_at` is ISO-8601 with a
  // `T` separator and a `Z`, while `datetime()` renders a space and no zone, and
  // 'T' sorts above ' ' — so a text comparison would spare every row on the day
  // the cutoff falls in. julianday() parses both forms correctly.
  const deleteExpired = db.prepare("DELETE FROM containment_violations WHERE julianday(created_at) < julianday('now', '-' || ? || ' days')");
  const deleteExpiredForTenant = db.prepare("DELETE FROM containment_violations WHERE tenant_id = ? AND julianday(created_at) < julianday('now', '-' || ? || ' days')");
  const countViolations = db.prepare('SELECT COUNT(*) AS count FROM containment_violations');
  const countTenantViolations = db.prepare('SELECT COUNT(*) AS count FROM containment_violations WHERE tenant_id = ?');
  let closed = false;
  return {
    mode: 'sqlite',
    file: path,
    pragmas,
    async append(record) {
      insert.run(record.tenant_id, record.url_origin, record.actions_indexed, record.actions_executed, record.execution_failures, record.received_at);
    },
    async upsertNavigationMap(siteId, url, payload) {
      upsertNavigationMap.run(siteId, url, JSON.stringify(payload), new Date().toISOString());
    },
    async readNavigationMap(siteId, url) {
      const row = /** @type {{site_id?: unknown, url?: unknown, payload?: unknown, updated_at?: unknown} | undefined} */ (selectNavigationMap.get(siteId, url));
      if (!row) return null;
      return { site_id: String(row.site_id), url: String(row.url), payload: JSON.parse(String(row.payload)), updated_at: String(row.updated_at) };
    },
    async consumeQuota(options) {
      const tenantId = String(options.tenant_id);
      const maxEvents = Math.max(1, Math.trunc(Number(options.max_events_per_window)));
      const windowMs = Math.max(1000, Math.trunc(Number(options.window_seconds ?? 3600)) * 1000);
      const now = Date.now();
      const row = /** @type {{window_start_ms?: unknown, event_count?: unknown} | undefined} */ (selectTenantQuota.get(tenantId));
      const prevStart = row ? asNumber(row.window_start_ms) : 0;
      const prevCount = row ? asNumber(row.event_count) : 0;
      const expired = !row || now - prevStart >= windowMs;
      const windowStart = expired ? now : prevStart;
      const currentCount = expired ? 0 : prevCount;
      if (currentCount >= maxEvents) {
        const retryAfterSeconds = Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));
        return { allowed: false, count: currentCount, remaining: 0, retry_after_seconds: retryAfterSeconds };
      }
      const nextCount = currentCount + 1;
      upsertTenantQuota.run(tenantId, windowStart, nextCount);
      return { allowed: true, count: nextCount, remaining: Math.max(0, maxEvents - nextCount), retry_after_seconds: 0 };
    },
    async readQuota(tenantId) {
      const row = /** @type {{window_start_ms?: unknown, event_count?: unknown} | undefined} */ (selectTenantQuota.get(String(tenantId)));
      if (!row) return null;
      return { tenant_id: String(tenantId), window_start_ms: asNumber(row.window_start_ms), event_count: asNumber(row.event_count) };
    },
    async upsertTenantDefinition(definition) {
      const record = normalizeTenantDefinition(definition);
      upsertTenantDefinition.run(record.tenant_id, record.api_key, JSON.stringify(record.allowed_origins), record.max_events_per_window, record.window_seconds, record.status, record.updated_at);
      return record;
    },
    async readTenantDefinition(tenantId) {
      const row = /** @type {any} */ (selectTenantDefinition.get(String(tenantId)));
      return row ? /** @type {import('./store-schema.js').TenantDefinitionRecord} */ (toTenantDefinition(row)) : null;
    },
    async readTenantDefinitions() {
      return /** @type {any[]} */ (selectTenantDefinitions.all()).map(row => /** @type {import('./store-schema.js').TenantDefinitionRecord} */ (toTenantDefinition(row)));
    },
    async recordWebhookEvent(eventId, receivedAtMs) {
      const record = normalizeWebhookEvent(eventId, receivedAtMs);
      deleteExpiredWebhookEvents.run(Date.now() - WEBHOOK_EVENT_TTL_MS);
      const result = /** @type {{changes?: unknown}} */ (insertWebhookEvent.run(record.event_id, record.received_at_ms));
      return asNumber(result?.changes) > 0;
    },
    async releaseWebhookEvent(eventId) {
      deleteWebhookEvent.run(normalizeWebhookEvent(eventId).event_id);
    },
    async applyWebhookEvent(mutation) {
      const eventId = typeof mutation?.event_id === 'string' && mutation.event_id.trim().length > 0
        ? normalizeWebhookEvent(mutation.event_id, mutation.received_at_ms)
        : null;
      const definition = mutation?.definition ? normalizeTenantDefinition(mutation.definition) : null;
      const claim = mutation?.checkout_claim ? normalizeCheckoutClaim(mutation.checkout_claim) : null;
      db.exec('BEGIN IMMEDIATE');
      try {
        deleteExpiredWebhookEvents.run(Date.now() - WEBHOOK_EVENT_TTL_MS);
        if (eventId) {
          const inserted = /** @type {{changes?: unknown}} */ (insertWebhookEvent.run(eventId.event_id, eventId.received_at_ms));
          if (asNumber(inserted?.changes) === 0) {
            db.exec('COMMIT');
            return { duplicate: true, record: null };
          }
        }
        if (definition) {
          upsertTenantDefinition.run(
            definition.tenant_id,
            definition.api_key,
            JSON.stringify(definition.allowed_origins),
            definition.max_events_per_window,
            definition.window_seconds,
            definition.status,
            definition.updated_at
          );
        }
        if (claim) {
          deleteExpiredCheckoutClaims.run(Date.now());
          upsertCheckoutClaim.run(claim.session_id, claim.tenant_id, claim.api_key, claim.expires_at_ms);
        }
        db.exec('COMMIT');
        return { duplicate: false, record: definition };
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* ignore rollback error */ }
        throw error;
      }
    },
    async recordCheckoutClaim(claimInput) {
      const claim = normalizeCheckoutClaim(claimInput);
      deleteExpiredCheckoutClaims.run(Date.now());
      upsertCheckoutClaim.run(claim.session_id, claim.tenant_id, claim.api_key, claim.expires_at_ms);
      return claim;
    },
    async consumeCheckoutClaim(sessionId, nowMs = Date.now()) {
      const id = typeof sessionId === 'string' ? sessionId.trim() : '';
      if (!id) return null;
      const now = Number.isFinite(nowMs) ? Math.trunc(nowMs) : Date.now();
      db.exec('BEGIN IMMEDIATE');
      try {
        deleteExpiredCheckoutClaims.run(now);
        const row = /** @type {{session_id?: unknown, tenant_id?: unknown, api_key?: unknown, expires_at_ms?: unknown} | undefined} */ (selectCheckoutClaim.get(id));
        if (!row) {
          db.exec('COMMIT');
          return null;
        }
        deleteCheckoutClaim.run(id);
        db.exec('COMMIT');
        if (asNumber(row.expires_at_ms) <= now) return null;
        return { tenant_id: String(row.tenant_id), api_key: String(row.api_key) };
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* ignore rollback error */ }
        throw error;
      }
    },
    async summarize(filter = {}) {
      const where = filter.tenant_id ? 'WHERE tenant_id = ?' : '';
      const args = filter.tenant_id ? [filter.tenant_id] : [];
      const rows = /** @type {any[]} */ (db.prepare(`SELECT tenant_id, url_origin, actions_indexed, actions_executed, execution_failures, received_at FROM telemetry ${where}`).all(...args));
      return summarizeRecords(rows.map(row => ({
        tenant_id: String(row.tenant_id),
        url_origin: String(row.url_origin),
        actions_indexed: asNumber(row.actions_indexed),
        actions_executed: asNumber(row.actions_executed),
        execution_failures: asNumber(row.execution_failures),
        received_at: String(row.received_at)
      })), filter);
    },
    async recordViolation(violation) {
      const record = normalizeViolation(violation);
      insertViolation.run(record.tenant_id, record.session_id, record.category, record.target_url, record.resolved_ip, record.created_at);
      const row = /** @type {{id?: unknown}} */ (lastViolationId.get());
      return { id: asNumber(row?.id), ...record };
    },
    async queryViolations(filter) {
      const rows = /** @type {any[]} */ (selectViolations.all(filter.tenant_id, filter.since ?? '', normalizeLimit(filter.limit)));
      return rows.map(row => ({
        id: asNumber(row.id),
        tenant_id: String(row.tenant_id),
        session_id: row.session_id === null || row.session_id === undefined ? null : String(row.session_id),
        category: String(row.category),
        target_url: String(row.target_url),
        resolved_ip: row.resolved_ip === null || row.resolved_ip === undefined ? null : String(row.resolved_ip),
        created_at: String(row.created_at)
      }));
    },
    async pruneViolations(options) {
      const { days, tenant_id } = normalizeRetention(options);
      const removed = tenant_id ? deleteExpiredForTenant.run(tenant_id, days) : deleteExpired.run(days);
      const pruned = asNumber(/** @type {{changes?: unknown}} */ (removed)?.changes);
      if (pruned > 0) {
        // Best effort: the delete has already committed, so a database that cannot
        // vacuum must not turn a successful prune into an error. On a database whose
        // auto-vacuum is not incremental this is a no-op, and VACUUM is the
        // operator's tool.
        try { db.exec('PRAGMA incremental_vacuum'); } catch { /* pages stay on the freelist for reuse */ }
      }
      const row = /** @type {{count?: unknown}} */ ((tenant_id ? countTenantViolations.get(tenant_id) : countViolations.get()));
      return { pruned_count: pruned, remaining_count: asNumber(row?.count) };
    },
    async checkpoint(options = {}) {
      // The mode is chosen by a switch rather than interpolated from the caller: a
      // PRAGMA argument cannot be bound, so anything caller-supplied would be SQL.
      const statement = db.prepare(options?.truncate === false ? 'PRAGMA wal_checkpoint(PASSIVE)' : 'PRAGMA wal_checkpoint(TRUNCATE)');
      const row = /** @type {{busy?: unknown, log?: unknown, checkpointed?: unknown} | undefined} */ (statement.get()) ?? {};
      return { busy: asNumber(row.busy), log: asNumber(row.log), checkpointed: asNumber(row.checkpointed) };
    },
    async reset() {
      db.exec('DELETE FROM telemetry');
      db.exec('DELETE FROM containment_violations');
      db.exec('DELETE FROM navigation_maps');
      db.exec('DELETE FROM tenant_quotas');
      db.exec('DELETE FROM tenant_definitions');
      db.exec('DELETE FROM webhook_events');
      db.exec('DELETE FROM checkout_claims');
    },
    async close() {
      if (closed) return;
      closed = true;
      // Always release the connection, but a failed/busy checkpoint must remain
      // visible to the owner: swallowing it would permit a false clean marker.
      try {
        const row = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
        if (asNumber(row?.busy) !== 0) throw new Error('store close checkpoint was busy');
      } finally {
        db.close();
      }
    }
  };
}
