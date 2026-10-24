/**
 * React hooks over the shared GitHub list cache (#3460). Components read a
 * repository's pull requests or issues through these instead of calling
 * `fetch` on mount, so every surface shares one entry per repository.
 */

import { useGithubWindowHidden } from './visibility';
import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import {
  issueListQuery,
  pullRequestListQuery,
  refreshGithubList,
  type GithubIssueList,
  type GithubPullRequestList,
} from './queries';

export function useRepoPullRequests(repo: string | null | undefined, repoPath?: string | null, enabled = true) {
  const queryClient = useQueryClient();
  const hidden = useGithubWindowHidden();
  const query = useQuery<GithubPullRequestList>({
    ...pullRequestListQuery(repo ?? '', { repoPath, isHidden: () => hidden }),
    enabled: Boolean(repo) && enabled,
  });
  const refresh = useCallback(
    () => (repo ? refreshGithubList(queryClient, repo, 'prs', repoPath) : Promise.resolve(undefined)),
    [queryClient, repo, repoPath],
  );
  return { ...query, refresh };
}

export function useRepoIssues(repo: string | null | undefined) {
  const queryClient = useQueryClient();
  const hidden = useGithubWindowHidden();
  const query = useQuery<GithubIssueList>({
    ...issueListQuery(repo ?? '', { isHidden: () => hidden }),
    enabled: Boolean(repo),
  });
  const refresh = useCallback(
    () => (repo ? refreshGithubList(queryClient, repo, 'issues') : Promise.resolve(undefined)),
    [queryClient, repo],
  );
  return { ...query, refresh };
}
