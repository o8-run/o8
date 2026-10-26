#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMachOArchitectures } from '../lib/macos-release-artifacts.mjs';
import { verifyNextBuildIdentity } from './build-identity.mjs';

/** Release-only gate, after signing. The app's existing notary flow covers its sealed sidecars. */
export function verifyNextAppSidecar(app) {
  const binary = join(app, 'Contents/MacOS/o8-next');
  if (!existsSync(binary)) throw new Error('o8 next sidecar is missing from the app bundle');
  const metadata = lstatSync(binary);
  if (!metadata.isFile() || !(metadata.mode & 0o111)) throw new Error('o8 next sidecar must be a regular executable');
  const required = readMachOArchitectures(join(app, 'Contents/MacOS/o8'));
  const actual = readMachOArchitectures(binary);
  if (JSON.stringify(actual.slice().sort()) !== JSON.stringify(required.slice().sort())) throw new Error('o8 next sidecar architecture does not match the app');
  const build = verifyNextBuildIdentity(app, actual);
  try {
    execFileSync('codesign', ['--verify', '--strict', '--verbose=2', binary], { stdio: 'pipe' });
    execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' });
    const identity = path => {
      const result = spawnSync('codesign', ['--display', '--verbose=4', path], { encoding: 'utf8' });
      if (result.error || result.status !== 0) throw new Error('signature metadata unavailable');
      const text = result.stdout + result.stderr;
      return { team: text.match(/^TeamIdentifier=(.+)$/m)?.[1], runtime: /flags=.*\(.*runtime.*\)/.test(text) };
    };
    const sidecar = identity(binary); const outer = identity(app);
    if (!sidecar.team || sidecar.team === 'not set' || sidecar.team !== outer.team || !sidecar.runtime) {
      throw new Error('sidecar must use the app signing team and hardened runtime');
    }
  } catch { throw new Error('o8 next signing coverage verification failed'); }
  return { architectures: actual, bytes: metadata.size, ...build };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv[2]) throw new Error('usage: verify-app-bundle.mjs APP');
    console.log('[o8-next] app sidecar verified', verifyNextAppSidecar(resolve(process.argv[2])));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
