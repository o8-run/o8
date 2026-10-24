import { useGithubWindowHidden } from '@/lib/github-client/visibility';
import { useCallback, useMemo } from 'react';
import { useQueries, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { githubListQueryKey, issueListQuery, refreshGithubList, type GithubIssueList } from '@/lib/github-client';
import type { RepoFocusRepo } from '../../types';
import type { GitHubIssueIntake, PanelIssuePayload } from './types';
import { issueAge, issueKind, repoIssueParam } from './helpers';

interface IntakeScope {
  repoParam: string;
  repoPath?: string;
  repos: RepoFocusRepo[];
}

export function useIssueIntake(repos: RepoFocusRepo[], limit: number) {
  const client = useQueryClient();
  const hidden = useGithubWindowHidden();
  const scopes = useMemo(() => {
    const grouped = new Map<string, IntakeScope>();
    for (const repo of repos) {
      const repoParam = repoIssueParam(repo);
      // Qualified slugs share the canonical list entry. Display-name fallback
      // entries stay local to their checkout; server name resolution is unchanged.
      const repoPath = /^[\w.-]+\/[\w.-]+$/.test(repoParam) ? undefined : repo.localPath;
      const key = JSON.stringify(githubListQueryKey(repoParam, 'issues', repoPath));
      const scope = grouped.get(key);
      if (scope) scope.repos.push(repo);
      else grouped.set(key, { repoParam, repoPath, repos: [repo] });
    }
    return [...grouped.values()];
  }, [repos]);

  const combine = useCallback((results: UseQueryResult<GithubIssueList>[]) => {
    const issues: GitHubIssueIntake[] = [];
    const errors: string[] = [];
    results.forEach((result, index) => {
      const scope = scopes[index];
      const data = result.data;
      const repoFullName = data?.repo || scope.repoParam;
      const payload: PanelIssuePayload[] = Array.isArray(data?.issues) ? data.issues : [];
      const error = data?.error || (result.isError ? 'Unable to load GitHub issues.' : null);
      for (const repo of scope.repos) {
        if (error) errors.push(`${repo.name}: ${error}`);
        for (const issue of payload) {
          const number = typeof issue.number === 'number' ? issue.number : Number(issue.number);
          const title = typeof issue.title === 'string' ? issue.title.trim() : '';
          if (!Number.isFinite(number) || !title) continue;
          const labels = Array.isArray(issue.labels)
            ? issue.labels.map((label) => {
              if (typeof label === 'string') return label;
              if (label && typeof label === 'object' && 'name' in label && typeof label.name === 'string') return label.name;
              return '';
            }).filter(Boolean)
            : [];
          const updatedAt = typeof issue.updatedAt === 'string' ? issue.updatedAt : null;
          const createdAt = typeof issue.createdAt === 'string' ? issue.createdAt : null;
          issues.push({
            id: `${repo.id}:${repoFullName}#${number}`,
            kind: issueKind(labels),
            repoId: repo.id,
            repoName: repo.name,
            repoPath: repo.localPath,
            repoFullName,
            number,
            title,
            body: typeof issue.body === 'string' ? issue.body.trim() : '',
            url: typeof issue.url === 'string' ? issue.url : '',
            labels,
            comments: typeof issue.comments === 'number' ? issue.comments : Number(issue.comments) || 0,
            updatedAt,
            age: issueAge({ updatedAt, createdAt }),
          });
        }
      }
    });
    issues.sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''));
    return {
      issues: issues.slice(0, limit),
      loading: results.some(result => result.isPending),
      refreshing: results.some(result => result.isFetching),
      error: errors.length ? errors.slice(0, 2).join(' - ') : null,
    };
  }, [limit, scopes]);

  const snapshot = useQueries({
    queries: scopes.map(scope => issueListQuery(scope.repoParam, { repoPath: scope.repoPath, isHidden: () => hidden })),
    combine,
  });
  const refresh = useCallback(async () => {
    await Promise.allSettled(scopes.map(scope => refreshGithubList(client, scope.repoParam, 'issues', scope.repoPath)));
  }, [client, scopes]);
  return { ...snapshot, refresh };
}
