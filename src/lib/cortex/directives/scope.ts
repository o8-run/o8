import type { DirectiveProjectScope } from './filter';
import { resolveActiveDirectiveProjectScope } from './filter';
import { getProjectContext } from '@/lib/projects/context';
import { getActiveProjectScopeForRepo } from '@/lib/repos/projects';
import { isVirtualRepoProjectId } from '@/lib/repos/virtual-project-id';

/** Canonical scope authority shared by the classic GET and native admission. */
export async function resolveDirectiveListScope(projectId: string | undefined, repoPath: string | null): Promise<DirectiveProjectScope | null> {
  if (projectId) {
    const context = await getProjectContext({ projectId, repoPath });
    if (![context.id, context.runtimeProjectId, context.settingsProjectId].includes(projectId)) return null;
    return {
      projectIds: new Set([context.id, context.runtimeProjectId, context.settingsProjectId].filter((id): id is string => Boolean(id)).map(id => id.toLowerCase())),
      // Virtual repo projects must not inherit an unrelated display-name slug.
      projectSlugs: isVirtualRepoProjectId(context.runtimeProjectId) ? new Set() : new Set([context.slug.toLowerCase()]),
      repoInActiveProject: context.repoInProject,
    };
  }
  if (repoPath) return resolveActiveDirectiveProjectScope(repoPath);
  const active = await getActiveProjectScopeForRepo();
  return { projectIds: new Set([active.projectId.toLowerCase()]), projectSlugs: new Set([active.projectSlug.toLowerCase()]), repoInActiveProject: false };
}
