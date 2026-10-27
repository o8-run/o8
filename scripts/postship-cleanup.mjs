#!/usr/bin/env node
/** Reclaim generated native-release outputs after publication finishes. */
import { lstat, readFile, readdir, readlink, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generatedOutputLaunch } from './lib/generated-output-launch.mjs';
import { boundBuildEnvironment } from './lib/release-build-profile.mjs';
import { resolveReleaseBuildEnvironment } from './lib/release-config.mjs';
import { retainMacosReleaseSymbols } from './lib/release-symbols.mjs';

const runFile = promisify(execFile);

export const POSTSHIP_GENERATED_DIRS = [
  '.next',
  'src-tauri/target',
  'src-tauri/sidecars/speech-local/.build',
  'src-tauri/sidecars/pi-write/target',
];

// `out` is the verified release artifact, not disposable scratch space. Its
// provenance manifest and checksummed outputs let the next exact-match
// prebuild reuse the web and speech artifacts instead of rebuilding them.
export const POSTSHIP_PRESERVED_DIRS = ['out'];

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function assertO8RepoRoot(repoRoot) {
  const packagePath = path.join(repoRoot, 'package.json');
  const manifest = JSON.parse(await readFile(packagePath, 'utf8'));
  if (manifest?.name !== 'o8') {
    throw new Error(`refusing cleanup outside the o8 repo: ${packagePath}`);
  }
}

async function assertGeneratedAncestors(root, target) {
  let ancestor = root;
  for (const segment of path.relative(root, path.dirname(target)).split(path.sep).filter(Boolean)) {
    ancestor = path.join(ancestor, segment);
    const metadata = await lstat(ancestor);
    if (metadata.isSymbolicLink()) {
      throw new Error(`linked ancestor: ${path.relative(root, ancestor)}`);
    }
    if (!metadata.isDirectory()) throw new Error('ancestor is not a real directory');
  }
}

async function assertInternalLink(root, rootAlias, link) {
  // Resolve only path components, never destination contents. Check each hop
  // before continuing so an external detour cannot return to the checkout.
  let current = root;
  let remaining = path.relative(root, link).split(path.sep);
  let hops = 0;
  while (remaining.length > 0) {
    const segment = remaining.shift();
    if (!segment || segment === '.') continue;
    const candidate = path.join(current, segment);
    if (candidate !== root && !isInside(root, candidate)) throw new Error('link escapes repo root');
    const metadata = await lstat(candidate);
    if (metadata.isSymbolicLink()) {
      if (++hops > 40) throw new Error('link resolution is uncertain');
      const destination = await readlink(candidate);
      if (path.isAbsolute(destination)) {
        // Accept the caller's checkout alias (e.g. macOS /var vs /private/var),
        // but retain unnormalized components to check symlinks before `..`.
        const prefix = [root, rootAlias].find((base) => destination === base || destination.startsWith(`${base}${path.sep}`));
        if (!prefix) throw new Error('link escapes repo root');
        current = root;
        remaining = [...destination.slice(prefix.length).split(path.sep), ...remaining];
      } else {
        remaining = [...destination.split(path.sep), ...remaining];
      }
      continue;
    }
    if (remaining.length > 0 && !metadata.isDirectory()) throw new Error('link ancestor is not a directory');
    current = candidate;
  }
  // Require agreement with the filesystem's own resolution; failures are
  // uncertain links and must keep the generated tree intact.
  if (await realpath(link) !== current) throw new Error('link resolution is uncertain');
}

export async function assertGeneratedTreeHasSafeLinks(root, rootAlias, target, relativePath) {
  const pending = [target];
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      const metadata = await lstat(candidate);
      if (entry.isSymbolicLink() || metadata.isSymbolicLink()) {
        try {
          await assertInternalLink(root, rootAlias, candidate);
        } catch {
          throw new Error(`linked entry inside ${relativePath}: ${path.relative(target, candidate)}`);
        }
        continue;
      }
      if (metadata.isDirectory()) pending.push(candidate);
    }
  }
}

export async function cleanupPostshipOutputs(repoRoot = process.cwd(), symbolsOptions = {}) {
  const rootAlias = path.resolve(repoRoot);
  const root = await realpath(rootAlias);
  await assertO8RepoRoot(root);
  const result = { removed: [], skipped: [], refused: [] };

  for (const relativePath of POSTSHIP_GENERATED_DIRS) {
    const target = path.resolve(root, relativePath);
    if (relativePath === '.next') {
      try {
        const env = resolveReleaseBuildEnvironment(root, boundBuildEnvironment(root));
        const marker = await lstat(path.join(root, '.o8-generated-output-store')).catch(error => {
          if (error.code !== 'ENOENT') throw error;
          return null;
        });
        if (!marker) {
          if (await lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; return null; })) {
            throw new Error('Postship output has unknown lifecycle ownership.');
          }
          result.skipped.push(relativePath);
          continue;
        }
        const invocation = generatedOutputLaunch('postship');
        const completed = await runFile(invocation.command, invocation.args, { cwd: root,
          env: { ...env, TSX_TSCONFIG_PATH: fileURLToPath(new URL('../tsconfig.json', import.meta.url)) },
          maxBuffer: 2 * 1024 ** 2 });
        if (completed.stdout.includes('Preserved unowned entries in .next;')) {
          console.info('[postship-cleanup] Preserved unowned entries in .next; release-owned cleanup left them in place.');
        }
        for (const line of completed.stdout.split('\n')) {
          if (line.startsWith('Kept ')) console.info('[postship-cleanup]', line);
        }
        const status = /\[postship-generated-output\] (removed|skipped)\s*$/.exec(completed.stdout)?.[1];
        if (!status) throw new Error('Postship output has no completed lifecycle receipt.');
        result[status].push(relativePath);
      } catch (error) {
        result.refused.push({ path: relativePath, reason: error instanceof Error ? error.message : String(error) });
        break;
      }
      continue;
    }
    if (!isInside(root, target)) {
      result.refused.push({ path: relativePath, reason: 'outside repo root' });
      break;
    }

    let metadata;
    try {
      await assertGeneratedAncestors(root, target);
      metadata = await lstat(target);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        result.skipped.push(relativePath);
        continue;
      }
      result.refused.push({ path: relativePath, reason: error instanceof Error ? error.message : String(error) });
      break;
    }

    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      result.refused.push({ path: relativePath, reason: 'target is not a real directory' });
      break;
    }

    try {
      await assertGeneratedTreeHasSafeLinks(root, rootAlias, target, relativePath);
      if (relativePath === 'src-tauri/target') await retainMacosReleaseSymbols(root, symbolsOptions);
      // Recursive rm unlinks nested symlinks without removing their destinations.
      await rm(target, { recursive: true, force: false, maxRetries: 0 });
      result.removed.push(relativePath);
    } catch (error) {
      result.refused.push({ path: relativePath, reason: error instanceof Error ? error.message : String(error) });
      break;
    }
  }

  return result;
}

async function main() {
  const bestEffort = process.argv.includes('--best-effort');
  try {
    const result = await cleanupPostshipOutputs();
    console.log(
      `[postship-cleanup] removed=${result.removed.length} skipped=${result.skipped.length} refused=${result.refused.length}`,
    );
    for (const refusal of result.refused) {
      console.warn(`[postship-cleanup] refused ${refusal.path}: ${refusal.reason}`);
    }
    if (result.refused.length > 0 && !bestEffort) process.exitCode = 1;
  } catch (error) {
    console.warn(`[postship-cleanup] ${error instanceof Error ? error.message : String(error)}`);
    if (!bestEffort) process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  void main();
}
