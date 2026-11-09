#!/usr/bin/env node
// Bundles cli/src/index.ts into cli/dist/o8.mjs as a single-file ESM Node binary.
// Mirrors the standalone-bundle pattern in scripts/tauri-export.mjs.

import * as esbuild from 'esbuild';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliBundleAlias } from './bundle-alias.mjs';
import { ESM_BANNER, cliBuildOptions } from './build-options.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerOutputIndex = process.argv.indexOf('--worker-output');
const workerOutput = workerOutputIndex < 0 ? null : process.argv[workerOutputIndex + 1];
if (workerOutputIndex >= 0 && !workerOutput) throw new Error('--worker-output requires a destination');
const outFile = workerOutput ? resolve(workerOutput) : join(__dirname, 'dist', 'o8.mjs');
mkdirSync(dirname(outFile), { recursive: true });

// Inject the app version (repo-root package.json, kept in sync by
// scripts/sync-version.mjs) so the bundled `o8 version` reports what it
// shipped with instead of the dev placeholder.
const rootPkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
const cliVersion = rootPkg.version ?? '0.0.0-dev';

await esbuild.build(cliBuildOptions({ outfile: outFile, version: cliVersion }));

chmodSync(outFile, 0o755);
// Worker launches build only their run-owned CLI from current source inputs.
if (workerOutput) process.exit(0);
// Keep the private PTY setup flow in a separate bundle. It can use the server's
// encrypted storage implementation without adding native modules to every CLI command.
await esbuild.build({
  entryPoints: [join(__dirname, '..', 'scripts', 'connect-native-worker.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: { js: ESM_BANNER },
  alias: {
    '@': join(__dirname, '..', 'src'),
    ...cliBundleAlias,
  },
  external: ['node-pty'],
  outfile: join(__dirname, 'dist', 'worker-login.mjs'),
});
console.log(`built ${outFile}`);
