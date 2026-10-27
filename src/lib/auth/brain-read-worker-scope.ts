import 'server-only';
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { listProjects } from '@/lib/projects/store';
import { getSqlite } from '@/lib/db';
import { getProjectsLedgerSync } from '@/lib/repos/projects';
import { listReposFresh } from '@/lib/repos/registry';
import { parseGithubRemoteIdentity } from '@/lib/repos/github-identity';
import type { RequestProjectSnapshot } from '@/lib/repos/request-project-scope';

function canonical(candidate: string): string | null {
  try { return realpathSync(candidate); } catch { return null; }
}

/** Membership must succeed against SQL; display-ledger fallbacks grant nothing. */
export async function resolveBrainReadWorkerScope(repoPath: string, projectId: string): Promise<RequestProjectSnapshot | null> {
  const repositories = await listReposFresh();
  const projects = getSqlite().transaction(() => listProjects())();
  const boundIds = new Set(repositories.filter(repo => canonical(repo.localPath) === repoPath).map(repo => repo.id));
  const memberships = projects.filter(project => project.repos.some(link => boundIds.has(link.repoId)));
  if (memberships.length !== 1) return null;
  const ledger = getProjectsLedgerSync();
  const alias = ledger.projects.find(project => project.id === projectId);
  const expected = projects.find(project => project.id === projectId)
    ?? (alias?.sqliteProjectId && projects.find(project => project.id === alias.sqliteProjectId));
  const project = memberships[0];
  if (!expected || expected.id !== project.id) return null;
  const ids = new Set(project.repos.map(link => link.repoId));
  const members = repositories.filter(repo => ids.has(repo.id) && canonical(repo.localPath));
  const repoPaths = [...new Set(members.map(repo => canonical(repo.localPath)!))].sort();
  if (!repoPaths.includes(repoPath)) return null;
  const repositoryNames = members.flatMap(repo => {
    const remote = parseGithubRemoteIdentity(repo.remoteUrl);
    return remote.githubOwner && remote.githubRepo ? [`${remote.githubOwner}/${remote.githubRepo}`.toLowerCase()] : [];
  }).sort();
  const names = new Map<string, Set<string>>();
  for (const repo of repositories) {
    const resolved = canonical(repo.localPath);
    if (!resolved) continue;
    const name = basename(resolved).toLowerCase();
    const paths = names.get(name) ?? new Set<string>(); paths.add(resolved); names.set(name, paths);
  }
  return { project, repositories: members, repositoryNames,
    ambiguousRepoNames: [...names].filter(([, paths]) => paths.size > 1).map(([name]) => name).sort(),
    scope: { project: { id: project.id, sqliteProjectId: project.id, name: project.name, repoPaths,
      createdAt: new Date(project.createdAt).toISOString() }, projectId: project.id, projectSlug: project.slug,
      repoPaths, repoInActiveProject: true } };
}
