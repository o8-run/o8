import { githubSnapshotTime } from '@/lib/github-client/refresh-policy';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { activityListQuery, type ActivityListKind } from '@/lib/github-client/activity-queries';
import { refreshGithubList } from '@/lib/github-client';
import { useGithubWindowHidden } from '@/lib/github-client/visibility';
import { GithubReadDeferredError, githubScopeDeadline } from '@/lib/github-client/refresh-policy';
import { relativeAge } from './shared';
import type { ActivityItem, GHIssue, GHPullRequest } from './types';
import type { CIRun } from '@/lib/github-client/ci-runs';

type ActivityExtras = { issues: ActivityItem[]; prs: ActivityItem[]; ciRuns: ActivityItem[]; repoCommits: ActivityItem[] };
type Payload = { error?: string; issues?: GHIssue[]; prs?: GHPullRequest[]; runs?: CIRun[]; commits?: Array<{ hash?: string; message?: string; date?: string }> };
const KINDS: ActivityListKind[] = ['issues', 'prs', 'ci', 'commits'];

/** All Activity list rows observe the same snapshots used by badges and cards. */
export function useActivityExtras(repo: string | null, allRepos: string[], isAllRepos: boolean, refreshKey?: number) {
  const client = useQueryClient();
  const hidden = useGithubWindowHidden();
  const scope = JSON.stringify(isAllRepos ? [...new Set(allRepos)].sort() : repo ? [repo] : []);
  const repos = useMemo(() => JSON.parse(scope) as string[], [scope]);
  const specs = useMemo(() => repos.flatMap(repo => KINDS.map(kind => ({ repo, kind }))), [repos]);
  const queries = useQueries({ queries: specs.map(({ repo, kind }) => activityListQuery(repo, kind, { isHidden: () => hidden })) });
  const initialRefresh = useRef(refreshKey);
  const [timelineOrigin] = useState(() => Date.now());
  useEffect(() => {
    const refresh = (manual = false) => {
      void Promise.allSettled(specs.map(async ({ repo, kind }) => {
        const options = activityListQuery(repo, kind, { manual });
        if (!manual && githubScopeDeadline(client, repo) > Date.now()) return;
        if (!manual && client.getQueryState(options.queryKey)?.error instanceof GithubReadDeferredError) {
          const error = client.getQueryState(options.queryKey)!.error as GithubReadDeferredError;
          if (error.retryAt > Date.now()) return;
        }
        if (manual && (kind === 'issues' || kind === 'prs')) return refreshGithubList(client, repo, kind);
        await client.cancelQueries({ queryKey: options.queryKey, exact: true });
        return client.fetchQuery({ ...options, staleTime: 0 });
      }));
    };
    const handler = () => refresh();
    window.addEventListener('o8:lifecycle-reconcile', handler);
    if (initialRefresh.current !== refreshKey) { initialRefresh.current = refreshKey; refresh(true); }
    return () => window.removeEventListener('o8:lifecycle-reconcile', handler);
  }, [client, specs, refreshKey]);
  const extras: ActivityExtras = { issues: [], prs: [], ciRuns: [], repoCommits: [] };
  const errors: string[] = [];
  specs.forEach(({ repo: repoSlug, kind }, index) => {
    const query = queries[index];
    if (query.error) errors.push(query.error instanceof GithubReadDeferredError ? 'GitHub rate limit — paused until reset' : 'Unable to load repo activity');
    const payload = query.data as Payload | undefined;
    if (payload?.error) errors.push(payload.error);
    const mapStream = (target: ActivityListKind, map: (data: Payload) => ActivityItem[]) => target === kind && payload ? map(payload) : [];
    const issueItems = mapStream('issues', (data) => {
      const issueItems: ActivityItem[] = [];
      if (!Array.isArray(data.issues)) throw new Error('Invalid issues activity');
      for (const issue of (data.issues ?? []).slice(0, 8)) {
        const ts = issue.createdAt ? new Date(issue.createdAt).getTime() : 0;
        issueItems.push({
          kind: 'issue',
          number: issue.number,
          title: issue.title,
          state: (issue.state ?? '').toLowerCase(),
          labels: (issue.labels ?? []).filter(label => label && typeof label === 'object'),
          age: issue.createdAt ? relativeAge(issue.createdAt) : '',
          ts,
          repo: repoSlug,
          author: issue.author?.login ?? 'unknown',
          assignees: (issue.assignees ?? [])
            .map((assignee: { login?: string | null }) => assignee.login ?? '')
            .filter(Boolean),
          comments: typeof issue.comments === 'number' ? issue.comments : 0,
          body: (issue.body ?? '').trim(),
        });
      }
      return issueItems;
    });

    const prItems = mapStream('prs', (data) => {
      const prItems: ActivityItem[] = [];
      if (!Array.isArray(data.prs)) throw new Error('Invalid prs activity');
      for (const pr of (data.prs ?? []).slice(0, 8)) {
        const ts = pr.createdAt ? new Date(pr.createdAt).getTime() : 0;
        const checks = pr.statusCheckRollup ?? [];
        prItems.push({
          kind: 'pr',
          number: pr.number,
          title: pr.title,
          state: (pr.state ?? '').toLowerCase(),
          author: pr.author?.login ?? '',
          branch: pr.headRefName ?? '',
          additions: pr.additions ?? 0,
          deletions: pr.deletions ?? 0,
          changedFiles: pr.changedFiles ?? 0,
          reviewDecision: pr.reviewDecision ?? '',
          checkSummary: {
            passed: checks.filter((check: { conclusion?: string | null }) => check.conclusion?.toLowerCase() === 'success').length,
            failed: checks.filter((check: { conclusion?: string | null }) => check.conclusion?.toLowerCase() === 'failure').length,
            pending: checks.filter((check: { conclusion?: string | null; status?: string | null }) => !check.conclusion || check.status?.toLowerCase() !== 'completed').length,
          },
          failingChecks: checks
            .filter((check: { name?: string | null; conclusion?: string | null }) => check.conclusion?.toLowerCase() === 'failure')
            .map((check: { name?: string | null }) => check.name || 'Unknown check')
            .slice(0, 3),
          age: pr.createdAt ? relativeAge(pr.createdAt) : '',
          ts,
          repo: repoSlug,
        });
      }
      return prItems;
    });

    const ciItems = mapStream('ci', (data) => {
      const ciItems: ActivityItem[] = [];
      if (!Array.isArray(data.runs)) throw new Error('Invalid runs activity');
      for (const run of (data.runs ?? []).slice(0, 6)) {
        const ts = run.createdAt ? new Date(run.createdAt).getTime() : 0;
        ciItems.push({
          kind: 'ci',
          id: run.databaseId,
          title: run.displayTitle ?? '',
          status: run.status ?? '',
          conclusion: run.conclusion ?? '',
          branch: run.headBranch ?? '',
          workflow: run.workflowName ?? '',
          age: run.createdAt ? relativeAge(run.createdAt) : '',
          ts,
          repo: repoSlug,
        });
      }
      return ciItems;
    });

    const commitItems = mapStream('commits', (data) => {
      const commitItems: ActivityItem[] = [];
      if (!Array.isArray(data.commits)) throw new Error('Invalid commits activity');
      for (const commit of (data.commits ?? []).slice(0, 10)) {
        const ts = commit.date ? new Date(commit.date).getTime() : 0;
        commitItems.push({
          kind: 'commit',
          hash: commit.hash ?? '',
          message: commit.message ?? '',
          age: commit.date ? relativeAge(commit.date) : '',
          ts,
          repo: repoSlug,
        });
      }
      return commitItems;
    });
    extras.issues.push(...issueItems);
    extras.prs.push(...prItems);
    extras.ciRuns.push(...ciItems);
    extras.repoCommits.push(...commitItems.map(item => item.kind === 'commit' && isAllRepos
      ? { ...item, message: `[${repoSlug.split('/').pop()}] ${item.message}` } : item));
  });
  return { extras, remoteScopeError: errors.length ? [...new Set(errors)].join(' | ') : null, timelineOrigin,
    updatedAt: Math.min(...queries.filter(query => query.data).map(query => githubSnapshotTime(query.data, query.dataUpdatedAt))) };
}
