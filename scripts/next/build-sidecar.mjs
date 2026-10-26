#!/usr/bin/env node
// Stage the GPUI sidecar under the names Tauri externalBin signs and bundles.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NEXT_BUILD_RECEIPT, nextBuildCommit, nextBuildIdentity } from './build-identity.mjs';

const root = process.cwd();
const requested = process.env.O8_TAURI_BUILD_TARGET || process.env.TAURI_ENV_TARGET_TRIPLE || '';
if (process.platform !== 'darwin' && !requested.endsWith('-apple-darwin')) {
  console.log('[o8-next] macOS sidecar build skipped');
  process.exit(0);
}
const triples = ['aarch64-apple-darwin', 'x86_64-apple-darwin'];
const directory = join(root, 'src-tauri/helpers');
const target = join(root, 'native/o8-next/target');
const names = ['o8-next', ...[...triples, 'universal-apple-darwin'].map(triple => `o8-next-${triple}`)];
const outputs = [...names, NEXT_BUILD_RECEIPT];
mkdirSync(directory, { recursive: true });
for (const name of outputs) rmSync(join(directory, name), { force: true });
try {
  const commit = nextBuildCommit(root);
  for (const triple of triples) {
    execFileSync('cargo', ['build', '--release', '--locked', '--manifest-path', join(root, 'native/o8-next/Cargo.toml'),
      '--target', triple, '--target-dir', target], { stdio: 'inherit' });
  }
  const universal = join(target, 'o8-next-universal');
  execFileSync('lipo', ['-create', '-output', universal, ...triples.map(triple => join(target, triple, 'release/o8-next'))], { stdio: 'inherit' });
  for (const name of names) {
    const triple = triples.find(triple => name === `o8-next-${triple}`);
    copyFileSync(triple ? join(target, triple, 'release/o8-next') : universal, join(directory, name));
    chmodSync(join(directory, name), 0o755);
  }
  if (nextBuildCommit(root) !== commit) throw new Error('build commit changed');
  writeFileSync(join(directory, NEXT_BUILD_RECEIPT), `${JSON.stringify(nextBuildIdentity(universal, commit), null, 2)}\n`);
  console.log('[o8-next] staged arm64, x86_64 and universal release sidecars');
} catch {
  for (const name of outputs) rmSync(join(directory, name), { force: true });
  console.error('[o8-next] release sidecar build failed; no binary staged');
  process.exitCode = 1;
}
