import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { issueListQuery } from '@/lib/github-client';
import { getQueryClient } from '@/lib/query/client';
import { readPrJson } from './read-pr-json';
import type { PrDetail } from './types';

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const textOrNull = (value: unknown) => value === null || typeof value === 'string';
const optionalText = (value: unknown) => value === undefined || textOrNull(value);
const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const slugKey = (repo: string | null | undefined) => repo?.trim().toLowerCase() || null;

export function prPanelDetailKey(repo: string | null | undefined, number: number) {
  return ['gh', slugKey(repo), 'pr-panel', number] as const;
}

function validDetail(value: unknown, number: number, repo: string | null): value is PrDetail {
  if (!record(value) || value.number !== number) return false;
  if (!['title', 'body', 'author', 'headRefName', 'baseRefName', 'url', 'createdAt', 'updatedAt'].every(key => typeof value[key] === 'string')) return false;
  if (typeof value.state !== 'string' || !['open', 'closed', 'merged'].includes(value.state.toLowerCase())) return false;
  if (!['additions', 'deletions', 'changedFiles'].every(key => count(value[key])) || typeof value.mergeable !== 'boolean') return false;
  if (!textOrNull(value.closedAt) || !textOrNull(value.mergedAt) || !textOrNull(value.reviewDecision)) return false;
  if (value.resolvedRepo !== undefined && (typeof value.resolvedRepo !== 'string' || (repo && slugKey(value.resolvedRepo) !== slugKey(repo)))) return false;
  if (!Array.isArray(value.files) || !value.files.every(file => record(file) && typeof file.path === 'string' && typeof file.status === 'string' && count(file.additions) && count(file.deletions) && textOrNull(file.patch))) return false;
  if (!Array.isArray(value.statusCheckRollup) || !value.statusCheckRollup.every(check => record(check) && typeof check.name === 'string' && optionalText(check.status) && optionalText(check.conclusion) && optionalText(check.url))) return false;
  if (!Array.isArray(value.reviewComments) || !value.reviewComments.every(comment => record(comment) && typeof comment.id === 'number' && ['author', 'body', 'path', 'side', 'createdAt', 'state', 'diffHunk'].every(key => typeof comment[key] === 'string') && (comment.line === null || count(comment.line)) && (comment.inReplyTo === null || count(comment.inReplyTo)))) return false;
  if (!Array.isArray(value.issueComments) || !value.issueComments.every(comment => record(comment) && typeof comment.id === 'number' && ['body', 'user', 'created_at'].every(key => typeof comment[key] === 'string'))) return false;
  if (value.watch !== undefined && (!record(value.watch) || !Array.isArray(value.watch.changes) || !value.watch.changes.every(change => ['head', 'checks', 'state', 'comments', 'reviews'].includes(change)) || typeof value.watch.commentUpdatesPaused !== 'boolean')) return false;
  return true;
}

export function prPanelDetailQuery(repo: string | null | undefined, number: number, background = false, manual = false) {
  const slug = repo?.trim() || null;
  return queryOptions({
    ...issueListQuery(slug ?? ''),
    // Compact panel detail includes discussion and watch state; viewer/list shapes stay separate.
    queryKey: prPanelDetailKey(slug, number),
    queryFn: async ({ signal, client }): Promise<PrDetail> => {
      const search = new URLSearchParams();
      if (slug) search.set('repo', slug);
      if (background) search.set('poll', '1');
      const suffix = search.size ? `?${search}` : '';
      const result = await readPrJson<unknown>(`/api/panel/prs/${number}${suffix}`, signal, { client, repo: slug ?? '', manual });
      if (!record(result) || result.error || !validDetail(result.pr, number, slug)) throw new Error('Pull request could not be read. Retry.');
      return result.pr;
    },
    staleTime: query => query.state.data && query.state.data.state.toLowerCase() !== 'open' ? Infinity : 120_000,
    // Preserve the panel's running-check scheduler rather than adding a second timer.
    refetchInterval: false,
    retry: false,
  });
}

export async function refreshPrPanelDetail(client: QueryClient, repo: string | null | undefined, number: number) {
  const options = prPanelDetailQuery(repo, number, false, true);
  await client.cancelQueries({ queryKey: options.queryKey, exact: true });
  await client.invalidateQueries({ queryKey: options.queryKey, exact: true, refetchType: 'none' });
  return client.fetchQuery({ ...options, staleTime: 0 });
}

/** Confirmed delivery invalidates inactive snapshots and supersedes pre-write reads. */
export function invalidatePrPanelDetail(repo: string, number: number) {
  const client = getQueryClient();
  const predicate = (query: { queryKey: readonly unknown[]; state: { data: unknown } }) => {
    const [family, scope, kind, prNumber] = query.queryKey;
    return family === 'gh' && kind === 'pr-panel' && prNumber === number
      && (scope === slugKey(repo) || (scope === null && record(query.state.data) && typeof query.state.data.resolvedRepo === 'string' && slugKey(query.state.data.resolvedRepo) === slugKey(repo)));
  };
  void client.cancelQueries({ predicate }).then(() => client.invalidateQueries({ predicate }))
    // Read recovery must not change a confirmed write into uncertain delivery.
    .catch(() => {});
}
