import { test, expect } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * The edge schema is executed, not read.
 *
 * `deploy/supabase-schema.sql` is applied by hand, and the three functions at the end
 * are the whole write path for the Worker — so a test that greps the file proves
 * syntax, not behaviour. This file starts a throwaway PostgreSQL cluster, applies the
 * schema twice (idempotency is a promise the file makes), and drives the functions
 * directly: a duplicate delivery, a transaction that aborts, a one-time claim, and
 * the quota charge under real row locks with genuinely concurrent callers.
 *
 * The cluster is local and disposable. When no server binaries are installed the
 * behavioural tests skip with that reason rather than passing quietly; the static
 * contract in `release-pipeline.spec.mjs` still runs everywhere.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const schemaPath = join(root, 'deploy', 'supabase-schema.sql');

/**
 * Find a PostgreSQL server binary: on PATH first, then the packaged locations a
 * distro or Homebrew installs the server into without linking it.
 * @param {string} name
 * @returns {string | null}
 */
function findBinary(name) {
  /** @type {string[]} */
  const directories = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const prefix of ['/usr/lib/postgresql', '/opt/homebrew/opt', '/usr/local/opt']) {
    try {
      for (const entry of readdirSync(prefix)) {
        if (prefix === '/usr/lib/postgresql' || entry.startsWith('postgresql')) directories.push(join(prefix, entry, 'bin'));
      }
    } catch { /* the prefix does not exist on this host */ }
  }
  for (const directory of directories) {
    const candidate = join(directory, process.platform === 'win32' ? `${name}.exe` : name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const initdb = findBinary('initdb');
const pgCtl = findBinary('pg_ctl');
const psqlBin = findBinary('psql');
const postgres = initdb && pgCtl && psqlBin;

// A postmaster needs a valid locale; without one it aborts as "became multithreaded".
const env = { ...process.env, LC_ALL: 'C', LANG: 'C' };

test.skip(!postgres, 'no PostgreSQL server binaries (initdb, pg_ctl, psql) on this host');

/** @type {{dataDir: string, socketDir: string, port: number}} */
let cluster;
/** @type {string[]} */
let connection;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  const dataDir = await mkdtemp(join(tmpdir(), 'navi-schema-pg-'));
  const socketDir = await mkdtemp(join(tmpdir(), 'navi-schema-sock-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  execFileSync(/** @type {string} */ (initdb), ['-D', dataDir, '-U', 'postgres', '--auth=trust'], { env, stdio: 'pipe' });
  execFileSync(/** @type {string} */ (pgCtl), [
    '-D', dataDir,
    '-o', `-p ${port} -k ${socketDir} -c listen_addresses=''`,
    '-l', join(dataDir, 'server.log'),
    '-w', 'start'
  ], { env, stdio: 'pipe' });
  cluster = { dataDir, socketDir, port };
  connection = ['-h', socketDir, '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'];
  // The roles Supabase projects have, without BYPASSRLS: the point is to prove the
  // grants and the service_role policy carry the Worker, not that a superuser can
  // read past them.
  run("create role anon nologin; create role authenticated nologin; create role service_role nologin;");
  applySchema();
});

test.afterAll(async () => {
  if (!cluster) return;
  try { execFileSync(/** @type {string} */ (pgCtl), ['-D', cluster.dataDir, '-m', 'immediate', '-w', 'stop'], { env, stdio: 'pipe' }); } catch { /* already down */ }
  await rm(cluster.dataDir, { recursive: true, force: true });
  await rm(cluster.socketDir, { recursive: true, force: true });
});

/**
 * @param {string} sql
 * @param {{allowFailure?: boolean}} [options]
 * @returns {string}
 */
function run(sql, options = {}) {
  try {
    return execFileSync(/** @type {string} */ (psqlBin), [...connection, '-c', sql], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    if (options.allowFailure) return `ERROR: ${String(/** @type {any} */ (error).stderr ?? error).trim().split('\n')[0]}`;
    throw error;
  }
}

/**
 * As `run`, but concurrent with the other calls in the same `Promise.all`.
 * @param {string} sql
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string}>}
 */
function runAsync(sql) {
  return new Promise(resolve => {
    const child = spawn(/** @type {string} */ (psqlBin), [...connection, '-c', sql], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (/** @type {Buffer} */ chunk) => { stdout += chunk; });
    child.stderr.on('data', (/** @type {Buffer} */ chunk) => { stderr += chunk; });
    child.on('close', () => resolve({ ok: child.exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

function applySchema() {
  execFileSync(/** @type {string} */ (psqlBin), [...connection, '-f', schemaPath], { env, stdio: 'pipe' });
}

/**
 * The JSON a function returned, decoded.
 * @param {string} sql
 * @returns {any}
 */
const json = sql => JSON.parse(run(sql));

test.beforeEach(() => {
  // Every test starts from an empty ledger and no tenants, so a count asserts this
  // test's writes rather than the file's history.
  run('truncate public.navigation_maps, public.webhook_events, public.checkout_claims, public.sites;');
});

test('the schema applies twice without error and leaves the tables, policies and grants it promises', () => {
  // Idempotency is the migration story: this file is the upgrade path for a live
  // project, so a second run must change nothing and fail at nothing.
  applySchema();
  applySchema();

  const tables = run("select string_agg(tablename, ',' order by tablename) from pg_tables where schemaname = 'public';");
  expect(tables).toBe('checkout_claims,navigation_maps,sites,webhook_events');
  const protectedTables = run("select string_agg(tablename, ',' order by tablename) from pg_tables where schemaname = 'public' and rowsecurity;");
  expect(protectedTables).toBe('checkout_claims,navigation_maps,sites,webhook_events');

  // The claim expiry is a timestamp: the prune and the one-time read compare it to
  // `now()`, and a millisecond integer cannot answer that comparison.
  const claimColumns = run("select string_agg(column_name, ',' order by column_name) from information_schema.columns where table_schema = 'public' and table_name = 'checkout_claims';");
  expect(claimColumns).toBe('api_key,expires_at,session_id,tenant_id');

  // Functions are executable by PUBLIC until that is revoked, so this is the check
  // that the revocation happened rather than being assumed.
  const privileges = run("select p.proname || ':' || has_function_privilege('anon', p.oid, 'execute') || ':' || has_function_privilege('authenticated', p.oid, 'execute') || ':' || has_function_privilege('service_role', p.oid, 'execute') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' order by p.proname;");
  expect(privileges).toBe([
    'apply_stripe_webhook:false:false:true',
    'claim_checkout_session:false:false:true',
    'consume_site_quota:false:false:true'
  ].join('\n'));

  // One shape per function, not an overload set: `create or replace` with a new
  // argument list adds a function, so the file drops the previous signature itself.
  const overloads = run("select p.proname || ':' || count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' group by p.proname order by p.proname;");
  expect(overloads).toBe(['apply_stripe_webhook:1', 'claim_checkout_session:1', 'consume_site_quota:1'].join('\n'));

  // And the public role cannot reach a table either, while the service role can.
  expect(run('set role anon; select count(*) from public.sites;', { allowFailure: true })).toContain('permission denied');
  expect(run('set role service_role; select count(*) from public.sites;')).toBe('0');
  expect(run("set role anon; select public.claim_checkout_session('cs_x');", { allowFailure: true })).toContain('permission denied');
});

test('one webhook transaction claims the event, writes the tenant and stores the checkout claim', () => {
  const first = json(`select public.apply_stripe_webhook('evt_1', 'acme', 'navi_live_a', '["https://app.example.com"]'::jsonb, 2, 60, true, 'cs_1', now() + interval '15 minutes')::text;`);
  expect(first).toEqual({ duplicate: false, tenant_id: 'acme', api_key: 'navi_live_a' });
  expect(run("select id || ':' || api_key || ':' || array_to_string(allowed_origins, '|') || ':' || max_events_per_window || ':' || window_seconds from public.sites;")).toBe('acme:navi_live_a:https://app.example.com:2:60');
  expect(run("select count(*) from public.webhook_events where event_id = 'evt_1';")).toBe('1');
  expect(run("select count(*) from public.checkout_claims where session_id = 'cs_1';")).toBe('1');

  // A redelivery is answered before any tenant row is touched: the second call
  // carries a different key and must not rotate the one already handed out.
  const duplicate = json(`select public.apply_stripe_webhook('evt_1', 'acme', 'navi_live_rotated', null, 99, 99, true)::text;`);
  expect(duplicate).toEqual({ duplicate: true });
  expect(run("select api_key || ':' || max_events_per_window from public.sites;")).toBe('navi_live_a:2');
  expect(run("select count(*) from public.webhook_events where event_id = 'evt_1';")).toBe('1');

  // An event this deployment ignores records its id and nothing else, so its
  // resend is still a no-op.
  expect(json(`select public.apply_stripe_webhook('evt_ignored', null, null, null, null, null, null)::text;`)).toEqual({ duplicate: false, ignored: true });
  expect(json(`select public.apply_stripe_webhook('evt_ignored', null, null, null, null, null, null)::text;`)).toEqual({ duplicate: true });
});

test('an update without a key or an origin list preserves both, and a cancellation only zeroes the ceiling', () => {
  run(`select public.apply_stripe_webhook('evt_1', 'acme', 'navi_live_a', '["https://app.example.com"]'::jsonb, 50, 600, true);`);

  // A subscription update that omits the credential keeps it, and an event that
  // carries no origin list must not widen a restriction to `*`.
  const update = json(`select public.apply_stripe_webhook('evt_2', 'acme', null, null, 75, null, true)::text;`);
  expect(update).toEqual({ duplicate: false, tenant_id: 'acme', api_key: 'navi_live_a' });
  expect(run("select api_key || ':' || array_to_string(allowed_origins, '|') || ':' || max_events_per_window || ':' || window_seconds from public.sites;")).toBe('navi_live_a:https://app.example.com:75:600');

  // An upgrade to an unmetered plan passes NULL for p_max_events alongside a non-null
  // p_window_seconds, clearing the ceiling to NULL rather than keeping the old one.
  expect(json(`select public.apply_stripe_webhook('evt_2b', 'acme', null, null, null, 2592000, true)::text;`).api_key).toBe('navi_live_a');
  expect(run("select coalesce(max_events_per_window::text, 'NULL') || ':' || window_seconds from public.sites where id = 'acme';")).toBe('NULL:2592000');

  // Cancellation: the ceiling becomes 0 and nothing else moves.
  expect(json(`select public.apply_stripe_webhook('evt_3', 'acme', null, null, 0, null, true)::text;`).api_key).toBe('navi_live_a');
  expect(run("select api_key || ':' || array_to_string(allowed_origins, '|') || ':' || max_events_per_window from public.sites;")).toBe('navi_live_a:https://app.example.com:0');

  // A cancellation for a tenant that does not exist must not mint a credential.
  expect(json(`select public.apply_stripe_webhook('evt_4', 'ghost', null, null, 0, null, true)::text;`)).toEqual({ duplicate: false, tenant_id: 'ghost', missing: true, api_key: null });
  expect(run("select count(*) from public.sites where id = 'ghost';")).toBe('0');
});

test('a candidate key mints on insert and never rotates the row it conflicts with', () => {
  // This is what lets the Worker provision without reading the site first: the key it
  // generated is only ever used by the insert branch, so a retry or a subscription
  // update cannot replace the credential a live page is already embedding.
  const created = json(`select public.apply_stripe_webhook('evt_c1', 'fresh', null, '["https://app.example.com"]'::jsonb, 10, 60, true, null, null, 'navi_live_candidate')::text;`);
  expect(created).toEqual({ duplicate: false, tenant_id: 'fresh', api_key: 'navi_live_candidate' });
  expect(run("select api_key from public.sites where id = 'fresh';")).toBe('navi_live_candidate');

  const updated = json(`select public.apply_stripe_webhook('evt_c2', 'fresh', null, null, 20, null, true, null, null, 'navi_live_other')::text;`);
  expect(updated).toEqual({ duplicate: false, tenant_id: 'fresh', api_key: 'navi_live_candidate' });
  expect(run("select api_key || ':' || max_events_per_window from public.sites where id = 'fresh';")).toBe('navi_live_candidate:20');

  // An explicit key is an instruction rather than an omission, so it still sets the key.
  expect(json(`select public.apply_stripe_webhook('evt_c3', 'fresh', 'navi_live_explicit', null, 20, null, true)::text;`).api_key).toBe('navi_live_explicit');
});

test('a webhook that fails mid-transaction leaves neither the event id nor the tenant behind', () => {
  // The ceiling constraint rejects this after the ledger insert and before the
  // commit. Both effects must vanish together: a claim without its tenant is
  // exactly the crash window this function exists to close.
  const failed = run(`select public.apply_stripe_webhook('evt_bad', 'broken', 'navi_live_c', '["*"]'::jsonb, -5, 60, true);`, { allowFailure: true });
  expect(failed).toContain('ERROR');
  expect(run("select count(*) from public.webhook_events where event_id = 'evt_bad';")).toBe('0');
  expect(run("select count(*) from public.sites where id = 'broken';")).toBe('0');

  // A unique-key violation on the tenant write is the same story: the ledger insert
  // in front of it is rolled back with it.
  run(`select public.apply_stripe_webhook('evt_bad2', 'broken', 'navi_live_c', '["*"]'::jsonb, 10, 60, true, 'cs_dup', now() + interval '15 minutes');`);
  const duplicateKey = run(`select public.apply_stripe_webhook('evt_bad3', 'other', 'navi_live_c', '["*"]'::jsonb, 10, 60, true);`, { allowFailure: true });
  expect(duplicateKey, 'the api key index must refuse a second tenant on the same key').toContain('ERROR');
  expect(run("select count(*) from public.webhook_events where event_id = 'evt_bad3';")).toBe('0');
  expect(run("select count(*) from public.sites;")).toBe('1');

  // The same transaction still works after those failures, which is what makes the
  // resend Stripe sends safe to process.
  expect(json(`select public.apply_stripe_webhook('evt_bad', 'broken', 'navi_live_c', '["*"]'::jsonb, 5, 60, true)::text;`)).toEqual({ duplicate: false, tenant_id: 'broken', api_key: 'navi_live_c' });
});

test('the checkout claim is consumed exactly once, and an expired one is refused', () => {
  run(`select public.apply_stripe_webhook('evt_1', 'acme', 'navi_live_a', '["*"]'::jsonb, 10, 60, true, 'cs_live', now() + interval '15 minutes');`);

  expect(json(`select public.claim_checkout_session('cs_live')::text;`)).toEqual({ ok: true, tenant_id: 'acme', api_key: 'navi_live_a' });
  expect(json(`select public.claim_checkout_session('cs_live')::text;`)).toEqual({ ok: false });
  expect(run("select count(*) from public.checkout_claims;")).toBe('0');

  // Unknown and empty ids are the same answer, not an error and not a read.
  expect(json(`select public.claim_checkout_session('cs_missing')::text;`)).toEqual({ ok: false });
  expect(json(`select public.claim_checkout_session('')::text;`)).toEqual({ ok: false });
  expect(json(`select public.claim_checkout_session(null)::text;`)).toEqual({ ok: false });

  // An expired claim is pruned by the call rather than being handed out late.
  run(`select public.apply_stripe_webhook('evt_2', 'acme', 'navi_live_a', null, 10, 60, true, 'cs_stale', now() - interval '1 second');`);
  expect(json(`select public.claim_checkout_session('cs_stale')::text;`)).toEqual({ ok: false });
  expect(run("select count(*) from public.checkout_claims;")).toBe('0');
});

test('concurrent readers of one session id see at most one success', async () => {
  run(`select public.apply_stripe_webhook('evt_1', 'acme', 'navi_live_a', '["*"]'::jsonb, 10, 60, true, 'cs_race', now() + interval '15 minutes');`);
  // Genuinely concurrent connections: a read-then-delete would let several of these
  // hand the same key to different callers, which is the bug this function closes.
  const results = await Promise.all(Array.from({ length: 8 }, () => runAsync("select public.claim_checkout_session('cs_race')::text;")));
  const granted = results.filter(result => result.ok && result.stdout.includes('"ok": true'));
  expect(granted).toHaveLength(1);
  expect(granted[0].stdout).toContain('navi_live_a');
  expect(results.every(result => result.ok), results.map(result => result.stderr).join('; ')).toBe(true);
});

test('the quota charge is serialised, refuses a forbidden origin for free and rolls its window', async () => {
  run(`select public.apply_stripe_webhook('evt_1', 'acme', 'navi_live_a', '["https://app.example.com"]'::jsonb, 2, 60, true);`);

  // A forbidden origin costs nothing: the check happens before the increment.
  expect(json(`select public.consume_site_quota('navi_live_a', 1000, 'https://evil.example.com', null)::text;`)).toMatchObject({ found: true, forbidden: true, allowed: false });
  expect(json(`select public.consume_site_quota('navi_live_a', 1000, 'https://app.example.com', 'https://evil.example.com')::text;`)).toMatchObject({ forbidden: true, allowed: false });
  expect(run("select event_count from public.sites;")).toBe('0');

  // A matching origin is charged, and the allowance is reported from the same row.
  expect(json(`select public.consume_site_quota('navi_live_a', 1000, 'https://app.example.com', null)::text;`)).toMatchObject({ found: true, forbidden: false, allowed: true, limit: 2, remaining: 1 });
  expect(json(`select public.consume_site_quota('navi_live_a', 1001, 'https://app.example.com', null)::text;`)).toMatchObject({ allowed: true, remaining: 0 });
  const exhausted = json(`select public.consume_site_quota('navi_live_a', 1030, 'https://app.example.com', null)::text;`);
  expect(exhausted).toMatchObject({ allowed: false, limit: 2, remaining: 0 });
  // 30 seconds into a 60-second window that opened at t=1000: the ceiling is spent and
  // the answer says how long until it reopens, rounded up so it is never optimistic.
  expect(exhausted.retry_after_seconds).toBe(60);
  expect(run("select event_count from public.sites;")).toBe('2');

  // Past the window the next event opens a fresh one at 1 instead of carrying the
  // exhausted count across the boundary.
  expect(json(`select public.consume_site_quota('navi_live_a', 1000 + 60_000, 'https://app.example.com', null)::text;`)).toMatchObject({ allowed: true, remaining: 1 });
  expect(run("select event_count from public.sites;")).toBe('1');

  // A ceiling of 0 is a suspension: it refuses and says so, rather than reading as
  // unmetered, and it does not move the counter.
  run(`select public.apply_stripe_webhook('evt_2', 'acme', null, null, 0, null, true);`);
  expect(json(`select public.consume_site_quota('navi_live_a', 500000, 'https://app.example.com', null)::text;`)).toMatchObject({ allowed: false, limit: 0, remaining: 0, retry_after_seconds: 60 });

  // An unknown key is not a tenant.
  expect(json(`select public.consume_site_quota('nope', 1, null, null)::text;`)).toEqual({ found: false });
});

test('the map write commits with the charge and rolls back with it', () => {
  run(`select public.apply_stripe_webhook('evt_1', 'acme', 'navi_live_a', '["https://app.example.com"]'::jsonb, 2, 60, true);`);

  // One call charges the event and stores the map it was handed.
  expect(json(`select public.consume_site_quota('navi_live_a', 1000, 'https://app.example.com', null, 'https://app.example.com/checkout', '{"url":"https://app.example.com/checkout","actions":[]}'::jsonb)::text;`)).toMatchObject({ allowed: true, remaining: 1 });
  expect(run("select payload->>'url' from public.navigation_maps where url = 'https://app.example.com/checkout';")).toBe('https://app.example.com/checkout');
  expect(run('select event_count from public.sites;')).toBe('1');

  // A second event for the same URL replaces the stored map rather than appending.
  run(`select public.consume_site_quota('navi_live_a', 1001, 'https://app.example.com', null, 'https://app.example.com/checkout', '{"url":"https://app.example.com/checkout","actions":[{"name":"Pay"}]}'::jsonb);`);
  expect(run('select count(*) from public.navigation_maps;')).toBe('1');
  expect(run("select payload->'actions'->0->>'name' from public.navigation_maps;")).toBe('Pay');

  // A refused event stores nothing: the ceiling is spent, so the map never lands.
  expect(json(`select public.consume_site_quota('navi_live_a', 1002, 'https://app.example.com', null, 'https://app.example.com/refused', '{"url":"https://app.example.com/refused"}'::jsonb)::text;`)).toMatchObject({ allowed: false });
  expect(run("select count(*) from public.navigation_maps where url = 'https://app.example.com/refused';")).toBe('0');

  // A storage failure aborts the call, so the charge goes with it. Without the
  // single transaction the tenant would be billed for an event that was not stored.
  run("alter table public.navigation_maps add constraint navi_storage_probe check (url <> 'https://boom.example');");
  const before = run('select event_count from public.sites;');
  const failed = run(`select public.consume_site_quota('navi_live_a', 61002, 'https://app.example.com', null, 'https://boom.example', '{"url":"https://boom.example"}'::jsonb);`, { allowFailure: true });
  expect(failed).toContain('ERROR');
  expect(run('select event_count from public.sites;'), 'a failed storage write must take the charge with it').toBe(before);
  expect(run("select count(*) from public.navigation_maps where url = 'https://boom.example';")).toBe('0');
  run('alter table public.navigation_maps drop constraint navi_storage_probe;');

  // The same call succeeds once the failure is gone, so nothing is left poisoned.
  expect(json(`select public.consume_site_quota('navi_live_a', 61003, 'https://app.example.com', null, 'https://app.example.com/after', '{"url":"https://app.example.com/after"}'::jsonb)::text;`)).toMatchObject({ allowed: true });
  expect(run("select count(*) from public.navigation_maps where url = 'https://app.example.com/after';")).toBe('1');
});

test('concurrent charges admit exactly the ceiling, never more', async () => {
  run(`select public.apply_stripe_webhook('evt_1', 'acme', 'navi_live_a', '["*"]'::jsonb, 3, 60, true);`);
  // Eight isolates charging at once against a ceiling of three. Without the row
  // lock every caller reads 0 and the tenant gets eight events for three.
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => runAsync(`select public.consume_site_quota('navi_live_a', ${10_000 + index}, 'https://shop.example', null)::text;`)));
  expect(results.every(result => result.ok), results.map(result => result.stderr).join('; ')).toBe(true);
  const granted = results.filter(result => result.stdout.includes('"allowed": true'));
  expect(granted).toHaveLength(3);
  expect(run("select event_count from public.sites;")).toBe('3');
});

test('unmetered tenants are never charged and the ledger is pruned to 24 hours', () => {
  run(`select public.apply_stripe_webhook('evt_1', 'free', 'navi_live_free', '["*"]'::jsonb, null, null, true);`);
  expect(json(`select public.consume_site_quota('navi_live_free', 1, 'https://shop.example', null)::text;`)).toMatchObject({ found: true, allowed: true, limit: null });
  expect(run("select coalesce(event_count, 0) from public.sites;")).toBe('0');

  // The replay window is 300 seconds, so a day is already generous: an older row
  // cannot deduplicate anything and only makes the table grow under traffic.
  run("insert into public.webhook_events (event_id, received_at) values ('ancient', now() - interval '25 hours'), ('recent', now() - interval '23 hours');");
  run(`select public.apply_stripe_webhook('evt_next', null, null, null, null, null, null);`);
  expect(run("select string_agg(event_id, ',' order by event_id) from public.webhook_events;")).toBe('evt_1,evt_next,recent');
});
