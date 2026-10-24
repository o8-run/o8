#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { parse as parseToml } from 'smol-toml';
import { releaseCargoTarget } from './lib/release-cargo-target.mjs';
import { resolveReleaseBuildEnvironment } from './lib/release-config.mjs';
import { nativeCacheRestoreGuard } from './lib/release-native-inputs.mjs';
import {
  captureReleaseBuildCache,
  collectReleaseBuildCacheIdentity,
  createReleaseBuildCacheRunId,
  finalizeReleaseBuildCacheReceipt,
  isReleaseBuildCacheSafetyError,
  resolveReleaseBuildCacheRoot,
  restoreReleaseBuildCache,
  writeReleaseBuildCachePhaseReceipt,
} from './lib/release-build-cache.mjs';

const root = process.cwd();
const startedAt = Date.now();
const runId = createReleaseBuildCacheRunId();
const cacheRoot = resolveReleaseBuildCacheRoot();
const buildEnv = resolveReleaseBuildEnvironment(root);
const cargoTauriArgs = process.argv.slice(2);
const targetFlagIndex = cargoTauriArgs.indexOf('--target');
const requestedTarget = targetFlagIndex >= 0 ? cargoTauriArgs[targetFlagIndex + 1]
  : cargoTauriArgs.find(arg => arg.startsWith('--target='))?.slice(9);
const nativeArtifact = (requestedTarget?.endsWith('-apple-darwin') || (!requestedTarget && process.platform === 'darwin'))
  && !cargoTauriArgs.some(arg => arg === '--debug' || arg === '--runner' || arg.startsWith('--runner=') || arg.startsWith('--profile') || arg.startsWith('--target-dir'));
const persistentTarget = nativeArtifact ? releaseCargoTarget(root, cacheRoot).path : undefined;
const nativeBuildOptions = { cargoTauriArgs, ...(nativeArtifact ? {
  nativeArtifact: true,
  // Until native runtime version reporting is externalized, a cached executable
  // must retain its embedded Cargo/Tauri version identity.
  binaryVersions: {
    package: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
    cargo: parseToml(readFileSync(join(root, 'src-tauri/Cargo.toml'), 'utf8')).package.version,
    tauri: JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8')).version,
  },
} : {}) };
const prebuildMarker = join(cacheRoot, 'runs', runId, 'prebuild-completed-at');
let nativeIdentity;
let nativeRestore;

try {
  nativeIdentity = collectReleaseBuildCacheIdentity(root, 'native', { env: buildEnv, buildOptions: nativeBuildOptions });
  nativeRestore = await restoreReleaseBuildCache(root, 'native', {
    cacheRoot,
    runId,
    identity: nativeIdentity,
    buildOptions: nativeBuildOptions,
    env: buildEnv,
  });
} catch (error) {
  if (isReleaseBuildCacheSafetyError(error)) throw error;
  nativeRestore = {
    phase: 'native',
    status: 'miss',
    reason: `cache_unavailable:${error instanceof Error ? error.message : String(error)}`,
    durationMs: Date.now() - startedAt,
  };
}
console.log(
  `[release-cache] native restore=${nativeRestore.status} reason=${nativeRestore.reason}`
  + ` bytes=${nativeRestore.archiveBytes ?? 0} duration=${nativeRestore.durationMs}ms`,
);
writeReleaseBuildCachePhaseReceipt(cacheRoot, runId, { phase: 'native', restore: nativeRestore });

const env = {
  ...buildEnv,
  O8_RELEASE_BUILD_CACHE_DIR: cacheRoot,
  O8_RELEASE_CACHE_RUN_ID: runId,
  O8_RELEASE_CACHE_PREBUILD_MARKER: prebuildMarker,
  ...(nativeArtifact ? {
    O8_RELEASE_NATIVE_ROOT: root,
    O8_RELEASE_NATIVE_CACHE_HIT: nativeRestore.status.startsWith('hit_') ? '1' : '0',
    O8_RELEASE_NATIVE_CACHE_GUARD: nativeIdentity ? nativeCacheRestoreGuard(nativeIdentity) : '',
    O8_RELEASE_CARGO_TARGET_DIR: persistentTarget,
    CARGO_TARGET_DIR: join(root, 'src-tauri/target'),
  } : {}),
  ...(requestedTarget ? { O8_TAURI_BUILD_TARGET: requestedTarget } : {}),
};
const runnerArgs = nativeArtifact
  ? ['--runner', fileURLToPath(new URL('./release-cargo-runner.mjs', import.meta.url))] : [];
const build = spawnSync('cargo', ['tauri', 'build', ...runnerArgs, ...cargoTauriArgs], {
  cwd: root,
  env,
  stdio: 'inherit',
});
const buildDurationMs = Date.now() - startedAt;
const prebuildCompletedAt = existsSync(prebuildMarker)
  ? Number.parseInt(readFileSync(prebuildMarker, 'utf8').trim(), 10)
  : Number.NaN;
const nativeBuildDurationMs = Number.isFinite(prebuildCompletedAt)
  ? Math.max(0, Date.now() - prebuildCompletedAt)
  : buildDurationMs;
let nativeCapture;
if (!build.error && build.status === 0) {
  try {
    const builtIdentity = collectReleaseBuildCacheIdentity(root, 'native', { env: buildEnv, buildOptions: nativeBuildOptions });
    nativeCapture = !nativeIdentity || nativeIdentity.entrySha256 !== builtIdentity.entrySha256 ? {
      phase: 'native',
      status: 'bypass',
      reason: nativeIdentity ? 'source_changed_during_build' : 'source_identity_unavailable',
      durationMs: 0,
    } : await captureReleaseBuildCache(root, 'native', {
      cacheRoot,
      runId,
      identity: builtIdentity,
      buildDurationMs: nativeBuildDurationMs,
      buildOptions: nativeBuildOptions,
      env: buildEnv,
    });
  } catch (error) {
    if (isReleaseBuildCacheSafetyError(error)) throw error;
    nativeCapture = {
      phase: 'native',
      status: 'miss',
      reason: `capture_unavailable:${error instanceof Error ? error.message : String(error)}`,
      durationMs: 0,
    };
  }
  console.log(
    `[release-cache] native capture=${nativeCapture.status} reason=${nativeCapture.reason}`
    + ` bytes=${nativeCapture.archiveBytes ?? 0} duration=${nativeCapture.durationMs}ms`,
  );
  writeReleaseBuildCachePhaseReceipt(cacheRoot, runId, {
    phase: 'native',
    restore: nativeRestore,
    buildDurationMs: nativeBuildDurationMs,
    capture: nativeCapture,
  });
}

let finalized;
try {
  finalized = await finalizeReleaseBuildCacheReceipt(cacheRoot, runId, {
    outcome: !build.error && build.status === 0 ? 'PASS' : 'FAIL',
    source: nativeIdentity?.source ?? { head: 'unavailable' },
    buildDurationMs,
  }, { projectRoot: root });
  const totals = finalized.receipt.totals ?? {};
  console.log(
    `[release-cache] receipt ${finalized.receiptPath}`
    + ` hits=${totals.hits ?? 0} misses=${totals.misses ?? 0}`
    + ` restored=${totals.archiveBytesRestored ?? 0} estimated-saved=${totals.estimatedSavedMs ?? 0}ms`,
  );
} catch (error) {
  if (isReleaseBuildCacheSafetyError(error)) throw error;
  console.warn(`[release-cache] receipt unavailable: ${error instanceof Error ? error.message : String(error)}`);
}

if (build.error) throw build.error;
process.exit(build.status ?? 1);
