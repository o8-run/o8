import 'server-only';

import { deleteProject, listProjects } from '@/lib/projects/store';
import type { ProjectsLedger } from './projects';
import { resolveProjectIdentity } from './project-identity';
import { listRepos } from './registry';
import { removeRepoFromPool } from './remove';
import { RepoRuntimeStopUnconfirmed, stopRepoBoundRuntimeSessions } from './runtime-removal';
import { virtualProjectRepoId } from './virtual-project-id';

export async function removeProjectRepositories(projectId: string, ledger: ProjectsLedger) {
  const { project, sqlite } = resolveProjectIdentity(projectId, ledger);
  const virtualRepo = virtualProjectRepoId(project.id);
  const used = new Set(listProjects()
    .filter((candidate) => candidate.id !== sqlite?.id && candidate.slug !== 'workspace')
    .flatMap((candidate) => candidate.repos.map((link) => link.repoId)));
  const exclusive = new Set(virtualRepo ? [virtualRepo]
    : (sqlite?.repos ?? []).map((link) => link.repoId).filter((id) => !used.has(id)));
  const repos = (await listRepos()).filter((repo) => exclusive.has(repo.id));

  // Confirm every exclusive repository before deleting any project or links.
  // Shared repositories and their running sessions are retained.
  for (const repo of repos) {
    const cleanup = await stopRepoBoundRuntimeSessions(repo);
    if (!cleanup.ok) throw new RepoRuntimeStopUnconfirmed(cleanup);
  }
  if (sqlite) deleteProject(sqlite.id);
  for (const repo of repos) await removeRepoFromPool(repo.id);
  return new Set([projectId, project.id, ...(sqlite ? [sqlite.id] : [])]);
}
