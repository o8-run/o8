import { githubItemQuery } from '@/lib/github-client/item-query';
import type { ListQueryOptions } from '@/lib/github-client';
import type { getMobileGithubContext } from './github-cache';

export interface MobilePullRequestDetail {
  number: number;
  title: string;
  state: string;
  draft?: boolean;
  headSha: string;
  changedFiles: number;
  mergeable: boolean;
  reviewDecision: string | null;
  statusCheckRollup: Array<{ name: string; status?: string; conclusion?: string | null }>;
  allowedMergeMethods: Array<'squash' | 'merge' | 'rebase'>;
  mergeGate?: { allowed: boolean; snapshot: string; checks: Array<{ verdict: string; detail?: string }> };
}

export function mobilePullRequestQuery(repo: string, number: number, options: ListQueryOptions) {
  return githubItemQuery<{ pr: MobilePullRequestDetail }>(repo, 'pr-files', number,
    `/api/panel/prs/${number}?repo=${encodeURIComponent(repo)}`, options);
}

export function mobileMergeMethod(pr: MobilePullRequestDetail) {
  return (['squash', 'merge', 'rebase'] as const).find(method => pr.allowedMergeMethods?.includes(method));
}

export function mobileMergeAvailable(pr: MobilePullRequestDetail): boolean {
  return pr.state.toLowerCase() === 'open' && !pr.draft && pr.mergeable
    && Boolean(pr.headSha && pr.mergeGate?.allowed && pr.mergeGate.snapshot && mobileMergeMethod(pr));
}

export async function mergeMobilePullRequest(context: ReturnType<typeof getMobileGithubContext>, repo: string,
  pr: MobilePullRequestDetail, confirmedWithoutApproval = false): Promise<void> {
  context.beforeRead();
  if (!mobileMergeAvailable(pr)) throw new Error('Merge is unavailable. Refresh and review the pull request.');
  if (pr.reviewDecision !== 'APPROVED' && !confirmedWithoutApproval) throw new Error('Confirm merge without reviewer approval.');
  const response = await fetch(`/api/panel/prs/${pr.number}`, {
    method: 'POST', headers: { ...context.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'merge', repo, commitSha: pr.headSha,
      mergeMethod: mobileMergeMethod(pr), expectedMergeGate: pr.mergeGate!.snapshot }),
  });
  const result = await response.json();
  if (!response.ok || result.ok !== true) throw new Error(result.error || 'Merge could not be confirmed. Refresh before retrying.');
  await context.client.invalidateQueries({ queryKey: ['gh', repo.trim().toLowerCase()] });
}
