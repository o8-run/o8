#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  collectReleaseArtifactRecipe,
  verifyReleaseArtifactManifest,
  writeReleaseArtifactManifest,
} from './release-artifacts.mjs';
import {
  captureReleaseBuildCache,
  collectReleaseBuildCacheIdentity,
  createReleaseBuildCacheRunId,
  finalizeReleaseBuildCacheReceipt,
  isReleaseBuildCacheSafetyError,
  resolveReleaseBuildCacheRoot,
  restoreReleaseBuildCache,
  writeReleaseBuildCachePhaseReceipt,
} from './release-build-cache.mjs';
import { resolveReleaseBuildEnvironment } from './release-config.mjs';

/** Probe before registration creates any output, while the caller owns exclusion. */
export function prebuildPreflight() {
  const result = spawnSync(process.execPath, ['scripts/preship-cleanup.mjs'], {
    cwd: process.cwd(), env: process.env, stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`stale-build preflight failed with exit ${result.status ?? 'unknown'}`);
}

/** Called with one live generated-output exclusion; build enters its producer only once. */
export async function runPrebuild({ runBuild, canReuse }) {
  const root = process.cwd();
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const env = process.env;
  const buildEnv = resolveReleaseBuildEnvironment(root, env);
  let producerRun;
  if (buildEnv.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY !== env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    // Registered build phases also read process.env, so retain prebuild's
    // existing process-wide propagation of this one public client setting.
    env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = buildEnv.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    console.log('[tauri-prebuild] Clerk publishable key loaded from release config');
  }
  const cacheRoot = resolveReleaseBuildCacheRoot(env);
  const cacheRunId = env.O8_RELEASE_CACHE_RUN_ID || createReleaseBuildCacheRunId();
  const ownsCacheRun = !env.O8_RELEASE_CACHE_RUN_ID;
  const prebuildStartedAt = Date.now();
  let cacheSource = { head: 'unavailable' };
  let cacheOutcome = 'FAIL';

  async function phase(label, command, args) {
    const started = Date.now();
    console.log(`[tauri-prebuild] ${label} started`);
    const result = producerRun
      ? { status: await producerRun(command, args, env) }
      : spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${label} failed with exit ${result.status ?? 'unknown'} after ${seconds}s`);
    console.log(`[tauri-prebuild] ${label} completed in ${seconds}s`);
    return Date.now() - started;
  }

  async function cachedPhase(cachePhase, label, command, args) {
    const identityOptions = { env };
    let identity;
    let restore;
    try {
      identity = collectReleaseBuildCacheIdentity(root, cachePhase, identityOptions);
      cacheSource = identity.source;
      restore = await restoreReleaseBuildCache(root, cachePhase, { cacheRoot, identity, runId: cacheRunId });
    } catch (error) {
      if (isReleaseBuildCacheSafetyError(error)) throw error;
      restore = {
        phase: cachePhase,
        status: 'miss',
        reason: `cache_unavailable:${error instanceof Error ? error.message : String(error)}`,
        durationMs: 0,
      };
    }
    console.log(
      `[release-cache] ${cachePhase} restore=${restore.status} reason=${restore.reason}`
      + ` bytes=${restore.archiveBytes ?? 0} duration=${restore.durationMs}ms`,
    );
    const buildStarted = Date.now();
    if (cachePhase === 'web') {
      const { runRegisteredBuild } = await import('./registered-build.mjs');
      const code = await runRegisteredBuild(producerRun);
      if (code !== 0) throw new Error(`web build failed with exit ${code}`);
    } else if (restore.status === 'hit_exact' || restore.status === 'hit_compatible') {
      console.log(`[tauri-prebuild] ${label} skipped (verified executable cache)`);
    } else await phase(label, command, args);
    const buildDurationMs = Date.now() - buildStarted;
    let capture;
    try {
      identity = identity ?? collectReleaseBuildCacheIdentity(root, cachePhase, identityOptions);
      capture = await captureReleaseBuildCache(root, cachePhase, {
        cacheRoot,
        runId: cacheRunId,
        identity,
        buildDurationMs,
      });
    } catch (error) {
      if (isReleaseBuildCacheSafetyError(error)) throw error;
      capture = {
        phase: cachePhase,
        status: 'miss',
        reason: `capture_unavailable:${error instanceof Error ? error.message : String(error)}`,
        durationMs: 0,
      };
    }
    console.log(
      `[release-cache] ${cachePhase} capture=${capture.status} reason=${capture.reason}`
      + ` bytes=${capture.archiveBytes ?? 0} duration=${capture.durationMs}ms`,
    );
    writeReleaseBuildCachePhaseReceipt(cacheRoot, cacheRunId, {
      phase: cachePhase,
      restore,
      buildDurationMs,
      capture,
    });
  }

  try {
    const recipe = collectReleaseArtifactRecipe(root, version, { env });
    cacheSource = { head: recipe.head };
    const verification = verifyReleaseArtifactManifest(root, recipe);
    if (canReuse && verification.reusable) {
      console.log(`[tauri-prebuild] reused verified artifact ${recipe.recipeSha256.slice(0, 16)} (${verification.manifest.outputs.length} checksums)`);
      for (const cachePhase of ['speech', 'web']) {
        writeReleaseBuildCachePhaseReceipt(cacheRoot, cacheRunId, {
          phase: cachePhase,
          restore: { phase: cachePhase, status: 'bypass', reason: 'exact_artifact_reused', durationMs: 0 },
        });
      }
      process.exitCode = 0;
    } else {
      const buildCode = await runBuild(async run => {
        producerRun = run;
        console.log(`[tauri-prebuild] rebuilding artifact: ${verification.reason}`);
        await cachedPhase('speech', 'speech sidecar', process.execPath, ['scripts/build-speech-local.mjs']);
        await phase('Pi write helper', process.execPath, ['scripts/build-pi-write.mjs']);
        await cachedPhase('web', 'web build', 'npm', ['run', 'build']);
        await phase('Tauri export', process.execPath, ['scripts/tauri-export.mjs']);
        const receipt = writeReleaseArtifactManifest(root, recipe);
        console.log(`[tauri-prebuild] verified artifact ${recipe.recipeSha256.slice(0, 16)} (${receipt.manifest.outputs.length} checksums)`);
        await phase('packaged server smoke', process.execPath, ['scripts/packaged-server-smoke.mjs']);
        return 0;
      });
      producerRun = undefined;
      if (buildCode !== 0) throw new Error(`prebuild producer failed with exit ${buildCode}`);
    }
    if (canReuse && verification.reusable) await phase('packaged server smoke', process.execPath, ['scripts/packaged-server-smoke.mjs']);
    cacheOutcome = 'PASS';
    if (env.O8_RELEASE_CACHE_PREBUILD_MARKER) {
      writeFileSync(env.O8_RELEASE_CACHE_PREBUILD_MARKER, `${Date.now()}\n`, { mode: 0o600 });
    }
  } finally {
    if (ownsCacheRun) {
      try {
        const finalized = await finalizeReleaseBuildCacheReceipt(cacheRoot, cacheRunId, {
          outcome: cacheOutcome,
          source: cacheSource,
          buildDurationMs: Date.now() - prebuildStartedAt,
        }, { projectRoot: root });
        console.log(`[release-cache] receipt ${finalized.receiptPath}`);
      } catch (error) {
        if (isReleaseBuildCacheSafetyError(error)) throw error;
        console.warn(`[release-cache] receipt unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return 0;
}
