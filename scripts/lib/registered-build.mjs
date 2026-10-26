import { createRequire } from 'node:module';
import { existsSync, lstatSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { resolveReleaseConfig } from './release-config.mjs';
import { assertTauriExportInputsSafe } from './tauri-export-safety.mjs';

/** Invoked only after generated-output exclusion and producer reservation. */
export async function runRegisteredBuild(run) {
  const root = process.cwd();
  const require = createRequire(join(root, 'package.json'));
  const heapMiB = process.env.O8_BUILD_HEAP_MIB === undefined ? 24576 : Number(process.env.O8_BUILD_HEAP_MIB);
  if (!Number.isSafeInteger(heapMiB) || heapMiB < 1024 || heapMiB > 24576) {
    throw new Error('O8_BUILD_HEAP_MIB must be an integer from 1024 through 24576.');
  }
  const bust = await run(process.execPath, ['scripts/bust-stale-patch-cache.mjs']);
  if (bust !== 0) return bust;
  const env = { ...process.env };
  const releaseConfig = resolveReleaseConfig(root, env);
  if (!env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && releaseConfig.clerkPublishableKey) {
    env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = releaseConfig.clerkPublishableKey;
    console.log('[build] Clerk publishable key loaded from release config');
  }
  for (const key of ['TURBOPACK', 'NEXT_DEPLOYMENT_ID', '__NEXT_PRIVATE_ORIGIN', '__NEXT_PRIVATE_STANDALONE_CONFIG']) {
    delete env[key];
  }
  const buildOutput = run.buildOutput?.directory || join(root, '.next');
  if (run.buildOutput) {
    const distDir = relative(root, buildOutput).split('\\').join('/');
    if (distDir !== '.next/.o8-release-build') throw new Error('Build output reservation is invalid.');
    env.O8_RELEASE_NEXT_DIST_DIR = distDir;
    const cache = join(root, '.next/cache');
    if (existsSync(cache)) renameSync(cache, join(buildOutput, 'cache'));
  }
  if (!run.buildOutput) delete env.O8_RELEASE_NEXT_DIST_DIR;
  env.NODE_ENV = 'production';
  env.NODE_OPTIONS = `--max-old-space-size=${heapMiB}`;
  const code = await run(process.execPath, [require.resolve('next/dist/bin/next'), 'build', '--webpack'], env);
  if (code !== 0) return code;
  const standalone = join(buildOutput, 'standalone');
  if (!lstatSync(standalone, { throwIfNoEntry: false })) {
    await run.buildOutput?.complete();
    return 0;
  }
  for (const path of [buildOutput, standalone]) {
    const entry = lstatSync(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Standalone output must be an isolated generated directory.');
  }
  // Next explicitly copies these after tracing, bypassing tracing exclusions.
  // The packaged server gets its environment at launch, never from this checkout.
  for (const name of ['.env', '.env.production']) {
    const path = join(standalone, name);
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (!entry) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Standalone environment copy must be a regular generated file.');
    rmSync(path);
  }
  if (run.buildOutput) {
    // Normalize the private compiler layout before packaging its own output.
    const nested = join(standalone, env.O8_RELEASE_NEXT_DIST_DIR);
    if (existsSync(nested)) {
      const normalized = join(standalone, '.next-runtime');
      renameSync(nested, normalized);
      rmdirSync(join(standalone, '.next'));
      renameSync(normalized, join(standalone, '.next'));
    }
    const server = join(standalone, 'server.js');
    if (existsSync(server)) writeFileSync(server, readFileSync(server, 'utf8')
      .replaceAll(JSON.stringify(env.O8_RELEASE_NEXT_DIST_DIR), JSON.stringify('.next'))
      .replaceAll(JSON.stringify('./' + env.O8_RELEASE_NEXT_DIST_DIR), JSON.stringify('.next')));
    const required = join(buildOutput, 'required-server-files.json');
    if (existsSync(required)) {
      const manifest = JSON.parse(readFileSync(required, 'utf8'));
      manifest.config.distDir = '.next';
      writeFileSync(required, JSON.stringify(manifest));
    }
  }
  assertTauriExportInputsSafe(standalone);
  await run.buildOutput?.complete();
  return 0;
}
