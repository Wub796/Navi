#!/usr/bin/env node
// Publish-boundary check: what `npm publish` would actually upload.
//
// `files` in package.json is an allowlist, and this asserts the resolved tarball
// contents rather than trusting the manifest to stay correct. The failure this
// guards against is silent: a scratch probe, a test, a report or a captured
// session travelling to a registry inside a release because someone added a
// directory to `files` or dropped a file next to the ones that ship.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Files npm includes whether or not `files` names them, so they cannot be treated
 * as escapes. `LICENSE` is listed here rather than in `files` on purpose: npm picks
 * it up automatically, and the publish preflight is what insists there is one.
 */
const IMPLICIT = ['package.json', 'README.md', 'LICENSE', 'LICENSE.md', 'LICENCE', 'CHANGELOG.md'];
/**
 * Everything a release is allowed to contain, read from package.json at run time.
 * The manifest is the allowlist: this check asserts the real tarball against it, so
 * a directory added to `files` (or a file that does not belong beside the ones that
 * ship) is caught here rather than in a registry.
 */
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const ALLOWED = [...(Array.isArray(manifest.files) ? manifest.files : []), ...IMPLICIT];
/** Patterns that must never appear in a published tarball, whatever the manifest says. */
const FORBIDDEN = [
  /(^|\/)tests?\//,
  /(^|\/)reports?\//,
  /(^|\/)scripts\//,
  /(^|\/)demo\//,
  /(^|\/)types\//,
  /(^|\/)\.freebuff\//,
  /(^|\/)\.github\//,
  /\.spec\.mjs$/,
  /probe/i,
  /(^|\/)\.env/,
  /telemetry\.db/,
  /storageState/i,
  /\.pem$/,
  /\.key$/,
  /(^|\/)\.npmrc$/
];

let raw = '';
try {
  raw = execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (error) {
  const stderr = /** @type {{stderr?: Buffer | string}} */ (error)?.stderr;
  process.stderr.write(`pack-check: npm pack --dry-run failed: ${error instanceof Error ? error.message : String(error)}\n`);
  if (stderr) process.stderr.write(String(stderr));
  process.exit(1);
}

/** @type {{ files?: { path?: string }[] }[]} */
let report;
try {
  report = JSON.parse(raw);
} catch (error) {
  process.stderr.write(`pack-check: could not parse the pack report: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

const files = (report[0]?.files ?? []).map(entry => entry.path).filter(/** @returns {path is string} */ path => typeof path === 'string');
if (!files.length) {
  process.stderr.write('pack-check: the pack report listed no files, which means the check cannot prove anything.\n');
  process.exit(1);
}

const outside = files.filter(path => !ALLOWED.some(allowed => path === allowed || path.startsWith(allowed)));
const leaked = files.filter(path => FORBIDDEN.some(pattern => pattern.test(path)));
const missing = ['dist/navi.min.js', 'dist/index.mjs', 'dist/index.cjs', 'dist/index.d.ts', 'dist/navi.d.ts', 'dist/cli.mjs', 'dist/mcp.mjs', 'dist/loader.min.js']
  .filter(path => !files.includes(path));

const bytes = (/** @type {{files?: {path?: string, size?: number}[]}[]} */ (report))[0]?.files ?? [];
const total = bytes.reduce((sum, entry) => sum + (typeof entry.size === 'number' ? entry.size : 0), 0);
console.log(`pack-check: ${files.length} files, ${total} bytes unpacked`);
for (const path of [...files].sort()) console.log(`  ${path}`);

if (outside.length) process.stderr.write(`\npack-check: ${outside.length} file(s) outside package.json's \`files\` allowlist (${ALLOWED.join(', ')}): ${outside.join(', ')}\n`);
if (leaked.length) process.stderr.write(`\npack-check: ${leaked.length} file(s) matching a forbidden pattern: ${leaked.join(', ')}\n`);
if (missing.length) process.stderr.write(`\npack-check: ${missing.length} required release artifact(s) absent: ${missing.join(', ')}\n`);
if (outside.length || leaked.length || missing.length) process.exit(1);
console.log(`pack-check: every published path is an intended release artifact (${ALLOWED.length} allowed entries, ${files.length} shipped).`);
