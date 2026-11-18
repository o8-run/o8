import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import { getApfsCowCapability } from '@/lib/worktree/apfs';
import { resolveWorktreeRootLayout } from '@/lib/worktree/root-layout';
import { deriveDependencyInstallRecipeAtCommit } from '@/lib/workspace/dependency-install';
import { inspectDependencyCloneSource } from '@/lib/workspace/dependency-directory-clone';
import { dependencyCloneSnapshotMatches } from '@/lib/workspace/dependency-clone-snapshot';
import { readEstimateInput } from './storage-estimate-measurement';

const BLOCK_BYTES = 4096;
const MAX_ENTRIES = 250_000;

export interface DependencyReuseEstimate {
  recipeKey: string;
  metadataBytes: number;
  nativeWriteBytes: number;
  entries: number;
}

/** Estimate clone metadata from entry counts, excluding shared payload blocks. Never follow links. */
async function cloneMetadataBytes(root: string): Promise<{ bytes: number; entries: number }> {
  const pending = [root];
  let entries = 1;
  while (pending.length) {
    const directory = pending.pop()!;
    const before = await lstat(directory);
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('Dependency directory changed during measurement.');
    const children = await readdir(directory, { withFileTypes: true });
    entries += children.length;
    if (entries > MAX_ENTRIES) throw new Error('Dependency clone metadata exceeds its measurement bound.');
    for (const child of children) {
      if (child.isDirectory()) pending.push(path.join(directory, child.name));
      else if (!child.isFile() && !child.isSymbolicLink()) throw new Error('Unsupported dependency clone entry.');
    }
    const after = await lstat(directory);
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs) {
      throw new Error('Dependency directory changed during measurement.');
    }
  }
  return { bytes: entries * BLOCK_BYTES, entries };
}

/** Only an exact target recipe and a validated same-volume donor permit a discount. */
export async function observeDependencyReuse(
  repoPath: string,
  creationBaseCommit: string,
  installCommand: string,
): Promise<DependencyReuseEstimate | null> {
  if (process.platform !== 'darwin') return null;
  const destination = resolveWorktreeRootLayout(repoPath).primaryBase;
  if (!(await getApfsCowCapability(repoPath, destination)).canCowClone) return null;
  const recipe = await deriveDependencyInstallRecipeAtCommit(repoPath, creationBaseCommit, installCommand);
  const manifest = JSON.parse((await readEstimateInput(repoPath, 'package.json', creationBaseCommit))!);
  // Read-closure declarations do not bound lifecycle writes to cloned payloads.
  if (recipe.lifecycleScripts === 'enabled' && ['preinstall', 'install', 'postinstall'].some(stage => (
    typeof manifest.scripts?.[stage] === 'string'
  ))) return null;
  const source = await inspectDependencyCloneSource({ sourceWorkspace: repoPath, recipe, manifest,
    bindingGyp: await readEstimateInput(repoPath, 'binding.gyp', creationBaseCommit) !== null });
  if (source.status !== 'ready') return null;
  const metadata = await cloneMetadataBytes(path.join(repoPath, 'node_modules'));
  // Retain conservative native-file headroom in addition to estimated metadata.
  // Enabled root lifecycle writes are unbounded and are excluded above.
  let nativeWriteBytes = 0;
  for (const relative of source.graph.nativeFiles) {
    const entry = await lstat(path.join(repoPath, relative));
    if (!entry.isFile() || entry.isSymbolicLink()) return null;
    nativeWriteBytes += Math.ceil(entry.size / BLOCK_BYTES) * BLOCK_BYTES;
  }
  if (!await source.sourceMatches() || !await dependencyCloneSnapshotMatches(repoPath, source.graph.snapshot)) return null;
  return { recipeKey: recipe.key, metadataBytes: metadata.bytes, nativeWriteBytes, entries: metadata.entries };
}
