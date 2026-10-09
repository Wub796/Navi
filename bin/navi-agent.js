#!/usr/bin/env node
// Executable entry for the Navi agent harness.
// The implementation ships in dist/cli.mjs so this launcher stays trivial.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const candidates = [resolve(here, '../dist/cli.mjs'), resolve(here, '../src/cli.js')];
const entry = candidates.find(candidate => existsSync(candidate));
if (!entry) {
  process.stderr.write('error: missing build output. Run "npm run build" first.\n');
  process.exitCode = 3;
} else {
  const { main } = await import(pathToFileURL(entry).href);
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
