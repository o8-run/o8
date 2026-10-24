import 'server-only';

import os from 'node:os';
import path from 'node:path';
import {
  addRepoToProject,
  createProject,
  getProjectWithRepos,
  removeRepoFromProject,
} from '@/lib/projects/store';
import { listRepos } from './registry';
import type { ProjectRecord } from './projects';

function projectNameToSlug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'default';
}

function normalizeRepoPath(repoPath: string) {
  return path.resolve(repoPath.trim().replace(/^~(?=\/|$)/, os.homedir()));
}

export async function reconcileSqliteProjectRepos(project: ProjectRecord, repoPaths: string[]): Promise<void> {
  const repos = await listRepos();
  const idByPath = new Map(repos.map((repo) => [normalizeRepoPath(repo.localPath), repo.id]));
  const targetRepoIds = new Set(repoPaths.map((repoPath) => idByPath.get(normalizeRepoPath(repoPath))).filter((id): id is string => Boolean(id)));
  let sqlite = getProjectWithRepos(project.sqliteProjectId ?? project.id);
  if (!sqlite) {
    const created = createProject({ name: project.name, slug: projectNameToSlug(project.name), description: null });
    sqlite = getProjectWithRepos(created.id);
  }
  if (!sqlite) return;
  const currentRepoIds = new Set(sqlite.repos.map((link) => link.repoId));
  for (const repoId of targetRepoIds) {
    if (!currentRepoIds.has(repoId)) addRepoToProject(sqlite.id, repoId, null, 'manual');
  }
  for (const repoId of currentRepoIds) {
    if (!targetRepoIds.has(repoId)) removeRepoFromProject(sqlite.id, repoId);
  }
}
