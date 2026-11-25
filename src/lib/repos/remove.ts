import 'server-only';

import { listRepos, removeRepo } from './registry';
import { removeRepoFromAllProjects } from '@/lib/projects/store';
import { removeRuntimeTerminalSessionsForRepoPath } from '@/lib/runtime/terminal-session-registry';
import { pruneTerminalStateForRepoPath } from '@/lib/terminal/state-store';
import { removeWorkspaceLifecycleRecordsForRepoPath } from '@/lib/workspace/lifecycle';

export interface RemovedRepo {
  id: string;
  name: string;
  localPath: string;
  removedTerminalBindings: number;
}

/**
 * Remove a repo from o8's pool everywhere it is tracked: registry, SQLite
 * project links, workspace lifecycle records, terminal state, and runtime
 * terminal bindings. The repo on disk is never
 * touched.
 *
 * Shared by the repo-registry DELETE route and project deletion (a deleted
 * project takes its exclusive repos with it — otherwise unassigned repos
 * re-project as virtual single-repo rows and the delete visibly "doesn't
 * work"). Ledger (projects.json) cleanup stays with the callers to avoid a
 * repos/projects.ts import cycle.
 *
 * Throws 'Repository not found.' for an unknown id (registry behavior).
 */
export async function removeRepoFromPool(repoId: string): Promise<RemovedRepo> {
  const repos = await listRepos();
  const toRemove = repos.find((repo) => repo.id === repoId);
  if (!toRemove) {
    throw new Error('Repository not found.');
  }

  const removedTerminalBindings = toRemove.localPath
    ? removeRuntimeTerminalSessionsForRepoPath(toRemove.localPath)
    : [];

  await removeRepo(repoId);

  if (toRemove.localPath) {
    removeRepoFromAllProjects(toRemove.id);
    removeWorkspaceLifecycleRecordsForRepoPath(toRemove.localPath);
    pruneTerminalStateForRepoPath(toRemove.localPath);
  }

  return {
    id: toRemove.id,
    name: toRemove.name,
    localPath: toRemove.localPath,
    removedTerminalBindings: removedTerminalBindings.length,
  };
}
