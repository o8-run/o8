import { assertGithubRead } from './refresh-policy';
import type { PullRequestListPage } from '@/lib/github-broker/pull-request-list.types';
import { ipcFetch } from '@/lib/tauri/ipc-fetch';
import { pullRequestListQuery } from './queries';

/** Enriched first-page dependencies have a different shape from compact PR lists. */
export function linkedPullRequestListQuery(repo: string) {
  const slug = repo.trim().toLowerCase();
  return {
    ...pullRequestListQuery(slug),
    queryKey: ['gh', slug, 'linked-pr-list'],
    queryFn: async ({ signal }: { signal?: AbortSignal }): Promise<PullRequestListPage> => {
      const params = new URLSearchParams({ repo: slug, view: 'list', state: 'open', page: '1' });
      const response = await ipcFetch(`/api/panel/prs?${params}`, { signal });
      assertGithubRead(response);
      const body = await response.json() as PullRequestListPage;
      if (!response.ok || body.error || body.repo?.toLowerCase() !== slug || !Array.isArray(body.prs)) {
        throw new Error('Branch dependencies unavailable. Your saved links are still here.');
      }
      return { ...body, repo: slug };
    },
  };
}
