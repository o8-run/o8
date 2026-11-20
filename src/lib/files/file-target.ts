import { isAbsolute, relative } from 'node:path';
import { homedir } from 'node:os';
import { getDefaultLlmRepoRoot, resolveRegisteredRepoScope } from '@/lib/llm/repo-scope';
import { ABSOLUTE_PATH_NOT_ALLOWLISTED, resolveAllowedOperatorConfigPath, resolveRepoRelativeFilePath } from '@/lib/files/operator-config-docs';
import { normalizeKnowledgeWritePath } from '@/lib/cortex/knowledge/sources';

/** Canonical target shared by the TS handlers and authenticated native admission. */
async function resolveRoot(workspace?: string | null) {
  if (!workspace) return getDefaultLlmRepoRoot();

  const requestedPath = normalizeKnowledgeWritePath(workspace);

  const { repoRoot } = await resolveRegisteredRepoScope(requestedPath);
  return repoRoot;
}

export async function resolveFileTarget(filePath: string, workspace?: string | null) {
  if (isAbsolute(filePath)) {
    const resolved = resolveAllowedOperatorConfigPath(filePath);
    if (!resolved) {
      return {
        error: 'Absolute path is not allowlisted',
        code: ABSOLUTE_PATH_NOT_ALLOWLISTED,
        status: 400,
      } as const;
    }
    const root = homedir();
    return { root, relativePath: relative(root, resolved) } as const;
  }

  const root = await resolveRoot(workspace);
  if (!root) {
    return {
      error: 'Workspace is not registered',
      code: 'workspace_not_registered',
      status: 400,
    } as const;
  }

  const resolved = resolveRepoRelativeFilePath(root, filePath);
  if (!resolved) {
    return {
      error: 'Path outside repository',
      code: 'path_outside_repository',
      status: 400,
    } as const;
  }

  return { root, relativePath: relative(root, resolved) } as const;
}
