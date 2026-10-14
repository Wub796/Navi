import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { resolveComposeTarget } from './compose-target.mjs';

// Usage: node scripts/verify-containers.mjs [--production] [--compose <file>]
//
// Isolated project/volume; never touches a user's normal Compose deployment. Which
// deployment configuration is verified is decided by the flags and named in the receipt,
// so the evidence states the file it proves: the local file by default, the shipped
// production file for a release (either `--production`, which also requires NAVI_IMAGE,
// or `--compose deploy/docker-compose.prod.yml` against an image just built here).
let target;
try {
  target = resolveComposeTarget(process.argv.slice(2), process.env);
} catch (error) {
  process.stderr.write(`verify-containers: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
const { production, image, composeFile, receiptPath } = target;
if (!existsSync(composeFile)) {
  process.stderr.write(`verify-containers: ${composeFile} does not exist\n`);
  process.exit(2);
}
const project = `${production ? 'navi-prod-check' : 'navi-check'}-${process.pid}`;
const token = randomBytes(32).toString('hex');
const tenantKey = randomBytes(16).toString('hex');
const env = { ...process.env, NAVI_IMAGE: image, NAVI_BIND_ADDRESS: '127.0.0.1', NAVI_MCP_TOKEN: token, NAVI_TENANTS: `${tenantKey}:container-check` };
const composeArgs = ['compose', '--project-name', project, '-f', composeFile];
/** @type {{check: string, ok: boolean, detail: string}[]} */
const checks = [];
/**
 * What a failed `docker` call actually was: the command, its exit status or the signal that
 * ended it, how long it took, and the child's own streams. A receipt that records only
 * "Command failed: <command>" cannot distinguish a missing process from a refused exec from
 * a client that died with the container it was talking to — which is exactly what a
 * crash-recovery failure on one architecture looked like, and why it could not be
diagnosed from its own evidence.
 * @param {string} command @param {unknown} error @param {number} elapsedMs @returns {string}
 */
function describeDockerFailure(command, error, elapsedMs) {
  const detail = /** @type {{status?: number | null, signal?: string | null, stdout?: unknown, stderr?: unknown}} */ (error);
  const verdict = typeof detail?.status === 'number'
    ? `exit code ${detail.status}`
    : detail?.signal ? `killed by ${detail.signal}` : 'no exit status';
  const text = (/** @type {unknown} */ value) => String(value ?? '').trim().replace(/\n/g, ' \\n ');
  return [
    `${command.replace(/\s+/g, ' ')} failed: ${verdict} after ${elapsedMs}ms`,
    `stdout: ${text(detail?.stdout) || '(empty)'}`,
    `stderr: ${text(detail?.stderr) || '(empty)'}`
  ].join('\n');
}
/** @param {string[]} args @param {number} [timeout] */
const docker = (args, timeout = 30000) => {
  const startedAt = Date.now();
  try {
    return execFileSync('docker', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout });
  } catch (error) {
    // The message is rewritten to name the status, the signal, the duration and both
    // streams; the error object itself is re-thrown so callers that read its `status` and
    // `stderr` keep working (the fail-closed startup check does), while a receipt that
    // records only the message still carries the cause.
    const message = describeDockerFailure(`docker ${args.join(' ')}`, error, Date.now() - startedAt);
    if (error instanceof Error) { error.message = message; throw error; }
    throw new Error(message);
  }
};
/** @param {string[]} args @param {number} [timeout] */
const compose = (args, timeout) => docker([...composeArgs, ...args], timeout);
/** @param {unknown} condition @param {string} message */
function assert(condition, message) { if (!condition) throw new Error(message); }
/** @param {string} check @param {string} detail */
function record(check, detail) { checks.push({ check, ok: true, detail }); console.log(`ok ${check}: ${detail}`); }
/** @param {string} path @param {RequestInit} [options] */
const request = (path, options = {}) => fetch(path, { ...options, signal: AbortSignal.timeout(5000) });
/** Wait for HTTP readiness, never treating a restart command as a ready service.
 * @param {string} url @returns {Promise<void>} */
async function waitReady(url) {
  let last = 'no response';
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const response = await request(`${url}/healthz`);
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) { last = error instanceof Error ? error.message : String(error); }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`${url} never became ready: ${last}`);
}
/** @param {string} service @returns {any} */
const inspectService = service => JSON.parse(docker(['inspect', compose(['ps', '-a', '-q', service]).trim()]))[0];
/**
 * Wait for the service to be gone, and carry the caller's diagnostic into the failure: a
 * service that never stopped is usually a signal that never landed, and the report of that
 * attempt is the only thing that can say why.
 * @param {string} service @param {number} exitCode @param {string} [diagnostic] @returns {Promise<void>}
 */
async function waitStopped(service, exitCode, diagnostic = '') {
  const note = diagnostic ? `; ${diagnostic}` : '';
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const state = inspectService(service).State;
    if (!state.Running) {
      assert(state.ExitCode === exitCode, `${service} exit code ${state.ExitCode}, expected ${exitCode}${note}`);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${service} did not stop within 15s${note}`);
}
/**
 * The service's own Node process, found inside its container and SIGKILLed, returning what
 * was signalled (or why nothing was).
 *
 * Three things make this deterministic across architectures. The match is a path suffix
 * rather than one exact argv element, because how the entry point spells the script is not
 * what this check is about. The probe excludes its own pid, so neither /proc order nor the
 * script's own text can make it signal the wrapper running it. And the exit status of the
 * exec is deliberately not treated as the proof that the crash happened: killing the
 * service's main process can end the container - and this exec's connection to it - before
 * the client can report a status, so a client that reports a signal after the kill has
 * already done its job. What proves the crash is the container's own exit code 137 and the
 * dirty sentinel read immediately after; a kill that did not land leaves the service
 * running, and the caller's `waitStopped` then fails with this function's report attached.
 * @param {string} service @param {string} entry @returns {Promise<string>}
 */
async function killServiceProcess(service, entry) {
  const deadline = Date.now() + 20000;
  let observed = `${entry} was never looked for`;
  for (;;) {
    const script = `
      const fs = require('fs');
      const entry = ${JSON.stringify(entry)};
      const self = process.pid;
      const matches = fs.readdirSync('/proc').filter(p => /^\\d+$/.test(p)).filter(p => Number(p) !== self).filter(p => {
        try {
          return fs.readFileSync('/proc/' + p + '/cmdline', 'utf8').split('\\0').some(arg => arg === entry || arg.endsWith('/' + entry));
        } catch (e) { if (e.code === 'ENOENT' || e.code === 'ESRCH') return false; throw e; }
      });
      if (!matches.length) { console.log(JSON.stringify({ found: 0 })); process.exit(0); }
      const pid = Number(matches[0]);
      const argv = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\\0').filter(Boolean);
      console.log(JSON.stringify({ found: matches.length, pid, argv }));
      process.kill(pid, 'SIGKILL');
    `;
    let stdout = '';
    let clientFailure = '';
    try { stdout = compose(['exec', '-T', service, 'node', '-e', script], 60000); }
    catch (error) { clientFailure = error instanceof Error ? error.message : String(error); }
    /** @type {{found?: number, pid?: number, argv?: string[]} | null} */
    let probe = null;
    try { probe = JSON.parse(stdout.trim()); } catch { probe = null; }
    if (probe?.pid) {
      const after = clientFailure ? `; the exec client then reported ${clientFailure.replace(/\s+/g, ' ').slice(0, 240)}` : '';
      return `SIGKILL sent to ${service} pid ${probe.pid} (${(probe.argv ?? []).join(' ')}) among ${probe.found} match(es)${after}`;
    }
    observed = clientFailure || `no process matching ${entry} was visible inside ${service} (probe reported ${probe ? `${probe.found} match(es)` : 'no output'})`;
    if (Date.now() > deadline) return observed;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}
/** Read stopped-container state through only its isolated volume, as UID 1000.
 * @param {string} volume @param {string} directory @param {string} stateFile @param {string} cleanFile @returns {any} */
function lifecycleFiles(volume, directory, stateFile, cleanFile) {
  return JSON.parse(docker(['run', '--rm', '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--mount', `type=volume,source=${volume},target=${directory},readonly`, image, 'node', '-e', `
      const fs = require('fs');
      const directory = ${JSON.stringify(directory)}, state = ${JSON.stringify(stateFile)}, clean = ${JSON.stringify(cleanFile)};
      const st = fs.statSync(directory);
      console.log(JSON.stringify({uid: st.uid, gid: st.gid, mode: st.mode & 0o777,
        dirty: fs.existsSync(state), clean: fs.existsSync(clean),
        doubled: fs.existsSync(clean + '.clean')}));
    `]));
}
/** @param {string} url @param {string} metric @param {number} expected */
async function assertBootMetric(url, metric, expected) {
  const response = await request(`${url}/metrics`);
  assert(response.status === 200, `${url}/metrics answered ${response.status}`);
  const body = await response.text();
  assert(body.includes(`# TYPE ${metric} counter`) && body.split('\n').includes(`${metric} ${expected}`), `${metric} did not report ${expected}: ${body}`);
  assert(body.includes('# TYPE process_start_time_seconds gauge'), 'startup gauge missing');
}
let started = false;
/** The platform the verified image was built for, recorded as evidence. @type {string | null} */
let architecture = null;
/**
 * The image the checks actually ran against, by local config id, recorded as evidence.
 * `compose` and `architecture` say which deployment and platform were proved but not
 * which bytes: an image rebuilt under the same tag between two runs leaves both fields
 * identical. The id is the content digest of that image's configuration, which is what a
 * reader needs to tie the verdicts to the artifact they describe.
 * @type {string | null}
 */
let imageId = null;
/** @type {Client | undefined} */
let client;
try {
  if (production) assert(Boolean(process.env.NAVI_IMAGE), '--production requires NAVI_IMAGE to select the verified artifact');
  docker(['info']);
  compose(['config', '--quiet']);
  const metadata = JSON.parse(docker(['image', 'inspect', image]))[0];
  assert(metadata.Config.User === 'pwuser:pwuser', 'image must run as pwuser:pwuser');
  architecture = `${metadata.Os}/${metadata.Architecture}`;
  imageId = metadata.Id;
  record('image', `${imageId}; ${architecture}; user ${metadata.Config.User}`);
  started = true;
  // Fail on occupied requested ports; do not stop or replace their owners.
  // Only the isolated verification deployment allows its private fixture hosts.
  const override = `.freebuff/${project}.override.yml`;
  await mkdir('.freebuff', { recursive: true });
  // Disable automatic restart only in this disposable project so the verifier
  // can witness exit 137 and inspect dirty files before an explicit restart.
  await writeFile(override, 'services:\n  navi-host:\n    restart: "no"\n  navi-mcp:\n    restart: "no"\n    environment:\n      NAVI_ALLOW_LOCAL_NETWORK: "1"\n');
  composeArgs.push('-f', override);
  compose(['up', '-d', '--no-build', '--wait', '--wait-timeout', '90'], 120000);
  record('compose-health', 'both services healthy under read-only rootfs, dropped capabilities, no-new-privileges');
  const runtime = compose(['exec', '-T', 'navi-mcp', 'node', '-e', 'const f=require("fs");console.log(JSON.stringify({uid:process.getuid(),node:process.version,playwright:require("playwright-core/package.json").version,proc:f.readFileSync("/proc/self/status","utf8").split(String.fromCharCode(10)).filter(s=>/^(CapEff|NoNewPrivs):/.test(s))}))']);
  const posture = JSON.parse(runtime);
  assert(posture.uid === 1000 && posture.node.startsWith('v22.'), 'unexpected runtime identity/version');
  assert(posture.proc.some((/** @type {string} */ line) => /CapEff:\s+0+$/.test(line)), 'capabilities not dropped');
  assert(posture.proc.some((/** @type {string} */ line) => /NoNewPrivs:\s+1$/.test(line)), 'no-new-privileges missing');
  record('runtime-posture', runtime.trim());
  const sandbox = JSON.parse(compose(['exec', '-T', 'navi-mcp', 'node', 'scripts/check-sandbox.mjs']));
  assert(sandbox.ok, 'Chromium sandbox verification failed');
  record('chromium-sandbox', JSON.stringify(sandbox));
  const host = 'http://127.0.0.1:3000';
  const mcp = 'http://127.0.0.1:3001';
  const hostState = '/data/telemetry.db';
  const hostClean = `${hostState}.clean`;
  const mcpDirectory = '/var/lib/navi/mcp';
  const mcpMount = inspectService('navi-mcp').Mounts.find((/** @type {any} */ mount) => mount.Destination === mcpDirectory);
  assert(mcpMount?.Type === 'volume' && mcpMount.RW, 'MCP lifecycle state must be a writable named volume');
  const hostMount = inspectService('navi-host').Mounts.find((/** @type {any} */ mount) => mount.Destination === '/data');
  assert(hostMount?.Type === 'volume' && hostMount.Name !== mcpMount.Name, 'host/MCP volumes must be separate');
  // The sentinel names come from the code the image ships, not from this script's
  // assumptions: a `.clean`-suffixed NAVI_MCP_STATE_FILE is the teardown marker
  // itself, so a completed stop must publish that name rather than `state.clean.clean`.
  const configuredState = compose(['exec', '-T', 'navi-mcp', 'node', '-p', 'process.env.NAVI_MCP_STATE_FILE']).trim();
  assert(configuredState === `${mcpDirectory}/state.clean`, `unexpected MCP state path: ${configuredState}`);
  const mcpPaths = JSON.parse(compose(['exec', '-T', 'navi-mcp', 'node', '--input-type=module', '-e', `
    import { lifecyclePaths } from '/app/server/store.js';
    console.log(JSON.stringify(lifecyclePaths(process.env.NAVI_MCP_STATE_FILE)));
  `]));
  assert(mcpPaths.normalized === true && mcpPaths.cleanFile === configuredState && mcpPaths.stateFile === `${mcpDirectory}/state.dirty`,
    `MCP sentinels are not normalized: ${JSON.stringify(mcpPaths)}`);
  const mcpState = mcpPaths.stateFile;
  const mcpClean = mcpPaths.cleanFile;
  const statePosture = lifecycleFiles(mcpMount.Name, mcpDirectory, mcpState, mcpClean);
  assert(statePosture.uid === 1000 && statePosture.gid === 1000 && statePosture.mode === 0o700, `bad MCP volume ownership/permissions: ${JSON.stringify(statePosture)}`);
  assert(statePosture.dirty && !statePosture.clean && !statePosture.doubled, 'MCP first boot must create dirty evidence, consume the clean marker and never double the suffix');
  await assertBootMetric(host, 'navi_host_unclean_shutdowns_total', 0);
  await assertBootMetric(mcp, 'navi_mcp_unclean_shutdowns_total', 0);
  record('lifecycle-volume', `separate named MCP volume at ${mcpDirectory}, owner 1000:1000 mode 0700; dirty ${mcpState}, marker ${mcpClean}; no ${mcpClean}.clean; first boot 0 on both roles`);
  const sdk = await request(`${host}/v1/navi.js?key=${tenantKey}`);
  assert(sdk.ok, 'keyed SDK unavailable');
  assert(Buffer.from(await sdk.arrayBuffer()).equals(await readFile('dist/navi.min.js')), 'container SDK differs from local artifact');
  assert((await request(`${host}/v1/navi.js`)).status === 401, 'SDK key rejection failed');
  assert(Buffer.from(await (await request(`${host}/v1/loader.js`)).arrayBuffer()).equals(await readFile('dist/loader.min.js')), 'loader mismatch');
  record('distribution', 'SDK and loader byte-identical; missing tenant key rejected');
  const beacon = { tenant_id: 'container-check', url_origin: 'https://container.example', actions_indexed: 7, actions_executed: 2, execution_failures: 0 };
  assert((await request(`${host}/v1/telemetry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(beacon) })).status === 202, 'telemetry rejected');
  compose(['restart', 'navi-host'], 30000);
  // Restart is not readiness: bounded HTTP poll until the host answers again.
  let summary;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await request(`${host}/v1/telemetry?key=${tenantKey}`);
      if (response.ok) { summary = await response.json(); break; }
    } catch { /* bounded retry only during owned service restart */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert(summary?.summary?.events === 1, 'telemetry did not survive host restart');
  record('telemetry-persistence', 'accepted aggregate survives service restart in isolated named volume');
  for (const path of ['/sse', '/message?sessionId=unknown']) {
    const options = path.startsWith('/message') ? { method: 'POST' } : {};
    assert((await request(`${mcp}${path}`, options)).status === 401, `${path} accepted anonymous caller`);
    assert((await request(`${mcp}${path}`, { ...options, headers: { Authorization: 'Bearer wrong' } })).status === 401, `${path} accepted wrong token`);
  }
  record('bearer-rejection', 'missing/wrong credentials rejected on both SSE and message endpoints');
  const headers = { Authorization: `Bearer ${token}` };
  client = new Client({ name: 'navi-container-check', version: '1.0.0' });
  await client.connect(new SSEClientTransport(new URL(`${mcp}/sse`), { requestInit: { headers }, eventSourceInit: { fetch: (input, init) => fetch(input, { ...init, headers }) } }));
  /** @param {string} name @param {Record<string, unknown>} args @returns {Promise<any>} */
  const call = async (name, args) => {
    const result = await /** @type {Client} */ (client).callTool({ name, arguments: args });
    const body = JSON.parse(/** @type {{text: string}[]} */ (result.content)[0].text);
    assert(!result.isError && body.ok, `${name}: ${JSON.stringify(body)}`);
    return body;
  };
  // Target the other real container over the Compose network. This requires an
  // actual Chromium launch and SDK injection under all runtime restrictions.
  await call('navi_navigate', { url: 'http://navi-host:3000/healthz' });
  const map = await call('navi_get_actions', {});
  assert(Array.isArray(map.actions), 'browser action map missing');
  // Serve a disposable interactive page inside the browser container; no source
  // mounts, exposed ports, shell downloads or external websites are needed.
  const fixtureCode = 'require("http").createServer((q,s)=>{s.setHeader("Content-Type","text/html");s.end(`<button data-agent-target="change" onclick="this.textContent=String.fromCharCode(67,104,97,110,103,101,100)">Change state</button><a data-agent-target="next" href="/?done=1">Continue</a>`)}).listen(4100,"127.0.0.1")';
  compose(['exec', '-T', 'navi-mcp', 'node', '-e', `
    const {spawn}=require('child_process');
    const fs=require('fs');
    const fd=fs.openSync('/tmp/fixture.log','w');
    const child=spawn(process.execPath,['-e',${JSON.stringify(fixtureCode)}],{detached:true,stdio:['ignore',fd,fd]});
    child.unref();
    (async()=>{
      for(let i=0;i<40;i++){
        try{const r=await fetch('http://127.0.0.1:4100/',{signal:AbortSignal.timeout(500)});if(r.ok)return;}catch{}
        await new Promise(r=>setTimeout(r,100));
      }
      throw new Error('Fixture did not become ready: '+fs.readFileSync('/tmp/fixture.log','utf8'));
    })().catch(e=>{console.error(e);process.exitCode=1;});
  `]);
  await call('navi_navigate', { url: 'http://127.0.0.1:4100/' });
  const receipt = await call('navi_execute_action', { target_id: 'change', action_type: 'click', settle: { wait_for: 'mutation_settle' } });
  assert(receipt.executed && receipt.settled, 'container mutation receipt missing');
  const state = await call('navi_assert_state', { target_id: 'change', name: 'Changed' });
  assert(state.passed, 'container browser action did not update the DOM');
  const navigation = await call('navi_execute_action', { target_id: 'next', action_type: 'click', settle: { wait_for: 'navigation' } });
  assert(navigation.settled && navigation.final_url.includes('done=1'), 'container navigation receipt invalid');
  record('authenticated-browser', 'official SSE client launched locked Chromium, discovered host and fixture pages, executed a DOM mutation and verified navigation receipts');
  await client.close(); client = undefined;
  let refused = false;
  try { docker(['run', '--rm', '-e', 'NAVI_MODE=mcp', production ? image : 'navi:local']); }
  catch (error) {
    const captured = /** @type {{status?: number, stderr?: string | Buffer}} */ (error);
    refused = captured.status !== 0 && String(captured.stderr).includes('NAVI_MCP_TOKEN');
  }
  assert(refused, 'MCP image must fail closed without token');
  record('fail-closed-startup', 'MCP mode refuses missing token before listening');
  // The scrape surface an operator's monitoring uses must work in the shipped
  // image, not only in-process: /metrics is unauthenticated like the liveness
  // probe and carries aggregate counters, never URLs or session identifiers.
  const metrics = await request(`${mcp}/metrics`);
  assert(metrics.status === 200, 'the metrics endpoint is unavailable');
  assert(String(metrics.headers.get('content-type')).includes('text/plain'), 'the metrics endpoint did not serve text');
  const exposition = await metrics.text();
  const series = exposition.split('\n').filter(line => line.startsWith('navi_containment'));
  assert(exposition.includes('navi_containment_violations_total') && exposition.includes('navi_mcp_sessions'), 'the exposition is missing containment or session series');
  const health = await (await request(`${mcp}/healthz`)).json();
  assert(health.containment && typeof health.containment.violations_total === 'number' && typeof health.containment.enforced === 'boolean', 'healthz does not report the containment counters');
  assert(Object.keys(health.containment.violations_by_category).length === 6, 'healthz is missing violation categories');
  assert(!exposition.includes('http'), 'the exposition must not carry a destination URL');
  record('containment-observability', `healthz containment ${JSON.stringify(health.containment)}; ${series.length} containment series on /metrics`);
  // Durable audit: a violation filed with the tenant's key must be readable back
  // by that tenant from the shipped image, not only from a unit test.
  const filed = await request(`${host}/v1/telemetry/violations`, {
    method: 'POST',
    // The host's tenant key, not the MCP bearer token: this is the tenant's own
    // credential, and the audit read is confined to the tenant it resolves to.
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tenantKey}` },
    body: JSON.stringify({ session_id: 'container-check', category: 'metadata_endpoint', target_url: 'http://169.254.169.254/latest/meta-data/', resolved_ip: '169.254.169.254' })
  });
  assert(filed.status === 202, `violation ingest answered ${filed.status}`);
  const auditResponse = await request(`${host}/v1/tenants/container-check/security-audit`, { headers: { Authorization: `Bearer ${tenantKey}` } });
  assert(auditResponse.status === 200, `audit read answered ${auditResponse.status}`);
  const audit = await auditResponse.json();
  assert(audit.count === 1 && audit.violations[0].target_url === 'http://169.254.169.254/latest/meta-data/', 'the audit record did not round-trip');
  assert(String(auditResponse.headers.get('cache-control')).includes('private'), 'an audit read must not be publicly cacheable');
  const anonymousAudit = await request(`${host}/v1/tenants/container-check/security-audit`);
  assert(anonymousAudit.status === 401, `an anonymous audit read answered ${anonymousAudit.status}`);
  const hostHealth = await (await request(`${host}/healthz`)).json();
  record('tenant-security-audit', `a violation filed with the tenant key reads back through security-audit (${hostHealth.mode} store) and is refused without one`);
  // Retention runs through the live backend; an in-window record must retain
  // its id whether the store is SQLite or an existing JSONL file.
  const anonymousPrune = await request(`${host}/v1/tenants/container-check/maintenance/prune`, { method: 'POST' });
  assert(anonymousPrune.status === 401, `an anonymous prune answered ${anonymousPrune.status}`);
  const crossTenantPrune = await request(`${host}/v1/tenants/other-tenant/maintenance/prune`, { method: 'POST', headers: { Authorization: `Bearer ${tenantKey}` } });
  assert(crossTenantPrune.status === 403, `a cross-tenant prune answered ${crossTenantPrune.status}`);
  const pruneResponse = await request(`${host}/v1/tenants/container-check/maintenance/prune`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tenantKey}` },
    body: JSON.stringify({ max_age_days: 1 })
  });
  assert(pruneResponse.status === 200, `the maintenance prune answered ${pruneResponse.status}`);
  const pruneResult = await pruneResponse.json();
  assert(pruneResult.pruned_count === 0 && pruneResult.remaining_count === 1, `unexpected prune result ${JSON.stringify(pruneResult)}`);
  const afterPrune = await (await request(`${host}/v1/tenants/container-check/security-audit`, { headers: { Authorization: `Bearer ${tenantKey}` } })).json();
  assert(afterPrune.count === 1 && afterPrune.violations[0].id === audit.violations[0].id, 'compaction lost or renumbered a record inside the retention window');
  assert(hostHealth.retention_days === 30, `unexpected default retention window ${hostHealth.retention_days}`);
  record('retention-maintenance', `a ${hostHealth.mode}-backed prune kept the in-window record with id ${afterPrune.violations[0].id}, refused anonymous and cross-tenant callers, and reported a ${hostHealth.retention_days}-day window`);
  // The host's own scrape surface, in the shipped image rather than only in
  // process: unauthenticated and aggregate-only like the MCP exposition, with the
  // route label drawn from the closed set rather than from the requested path.
  const previousExposition = await (await request(`${host}/metrics`)).text();
  const scrapeCount = (/** @type {string} */ text) => Number(/^navi_host_requests_total\{route="metrics",status="200"\} (\d+)$/m.exec(text)?.[1] ?? 0);
  const hostMetrics = await request(`${host}/metrics`);
  assert(hostMetrics.status === 200, 'the host metrics endpoint is unavailable');
  assert(String(hostMetrics.headers.get('content-type')).includes('version=0.0.4'), 'the host metrics endpoint did not declare the Prometheus text format');
  assert(String(hostMetrics.headers.get('cache-control')).includes('no-store'), 'a scrape must not be cacheable');
  const hostExposition = await hostMetrics.text();
  for (const name of ['navi_host_requests_total', 'navi_host_rate_limited_total', 'navi_host_prune_events_total', 'navi_host_pruned_records_total', 'navi_host_active_tenants', 'navi_host_store_bytes']) {
    assert(hostExposition.includes(`# TYPE ${name} `), `the host exposition is missing ${name}`);
  }
  const hostRouted = hostExposition.split('\n').filter(line => line.startsWith('navi_host_requests_total{'));
  assert(hostRouted.length > 0 && hostRouted.every(line => /^navi_host_requests_total\{route="[a-z_.]+",status="\d{3}"\} \d+$/.test(line)), `unexpected host request series: ${hostRouted.join(' | ')}`);
  assert(scrapeCount(hostExposition) === scrapeCount(previousExposition) + 1, 'the host did not count a scrape it answered');
  assert(!hostExposition.includes('http') && !hostExposition.includes(tenantKey) && !hostExposition.includes('container-check'), 'the host exposition must carry no URL, key or tenant identifier');
  record('host-metrics', `${hostRouted.length} request series in ${hostExposition.trim().split('\n').length} lines scraped from the shipped host service`);
  // The store backend is a runtime capability, not a config flag: node:sqlite has
  // been importable without --experimental-sqlite since Node 22.13, which is the
  // pinned base. What has to be proven is that this image reaches the module and
  // serves a database in WAL mode, rather than quietly falling back to the
  // append-only log that shares the same path - both are durable, and only one of
  // them is what the deployment guide promises.
  const storeHealth = await (await request(`${host}/healthz`)).json();
  const storeProbe = JSON.parse(compose(['exec', '-T', 'navi-host', 'node', '--input-type=module', '-e', `
    import { storeFormat } from '/app/server/store.js';
    import { readFile, readdir } from 'node:fs/promises';
    const header = (await readFile('/data/telemetry.db')).subarray(0, 16).toString('utf8');
    console.log(JSON.stringify({
      format: await storeFormat('/data/telemetry.db'),
      header: header === 'SQLite format 3\\u0000',
      files: (await readdir('/data')).sort()
    }));
  `]));
  assert(storeHealth.mode === 'sqlite', `the host reported the ${storeHealth.mode} backend, so node:sqlite was not reached`);
  assert(storeProbe.format === 'sqlite' && storeProbe.header, `the store file is not a SQLite database: ${JSON.stringify(storeProbe)}`);
  assert(storeProbe.files.includes('telemetry.db-wal'), `the write-ahead log sidecar is missing, so the store is not in WAL mode: ${JSON.stringify(storeProbe.files)}`);
  record('sqlite-store', `the host serves the ${storeHealth.mode} backend with the SQLite header and its -wal sidecar present (${storeProbe.files.join(', ')})`);
  // Real Node SIGKILL, not a graceful Docker restart. The init process reaps the
  // child and exits 137; the dirty evidence must survive both restart and removal
  // of the container itself. Only this project's resources are ever targeted.
  for (const [service, url, metric, volume, directory, stateFile, cleanFile] of [
    ['navi-host', host, 'navi_host_unclean_shutdowns_total', hostMount.Name, '/data', hostState, hostClean],
    ['navi-mcp', mcp, 'navi_mcp_unclean_shutdowns_total', mcpMount.Name, mcpDirectory, mcpState, mcpClean]
  ]) {
    const entry = service === 'navi-host' ? 'server/index.js' : 'bin/navi-mcp.js';
    const crash = await killServiceProcess(service, entry);
    await waitStopped(service, 137, crash);
    let files = lifecycleFiles(volume, directory, stateFile, cleanFile);
    assert(files.dirty && !files.clean, `${service} SIGKILL left false clean evidence`);
    compose(['start', service]);
    await waitReady(url);
    await assertBootMetric(url, metric, 1);
    files = lifecycleFiles(volume, directory, stateFile, cleanFile);
    assert(!files.clean, `${service} did not consume clean marker on startup`);
    // A second crash followed by force-recreation proves the files do not live
    // in the disposable container layer or /tmp tmpfs.
    const oldId = inspectService(service).Id;
    const secondCrash = await killServiceProcess(service, entry);
    await waitStopped(service, 137, secondCrash);
    compose(['up', '-d', '--no-build', '--force-recreate', '--no-deps', service], 60000);
    await waitReady(url);
    assert(inspectService(service).Id !== oldId, `${service} was not recreated`);
    await assertBootMetric(url, metric, 1);
    // MCP stops with a real browser still active, so marker publication proves
    // graceful session teardown as well as an empty HTTP listener shutdown.
    if (service === 'navi-mcp') {
      client = new Client({ name: 'navi-lifecycle-check', version: '1.0.0' });
      await client.connect(new SSEClientTransport(new URL(`${mcp}/sse`), { requestInit: { headers }, eventSourceInit: { fetch: (input, init) => fetch(input, { ...init, headers }) } }));
      await call('navi_navigate', { url: 'http://navi-host:3000/healthz' });
      assert((await (await request(`${mcp}/healthz`)).json()).sessions === 1, 'graceful MCP stop must tear down an active session');
    }
    compose(['stop', service], 45000);
    await waitStopped(service, 0);
    files = lifecycleFiles(volume, directory, stateFile, cleanFile);
    assert(files.dirty && files.clean && !files.doubled, `${service} graceful stop did not publish exactly one clean marker`);
    await client?.close(); client = undefined;
    compose(['start', service]);
    await waitReady(url);
    await assertBootMetric(url, metric, 0);
    assert(!lifecycleFiles(volume, directory, stateFile, cleanFile).clean, `${service} clean marker was not consumed`);
    if (service === 'navi-host') {
      const recovered = await (await request(`${host}/v1/telemetry?key=${tenantKey}`)).json();
      const recoveredAudit = await (await request(`${host}/v1/tenants/container-check/security-audit`, { headers: { Authorization: `Bearer ${tenantKey}` } })).json();
      assert(recovered.summary.events === 1 && recoveredAudit.count === 1 && recoveredAudit.violations[0].id === audit.violations[0].id, 'host crash recovery lost telemetry or audit data');
    }
    record(`${service}-crash-recovery`, `SIGKILL exit 137 (${crash}; then ${secondCrash}): ${metric}=1 after restart and container recreation; graceful stop exit 0 publishes marker, next boot ${metric}=0 and consumes marker${service === 'navi-mcp' ? '; active Chromium session torn down' : '; telemetry and audit retained'}`);
  }
  // The containment guard is the shipped default, independent of the fixture
  // override this deployment adds: drive stdio MCP in a container that carries
  // no NAVI_ALLOW_LOCAL_NETWORK and require the metadata endpoint to be refused
  // with the containment code, which happens before a browser is launched.
  const guardedEnv = { ...process.env };
  delete guardedEnv.NAVI_ALLOW_LOCAL_NETWORK;
  const stdioInput = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'containment-check', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'navi_navigate', arguments: { url: 'http://169.254.169.254/latest/meta-data/' } } }
  ].map(message => JSON.stringify(message)).join('\n') + '\n';
  const guarded = spawnSync('docker', ['run', '--rm', '-i', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m', production ? image : 'navi:local', 'node', 'bin/navi-mcp.js'], { env: guardedEnv, input: stdioInput, encoding: 'utf8', timeout: 90000 });
  assert(!guarded.error && guarded.status === 0, `the guarded run failed: ${guarded.error?.message ?? guarded.stderr}`);
  const guardedOut = String(guarded.stdout);
  assert(guardedOut.includes('ERR_BLOCKED_BY_CONTAINMENT'), 'a metadata destination was not refused by default');
  assert(!guardedOut.includes('"ok": true'), 'the metadata destination was navigated to');
  // The refusal must also be auditable from the container: one structured line on
  // stderr, with the destination sanitized. stdout stays a protocol surface.
  const audited = String(guarded.stderr).split('\n').filter(Boolean).map(line => JSON.parse(line)).find(record_ => record_.type === 'SECURITY_CONTAINMENT_VIOLATION');
  assert(audited && audited.level === 'WARN' && audited.action === 'BLOCKED', 'the refusal was not audit-logged');
  assert(audited.category === 'metadata_endpoint' && audited.target_url === 'http://169.254.169.254/latest/meta-data/' && audited.resolved_ip === '169.254.169.254', `the audit line is incomplete: ${JSON.stringify(audited)}`);
  record('containment-default-deny', `metadata destination refused with ERR_BLOCKED_BY_CONTAINMENT and audited as ${JSON.stringify(audited)}, without any local-network override`);
} catch (error) {
  checks.push({ check: 'container-validation', ok: false, detail: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
  console.error(checks.at(-1)?.detail);
} finally {
  await client?.close();
  if (started) {
    try { compose(['down', '--volumes', '--remove-orphans'], 60000); }
    catch { checks.push({ check: 'cleanup', ok: false, detail: `Could not clean isolated Compose project ${project}` }); process.exitCode = 1; }
  }
  await mkdir('reports', { recursive: true });
  // The receipt names the deployment configuration, the platform and the image digest it
  // proves, beside the verdicts themselves, so a reader of the evidence does not have to
  // infer any of the three from the file name it happens to sit in or the tag it was run
  // with.
  await writeFile(receiptPath, JSON.stringify({ recordedAt: new Date().toISOString(), compose: composeFile, architecture, imageId, ok: checks.length > 0 && checks.every(check => check.ok), checks }, null, 2) + '\n');
}
