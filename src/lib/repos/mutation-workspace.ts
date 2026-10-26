import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

function canonical(path: string): string {
  try { return realpathSync.native(path); } catch { return resolve(path); }
}

/** Missing scope retains the global operator API; an invalid scope never does. */
export function mutationWorkspace(request: { url: string }): string | null | undefined {
  const value = new URL(request.url).searchParams.get('workspace');
  if (value === null) return undefined;
  return value.trim() && isAbsolute(value.trim()) ? canonical(value.trim()) : null;
}

export function matchesMutationWorkspace(workspace: string | null | undefined, repoPath: unknown): boolean {
  return workspace === undefined || (workspace !== null && typeof repoPath === 'string'
    && isAbsolute(repoPath) && canonical(repoPath) === workspace);
}

export class MutationWorkspaceNotFoundError extends Error {
  constructor() { super('Target was not found in the selected workspace.'); }
}
