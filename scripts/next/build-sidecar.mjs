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
const supported = ['aarch64-apple-darwin', 'x86_64-apple-darwin'];
const buildTarget = requested || 'universal-apple-darwin';
if (![...supported, 'universal-apple-darwin'].includes(buildTarget)) {
  console.error('[o8-next] unsupported macOS sidecar target');
  process.exit(1);
}
const triples = buildTarget === 'universal-apple-darwin' ? supported : [buildTarget];
const directory = join(root, 'src-tauri/helpers');
const target = join(root, 'native/o8-next/target');
const names = ['o8-next', ...[...supported, 'universal-apple-darwin'].map(triple => `o8-next-${triple}`)];
const outputs = [...names, NEXT_BUILD_RECEIPT];
mkdirSync(directory, { recursive: true });
for (const name of outputs) rmSync(join(directory, name), { force: true });
try {
  const commit = nextBuildCommit(root);
  for (const triple of triples) {
    execFileSync('cargo', ['build', '--release', '--locked', '--manifest-path', join(root, 'native/o8-next/Cargo.toml'),
      '--target', triple, '--target-dir', target], { stdio: 'inherit' });
    const staged = join(directory, `o8-next-${triple}`);
    copyFileSync(join(target, triple, 'release/o8-next'), staged);
    // Keep Cargo's unstripped output for symbolication. Strip only the bundled
    // copy, retaining external symbols, before recording its build identity.
    execFileSync('strip', ['-x', staged], { stdio: 'inherit' });
    chmodSync(staged, 0o755);
  }
  const binary = join(directory, `o8-next-${buildTarget}`);
  if (buildTarget === 'universal-apple-darwin') {
    execFileSync('lipo', ['-create', '-output', binary, ...triples.map(triple => join(directory, `o8-next-${triple}`))], { stdio: 'inherit' });
  }
  copyFileSync(binary, join(directory, 'o8-next'));
  chmodSync(binary, 0o755);
  chmodSync(join(directory, 'o8-next'), 0o755);
  if (nextBuildCommit(root) !== commit) throw new Error('build commit changed');
  writeFileSync(join(directory, NEXT_BUILD_RECEIPT), `${JSON.stringify(nextBuildIdentity(binary, commit), null, 2)}\n`);
  console.log(`[o8-next] staged ${buildTarget} release sidecar`);
} catch {
  for (const name of outputs) rmSync(join(directory, name), { force: true });
  console.error('[o8-next] release sidecar build failed; no binary staged');
  process.exitCode = 1;
}
