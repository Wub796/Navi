#!/usr/bin/env node
/**
 * Clean-room package and registry canary verifier for Navi.
 *
 * `scripts/pack-check.mjs` inspects the JSON report of `npm pack --dry-run`. This
 * script goes one step further: it produces (or downloads) a real package tarball,
 * extracts it into an isolated temporary directory with no `node_modules` and no
 * link back to this workspace, verifies the unpacked layout, SHA-384 subresource
 * integrity and zero-leak boundary on the real extracted files, and then spawns the
 * packed `bin/navi-mcp.js` executable in that clean-room directory to run a live
 * stdio JSON-RPC 2.0 handshake and `SIGTERM` teardown.
 *
 * Usage:
 *   node scripts/verify-registry-package.mjs --tarball             # pack local checkout and verify
 *   node scripts/verify-registry-package.mjs --tarball <file.tgz>  # verify an existing tarball
 *   node scripts/verify-registry-package.mjs --registry [spec]     # pack from npm registry (e.g. navi@0.6.2)
 *   node scripts/verify-registry-package.mjs --json                # emit structured JSON receipt
 *
 * Exit codes: 0 all checks passed, 1 a verification check failed, 2 usage error.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** Expected manifest exports and core shipped artifacts that must exist inside the unpacked tarball. */
export const REQUIRED_PACKAGE_FILES = [
  'package.json',
  'LICENSE',
  'README.md',
  'dist/navi.min.js',
  'dist/loader.min.js',
  'dist/mcp.mjs',
  'dist/cli.mjs',
  'dist/index.mjs',
  'dist/index.cjs',
  'dist/index.d.ts',
  'dist/navi.d.ts',
  'bin/navi-mcp.js',
  'bin/navi-agent.js',
  // The host service ships in the package, so the clean room verifies every module
  // its entrypoint imports. A module missing here is a tarball whose `npm run serve`
  // is an ERR_MODULE_NOT_FOUND, which no test in the checkout would notice.
  'server/index.js',
  'server/billing.js',
  'server/billing-success.js',
  'server/endpoints.js',
  'server/http.js',
  'server/ingest.js',
  'server/landing-hero.js',
  'server/landing-inspector.js',
  'server/landing-calculator.js',
  'server/landing-stage.js',
  'server/landing-responsive.js',
  'server/landing-styles.js',
  'server/landing.js',
  'server/maintenance.js',
  'server/metrics.js',
  'server/pricing.js',
  'server/public-routes.js',
  'server/quota.js',
  'server/rate-limit.js',
  'server/sitemap-workflows.js',
  'server/store.js',
  'server/store-format.js',
  'server/store-lifecycle.js',
  'server/store-log.js',
  'server/store-schema.js',
  'server/store-sqlite.js',
  'server/tenants.js'
];

/**
 * Patterns that must never leak into a published tarball: devDependencies (`node_modules`),
 * test files, uncompiled `src/` or `types/` source files, scripts, reports, or secrets.
 */
export const FORBIDDEN_PACKAGE_PATTERNS = [
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)src(\/|$)/,
  /(^|\/)types(\/|$)/,
  /(^|\/)tests?(\/|$)/,
  /(^|\/)scripts(\/|$)/,
  /(^|\/)reports?(\/|$)/,
  /(^|\/)demo(\/|$)/,
  /(^|\/)deploy(\/|$)/,
  /(^|\/)security(\/|$)/,
  /(^|\/)\.github(\/|$)/,
  /(^|\/)\.freebuff(\/|$)/,
  /\.spec\.m?js$/,
  /\.test\.m?js$/,
  /probe/i,
  /(^|\/)\.env/,
  /telemetry\.db/,
  /storageState/i,
  /\.pem$/,
  /\.key$/,
  /(^|\/)\.npmrc/
];

/** Required MCP tool declarations checked during the clean-room stdio handshake. */
export const REQUIRED_MCP_TOOLS = [
  'navi_navigate',
  'navi_action',
  'navi_set_session'
];

/**
 * Canonical MCP tool names exposed by the server, plus the `navi_action` family alias
 * (`navi_execute_action` / `navi_get_actions`).
 */
export const EXPECTED_MCP_TOOL_NAMES = [
  'navi_navigate',
  'navi_get_actions',
  'navi_execute_action',
  'navi_assert_state',
  'navi_set_session'
];

/** @typedef {{id: string, ok: boolean, detail: string}} CanaryCheck */

/**
 * Recursively list all files inside a directory as POSIX relative paths.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
export async function listUnpackedFiles(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter(entry => entry.isFile() || entry.isSymbolicLink())
    .map(entry => relative(dir, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
    .sort();
}

/**
 * Validate the unpacked file list and package manifest against the clean-room rules.
 * Pure over the unpacked file list and manifest so unit tests can exercise every failure mode.
 * @param {{files: string[], pkg: Record<string, any>, expectedSri: string, actualBundleBytes: Buffer, actualLoaderBytes: Buffer}} input
 * @returns {CanaryCheck[]}
 */
export function evaluateUnpackedPackage({ files, pkg, expectedSri, actualBundleBytes, actualLoaderBytes }) {
  /** @type {CanaryCheck[]} */
  const checks = [];

  // 1. Manifest exports & required files layout.
  const exportTargets = [
    pkg.main,
    pkg.module,
    pkg.types,
    pkg.bin?.['navi-mcp'],
    pkg.bin?.navi,
    pkg.exports?.['.']?.import,
    pkg.exports?.['.']?.require,
    pkg.exports?.['.']?.types,
    pkg.exports?.['./navi.min.js']?.default,
    pkg.exports?.['./navi.min.js']?.types
  ]
    .filter((/** @type {unknown} */ target) => typeof target === 'string')
    .map((/** @type {string} */ target) => target.replace(/^\.\//, ''));

  const requiredSet = new Set([...REQUIRED_PACKAGE_FILES, ...exportTargets]);
  const missing = [...requiredSet].filter(path => !files.includes(path));
  checks.push({
    id: 'manifest-layout',
    ok: missing.length === 0,
    detail: missing.length === 0
      ? `all ${requiredSet.size} required manifest exports present (dist/navi.min.js, dist/loader.min.js, dist/mcp.mjs, bin/navi-mcp.js, …)`
      : `missing required unpacked file(s): ${missing.join(', ')}`
  });

  // 2. Subresource integrity & byte budget parity on unpacked dist/navi.min.js.
  const computedSri = `sha384-${createHash('sha384').update(actualBundleBytes).digest('base64')}`;
  const sriMatches = Boolean(expectedSri) && computedSri === expectedSri.trim();
  const withinBudgets = actualBundleBytes.length === 14929 && actualLoaderBytes.length <= 700;
  checks.push({
    id: 'sri-and-budgets',
    ok: sriMatches && withinBudgets,
    detail: sriMatches && withinBudgets
      ? `dist/navi.min.js (${actualBundleBytes.length} B) matches ${computedSri.slice(0, 24)}…; dist/loader.min.js is ${actualLoaderBytes.length} B (<=700 B)`
      : `bundle=${actualBundleBytes.length} B (expected 14929), loader=${actualLoaderBytes.length} B (<=700), computed=${computedSri}, expected=${expectedSri}`
  });

  // 3. Zero devDependencies, test files, or uncompiled source files leaked.
  const allowedPrefixes = [
    ...(Array.isArray(pkg.files) ? pkg.files.map((/** @type {string} */ entry) => entry.replace(/^\.\//, '').replace(/\/$/, '')) : []),
    'package.json',
    'README.md',
    'LICENSE',
    'LICENSE.md',
    'LICENCE',
    'CHANGELOG.md'
  ];
  const leakedForbidden = files.filter(path => FORBIDDEN_PACKAGE_PATTERNS.some(pattern => pattern.test(path)));
  const outsideAllowlist = files.filter(path => !allowedPrefixes.some(allowed => path === allowed || path.startsWith(`${allowed}/`)));
  const runtimeDeps = Object.keys(pkg.dependencies ?? {});
  const bundledDeps = Array.isArray(pkg. bundledDependencies ?? pkg.bundleDependencies) ? (pkg.bundledDependencies ?? pkg.bundleDependencies) : [];
  const cleanRoomIsolation = leakedForbidden.length === 0 && outsideAllowlist.length === 0 && runtimeDeps.length === 0 && bundledDeps.length === 0;
  checks.push({
    id: 'zero-leak-isolation',
    ok: cleanRoomIsolation,
    detail: cleanRoomIsolation
      ? `0 forbidden/source/test files, 0 outside package.json allowlist, 0 runtime/bundled dependencies (${files.length} files total)`
      : [
          leakedForbidden.length ? `forbidden paths: ${leakedForbidden.join(', ')}` : null,
          outsideAllowlist.length ? `outside allowlist: ${outsideAllowlist.join(', ')}` : null,
          runtimeDeps.length ? `unexpected runtime dependencies: ${runtimeDeps.join(', ')}` : null,
          bundledDeps.length ? `unexpected bundledDependencies: ${bundledDeps.join(', ')}` : null
        ].filter(Boolean).join('; ')
  });

  return checks;
}

/**
 * Execute a live stdio JSON-RPC handshake and SIGTERM teardown against the unpacked
 * `bin/navi-mcp.js` in its isolated clean-room directory.
 * @param {string} packageDir unpacked `package/` directory
 * @returns {Promise<CanaryCheck[]>}
 */
export async function runCleanRoomMcpHandshake(packageDir) {
  /** @type {CanaryCheck[]} */
  const checks = [];
  const binPath = join(packageDir, 'bin', 'navi-mcp.js');
  if (!existsSync(binPath)) {
    return [
      { id: 'mcp-initialize', ok: false, detail: `missing ${binPath}` },
      { id: 'mcp-tools-list', ok: false, detail: `missing ${binPath}` },
      { id: 'mcp-sigterm-teardown', ok: false, detail: `missing ${binPath}` }
    ];
  }

  // The client identifies itself with the version it is verifying. Reading it from the
  // packed manifest rather than a literal is what keeps the handshake evidence about
  // the artifact under test: a stale constant here once labelled a 0.6.6 run as 0.6.5.
  const packedVersion = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')).version;
  const clientVersion = typeof packedVersion === 'string' ? packedVersion : '0.0.0';

  const child = spawn(process.execPath, [binPath], {
    cwd: packageDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? tmpdir(), NODE_ENV: 'production' }
  });

  const reader = createInterface({ input: child.stdout });
  /** @type {((line: string) => void)[]} */
  const waiters = [];
  reader.on('line', line => {
    const next = waiters.shift();
    if (next) next(line);
  });

  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });

  /** @param {Record<string, unknown>} message @returns {Promise<any>} */
  const request = message => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for JSON-RPC response to ${String(message.method)}; stderr: ${stderr.trim()}`)), 10000);
    waiters.push(line => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(new Error(`invalid JSON-RPC line "${line}": ${error instanceof Error ? error.message : String(error)}`));
      }
    });
    child.stdin.write(`${JSON.stringify(message)}\n`);
  });

  try {
    // 1. Send `initialize` with protocolVersion `2024-11-05` and verify compatibility negotiation + Navi 0.3.0 protocol support.
    const initReply = await request({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'navi-cleanroom-canary', version: clientVersion }
      }
    });
    const negotiatedVersion = initReply?.result?.protocolVersion;
    const serverName = initReply?.result?.serverInfo?.name;
    const serverVersion = initReply?.result?.serverInfo?.version;
    const initOk = initReply?.jsonrpc === '2.0' && initReply?.id === 1 && negotiatedVersion === '2024-11-05' && serverName === 'navi-mcp-server' && typeof serverVersion === 'string';
    checks.push({
      id: 'mcp-initialize',
      ok: initOk,
      detail: initOk
        ? `negotiated protocolVersion ${negotiatedVersion} with ${serverName}@${serverVersion} (Navi protocol 0.3.0)`
        : `unexpected initialize reply: ${JSON.stringify(initReply)}`
    });

    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

    // 2. Send `tools/list` and verify tool declarations (`navi_navigate`, `navi_execute_action` / `navi_get_actions`, `navi_set_session`).
    const toolsReply = await request({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {}
    });
    /** @type {{name?: string, description?: string, inputSchema?: {type?: string}}[]} */
    const tools = Array.isArray(toolsReply?.result?.tools) ? toolsReply.result.tools : [];
    const names = tools.map(tool => String(tool.name ?? ''));
    const navigateTool = tools.find(tool => tool.name === 'navi_navigate');
    const hasAllCanonical = EXPECTED_MCP_TOOL_NAMES.every(name => names.includes(name));
    const hasActionFamily = names.includes('navi_navigate')
      && names.includes('navi_set_session')
      && (names.includes('navi_action') || (names.includes('navi_execute_action') && names.includes('navi_get_actions')));
    const mentionsNaviProtocol = Boolean(navigateTool?.description?.includes('0.3.0'));
    const schemasValid = tools.length === EXPECTED_MCP_TOOL_NAMES.length && tools.every(tool => tool.inputSchema?.type === 'object');
    const toolsOk = hasAllCanonical && hasActionFamily && mentionsNaviProtocol && schemasValid;
    checks.push({
      id: 'mcp-tools-list',
      ok: toolsOk,
      detail: toolsOk
        ? `tools/list declared ${names.join(', ')} (Navi protocol 0.3.0)`
        : `unexpected tools/list: names=${JSON.stringify(names)}, mentionsProtocol030=${mentionsNaviProtocol}`
    });

    // 3. Send SIGTERM and confirm clean teardown with exit code 0.
    const exitResult = await new Promise(/** @param {(value: {code: number | null, signal: NodeJS.Signals | null, timedOut: boolean}) => void} resolve */ resolve => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve({ code: child.exitCode, signal: child.signalCode, timedOut: false });
        return;
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ code: child.exitCode, signal: child.signalCode, timedOut: true });
      }, 8000);
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, timedOut: false });
      });
      child.kill('SIGTERM');
    });

    const sigtermOk = !exitResult.timedOut && exitResult.code === 0 && exitResult.signal === null;
    checks.push({
      id: 'mcp-sigterm-teardown',
      ok: sigtermOk,
      detail: sigtermOk
        ? 'clean teardown on SIGTERM with exit code 0'
        : `SIGTERM teardown failed: code=${exitResult.code}, signal=${exitResult.signal}, timedOut=${exitResult.timedOut}, stderr=${stderr.trim()}`
    });
  } catch (error) {
    child.kill('SIGKILL');
    checks.push({
      id: 'mcp-handshake-error',
      ok: false,
      detail: error instanceof Error ? error.message : String(error)
    });
  } finally {
    reader.close();
  }

  return checks;
}

/**
 * Parse CLI arguments for `verify-registry-package.mjs`.
 * @param {string[]} argv
 * @returns {{mode: 'tarball' | 'registry', target: string | null, json: boolean, help: boolean} | {error: string}}
 */
export function parseArgs(argv) {
  let mode = /** @type {'tarball' | 'registry'} */ ('tarball');
  /** @type {string | null} */
  let target = null;
  let json = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--tarball') {
      mode = 'tarball';
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        target = next;
        i++;
      }
    } else if (arg === '--registry') {
      mode = 'registry';
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        target = next;
        i++;
      }
    } else {
      return { error: `unknown argument "${arg}"` };
    }
  }
  return { mode, target, json, help };
}

/**
 * Run the clean-room verification against either a local tarball or a registry package spec.
 * @param {{mode?: 'tarball' | 'registry', target?: string | null, expectedSri?: string}} [options]
 * @returns {Promise<{ok: boolean, mode: 'tarball' | 'registry', source: string, checks: CanaryCheck[]}>}
 */
export async function verifyCleanRoomPackage(options = {}) {
  const mode = options.mode ?? 'tarball';
  const workspaceSri = (options.expectedSri ?? readFileSync(join(root, 'dist', 'sri.txt'), 'utf8')).trim();
  const sandbox = await mkdtemp(join(tmpdir(), 'navi-canary-'));

  try {
    let tarballPath = '';
    let sourceLabel = '';

    if (mode === 'tarball' && options.target) {
      tarballPath = resolve(options.target);
      sourceLabel = tarballPath;
      if (!existsSync(tarballPath)) {
        return {
          ok: false,
          mode,
          source: sourceLabel,
          checks: [{ id: 'tarball-source', ok: false, detail: `tarball not found at ${tarballPath}` }]
        };
      }
    } else if (mode === 'registry') {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      const spec = options.target ?? `${pkg.name}@${pkg.version}`;
      sourceLabel = `registry:${spec}`;
      try {
        const out = execFileSync('npm', ['pack', spec, '--pack-destination', sandbox, '--silent'], {
          cwd: sandbox,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe']
        }).trim().split('\n').pop()?.trim() ?? '';
        tarballPath = join(sandbox, out);
      } catch (error) {
        const stderr = /** @type {{stderr?: Buffer | string}} */ (error)?.stderr;
        return {
          ok: false,
          mode,
          source: sourceLabel,
          checks: [{
            id: 'registry-fetch',
            ok: false,
            detail: `npm pack ${spec} failed: ${ stderr ? String(stderr).trim() : (error instanceof Error ? error.message : String(error)) }`
          }]
        };
      }
    } else {
      sourceLabel = 'local npm pack';
      const out = execFileSync('npm', ['pack', '--pack-destination', sandbox, '--silent'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      }).trim().split('\n').pop()?.trim() ?? '';
      tarballPath = join(sandbox, out);
    }

    execFileSync('tar', ['-xzf', tarballPath, '-C', sandbox], { stdio: ['ignore', 'pipe', 'pipe'] });
    const packageDir = join(sandbox, 'package');
    const info = await stat(packageDir).catch(() => null);
    if (!info || !info.isDirectory()) {
      return {
        ok: false,
        mode,
        source: sourceLabel,
        checks: [{ id: 'tarball-extract', ok: false, detail: 'tarball did not unpack a top-level package/ directory' }]
      };
    }

    const files = await listUnpackedFiles(packageDir);
    const pkg = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
    const actualBundleBytes = await readFile(join(packageDir, 'dist', 'navi.min.js')).catch(() => Buffer.alloc(0));
    const actualLoaderBytes = await readFile(join(packageDir, 'dist', 'loader.min.js')).catch(() => Buffer.alloc(0));
    const unpackedSri = await readFile(join(packageDir, 'dist', 'sri.txt'), 'utf8').then(s => s.trim(), () => workspaceSri);

    const layoutChecks = evaluateUnpackedPackage({
      files,
      pkg,
      expectedSri: unpackedSri === workspaceSri ? workspaceSri : `${workspaceSri} (unpacked dist/sri.txt had ${unpackedSri})`,
      actualBundleBytes,
      actualLoaderBytes
    });

    const mcpChecks = await runCleanRoomMcpHandshake(packageDir);
    const checks = [...layoutChecks, ...mcpChecks];
    return {
      ok: checks.every(check => check.ok),
      mode,
      source: sourceLabel,
      checks
    };
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

/** @param {string[]} [argv] @returns {Promise<number>} */
export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    process.stderr.write(`verify-registry-package: ${parsed.error}\n`);
    return 2;
  }
  if (parsed.help) {
    process.stdout.write(
      'Usage: node scripts/verify-registry-package.mjs [--tarball [path.tgz] | --registry [pkg@version]] [--json]\n'
    );
    return 0;
  }

  const result = await verifyCleanRoomPackage({ mode: parsed.mode, target: parsed.target });
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`Navi clean-room package verification (${result.source})\n`);
    for (const check of result.checks) {
      process.stdout.write(`  ${check.ok ? 'ok  ' : 'FAIL'} ${check.id}: ${check.detail}\n`);
    }
    process.stdout.write(result.ok ? 'Clean-room package verified.\n' : 'Clean-room package verification failed.\n');
  }
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
