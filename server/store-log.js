// Append-only JSONL backend for the telemetry store.
//
// This is what a runtime without `node:sqlite` gets, so the documented
// `engines.node` range keeps working. It answers with the identical summary shape
// as the SQLite backend, so callers never branch on which one is active.
//
// Neither record type grows forever: `pruneViolations` drops audit rows past a
// retention window by compacting the log - streaming it to a temporary file and
// renaming over the original. Compaction is the one place the log is rewritten, so
// it is also the one place an id is made explicit: a pruned row must not renumber
// the rows around it.

import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, readFile, rename, rm, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import {
  asNumber,
  CHECKOUT_CLAIM_CONSUMED_KIND,
  CHECKOUT_CLAIM_KIND,
  normalizeCheckoutClaim,
  normalizeLimit,
  normalizeRetention,
  normalizeTenantDefinition,
  normalizeViolation,
  normalizeWebhookEvent,
  retentionCutoff,
  STORE_META_KIND,
  summarizeRecords,
  toTenantDefinition,
  VIOLATION_KIND,
  WEBHOOK_EVENT_KIND,
  WEBHOOK_EVENT_RELEASE_KIND,
  WEBHOOK_EVENT_TTL_MS
} from './store-schema.js';

/** @param {string} path @returns {import('./store-schema.js').TelemetryStore} */
export function createLogStore(path) {
  /**
   * One pass over the whole file. Aggregates, violations and the id high-water
   * mark are read together because a rewrite has to know about all three at once.
   * @returns {Promise<{records: import('./store-schema.js').TelemetryRecord[], violations: import('./store-schema.js').ContainmentViolation[], definitions: Map<string, import('./store-schema.js').TenantDefinitionRecord>, sequence: number}>}
   */
  const scanLog = async () => {
    let text = '';
    /** @type {Map<string, import('./store-schema.js').TenantDefinitionRecord>} */
    const definitions = new Map();
    try {
      text = await readFile(path, 'utf8');
    } catch {
      return { records: [], violations: [], definitions, sequence: 0 };
    }
    /** @type {import('./store-schema.js').TelemetryRecord[]} */
    const records = [];
    /** @type {import('./store-schema.js').ContainmentViolation[]} */
    const violations = [];
    let sequence = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      /** @type {any} */
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        // A torn final line (crash mid-append) is skipped rather than fatal.
        continue;
      }
      if (!parsed || typeof parsed !== 'object') continue;
      if (parsed.kind === 'navigation_map' || parsed.kind === 'tenant_quota') continue;
      // The ledger is read on demand by `recordWebhookEvent` and never counts as a
      // beacon: falling through here would add a phantom event per delivery.
      if (
        parsed.kind === WEBHOOK_EVENT_KIND
        || parsed.kind === WEBHOOK_EVENT_RELEASE_KIND
        || parsed.kind === CHECKOUT_CLAIM_KIND
        || parsed.kind === CHECKOUT_CLAIM_CONSUMED_KIND
      ) continue;
      if (parsed.kind === 'tenant_definition') {
        // Last line wins, exactly like the SQLite upsert: a revocation appends a
        // new definition rather than rewriting the old one.
        const definition = toTenantDefinition(parsed);
        if (definition.tenant_id) definitions.set(definition.tenant_id, definition);
        continue;
      }
      if (parsed.kind === STORE_META_KIND) {
        sequence = Math.max(sequence, asNumber(parsed.violation_sequence));
        continue;
      }
      if (parsed.kind === VIOLATION_KIND) {
        // Position is the id of a line written before ids were made explicit; an
        // explicit id wins, which is what lets a compaction preserve them.
        const id = Number.isSafeInteger(parsed.id) && parsed.id > 0 ? Number(parsed.id) : violations.length + 1;
        sequence = Math.max(sequence, id);
        violations.push({
          id,
          tenant_id: String(parsed.tenant_id ?? ''),
          session_id: typeof parsed.session_id === 'string' && parsed.session_id.length ? parsed.session_id : null,
          category: String(parsed.category ?? ''),
          target_url: String(parsed.target_url ?? ''),
          resolved_ip: typeof parsed.resolved_ip === 'string' && parsed.resolved_ip.length ? parsed.resolved_ip : null,
          created_at: String(parsed.created_at ?? '')
        });
        continue;
      }
      // Normalize the shape so a hand-edited or foreign line cannot inject NaN
      // into an aggregate. A violation line is separated above rather than here:
      // counting one as a beacon would add a phantom event with zero actions.
      records.push({
        tenant_id: String(parsed.tenant_id ?? ''),
        url_origin: String(parsed.url_origin ?? ''),
        actions_indexed: asNumber(parsed.actions_indexed),
        actions_executed: asNumber(parsed.actions_executed),
        execution_failures: asNumber(parsed.execution_failures),
        received_at: String(parsed.received_at ?? '')
      });
    }
    return { records, violations, definitions, sequence };
  };
  /** @returns {Promise<import('./store-schema.js').TelemetryRecord[]>} */
  const readRecords = async () => (await scanLog()).records;
  /** Violations in append order, each carrying the id it was written under.
   * @returns {Promise<import('./store-schema.js').ContainmentViolation[]>} */
  const readViolations = async () => (await scanLog()).violations;
  /** Ids continue from what the file already holds, so a restart does not reuse
   * the position a reader already ordered by — and after a compaction the mark
   * comes from the metadata line, so it does not reuse the id of a pruned row
   * either. One process owns the file, which is how this backend is deployed; a
   * second writer is not supported.
   * @type {number | null} */
  let violationSequence = null;
  const nextViolationId = async () => {
    if (violationSequence === null) violationSequence = (await scanLog()).sequence;
    violationSequence += 1;
    return violationSequence;
  };
  /**
   * Mutations run one at a time. Compaction replaces the file with a renamed
   * temporary, so an append that interleaved with it could be written to a file
   * the rename discards; serializing is what makes "an append lands either before
   * the rewrite or after it" true. Reads are deliberately not queued: the original
   * is untouched until the rename, so a reader sees the old file or the new one
   * whole, never a mixture.
   */
  let tail = Promise.resolve();
  /** @template T @param {() => Promise<T>} task @returns {Promise<T>} */
  const serial = task => {
    const next = tail.then(task, task);
    tail = next.then(() => {}, () => {});
    return next;
  };
  return {
    mode: 'log',
    file: path,
    // A log has no connection and no journal, so there is no durability posture to
    // report; the field is present so a caller never has to branch on the backend.
    pragmas: null,
    async append(record) {
      await serial(() => appendFile(path, `${JSON.stringify(record)}\n`, 'utf8'));
    },
    async summarize(filter = {}) {
      return summarizeRecords(await readRecords(), filter);
    },
    async upsertNavigationMap(siteId, url, payload) {
      const record = { kind: 'navigation_map', site_id: siteId, url, payload, updated_at: new Date().toISOString() };
      await serial(() => appendFile(path, `${JSON.stringify(record)}\n`, 'utf8'));
    },
    async readNavigationMap(siteId, url) {
      const text = await readFile(path, 'utf8').catch(() => '');
      for (const line of text.split('\n').reverse()) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (record.kind === 'navigation_map' && record.site_id === siteId && record.url === url) {
            return { site_id: siteId, url, payload: record.payload, updated_at: record.updated_at };
          }
        } catch { /* ignore torn and malformed lines */ }
      }
      return null;
    },
    async readLatestNavigationMap(siteId) {
      // The log is append-only and each upsert appends, so the newest map is the
      // last matching line. Scanning backwards also means a torn final line is the
      // only one that can be skipped before a record is found.
      const text = await readFile(path, 'utf8').catch(() => '');
      for (const line of text.split('\n').reverse()) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (record.kind === 'navigation_map' && record.site_id === siteId) {
            return { site_id: siteId, url: record.url, payload: record.payload, updated_at: record.updated_at };
          }
        } catch { /* ignore torn and malformed lines */ }
      }
      return null;
    },
    async consumeQuota(options) {
      const tenantId = String(options.tenant_id);
      const maxEvents = Math.max(1, Math.trunc(Number(options.max_events_per_window)));
      const windowMs = Math.max(1000, Math.trunc(Number(options.window_seconds ?? 3600)) * 1000);
      return serial(async () => {
        const now = Date.now();
        const text = await readFile(path, 'utf8').catch(() => '');
        let prevStart = 0;
        let prevCount = 0;
        let found = false;
        for (const line of text.split('\n').reverse()) {
          if (!line.trim()) continue;
          try {
            const record = JSON.parse(line);
            if (record.kind === 'tenant_quota' && record.tenant_id === tenantId) {
              prevStart = asNumber(record.window_start_ms);
              prevCount = asNumber(record.event_count);
              found = true;
              break;
            }
          } catch { /* ignore torn lines */ }
        }
        const expired = !found || now - prevStart >= windowMs;
        const windowStart = expired ? now : prevStart;
        const currentCount = expired ? 0 : prevCount;
        if (currentCount >= maxEvents) {
          const retryAfterSeconds = Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));
          return { allowed: false, count: currentCount, remaining: 0, retry_after_seconds: retryAfterSeconds };
        }
        const nextCount = currentCount + 1;
        await appendFile(path, `${JSON.stringify({ kind: 'tenant_quota', tenant_id: tenantId, window_start_ms: windowStart, event_count: nextCount })}\n`, 'utf8');
        return { allowed: true, count: nextCount, remaining: Math.max(0, maxEvents - nextCount), retry_after_seconds: 0 };
      });
    },
    async upsertTenantDefinition(definition) {
      const record = normalizeTenantDefinition(definition);
      await serial(() => appendFile(path, `${JSON.stringify({ kind: 'tenant_definition', ...record })}\n`, 'utf8'));
      return record;
    },
    async readTenantDefinition(tenantId) {
      return (await scanLog()).definitions.get(String(tenantId)) ?? null;
    },
    async readTenantDefinitions() {
      return [...(await scanLog()).definitions.values()].sort((left, right) => left.tenant_id.localeCompare(right.tenant_id));
    },
    async recordWebhookEvent(eventId, receivedAtMs) {
      const record = normalizeWebhookEvent(eventId, receivedAtMs);
      // Queued with the appends so a concurrent delivery of the same event cannot
      // read the file before the other one's line has landed.
      return serial(async () => {
        const cutoffMs = Date.now() - WEBHOOK_EVENT_TTL_MS;
        const text = await readFile(path, 'utf8').catch(() => '');
        // The newest line for this id decides: a release withdraws the claim that
        // preceded it, and a claim older than the 24-hour TTL is expired.
        for (const line of text.split('\n').reverse()) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed?.event_id !== record.event_id) continue;
            if (parsed.kind === WEBHOOK_EVENT_KIND) {
              if (asNumber(parsed.received_at_ms) >= cutoffMs) return false;
              break;
            }
            if (parsed.kind === WEBHOOK_EVENT_RELEASE_KIND) break;
          } catch { /* ignore torn and malformed lines */ }
        }
        await appendFile(path, `${JSON.stringify({ kind: WEBHOOK_EVENT_KIND, ...record })}\n`, 'utf8');
        return true;
      });
    },
    async releaseWebhookEvent(eventId) {
      const { event_id: id } = normalizeWebhookEvent(eventId);
      await serial(() => appendFile(path, `${JSON.stringify({ kind: WEBHOOK_EVENT_RELEASE_KIND, event_id: id })}\n`, 'utf8'));
    },
    async applyWebhookEvent(mutation) {
      const eventId = typeof mutation?.event_id === 'string' && mutation.event_id.trim().length > 0
        ? normalizeWebhookEvent(mutation.event_id, mutation.received_at_ms)
        : null;
      const definition = mutation?.definition ? normalizeTenantDefinition(mutation.definition) : null;
      const claim = mutation?.checkout_claim ? normalizeCheckoutClaim(mutation.checkout_claim) : null;
      return serial(async () => {
        const cutoffMs = Date.now() - WEBHOOK_EVENT_TTL_MS;
        if (eventId) {
          const text = await readFile(path, 'utf8').catch(() => '');
          for (const line of text.split('\n').reverse()) {
            if (!line.trim()) continue;
            try {
              const parsed = JSON.parse(line);
              if (parsed?.event_id !== eventId.event_id) continue;
              if (parsed.kind === WEBHOOK_EVENT_KIND) {
                if (asNumber(parsed.received_at_ms) >= cutoffMs) return { duplicate: true, record: null };
                break;
              }
              if (parsed.kind === WEBHOOK_EVENT_RELEASE_KIND) break;
            } catch { /* ignore torn and malformed lines */ }
          }
        }
        /** @type {string[]} */
        const batch = [];
        if (eventId) batch.push(JSON.stringify({ kind: WEBHOOK_EVENT_KIND, ...eventId }));
        if (definition) batch.push(JSON.stringify({ kind: 'tenant_definition', ...definition }));
        if (claim) batch.push(JSON.stringify({ kind: CHECKOUT_CLAIM_KIND, ...claim }));
        if (batch.length > 0) await appendFile(path, `${batch.join('\n')}\n`, 'utf8');
        return { duplicate: false, record: definition };
      });
    },
    async recordCheckoutClaim(claimInput) {
      const claim = normalizeCheckoutClaim(claimInput);
      await serial(() => appendFile(path, `${JSON.stringify({ kind: CHECKOUT_CLAIM_KIND, ...claim })}\n`, 'utf8'));
      return claim;
    },
    async consumeCheckoutClaim(sessionId, nowMs = Date.now()) {
      const id = typeof sessionId === 'string' ? sessionId.trim() : '';
      if (!id) return null;
      const now = Number.isFinite(nowMs) ? Math.trunc(nowMs) : Date.now();
      return serial(async () => {
        const text = await readFile(path, 'utf8').catch(() => '');
        for (const line of text.split('\n').reverse()) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed?.session_id !== id) continue;
            if (parsed.kind === CHECKOUT_CLAIM_CONSUMED_KIND) return null;
            if (parsed.kind === CHECKOUT_CLAIM_KIND) {
              if (asNumber(parsed.expires_at_ms) <= now) return null;
              await appendFile(path, `${JSON.stringify({ kind: CHECKOUT_CLAIM_CONSUMED_KIND, session_id: id })}\n`, 'utf8');
              return { tenant_id: String(parsed.tenant_id), api_key: String(parsed.api_key) };
            }
          } catch { /* ignore torn and malformed lines */ }
        }
        return null;
      });
    },
    async readQuota(tenantId) {
      // The last line for this tenant is the current window: every accepted ingest
      // appends one, so the newest occurrence is the state a scrape or a summary
      // must report. Reading back to front stops at it instead of scanning the file.
      const text = await readFile(path, 'utf8').catch(() => '');
      for (const line of text.split('\n').reverse()) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (record.kind === 'tenant_quota' && record.tenant_id === tenantId) {
            return { tenant_id: String(tenantId), window_start_ms: asNumber(record.window_start_ms), event_count: asNumber(record.event_count) };
          }
        } catch { /* ignore torn lines */ }
      }
      return null;
    },
    async recordViolation(violation) {
      const record = normalizeViolation(violation);
      return serial(async () => {
        // The id is claimed before the append, because the seed reads the file: the
        // id returned here must be the one a later read assigns to this line.
        const id = await nextViolationId();
        // The line is the durable write: it is appended before this resolves, so
        // the caller's 202 means the record survived the process. The id travels in
        // the line so that compaction can keep it.
        await appendFile(path, `${JSON.stringify({ kind: VIOLATION_KIND, id, ...record })}\n`, 'utf8');
        return { id, ...record };
      });
    },
    async queryViolations(filter) {
      const selected = (await readViolations()).filter(violation => violation.tenant_id === filter.tenant_id && violation.created_at >= (filter.since ?? ''));
      const ordered = selected.sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id - left.id);
      return ordered.slice(0, normalizeLimit(filter.limit));
    },
    async pruneViolations(options) {
      const { days, tenant_id } = normalizeRetention(options);
      return serial(async () => {
        try {
          await stat(path);
        } catch {
          // Nothing has been written yet, so there is nothing to compact and no
          // file to create for the sake of a prune.
          return { pruned_count: 0, remaining_count: 0 };
        }
        const cutoff = retentionCutoff(days);
        const temporary = `${path}.compacting`;
        const output = createWriteStream(temporary);
        /** @type {Error | null} */
        let failure = null;
        /** The one pending wait, released by 'drain', 'finish' or 'error'.
         * @type {(() => void) | null} */
        let notify = null;
        const release = () => { const done = notify; notify = null; done?.(); };
        for (const event of ['drain', 'finish']) output.on(event, release);
        output.on('error', error => { failure = error; release(); });
        const wait = () => new Promise(/** @param {(value?: unknown) => void} resolve */ resolve => { notify = () => resolve(); });
        /** @param {string} line */
        const write = async line => {
          if (failure) throw failure;
          if (!output.write(`${line}\n`)) {
            await wait();
            if (failure) throw failure;
          }
        };
        let pruned = 0;
        let kept = 0;
        let keptForTenant = 0;
        let seen = 0;
        let sequence = 0;
        // Keep only each map URL's latest payload while removing superseded snapshots.
        /** @type {Map<string, string>} */
        const navigationMaps = new Map();
        /** @type {Map<string, string>} */
        const quotas = new Map();
        /** @type {Map<string, import('./store-schema.js').TenantDefinitionRecord>} */
        const definitions = new Map();
        /** @type {Map<string, number>} */
        const webhookEvents = new Map();
        /** @type {Map<string, import('./store-schema.js').CheckoutClaimRecord>} */
        const checkoutClaims = new Map();
        const webhookCutoffMs = Date.now() - WEBHOOK_EVENT_TTL_MS;
        const claimNowMs = Date.now();
        try {
          const input = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
          for await (const line of input) {
            if (!line.trim()) continue;
            /** @type {any} */
            let parsed;
            try {
              parsed = JSON.parse(line);
            } catch {
              // Compaction is where a torn line stops being re-read forever.
              continue;
            }
            if (!parsed || typeof parsed !== 'object') continue;
            if (parsed.kind === 'navigation_map') {
              if (typeof parsed.site_id === 'string' && typeof parsed.url === 'string') {
                const key = JSON.stringify([parsed.site_id, parsed.url]);
                // Map#set retains insertion order for an existing key; move it so
                // the last map written before compaction remains last afterward.
                navigationMaps.delete(key);
                navigationMaps.set(key, line);
              }
              continue;
            }
            if (parsed.kind === 'tenant_quota') {
              if (typeof parsed.tenant_id === 'string') quotas.set(parsed.tenant_id, line);
              continue;
            }
            if (parsed.kind === WEBHOOK_EVENT_KIND) {
              const id = typeof parsed.event_id === 'string' ? parsed.event_id.trim() : '';
              const receivedAt = asNumber(parsed.received_at_ms);
              if (id && receivedAt >= webhookCutoffMs) webhookEvents.set(id, receivedAt);
              else if (id) webhookEvents.delete(id);
              continue;
            }
            if (parsed.kind === WEBHOOK_EVENT_RELEASE_KIND) {
              const id = typeof parsed.event_id === 'string' ? parsed.event_id.trim() : '';
              if (id) webhookEvents.delete(id);
              continue;
            }
            if (parsed.kind === CHECKOUT_CLAIM_KIND) {
              const id = typeof parsed.session_id === 'string' ? parsed.session_id.trim() : '';
              const expiresAt = asNumber(parsed.expires_at_ms);
              if (id && expiresAt > claimNowMs) {
                checkoutClaims.set(id, {
                  session_id: id,
                  tenant_id: String(parsed.tenant_id ?? ''),
                  api_key: String(parsed.api_key ?? ''),
                  expires_at_ms: expiresAt
                });
              } else if (id) {
                checkoutClaims.delete(id);
              }
              continue;
            }
            if (parsed.kind === CHECKOUT_CLAIM_CONSUMED_KIND) {
              const id = typeof parsed.session_id === 'string' ? parsed.session_id.trim() : '';
              if (id) checkoutClaims.delete(id);
              continue;
            }
            if (parsed.kind === 'tenant_definition') {
              // Carried into the map and written back below: a prune prunes
              // violations, not the tenants an operator provisioned.
              const definition = toTenantDefinition(parsed);
              if (definition.tenant_id) definitions.set(definition.tenant_id, definition);
              continue;
            }
            if (parsed.kind === STORE_META_KIND) {
              // The old mark is superseded by the one written at the end, which
              // carries whatever this file has seen since.
              sequence = Math.max(sequence, asNumber(parsed.violation_sequence));
              continue;
            }
            if (parsed.kind === VIOLATION_KIND) {
              seen += 1;
              const id = Number.isSafeInteger(parsed.id) && parsed.id > 0 ? Number(parsed.id) : seen;
              sequence = Math.max(sequence, id);
              const expired = String(parsed.created_at ?? '') < cutoff;
              const inScope = tenant_id === null || String(parsed.tenant_id ?? '') === tenant_id;
              if (expired && inScope) { pruned += 1; continue; }
              kept += 1;
              if (inScope) keptForTenant += 1;
              // The id becomes explicit here, so the rows that survive a prune keep
              // the id a reader already holds for them.
              await write(JSON.stringify({ ...parsed, kind: VIOLATION_KIND, id }));
              continue;
            }
            // Aggregates are copied verbatim: compaction prunes violations, not events.
            await write(line);
          }
          // Rewrite each latest-value store once. These snapshots are durable state,
          // not disposable telemetry: dropping them during audit retention would erase
          // the hosted map and reset quota windows on the next restart.
          for (const row of navigationMaps.values()) await write(row);
          for (const row of quotas.values()) await write(row);
          // Definitions come before the meta line because that line describes the
          // file: a crash between the two leaves an unmarked but complete set.
          for (const definition of definitions.values()) {
            await write(JSON.stringify({ kind: 'tenant_definition', ...definition }));
          }
          for (const [event_id, received_at_ms] of webhookEvents.entries()) {
            await write(JSON.stringify({ kind: WEBHOOK_EVENT_KIND, event_id, received_at_ms }));
          }
          for (const claim of checkoutClaims.values()) {
            await write(JSON.stringify({ kind: CHECKOUT_CLAIM_KIND, ...claim }));
          }
          // Written last because it describes everything above it, and only when
          // there is a mark worth keeping: a file of aggregates alone stays as it is.
          if (sequence > 0) await write(JSON.stringify({ kind: STORE_META_KIND, violation_sequence: sequence }));
          const finished = wait();
          output.end();
          await finished;
          if (failure) throw failure;
          // The rename is the commit: a reader sees the old file or the new one.
          await rename(temporary, path);
        } catch (error) {
          output.destroy();
          await rm(temporary, { force: true });
          throw error;
        }
        violationSequence = sequence;
        return { pruned_count: pruned, remaining_count: tenant_id === null ? kept : keptForTenant };
      });
    },
    async checkpoint() {
      // A log has no journal to checkpoint. The shape is answered with zeros so a
      // caller never has to branch on which backend resolved.
      return { busy: 0, log: 0, checkpointed: 0 };
    },
    async reset() {
      await serial(async () => {
        await rm(path, { force: true });
        violationSequence = null;
      });
    },
    async close() {
      // Join queued writes/compaction before the owner can mark its stop clean.
      await tail;
    }
  };
}
