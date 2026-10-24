import { githubQuotaDeadline } from './quota-deadline';
import type { QueryClient } from '@tanstack/react-query';

export const GITHUB_LIST_FRESH_MS = 120_000;
export const GITHUB_VISIBLE_REFRESH_MS = 120_000;
export const GITHUB_HIDDEN_REFRESH_MS = 300_000;
export const GITHUB_CHECK_REFRESH_MS = 30_000;
export class GithubReadDeferredError extends Error {
  constructor(readonly retryAt: number, message = 'GitHub rate limit — refresh paused.') { super(message); }
}
export function githubScopeDeadline(client: QueryClient | undefined, scope: string): number {
  return client?.getQueryData<number>(['gh-quota', scope.trim().toLowerCase()]) ?? 0;
}
export function recordGithubQuota(client: QueryClient | undefined, scope: string, deadline: number): void {
  if (!client) return;
  // Holds can outlive the ordinary five-minute cache. Keep them through the 24h quota cap.
  client.setQueryDefaults(['gh-quota'], { gcTime: 24 * 60 * 60_000 });
  client.setQueryData(['gh-quota', scope.trim().toLowerCase()], Math.max(deadline, githubScopeDeadline(client, scope)));
}
export function assertGithubScope(client: QueryClient | undefined, scope: string, manual = false): void {
  const deadline = githubScopeDeadline(client, scope);
  if (!manual && deadline > Date.now()) throw new GithubReadDeferredError(deadline);
}
export function assertGithubRead(response: Response, client?: QueryClient, scope = ''): void {
  const deadline = githubQuotaDeadline(response);
  if (deadline !== null) {
    recordGithubQuota(client, scope, deadline);
    throw new GithubReadDeferredError(deadline);
  }
  if (!response.ok) throw new Error(`GitHub read returned ${response.status}`);
}
type ReadState = { state: { error: Error | null; data?: unknown } };
export function githubSnapshotDeadline(data: unknown): number {
  return data && typeof data === 'object' && 'retryAt' in data && typeof data.retryAt === 'number' ? data.retryAt : 0;
}
export function githubRefreshInterval(isHidden = () => typeof document !== 'undefined' && document.hidden) {
  return (query?: ReadState) => Math.max(isHidden() ? GITHUB_HIDDEN_REFRESH_MS : GITHUB_VISIBLE_REFRESH_MS,
    Math.max(query?.state.error instanceof GithubReadDeferredError ? query.state.error.retryAt : 0, githubSnapshotDeadline(query?.state.data)) - Date.now());
}
export function githubReadOnMount(query: ReadState): boolean | 'always' {
  if (query.state.error instanceof GithubReadDeferredError && query.state.error.retryAt > Date.now()) return false;
  return query.state.error ? 'always' : true;
}

/** Broker stale snapshots retain the age of the successful upstream read. */
export function githubSnapshotTime(data: unknown, receivedAt: number): number {
  const timestamp = data && typeof data === 'object' && 'lastSuccessfulAt' in data ? Date.parse(String(data.lastSuccessfulAt)) : NaN;
  return Number.isFinite(timestamp) ? Math.min(timestamp, receivedAt) : receivedAt;
}
