import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { createStore, sqliteAvailable, storeFormat } from '../server/store.js';

/**
 * SQLite on the pinned Node 22 runtime, and the container that has to prove it.
 *
 * The store's preferred backend is `node:sqlite`, which lives behind a runtime
 * capability rather than behind a config flag: it exists from Node 22.5, became
 * importable without `--experimental-sqlite` in Node 22.13, and a runtime can hide
 * it again with `--no-experimental-sqlite`. That makes three things worth asserting
 * rather than assuming - that this runtime really can reach the module, that the
 * backend is chosen by what the store file already *is* rather than by which Node
 * line is running, and that the image and both deployment files carry the flag for
 * the window where it is still load-bearing.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const storeUrl = pathToFileURL(join(root, 'server/store.js')).href;

/** @param {string} [suffix] @returns {Promise<string>} */
const tempDir = async (suffix = '') => mkdtemp(join(tmpdir(), `navi-sqlite${suffix}-`));
/** @param {number} days @returns {string} */
const daysAgo = days => new Date(Date.now() - days * 86400000).toISOString();
/** @returns {any} */
const violation = () => ({ tenant_id: 'tenant-alpha', session_id: 'session-1', category: 'private_ipv4', target_url: 'http://10.0.0.1/', resolved_ip: '10.0.0.1' });

/**
 * Run a snippet in a child of this same Node binary. The runtime is the variable
 * under test, so the child is the only way to hold it at a different setting.
 * @param {string[]} args @param {string} script @returns {{status: number | null, stdout: string, stderr: string}}
 */
function runNode(args, script) {
  const result = spawnSync(process.execPath, [...args, '--input-type=module', '-e', script], { encoding: 'utf8' });
  return { status: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
}

/** Does this runtime accept the flag at all? A runtime that never had it would
 * exit on the option parser with "bad option" before running anything. */
const experimentalFlagSupported = runNode(['--experimental-sqlite'], 'process.exit(0)').status === 0;
/** The negative form is how this spec simulates a runtime without the module. */
const negativeFlagSupported = runNode(['--no-experimental-sqlite'], 'process.exit(0)').status === 0;

test('this runtime can reach node:sqlite, and the store opens a new path as SQLite in WAL mode', async () => {
  test.skip(!(await sqliteAvailable()), `node ${process.versions.node} does not provide node:sqlite, so this runtime is expected to fall back to the log and the WAL assertions do not apply`);
  const directory = await tempDir();
  const file = join(directory, 'telemetry.db');
  const store = await createStore(file);
  try {
    expect(store.mode, 'a runtime that provides node:sqlite must use it for a new store').toBe('sqlite');
    expect(store.pragmas).toMatchObject({ journal_mode: 'wal', synchronous: 1, auto_vacuum: 2 });
    await store.append({ tenant_id: 'tenant-alpha', url_origin: 'https://shop.example.com', actions_indexed: 1, actions_executed: 0, execution_failures: 0, received_at: daysAgo(0) });
    expect(await store.checkpoint({ truncate: false })).toMatchObject({ busy: 0 });
    // A write on a live WAL connection leaves the sidecar behind, which is the
    // observable difference between WAL mode and a rollback journal.
    expect((await stat(`${file}-wal`)).size).toBeGreaterThan(0);
    const header = (await readFile(file)).subarray(0, 16).toString('utf8');
    expect(header, 'the file must be a SQLite database, not a formatted log').toBe('SQLite format 3\u0000');
    expect(header).not.toContain('tenant_id');
  } finally {
    await store.close();
  }
  // Closing checkpoints and lets SQLite remove its sidecars; a clean stop leaves a
  // single file rather than a database plus a journal someone has to reason about.
  await expect(stat(`${file}-wal`)).rejects.toThrow();
  await expect(stat(`${file}-shm`)).rejects.toThrow();
  await rm(directory, { recursive: true, force: true });
});

test('the file decides the backend: a JSONL log is never reopened as a database', async () => {
  const directory = await tempDir();
  const file = join(directory, 'telemetry.db');
  // A log written by an earlier version, holding real records.
  const log = await createStore(file, { mode: 'log' });
  await log.append({ tenant_id: 'tenant-alpha', url_origin: 'https://shop.example.com', actions_indexed: 4, actions_executed: 2, execution_failures: 0, received_at: daysAgo(0) });
  await log.recordViolation(violation());
  await log.close();

  // Resolution is by content, so an upgrade must carry the operator's existing
  // audit trail forward instead of failing the first statement with SQLITE_NOTADB.
  expect(await storeFormat(file)).toBe('jsonl');
  const reopened = await createStore(file);
  try {
    expect(reopened.mode, 'an existing log keeps its backend even where SQLite is available').toBe('log');
    expect((await reopened.summarize()).events).toBe(1);
    expect((await reopened.queryViolations({ tenant_id: 'tenant-alpha' })).length).toBe(1);
  } finally {
    await reopened.close();
  }

  // And the other direction: a database is recognised as one.
  const databaseFile = join(directory, 'database.db');
  const database = await createStore(databaseFile);
  const mode = database.mode;
  await database.close();
  expect(await storeFormat(databaseFile)).toBe(mode === 'sqlite' ? 'sqlite' : 'jsonl');
  expect(await storeFormat(join(directory, 'absent.db'))).toBe('missing');
  const empty = join(directory, 'empty.db');
  await writeFile(empty, '');
  // Zero bytes is not a format: SQLite opens an empty file as an empty database,
  // and a log that was never appended to is a log, so neither can lose data.
  expect(await storeFormat(empty)).toBe('empty');
  await rm(directory, { recursive: true, force: true });
});

test('a runtime with node:sqlite hidden refuses a database instead of reading it as an empty log', async () => {
  test.skip(!(await sqliteAvailable()), `node ${process.versions.node} has no node:sqlite to hide, so there is no positive control for this test`);
  test.skip(!negativeFlagSupported, 'this runtime does not accept --no-experimental-sqlite, so it cannot be held at that setting here');
  const directory = await tempDir();
  /**
   * Open a path through the shipped store in a child process, optionally writing
   * first. The child is the whole point: the capability under test belongs to the
   * runtime, and only a process can be started without it.
   * @param {boolean} write @param {string} path @returns {string}
   */
  const childScript = (write, path) => `
    const { createStore } = await import(${JSON.stringify(storeUrl)});
    try {
      const store = await createStore(${JSON.stringify(path)});
      ${write ? "await store.append({ tenant_id: 'tenant-alpha', url_origin: 'https://shop.example.com', actions_indexed: 1, actions_executed: 0, execution_failures: 0, received_at: new Date().toISOString() });" : ''}
      console.log('opened:' + store.mode);
      await store.close();
    } catch (error) {
      console.error('refused:' + error.message);
      process.exit(3);
    }
  `;
  // Positive control: an ordinary child on this runtime reaches SQLite, so a
  // failure below is about the hidden module and not about the snippet.
  const databaseFile = join(directory, 'created.db');
  const created = runNode(experimentalFlagSupported ? ['--experimental-sqlite'] : [], childScript(true, databaseFile));
  expect(created.status, `the setup child failed: ${created.stderr}`).toBe(0);
  expect(created.stdout.trim()).toBe('opened:sqlite');
  expect(await storeFormat(databaseFile)).toBe('sqlite');

  // The same path, opened by a runtime that cannot see the module. Reading it as a
  // log would answer "no violations" rather than "wrong runtime", which is the one
  // outcome an audit trail must never produce.
  const hidden = runNode(['--no-experimental-sqlite'], childScript(false, databaseFile));
  expect(hidden.status, `a database must not be opened as a log: ${hidden.stdout}`).not.toBe(0);
  expect(hidden.stderr).toContain('SQLite database');
  expect(hidden.stderr).toContain('node:sqlite');
  expect(hidden.stdout).not.toContain('opened:log');

  // A path with nothing in it still degrades to the log rather than failing, so a
  // runtime that lost the module keeps serving new deployments.
  const fresh = runNode(['--no-experimental-sqlite'], childScript(false, join(directory, 'fresh.db')));
  expect(fresh.status, `a fresh path must still be served: ${fresh.stderr}`).toBe(0);
  expect(fresh.stdout.trim()).toBe('opened:log');
  await rm(directory, { recursive: true, force: true });
});

test('the image and both deployment files carry the flag, and the base is the pinned Node 22 line', async () => {
  expect(experimentalFlagSupported, `${process.version} rejects --experimental-sqlite, so the flag this repository ships would be a syntax error on it`).toBe(true);
  const dockerfile = await readFile(join(root, 'Dockerfile'), 'utf8');
  const base = /^FROM (node:(\d+)[^\s@]*)(?:@(\S+))? AS base$/m.exec(dockerfile);
  expect(base, 'the base stage must be a pinned node image').toBeTruthy();
  expect(base?.[2], 'the pinned base must be the Node 22 line').toBe('22');
  expect(base?.[3], 'the base must be pinned by digest, not by tag alone').toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(dockerfile, 'the image must declare the flag NODE_OPTIONS reaches the service with').toMatch(/^ENV NODE_OPTIONS="--experimental-sqlite"$/m);

  for (const file of ['docker-compose.yml', 'deploy/docker-compose.prod.yml']) {
    const compose = parse(await readFile(join(root, file), 'utf8'));
    const services = Object.entries(compose.services ?? {});
    expect(services.length, `${file} must define services`).toBeGreaterThan(0);
    const names = services.map(([name]) => name);
    expect(names, `${file} must define both roles`).toEqual(['navi-host', 'navi-mcp']);
    for (const [name, service] of services) {
      // Per service, not on the shared anchor: a YAML merge replaces the whole
      // `environment` mapping, so an anchor-level copy would be silently dropped.
      expect(service.environment?.NODE_OPTIONS, `${file}: ${name} must declare NODE_OPTIONS`).toBe('--experimental-sqlite');
      expect(service.environment?.NAVI_MODE, `${file}: ${name} must select its role`).toBeDefined();
    }
  }
});

test('the container verification recorded the image serving SQLite in WAL mode', async () => {
  const receipt = JSON.parse(await readFile(join(root, 'reports/container-verification.json'), 'utf8'));
  expect(receipt.ok, 'the recorded container verification must have passed').toBe(true);
  const check = (receipt.checks ?? []).find((/** @type {any} */ candidate) => candidate.check === 'sqlite-store');
  expect(check, 'the container verification must record the store backend it observed').toBeTruthy();
  expect(check.ok).toBe(true);
  expect(check.detail, 'the detail must name the backend and the sidecar it observed').toMatch(/sqlite/i);
  expect(check.detail).toMatch(/-wal/);
});
