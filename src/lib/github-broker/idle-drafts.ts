import 'server-only';
import { DEFAULT_GITHUB_REPO, resolveRepoSlug, fetchGitHubPullRequestDetail, commentOnGitHubPullRequest, closeGitHubPullRequest } from '@/lib/github-broker';
import { captureGitHubAccount, requireGitHubAccount, githubInstallationFetch } from './auth';
import { githubProvider } from '@/lib/git-providers/github';
import type { PullRequestListItem, PullRequestListPage } from './pull-request-list.types';

export const IDLE_DRAFT_DAYS = 3;
export interface IdleDraft extends PullRequestListItem {
  ageDays: number;
  conflictsWithMain: boolean | null;
  decisions: readonly ['continue', 'handoff', 'close'];
}
export interface IdleDraftPage {
  repo: string | null;
  drafts: IdleDraft[];
  nextPage: number | null;
  error?: string;
}
export function idleDraftPage(page: PullRequestListPage, now = Date.now()): IdleDraftPage {
  return { repo: page.repo, nextPage: page.nextPage, error: page.error,
    drafts: page.prs.flatMap(pr => {
      const elapsed = now - Date.parse(pr.updatedAt);
      if (!pr.draft || pr.state !== 'open' || !Number.isFinite(elapsed) || elapsed < IDLE_DRAFT_DAYS * 86400000) return [];
      return [{ ...pr, ageDays: Math.floor(elapsed / 86400000),
        conflictsWithMain: pr.baseRefName !== 'main' || !pr.mergeable || pr.mergeable === 'UNKNOWN' ? null : pr.mergeable === 'CONFLICTING',
        decisions: ['continue', 'handoff', 'close'] as const }];
    }),
  };
}
const idleDraftCache = new Map<string, { startedAt: number; promise: Promise<IdleDraftPage> }>();
let idleDraftAccountScope: string | null = null;
export async function readIdleDrafts(repo?: string, page = 1, fresh = false): Promise<IdleDraftPage> {
  const account = captureGitHubAccount();
  const slug = await resolveRepoSlug(repo ?? null, DEFAULT_GITHUB_REPO);
  requireGitHubAccount(account);
  if (!slug) return { repo: null, drafts: [], nextPage: null };
  const scope = JSON.stringify(account);
  if (scope !== idleDraftAccountScope) { idleDraftCache.clear(); idleDraftAccountScope = scope; }
  const key = JSON.stringify([slug.toLowerCase(), page]);
  const cached = idleDraftCache.get(key);
  // Fleet refresh signals must not turn Inbox polling into repeated remote PR reads.
  if (!fresh && cached && Date.now() - cached.startedAt < 20_000) {
    const result = await cached.promise;
    requireGitHubAccount(account);
    return result;
  }
  const promise: Promise<IdleDraftPage> = githubProvider.listPullRequests(slug, { state: 'open', page, sort: 'oldest', fresh }).then(result => {
    requireGitHubAccount(account);
    return idleDraftPage(result);
  }).catch(error => {
    if (idleDraftCache.get(key)?.promise === promise) idleDraftCache.delete(key);
    throw error;
  });
  if (idleDraftCache.size >= 64 && !idleDraftCache.has(key)) idleDraftCache.delete(idleDraftCache.keys().next().value!);
  idleDraftCache.set(key, { startedAt: Date.now(), promise });
  return promise;
}
export class DraftDecisionError extends Error {
  constructor(readonly status: number, message: string, readonly commentPosted: boolean | null = false, readonly ownerAssigned: boolean | null = false) { super(message); }
}
/** Explicit triage only. This path never dispatches work or marks a draft ready. */
export async function recordDraftDecision(repo: string, number: number, input: Record<string, unknown>) {
  const { decision } = input;
  if (!['continue', 'handoff', 'close'].includes(String(decision))) throw new DraftDecisionError(400, 'Choose continue, handoff or close.');
  if (input.reason !== undefined && typeof input.reason !== 'string') throw new DraftDecisionError(400, 'Reason must be text.');
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (decision === 'close' && !reason) throw new DraftDecisionError(400, 'A reason is required to close a draft.');
  const owner = typeof input.owner === 'string' ? input.owner.trim() : '';
  if (decision === 'handoff' && !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(owner)) throw new DraftDecisionError(400, 'A GitHub owner login is required.');
  const pr = await fetchGitHubPullRequestDetail(repo, number);
  idleDraftCache.clear();
  if (pr.state !== 'open' || !pr.draft) throw new DraftDecisionError(409, 'This pull request is no longer an open draft. Refresh before deciding.');
  let ownerAssigned = false;
  if (decision === 'handoff') {
    const { response } = await githubInstallationFetch(repo, `/repos/${repo}/issues/${number}/assignees`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assignees: [owner] }),
    });
    if (!response.ok) throw new DraftDecisionError(502, 'GitHub could not confirm the handoff owner. Inspect the pull request before retrying.', false, response.status >= 500 ? null : false);
    const result = await response.json() as { assignees?: Array<{ login: string }> };
    if (!result.assignees?.some(row => row.login.toLowerCase() === owner.toLowerCase())) throw new DraftDecisionError(422, 'GitHub did not assign this owner. Choose an assignable GitHub user.');
    ownerAssigned = true;
  }
  const comment = decision === 'handoff' ? `Handoff draft to @${owner}: ${reason || 'Ownership transferred.'}`
    : decision === 'close' ? `Close draft: ${reason}` : `Continue draft: ${reason || 'Work will continue.'}`;
  try { await commentOnGitHubPullRequest(repo, number, comment); }
  catch { throw new DraftDecisionError(502, 'Comment outcome is unknown. Inspect the pull request before retrying.', null, ownerAssigned); }
  idleDraftCache.clear();
  if (decision === 'close') {
    try { await closeGitHubPullRequest(repo, number); }
    catch { throw new DraftDecisionError(502, 'Reason posted; closing could not be confirmed. Inspect the pull request before retrying.', true); }
  }
  return { ok: true, decision, commentPosted: true, ownerAssigned, ...(ownerAssigned ? { owner } : {}) };
}
