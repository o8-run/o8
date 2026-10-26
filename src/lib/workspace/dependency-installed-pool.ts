import { assertWorktreeMaterializationIdentity, captureWorktreeMaterializationIdentity, type WorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import type { DependencyInstallRecipe } from './dependency-install';
import { DependencyPayloadRefusal, sealDependencyPayload } from './dependency-payload';
import { validateDependencyCloneGraph } from './dependency-clone-validation';
import { dependencyCloneSourceMatcher } from './dependency-clone-source';
import { queueDependencyDirectoryPoolRefill } from './dependency-directory-pool';

/** Installation establishes payload provenance; a cache miss need not repeat it forever. */
export async function recordInstalledDependencyPayload(workspace: string, identity: WorktreeMaterializationIdentity, recipe: DependencyInstallRecipe, options: {
  platform?: NodeJS.Platform; cloneSourceWorkspace?: string; useDependencyPool?: boolean;
}): Promise<void> {
  if ((options.platform ?? process.platform) !== 'darwin' || recipe.packageManager !== 'npm' || recipe.installArgs[0] !== 'ci'
    || recipe.localDependencyDigests.length || recipe.installArgs.some(arg => arg.startsWith('--omit'))) return;
  try {
    await assertWorktreeMaterializationIdentity(workspace, identity);
    const graph = await validateDependencyCloneGraph(workspace, recipe.lockfile.path);
    if (!graph) return;
    await sealDependencyPayload(workspace, identity, recipe, graph);
    if (!options.useDependencyPool || !options.cloneSourceWorkspace) return;
    const origin = options.cloneSourceWorkspace;
    const originIdentity = await captureWorktreeMaterializationIdentity(origin);
    const matches = dependencyCloneSourceMatcher(origin, originIdentity, recipe,
      recipe.lifecycleScripts === 'enabled' && recipe.cloneLifecycleInputs === undefined);
    const originGraph = await validateDependencyCloneGraph(origin, recipe.lockfile.path);
    const recordedGraph = await validateDependencyCloneGraph(workspace, recipe.lockfile.path);
    if (originGraph?.digest === graph.digest && recordedGraph?.digest === graph.digest && await matches()) {
      // Read/clone authority is the installed worker. Pool selection remains
      // bound to the original repository, never a foreign repository's seed.
      queueDependencyDirectoryPoolRefill(workspace, recipe, identity, recordedGraph, originIdentity);
    }
  } catch (error) {
    // Cache eligibility cannot make an already audited private install fail.
    // Loss of the worker's original ownership remains a fatal refusal.
    await assertWorktreeMaterializationIdentity(workspace, identity);
    console.info('[dependency-payload]', JSON.stringify({ status: 'unavailable',
      reason: error instanceof DependencyPayloadRefusal ? error.reason : 'cache-validation-failed' }));
  }
}
