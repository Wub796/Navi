import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Production deployment checks.
 *
 * The deploy files are the part of this repository that cannot be exercised by
 * running the application: they are read by a container runtime, on a host, by someone
 * who may never read this tree. So they are held to two standards at once.
 *
 * The first is a tripwire. Every hardening decision - the non-root user, the dropped
 * capabilities, the read-only root, the volume the telemetry store lives on, the health
 * probe each service answers - is asserted against the file text, so deleting one is a
 * failing test rather than a silent weakening of a deployment nobody re-reads.
 *
 * The second is real. A tripwire passes on a file that says the right words in the
 * wrong place, so where a tool exists that actually parses the file, this suite uses
 * it: `docker compose config` resolves the file the way the daemon will, and the
 * assertions run against that resolution rather than against the source. The seccomp
 * profile is loaded as JSON and the paths each config references are resolved, because
 * a deployment file's most common defect is a path that looks right in one directory
 * and is wrong from another.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const deployDir = join(root, 'deploy');
const composePath = join(deployDir, 'docker-compose.prod.yml');
const flyPath = join(deployDir, 'fly.toml');
/** The variables the production files refuse to start without. */
const requiredEnv = { NAVI_IMAGE: 'navi:local', NAVI_TENANTS: 'key:tenant-a', NAVI_MCP_TOKEN: 'test-only-token' };
/** @param {string[]} args @returns {any} */
const docker = args => JSON.parse(execFileSync('docker', args, { encoding: 'utf8', env: { ...process.env, ...requiredEnv }, stdio: ['ignore', 'pipe', 'pipe'] }));
const composeAvailable = (() => {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
/**
 * A deployment file without its comments. Every structural assertion below runs on
 * this rather than on the raw text, for two reasons: a comment must never be able to
 * satisfy a security invariant ("runs as pwuser" is not a setting), and a comment
 * explaining why the sandbox is kept - which necessarily names the flag it refuses to
 * pass - must not read as an occurrence of that flag.
 * @param {string} text
 */
const withoutComments = text => text.split('\n').filter(line => !/^\s*#/.test(line)).join('\n');

test('the production compose file keeps least privilege, persistence and both health probes', async () => {
  const compose = withoutComments(await readFile(composePath, 'utf8'));
  // Two services over one image: the host API and the MCP bridge, selected by the
  // entrypoint's NAVI_MODE rather than by two different artifacts.
  expect(compose).toMatch(/^services:/m);
  expect(compose).toMatch(/^\s+navi-host:/m);
  expect(compose).toMatch(/^\s+navi-mcp:/m);
  expect(compose).toMatch(/NAVI_MODE: host/);
  expect(compose).toMatch(/NAVI_MODE: mcp/);
  // The non-root account is named as well as inherited, so a base-image change to the
  // default user cannot start either service as root without failing this test.
  expect(compose).toMatch(/user: '1000:1000'/);
  expect(compose).toMatch(/cap_drop: \[ALL\]/);
  expect(compose).toMatch(/security_opt: \[no-new-privileges:true\]/);
  expect(compose).toMatch(/read_only: true/);
  // A writable /tmp tmpfs is the only extra filesystem either process gets.
  expect(compose).toMatch(/\/tmp:rw,nosuid,nodev,size=256m,mode=1777/);
  expect(compose).toMatch(/pids_limit: 256/);
  // The telemetry store lives on a named volume, and the mount is the directory rather
  // than the file: the JSONL backend writes one file, a SQLite backend writes -wal and
  // -shm companions beside it, and mounting a single file would lose them.
  expect(compose).toMatch(/NAVI_STORE: \/data\/telemetry\.db/);
  expect(compose).toMatch(/telemetry:\/data/);
  expect(compose).toMatch(/^\s+telemetry:$/m);
  // Each service probes its own listener, and the probe names the port rather than
  // deriving it, so a service redeployed onto another port fails instead of passing.
  expect(compose).toMatch(/127\.0\.0\.1:3000\/healthz/);
  expect(compose).toMatch(/127\.0\.0\.1:3001\/healthz/);
  // Published to loopback only unless the operator says otherwise.
  expect(compose).toMatch(/\$\{NAVI_BIND_ADDRESS:-127\.0\.0\.1\}:3000:3000/);
  expect(compose).toMatch(/\$\{NAVI_BIND_ADDRESS:-127\.0\.0\.1\}:3001:3001/);
  // Required values fail loudly when unset rather than defaulting to something weak.
  expect(compose).toMatch(/\$\{NAVI_IMAGE:\?/);
  expect(compose).toMatch(/\$\{NAVI_TENANTS:\?/);
  expect(compose).toMatch(/\$\{NAVI_MCP_TOKEN:\?/);
  // Chromium keeps its sandbox: the renderer needs the vendored profile, and no
  // deployment file may disable the sandbox instead.
  expect(compose).toMatch(/seccomp=\.\.\/security\/chromium-seccomp\.json/);
  for (const [name, forbidden] of [
    ['a sandbox-disable flag', /--no-sandbox|--disable-[a-z-]*sandbox/],
    ['privileged mode', /privileged:\s*true/],
    ['the Docker socket', /docker\.sock/],
    ['host networking', /network_mode:\s*host/],
    ['host PID namespace', /pid:\s*host/],
    ['host IPC namespace', /ipc:\s*host/]
  ]) {
    expect(compose, `${name} must not appear in a production deployment`).not.toMatch(forbidden);
  }
});

test('the deployment files agree on the store path, and every path they reference resolves', async () => {
  const compose = withoutComments(await readFile(composePath, 'utf8'));
  const fly = withoutComments(await readFile(flyPath, 'utf8'));
  // The seccomp profile is read by the daemon from the host filesystem, relative to the
  // compose file's directory - the classic way a hardened deployment silently becomes a
  // broken one is a path that is right from the repository root and wrong from deploy/.
  const profilePath = resolve(deployDir, '../security/chromium-seccomp.json');
  expect(existsSync(profilePath), `the seccomp profile the compose file names must exist at ${profilePath}`).toBe(true);
  const profile = JSON.parse(await readFile(profilePath, 'utf8'));
  expect(profile.defaultAction).toBe('SCMP_ACT_ERRNO');
  // Both deployments keep the store at the same absolute path, so moving an operator
  // between them is a deployment change rather than a data migration.
  expect(fly).toMatch(/NAVI_STORE = "\/data\/telemetry\.db"/);
  expect(fly).toMatch(/destination = "\/data"/);
  expect(compose).toMatch(/NAVI_STORE: \/data\/telemetry\.db/);
  // The mode values the compose file sets are the ones the entrypoint actually accepts:
  // a typo here is a container that exits 2 at start rather than one that runs a service.
  const entrypoint = await readFile(join(root, 'scripts/docker-entrypoint.sh'), 'utf8');
  for (const mode of ['host', 'mcp']) {
    expect(compose).toMatch(new RegExp(`NAVI_MODE: ${mode}\\b`));
    expect(entrypoint).toMatch(new RegExp(`^\\s{2}${mode}\\)`, 'm'));
  }
  // Fly runs two process groups from one image, and each names a real entry point in
  // this tree rather than a command that has to be assembled by hand.
  const hostCommand = /^\s+host = "node (server\/index\.js) /m.exec(fly);
  const mcpCommand = /^\s+mcp = "node (bin\/navi-mcp\.js) --transport sse/m.exec(fly);
  expect(hostCommand?.[1], 'the host process group must start server/index.js').toBe('server/index.js');
  expect(mcpCommand?.[1], 'the MCP process group must start bin/navi-mcp.js with the SSE transport').toBe('bin/navi-mcp.js');
  for (const script of ['server/index.js', 'bin/navi-mcp.js']) expect(existsSync(join(root, script))).toBe(true);
  // Kubernetes-style probes and a graceful stop: SIGTERM is what the entrypoint's
  // `exec` hands to the service, and a browser session needs time to close.
  expect(fly).toMatch(/path = "\/healthz"/);
  expect(fly).toMatch(/kill_signal = "SIGTERM"/);
  expect(fly).toMatch(/kill_timeout = "30s"/);
  expect(fly).toMatch(/mcp = "node bin\/navi-mcp\.js --transport sse --host :: --port 3001"/);
  expect(fly).toMatch(/\[checks\.mcp\][\s\S]*?port = 3001[\s\S]*?processes = \["mcp"\][\s\S]*?path = "\/healthz"/);
  // The private process is not a portless Fly proxy service. Every defined proxy
  // service must have incoming ports; private 6PN MCP uses a monitoring check.
  const services = fly.split('[[services]]').slice(1);
  expect(services).toHaveLength(1);
  expect(services[0]).toMatch(/internal_port = 3000/);
  expect(services[0]).toMatch(/\[\[services\.ports\]\]/);
  const image = await readFile(join(root, 'Dockerfile'), 'utf8');
  expect(image).toMatch(/^USER pwuser:pwuser$/m);
  for (const [name, forbidden] of [['a sandbox-disable flag', /--no-sandbox|--disable-[a-z-]*sandbox/], ['privileged mode', /privileged/], ['a published Docker socket', /docker\.sock/]]) {
    expect(fly, `${name} must not appear in a deployment config`).not.toMatch(forbidden);
  }
});

test('release collateral names the exact SRI, byte budgets and runnable desktop client entries', async () => {
  const release = await readFile(join(root, 'docs/RELEASES/v0.5.0.md'), 'utf8');
  const core = await readFile(join(root, 'dist/navi.min.js'));
  const loader = await readFile(join(root, 'dist/loader.min.js'));
  const sri = (await readFile(join(root, 'dist/sri.txt'), 'utf8')).trim();
  expect(core.length).toBeLessThanOrEqual(14929);
  expect(loader.length).toBeLessThanOrEqual(700);
  expect(`sha384-${createHash('sha384').update(core).digest('base64')}`).toBe(sri);
  expect(release).toContain(sri);
  expect(release).toContain('14,929');
  expect(release).toContain('689');
  expect(release).toContain('96.9%');
  expect(release).toContain('AGPL-3.0');
  for (const client of ['claude-desktop-config.json', 'cursor-mcp.json']) {
    const entry = JSON.parse(await readFile(join(root, 'examples', client), 'utf8')).mcpServers.navi;
    expect(entry.command).toBe('node');
    expect(entry.args[0]).toMatch(/\/bin\/navi-mcp\.js$/);
    expect(release).toContain(client);
  }
});

test('docker resolves the production compose file to least privilege, not just to those words', () => {
  // The structural test above can be satisfied by a file that says the right things in
  // the wrong place; this one asks the tool that will actually read the file. It only
  // parses - nothing is created - so it is safe to run anywhere a Docker CLI exists.
  test.skip(!composeAvailable, 'docker compose is not installed here, so the resolved config cannot be checked; the file itself is still asserted above');
  const config = docker(['compose', '-f', composePath, 'config', '--format', 'json']);
  const host = config.services['navi-host'];
  const mcp = config.services['navi-mcp'];
  for (const [name, service] of Object.entries({ 'navi-host': host, 'navi-mcp': mcp })) {
    expect(service.user, `${name} must resolve to the unprivileged UID/GID`).toBe('1000:1000');
    expect(service.read_only, `${name} must resolve to a read-only root filesystem`).toBe(true);
    expect(service.cap_drop, `${name} must resolve to every capability dropped`).toEqual(['ALL']);
    expect(service.security_opt, `${name} must resolve to no-new-privileges`).toContain('no-new-privileges:true');
    // The probe is resolved to the command that will run, not to the words in the file.
    expect(JSON.stringify(service.healthcheck?.test ?? []), `${name} must probe /healthz`).toContain('/healthz');
    expect(service.healthcheck?.retries).toBeGreaterThan(0);
    // Nothing may publish to a world-reachable address by default.
    for (const port of service.ports ?? []) expect(port.host_ip).toBe('127.0.0.1');
  }
  // The renderer profile is the MCP service's, and the host service is not the one
  // that needs it: each service carries exactly the hardening it requires.
  expect(mcp.security_opt.some((/** @type {any} */ entry) => String(entry).startsWith('seccomp='))).toBe(true);
  expect(host.security_opt.some((/** @type {any} */ entry) => String(entry).startsWith('seccomp='))).toBe(false);
  // Persistence resolves to a named volume mounted at the store's directory.
  expect(host.volumes.map((/** @type {any} */ volume) => volume.target)).toContain('/data');
  expect(host.volumes.every((/** @type {any} */ volume) => Boolean(volume.source))).toBe(true);
  expect(Object.keys(config.volumes ?? {})).toEqual(['telemetry']);
  // The credentials arrive as environment, and the required ones are present in the
  // resolved file rather than being interpolated to an empty string.
  expect(host.environment.NAVI_TENANTS).toBe('key:tenant-a');
  expect(mcp.environment.NAVI_MCP_TOKEN).toBe('test-only-token');
  expect(mcp.environment.NAVI_MODE).toBe('mcp');
});
