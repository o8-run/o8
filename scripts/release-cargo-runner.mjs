#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { NATIVE_ARTIFACT } from './lib/release-native-inputs.mjs';
import { collectReleaseBuildCacheIdentity, isReleaseBuildCacheSafetyError, restoreReleaseBuildCache, writeReleaseBuildCachePhaseReceipt } from './lib/release-build-cache.mjs';
import { pruneReleaseCargoTarget, releaseCargoTarget } from './lib/release-cargo-target.mjs';

const root = process.env.O8_RELEASE_NATIVE_ROOT;
if (!root) throw new Error('Release Cargo runner requires the release build wrapper.');
const args = process.argv.slice(2);
if (args[0] !== 'build' || (!args.includes('--release') && !args.includes('--profile=release')))
  throw new Error('Release Cargo runner accepts only release builds.');
const index = args.indexOf('--target');
const triple = index >= 0 ? args[index + 1] : args.find(arg => arg.startsWith('--target='))?.slice(9) || '';
if (triple && !/^[a-zA-Z0-9_-]+$/.test(triple)) throw new Error('Invalid release Cargo target triple.');
const binary = join(triple, 'release', 'o8');
const artifact = join(root, NATIVE_ARTIFACT);
const output = join(root, 'src-tauri/target');
const host = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`;
const helperNames = [`speech_recognizer-${triple || host}`, 'speech_recognizer-universal-apple-darwin'];

function copy(from, to) {
  const metadata = lstatSync(from);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1)
    throw new Error('Release native artifact must be a private regular file.');
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

// Tauri has completed prebuild before it invokes its Cargo runner. Snapshot the
// compiled inputs here, once for both slices, rather than before generation.
const context = JSON.parse(readFileSync(process.env.O8_RELEASE_NATIVE_CONTEXT, 'utf8'));
const statePath = process.env.O8_RELEASE_NATIVE_STATE;
let state;
try {
  const identity = collectReleaseBuildCacheIdentity(root, 'native', {
    ...context, env: { ...process.env, TAURI_CONFIG: context.configEnvironment.TAURI_CONFIG },
  });
  if (existsSync(statePath)) {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
    if (state.identity?.entrySha256 !== identity.entrySha256) state.invalidated = true;
  } else {
    const restore = await restoreReleaseBuildCache(root, 'native', { ...context, identity,
      cacheRoot: process.env.O8_RELEASE_BUILD_CACHE_DIR, runId: process.env.O8_RELEASE_CACHE_RUN_ID });
    state = { identity, restore };
  }
} catch (error) {
  if (isReleaseBuildCacheSafetyError(error)) throw error;
  state = { identity: null, invalidated: true, restore: { phase: 'native', status: 'miss',
    reason: `cache_unavailable:${error.message}`, durationMs: 0 } };
}
console.log(`[release-cache] native restore=${state.restore.status} reason=${state.restore.reason}`);
writeReleaseBuildCachePhaseReceipt(process.env.O8_RELEASE_BUILD_CACHE_DIR, process.env.O8_RELEASE_CACHE_RUN_ID,
  { phase: 'native', restore: state.restore });
writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
const verifiedHit = !state.invalidated && state.restore.status.startsWith('hit_');

function copySymbols(from, to, allowedRoot) {
  if (!existsSync(from)) return;
  const resolved = realpathSync(from);
  const path = relative(realpathSync(allowedRoot), resolved);
  if (path === '..' || path.startsWith('..' + sep)) throw new Error('Native symbols escape the build output.');
  cpSync(resolved, to, { recursive: true, dereference: true });
}
if (verifiedHit && existsSync(join(artifact, 'target', binary))
  && helperNames.every(name => existsSync(join(artifact, 'helpers', name)))) {
  copy(join(artifact, 'target', binary), join(output, binary));
  copySymbols(join(artifact, 'target', binary + '.dSYM'), join(output, binary + '.dSYM'), artifact);
  for (const name of helperNames) copy(join(artifact, 'helpers', name), join(root, 'src-tauri/helpers', name));
  copy(join(artifact, 'helpers', 'speech_recognizer-universal-apple-darwin'), join(output, triple, 'release/speech_recognizer'));
  console.log(`[release-cache] native compiler skipped target=${triple || 'host'} (verified executable cache)`);
} else {
  const target = releaseCargoTarget(root, process.env.O8_RELEASE_BUILD_CACHE_DIR);
  const lock = join(target.path, '.o8-release-cargo-lock');
  mkdirSync(lock, { mode: 0o700 });
  try {
    pruneReleaseCargoTarget(target);
    const compilerEnv = { ...process.env, CARGO_TARGET_DIR: target.path };
    const clean = spawnSync('cargo', ['clean', '--package', 'o8', '--release', ...(triple ? ['--target', triple] : [])], {
      cwd: process.cwd(), env: compilerEnv, stdio: 'inherit',
    });
    if (clean.error) throw clean.error;
    if (clean.status !== 0) throw new Error(`Release native package clean failed with exit ${clean.status ?? 'unknown'}`);
    // build.rs uses mtimes for these Swift outputs. Reset them on an artifact
    // miss so SDK, compiler and deployment-target changes cannot reuse old bytes.
    for (const name of ['speech_recognizer', 'speech_recognizer-aarch64-apple-darwin', 'speech_recognizer-x86_64-apple-darwin'])
      rmSync(join(target.path, triple, 'release', name), { force: true });
    const build = spawnSync('cargo', args, { cwd: process.cwd(),
      env: compilerEnv, stdio: 'inherit' });
    if (build.error) throw build.error;
    if (build.status !== 0) throw new Error(`Release Cargo build failed with exit ${build.status ?? 'unknown'}`);
    // Snapshot executables before Tauri bundles them. Cargo's path-bearing build
    // metadata stays in the persistent release-only directory, never the archive.
    copy(join(target.path, binary), join(output, binary));
    copy(join(target.path, binary), join(artifact, 'target', binary));
    copySymbols(join(target.path, binary + '.dSYM'), join(artifact, 'target', binary + '.dSYM'), target.path);
    copySymbols(join(target.path, binary + '.dSYM'), join(output, binary + '.dSYM'), target.path);
    for (const name of helperNames)
      copy(join(root, 'src-tauri/helpers', name), join(artifact, 'helpers', name));
    copy(join(target.path, triple, 'release/speech_recognizer'), join(output, triple, 'release/speech_recognizer'));
    pruneReleaseCargoTarget(target);
  } finally { rmdirSync(lock); }
}
