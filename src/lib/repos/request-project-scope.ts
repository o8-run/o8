import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { ActiveProjectScope } from './projects';
import type { ProjectWithRepos } from '@/lib/projects/types';
import type { RepoRegistryEntry } from './types';

export interface RequestProjectSnapshot {
  scope: ActiveProjectScope;
  project: ProjectWithRepos;
  repositories: RepoRegistryEntry[];
  repositoryNames: string[];
  ambiguousRepoNames: string[];
}
const requestScope = new AsyncLocalStorage<{ snapshot: RequestProjectSnapshot; key: string }>();

/** Server-resolved membership, shared by retrieval and its answer-cache identity. */
export function withRequestProjectScope<T>(snapshot: RequestProjectSnapshot, operation: () => Promise<T>): Promise<T> {
  const current = structuredClone(snapshot);
  const key = createHash('sha256').update(JSON.stringify(current)).digest('hex');
  return requestScope.run({ snapshot: current, key }, operation);
}

export function requestProjectSnapshot(): RequestProjectSnapshot | undefined { return requestScope.getStore()?.snapshot; }
export function requestProjectScope(): ActiveProjectScope | undefined { return requestProjectSnapshot()?.scope; }
export function requestRepositoryNames(): readonly string[] | undefined { return requestProjectSnapshot()?.repositoryNames; }
export function requestProjectScopeKey(): string { return requestScope.getStore()?.key ?? ''; }
