import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

// Isolated project/volume; never touches a user's normal Compose deployment.
// --production exercises the shipped production file and writes a separate receipt.
const production = process.argv.includes('--production');
const image = process.env.NAVI_IMAGE || 'navi:local';
const project = `${production ? 'navi-prod-check' : 'navi-check'}-${process.pid}`;
const token = randomBytes(32).toString('hex');
const tenantKey = randomBytes(16).toString('hex');
const env = { ...process.env, NAVI_IMAGE: image, NAVI_BIND_ADDRESS: '127.0.0.1', NAVI_MCP_TOKEN: token, NAVI_TENANTS: `${tenantKey}:container-check` };
const composeArgs = ['compose', '--project-name', project, '-f', production ? 'deploy/docker-compose.prod.yml' : 'docker-compose.yml'];
/** @type {{check: string, ok: boolean, detail: string}[]} */
const checks = [];
/** @param {string[]} args @param {number} [timeout] */
const docker = (args, timeout = 30000) => execFileSync('docker', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout });
/** @param {string[]} args @param {number} [timeout] */
const compose = (args, timeout) => docker([...composeArgs, ...args], timeout);
/** @param {unknown} condition @param {string} message */
function assert(condition, message) { if (!condition) throw new Error(message); }
/** @param {string} check @param {string} detail */
function record(check, detail) { checks.push({ check, ok: true, detail }); console.log(`ok ${check}: ${detail}`); }
/** @param {string} path @param {RequestInit} [options] */
const request = (path, options = {}) => fetch(path, { ...options, signal: AbortSignal.timeout(5000) });
let started = false;
/** @type {Client | undefined} */
let client;
try {
  if (production) assert(Boolean(process.env.NAVI_IMAGE), '--production requires NAVI_IMAGE to select the verified artifact');
  docker(['info']);
  compose(['config', '--quiet']);
  const metadata = JSON.parse(docker(['image', 'inspect', production ? image : 'navi:local']))[0];
  assert(metadata.Config.User === 'pwuser:pwuser', 'image must run as pwuser:pwuser');
  record('image', `${metadata.Id}; ${metadata.Os}/${metadata.Architecture}; user ${metadata.Config.User}`);
  started = true;
  // Fail on occupied requested ports; do not stop or replace their owners.
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
  await writeFile(production ? 'reports/production-container-verification.json' : 'reports/container-verification.json', JSON.stringify({ recordedAt: new Date().toISOString(), ok: checks.length > 0 && checks.every(check => check.ok), checks }, null, 2) + '\n');
}
