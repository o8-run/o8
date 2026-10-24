import 'server-only';

import { listProjects } from '@/lib/projects/store';
import type { ProjectWithRepos } from '@/lib/projects/types';
import type { ProjectRecord, ProjectsLedger } from './projects';

function slugForName(name: string) {
  return name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
}

/** Read-time migration only. Once paired, names never select a mutation. */
export function sqliteProjectForLedger(project: ProjectRecord, projects: ProjectWithRepos[], ledger: ProjectRecord[]) {
  const stableId = project.sqliteProjectId ?? project.id;
  const direct = projects.find((candidate) => candidate.id === stableId);
  if (direct || project.sqliteProjectId) return direct ?? null;
  const candidates = projects.filter((candidate) => candidate.slug === slugForName(project.name)
    && candidate.name.toLowerCase() === project.name.toLowerCase()
    && !ledger.some((entry) => entry.id === candidate.id || entry.sqliteProjectId === candidate.id));
  return candidates.length === 1 ? candidates[0] : null;
}

/** Accept either stable namespace, refusing missing or ambiguous identities. */
export function resolveProjectIdentity(projectId: string, ledger: ProjectsLedger) {
  const direct = ledger.projects.find((project) => project.id === projectId);
  const aliases = ledger.projects.filter((project) => project.sqliteProjectId === projectId);
  const project = direct ?? (aliases.length === 1 ? aliases[0] : null);
  if (!project) throw new Error('Project not found or identity is ambiguous. Refresh projects.');
  const sqlite = listProjects().find((candidate) => candidate.id === (project.sqliteProjectId ?? project.id)) ?? null;
  return { project, sqlite };
}
