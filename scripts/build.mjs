import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const SDK_BUDGET = 15000;
const LOADER_BUDGET = 500;
/** @type {import('esbuild').BuildOptions} */
const shared = { bundle: true, sourcemap: false, legalComments: 'none', logLevel: 'warning' };

// Patterns that would break the documented Content-Security-Policy contract
// (`script-src 'self'` with no unsafe-eval, `style-src 'self'` with no
// unsafe-inline). Enforced at build time so the guarantee cannot rot silently.
/** @type {[RegExp, string][]} */
const CSP_FORBIDDEN = [
  [/\beval\s*\(/, 'eval() requires unsafe-eval'],
  [/\bFunction\s*\(/, 'the Function constructor requires unsafe-eval'],
  [/\.cssText\b/, 'cssText assignment is an inline style injection'],
  [/insertAdjacentHTML\s*\(/, 'insertAdjacentHTML can inject inline markup'],
  [/document\s*\.\s*write\s*\(/, 'document.write can inject inline markup'],
  [/createElement\s*\(\s*["']style["']/, 'creating a <style> element is blocked by style-src'],
  [/setAttribute\s*\(\s*["']style["']/, 'setting a style attribute is blocked by style-src']
];

await mkdir('dist', { recursive: true });

// 1. Browser bundle: self-executing, safe for a plain <script> tag or CDN.
await build({ ...shared, entryPoints: ['src/navi.js'], outfile: 'dist/navi.min.js', format: 'iife', minify: true, target: ['es2020'] });
const sdk = await readFile('dist/navi.min.js');
if (sdk.length >= SDK_BUDGET) throw new Error(`navi.min.js is ${sdk.length} bytes: exceeds the strict <${SDK_BUDGET} budget`);
const violations = CSP_FORBIDDEN.filter(([pattern]) => pattern.test(sdk.toString('utf8'))).map(([, reason]) => reason);
if (violations.length) throw new Error(`navi.min.js violates the CSP contract: ${violations.join('; ')}`);

// Subresource Integrity for enterprise <script integrity="..."> tagging.
const integrity = `sha384-${createHash('sha384').update(sdk).digest('base64')}`;
await writeFile('dist/sri.txt', `${integrity}\n`);

// 1b. Tenant embed loader, a self-executing snippet held to a strict <500-byte
// budget. The published SHA-384 is *not* baked in: the hash alone is 71 bytes,
// and carrying it here would push the snippet over budget. It travels in the
// embed tag's data-sri attribute instead, exactly as a standard SRI embed does,
// while the loader still appends `integrity` and `crossorigin` to the script it
// injects. The exact tag to paste is printed at the end of this build.
await build({ ...shared, entryPoints: ['src/loader.js'], outfile: 'dist/loader.min.js', format: 'iife', minify: true, target: ['es2018'] });
const loader = await readFile('dist/loader.min.js');
if (loader.length >= LOADER_BUDGET) throw new Error(`loader.min.js is ${loader.length} bytes: exceeds the strict <${LOADER_BUDGET} budget`);

// 2. Library entry points for ESM and CommonJS consumers (Playwright adapter + flow runner).
await build({ ...shared, entryPoints: ['src/index.js'], outfile: 'dist/index.mjs', format: 'esm', platform: 'node', target: ['node20'] });
// The CJS bundle has no import.meta, so point the SDK path resolution at the emitted file.
await build({ ...shared, entryPoints: ['src/index.js'], outfile: 'dist/index.cjs', format: 'cjs', platform: 'node', target: ['node20'],
  define: { 'import.meta.url': '__naviModuleUrl' },
  banner: { js: "var __naviModuleUrl = require('node:url').pathToFileURL(__filename).href;" } });

// 3. Agent harness CLI.
await build({ ...shared, entryPoints: ['src/cli.js'], outfile: 'dist/cli.mjs', format: 'esm', platform: 'node', target: ['node20'],
  banner: { js: '#!/usr/bin/env node' } });

// 4. MCP server: same browser bootstrap as the CLI, spoken over stdio JSON-RPC.
await build({ ...shared, entryPoints: ['src/mcp/server.js'], outfile: 'dist/mcp.mjs', format: 'esm', platform: 'node', target: ['node20'],
  banner: { js: '#!/usr/bin/env node' } });

// 5. Published types.
await copyFile('types/index.d.ts', 'dist/index.d.ts');
await copyFile('types/navi.d.ts', 'dist/navi.d.ts');

/** @param {string} path */
const bytes = async (path) => (await stat(path)).size;
const artifacts = {
  'dist/navi.min.js': { bytes: sdk.length, gzipBytes: gzipSync(sdk).length, minified: true, budgetBytes: SDK_BUDGET, integrity },
  'dist/index.mjs': { bytes: await bytes('dist/index.mjs'), gzipBytes: gzipSync(await readFile('dist/index.mjs')).length, minified: false },
  'dist/index.cjs': { bytes: await bytes('dist/index.cjs'), gzipBytes: gzipSync(await readFile('dist/index.cjs')).length, minified: false },
  'dist/cli.mjs': { bytes: await bytes('dist/cli.mjs'), gzipBytes: gzipSync(await readFile('dist/cli.mjs')).length, minified: false },
  'dist/mcp.mjs': { bytes: await bytes('dist/mcp.mjs'), gzipBytes: gzipSync(await readFile('dist/mcp.mjs')).length, minified: false },
  'dist/index.d.ts': { bytes: await bytes('dist/index.d.ts'), minified: false },
  'dist/navi.d.ts': { bytes: await bytes('dist/navi.d.ts'), minified: false },
  'dist/loader.min.js': { bytes: loader.length, minified: true, budgetBytes: LOADER_BUDGET }
};
const size = { rawBytes: sdk.length, gzipBytes: artifacts['dist/navi.min.js'].gzipBytes, budgetBytes: SDK_BUDGET, integrity, loaderBytes: loader.length, loaderBudgetBytes: LOADER_BUDGET, artifacts };
await mkdir('reports', { recursive: true });
await writeFile('reports/build.json', JSON.stringify(size, null, 2) + '\n');
console.log(`navi.min.js ${sdk.length} bytes raw, ${size.gzipBytes} gzip (<${SDK_BUDGET} budget)`);
console.log(`loader.min.js ${loader.length} bytes (<${LOADER_BUDGET} budget)`);
console.log('loader embed: <script src="/v1/loader.js" data-key="YOUR_TENANT_KEY" data-sri="' + integrity + '"></script>');
console.log(`integrity ${integrity}`);
for (const [path, meta] of Object.entries(artifacts)) console.log(`  ${path} ${meta.bytes} bytes`);
