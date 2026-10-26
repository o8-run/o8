import { lstat } from 'node:fs/promises';
import path from 'node:path';

import {
  assertWorktreeMaterializationIdentity,
  captureWorktreeMaterializationIdentity,
  type WorktreeMaterializationIdentity,
} from '@/lib/worktree/materialization-identity';
import { clonePinnedWorkspaceDirectory, readPinnedWorkspaceFile } from '@/lib/worktree/materialization-leaf-io';
import type { DependencyInstallOptions, DependencyInstallRecipe } from './dependency-install';
import { validateDependencyCloneGraph } from './dependency-clone-validation';
import { finishDependencyClone, probeDependencyCloneNativeFiles } from './dependency-clone-lifecycle';
import { purgeExactDirectory } from './exact-directory-purge';
import { dependencyCloneSnapshotMatches } from './dependency-clone-snapshot';
import { profileDependencyClone as profile } from './dependency-clone-profile';
import { dependencyCloneSourceMatcher } from './dependency-clone-source';
import { dependencyDirectoryPoolKey, dependencyDirectoryPoolStatus, queueDependencyDirectoryPoolRefill, takeDependencyDirectoryPoolTree } from './dependency-directory-pool';
import { DependencyPayloadRefusal, inspectDependencyPayload, readDependencyPayloadReceipt, sealDependencyPayload, type DependencyPayloadReceipt } from './dependency-payload';

export interface DependencySelection {
  path: 'directory-clone' | 'dependency-pool' | 'native-install' | 'image';
  reason: string;
  pool?: Awaited<ReturnType<typeof dependencyDirectoryPoolStatus>>;
}

/** Reuse only an installed payload with a recorded private baseline. */
export async function tryCloneDependencyDirectory(input: {
  sourceWorkspace: string;
  usePool?: boolean;
  platform?: NodeJS.Platform;
  afterClone?: () => Promise<void>;
  workspace: string;
  identity: WorktreeMaterializationIdentity;
  recipe: DependencyInstallRecipe;
  options: DependencyInstallOptions;
  onDecision?: (decision: { path: 'directory-clone' | 'dependency-pool' | 'fallback'; reason: string; pool?: DependencySelection['pool'] }) => Promise<void>;
}): Promise<boolean> {
  const { sourceWorkspace, workspace, identity, recipe, options } = input;
  const fallback = async (reason: string) => { await input.onDecision?.({ path: 'fallback', reason }); return false; };
  if (path.resolve(sourceWorkspace) === path.resolve(workspace)) return fallback('same-workspace');
  try { await lstat(path.join(workspace, 'node_modules')); return fallback('destination-exists'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if ((input.platform ?? process.platform) !== 'darwin' || recipe.packageManager !== 'npm'
    || recipe.platform !== process.platform || recipe.architecture !== process.arch
    || recipe.runtimeAbi !== process.versions.modules || recipe.installArgs[0] !== 'ci'
    || recipe.installArgs.some((arg) => arg.startsWith('--omit') || arg === '--production')
    || recipe.localDependencyDigests.length > 0) return fallback('ineligible-recipe');
  const sourceIdentity = await captureWorktreeMaterializationIdentity(sourceWorkspace);
  const sourcePath = path.join(sourceWorkspace, 'node_modules');
  try { await lstat(sourcePath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback('source-install-missing'); throw error; }
  const manifest = JSON.parse((await readPinnedWorkspaceFile(workspace, identity, 'package.json'))!) as { workspaces?: unknown; scripts?: Record<string, unknown> };
  if (manifest.workspaces) return fallback('workspace-topology');
  if (recipe.lifecycleScripts === 'enabled'
    && ['preinstall', 'install', 'prepublish', 'preprepare', 'prepare', 'postprepare', 'dependencies'].some((stage) => manifest.scripts?.[stage])) return fallback('unsupported-root-lifecycle');
  const requireSameTree = recipe.lifecycleScripts === 'enabled' && recipe.cloneLifecycleInputs === undefined;
  const sourceMatches = dependencyCloneSourceMatcher(sourceWorkspace, sourceIdentity, recipe, requireSameTree);
  if (!await profile('source-recipe', sourceMatches)) return fallback(requireSameTree ? 'source-inputs-or-unbounded-lifecycle' : 'source-inputs-mismatch');
  const graph = await profile('source-manifests', () => validateDependencyCloneGraph(sourceWorkspace, recipe.lockfile.path));
  if (!graph || await readPinnedWorkspaceFile(workspace, identity, 'binding.gyp') !== null) return fallback('installed-graph-ineligible');
  await assertWorktreeMaterializationIdentity(sourceWorkspace, sourceIdentity);
  let pooled: Awaited<ReturnType<typeof takeDependencyDirectoryPoolTree>> = null;
  try {
    if (input.usePool) pooled = await profile('dependency-pool-publication', () => takeDependencyDirectoryPoolTree({
      key: dependencyDirectoryPoolKey(recipe, sourceIdentity, graph.digest), workspace, identity, recipe, graph,
      onSelected: async () => { await input.onDecision?.({ path: 'dependency-pool', reason: 'matching-inputs', pool: await dependencyDirectoryPoolStatus() }); },
    }));
  } catch (error) {
    if (error instanceof DependencyPayloadRefusal) return fallback(`pool-${error.reason}`);
    throw error;
  }
  let expectedPayload: DependencyPayloadReceipt;
  try { expectedPayload = pooled?.payload ?? await readDependencyPayloadReceipt(sourceWorkspace, sourceIdentity, recipe, graph); }
  catch (error) { if (error instanceof DependencyPayloadRefusal) return fallback(error.reason); throw error; }
  if (!pooled) await input.onDecision?.({ path: 'directory-clone', reason: 'matching-inputs', ...(input.usePool ? { pool: await dependencyDirectoryPoolStatus() } : {}) });
  const clone = pooled ? { disposition: 'created' as const, ...pooled }
    : await profile('directory-clone-publication', () => clonePinnedWorkspaceDirectory(workspace, identity, 'node_modules', sourcePath));
  if (clone.disposition === 'unsupported') return fallback('directory-clone-unsupported');
  if (clone.disposition !== 'created') throw new Error('Dependency clone destination already exists.');
  const discard = async (reason = 'source-changed') => {
    await assertWorktreeMaterializationIdentity(workspace, identity);
    await purgeExactDirectory(path.join(workspace, 'node_modules'), clone);
    await assertWorktreeMaterializationIdentity(workspace, identity);
    return fallback(reason);
  };
  await input.afterClone?.();
  await assertWorktreeMaterializationIdentity(sourceWorkspace, sourceIdentity);
  await assertWorktreeMaterializationIdentity(workspace, identity);
  let sourceRefusal = 'source-changed';
  const sourceUnchanged = async () => {
    if (!await dependencyCloneSnapshotMatches(sourceWorkspace, graph.snapshot) || !await sourceMatches()) return false;
    if (!pooled) try { await readDependencyPayloadReceipt(sourceWorkspace, sourceIdentity, recipe, graph, expectedPayload); }
    catch (error) { if (error instanceof DependencyPayloadRefusal) { sourceRefusal = error.reason; return false; } throw error; }
    return true;
  };
  if (clone.sourceChanged || !await profile('source-recipe-recheck', sourceUnchanged)) return discard(sourceRefusal);
  const target = await profile('target-manifests', () => validateDependencyCloneGraph(workspace, recipe.lockfile.path));
  if (!target || target.digest !== graph.digest) return discard('installed-graph-ineligible');
  try {
    const payload = await inspectDependencyPayload(workspace, identity, target.entrypoints);
    if (payload.device !== clone.device || payload.inode !== clone.inode || payload.contents !== expectedPayload.contents
      || pooled && payload.identity !== expectedPayload.identity) return discard('payload-changed');
  } catch (error) { if (error instanceof DependencyPayloadRefusal) return discard(error.reason); throw error; }
  await finishDependencyClone({ workspace, identity, recipe, options });
  const final = await profile('final-manifests', () => validateDependencyCloneGraph(workspace, recipe.lockfile.path));
  if (!final) throw new Error('Dependency clone lifecycle changed its installed graph.');
  await probeDependencyCloneNativeFiles(workspace, identity, final.nativeFiles);
  if (!await dependencyCloneSnapshotMatches(workspace, final.snapshot)) throw new Error('Dependency clone changed during native validation.');
  if (!await profile('source-final-recheck', sourceUnchanged)) throw new Error('Dependency clone source changed after lifecycle; refusing to replay setup.');
  await assertWorktreeMaterializationIdentity(workspace, identity);
  try { await sealDependencyPayload(workspace, identity, recipe, final, undefined, clone); }
  catch (error) { if (error instanceof DependencyPayloadRefusal) return discard(error.reason); throw error; }
  const recordedGraph = await validateDependencyCloneGraph(workspace, recipe.lockfile.path);
  if (!recordedGraph || recordedGraph.digest !== final.digest) return discard('installed-graph-ineligible');
  if (input.usePool) queueDependencyDirectoryPoolRefill(workspace, recipe, identity, recordedGraph, sourceIdentity);
  return true;
}
