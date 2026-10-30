#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const entry = path.join(repoRoot, 'scripts/worker/index.ts');
const outFile = path.join(repoRoot, 'dist/worker/o8-worker.mjs');

await mkdir(path.dirname(outFile), { recursive: true });

await esbuild.build({
  entryPoints: [entry],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  alias: { 'server-only': path.join(repoRoot, 'scripts/server-only-stub.js') },
  target: 'node22',
  format: 'esm',
  sourcemap: false,
  minify: false,
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
});

console.log(`[build-worker] wrote ${outFile}`);
