import 'server-only';
import { isUnfinishedCheckRunState, isPendingStatusContext } from './check-state';
import { DEFAULT_GITHUB_REPO, resolveRepoSlug, fetchGitHubPullRequestDetail, commentOnGitHubPullRequest, closeGitHubPullRequest } from '@/lib/github-broker';
import { captureGitHubAccount, requireGitHubAccount, githubInstallationFetch } from './auth';
import { githubProvider } from '@/lib/git-providers/github';
import { registeredGitHubRepos } from './repo';
import type { PullRequestListItem, PullRequestListPage } from './pull-request-list.types';

export const IDLE_DRAFT_DAYS = 3;
export interface IdleDraft extends PullRequestListItem {
  decisionSnapshot: { expectedHeadSha: string | null; expectedUpdatedAt: string };
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
      if (!pr.draft || pr.state !== 'open' || pr.checks === 'pending' || pr.checksPending === true || !Number.isFinite(elapsed) || elapsed < IDLE_DRAFT_DAYS * 86400000) return [];
      return [{ ...pr, decisionSnapshot: { expectedHeadSha: pr.headSha ?? null, expectedUpdatedAt: pr.updatedAt }, ageDays: Math.floor(elapsed / 86400000),
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
export interface RegisteredIdleDrafts {
  drafts: Array<IdleDraft & { repo: string }>;
  sources: Array<{ repo: string; nextPage: number | null; error?: string }>;
}
export async function readRegisteredIdleDrafts(): Promise<RegisteredIdleDrafts> {
  const pages = await Promise.all([...(await registeredGitHubRepos()).keys()].map(async repo => {
    try { return { repo, page: await readIdleDrafts(repo) }; }
    catch { return { repo, page: { repo, drafts: [], nextPage: null, error: 'Idle drafts could not be loaded.' } }; }
  }));
  return { drafts: pages.flatMap(({ repo, page }) => page.drafts.map(pr => ({ ...pr, repo }))),
    sources: pages.map(({ repo, page }) => ({ repo, nextPage: page.nextPage, ...(page.error ? { error: page.error } : {}) })) };
}
export function isLiteralDraftRepo(value: unknown): value is string {
  return typeof value === 'string' && /^[\w.-]+\/[\w.-]+$/.test(value) && !value.split('/').some(part => part === '.' || part === '..');
}
export const DRAFT_DECISION_TEXT_BYTES = 4096;
const decisionsInFlight = new Set<string>();
export class DraftDecisionError extends Error {
  constructor(readonly status: number, message: string, readonly commentPosted: boolean | null = false, readonly ownerAssigned: boolean | null = false) { super(message); }
}
/** Explicit triage only. This path never dispatches work or marks a draft ready. */
export async function recordDraftDecision(repo: string, number: number, input: Record<string, unknown>) {
  if (!isLiteralDraftRepo(repo)) throw new DraftDecisionError(400, 'A literal GitHub owner/repository is required.');
  const { decision } = input;
  if (!['continue', 'handoff', 'close'].includes(String(decision))) throw new DraftDecisionError(400, 'Choose continue, handoff or close.');
  if (Object.hasOwn(input, 'comment')) throw new DraftDecisionError(400, 'The comment field is not supported for draft decisions. Use reason.');
  for (const name of ['reason'] as const) {
    if (input[name] !== undefined && typeof input[name] !== 'string') throw new DraftDecisionError(400, `${name} must be text.`);
    if (typeof input[name] === 'string' && Buffer.byteLength(input[name], 'utf8') > DRAFT_DECISION_TEXT_BYTES) throw new DraftDecisionError(400, `${name} must be at most ${DRAFT_DECISION_TEXT_BYTES} UTF-8 bytes.`);
  }
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (decision === 'close' && !reason) throw new DraftDecisionError(400, 'A reason is required to close a draft.');
  const owner = typeof input.owner === 'string' ? input.owner.trim() : '';
  if (decision === 'handoff' && !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(owner)) throw new DraftDecisionError(400, 'A GitHub owner login is required.');
  const { expectedHeadSha, expectedUpdatedAt } = input;
  if (typeof expectedHeadSha !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(expectedHeadSha)
    || typeof expectedUpdatedAt !== 'string' || expectedUpdatedAt.length > 40 || !Number.isFinite(Date.parse(expectedUpdatedAt))) {
    throw new DraftDecisionError(400, 'Pass expectedHeadSha and expectedUpdatedAt from the idle-draft row you reviewed.');
  }
  const comment = decision === 'handoff' ? `Handoff draft to @${owner}: ${reason || 'Ownership transferred.'}`
    : decision === 'close' ? `Close draft: ${reason}` : `Continue draft: ${reason || 'Work will continue.'}`;
  if (Buffer.byteLength(comment, 'utf8') > DRAFT_DECISION_TEXT_BYTES) throw new DraftDecisionError(400, `The generated comment must be at most ${DRAFT_DECISION_TEXT_BYTES} UTF-8 bytes, including its decision prefix.`);
  const key = `${repo.toLowerCase()}#${number}`;
  if (decisionsInFlight.has(key)) throw new DraftDecisionError(409, 'Another decision for this draft is already in progress. Inspect GitHub before retrying.');
  decisionsInFlight.add(key);
  try {
    if (!(await registeredGitHubRepos()).has(repo.toLowerCase())) throw new DraftDecisionError(403, 'Draft decisions require a registered GitHub repository.');
    const account = captureGitHubAccount();
    const pr = await fetchGitHubPullRequestDetail(repo, number, undefined, 'interactive', true);
    requireGitHubAccount(account);
    idleDraftCache.clear();
    const elapsed = Date.now() - Date.parse(pr.updatedAt);
    if (typeof pr.headSha !== 'string' || pr.headSha.toLowerCase() !== expectedHeadSha.toLowerCase() || pr.updatedAt !== expectedUpdatedAt) {
      throw new DraftDecisionError(409, 'This draft changed since the row you reviewed. Refresh the idle-draft list before deciding.');
    }
    if (pr.state !== 'open' || !pr.draft || !Number.isFinite(elapsed) || elapsed < IDLE_DRAFT_DAYS * 86400000) {
      throw new DraftDecisionError(409, 'This pull request is no longer an idle open draft. Refresh before deciding.');
    }
    const pendingChecks = pr.statusContextsPending === true || (pr.statusCheckRollup ?? []).some(check => !check.conclusion || Boolean(check.status && isUnfinishedCheckRunState(check.status)))
      || pr.requiredStatuses?.some(check => isPendingStatusContext(check.state));
    if (pr.checksUnavailable || pr.statusContextsPending === null) throw new DraftDecisionError(409, `Draft check status could not be confirmed. ${pr.checksUnavailableReason ? `${pr.checksUnavailableReason} ` : ''}Refresh before deciding.`);
    if (pendingChecks) throw new DraftDecisionError(409, 'This draft has pending checks. Refresh the idle-draft list after they finish.');
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
    try { requireGitHubAccount(account); }
    catch { throw new DraftDecisionError(502, 'GitHub account changed before commenting. Inspect the pull request before retrying.', false, ownerAssigned); }
    try { await commentOnGitHubPullRequest(repo, number, comment); }
    catch { throw new DraftDecisionError(502, 'Comment outcome is unknown. Inspect the pull request before retrying.', null, ownerAssigned); }
    idleDraftCache.clear();
    if (decision === 'close') {
      try { requireGitHubAccount(account); await closeGitHubPullRequest(repo, number); }
      catch { throw new DraftDecisionError(502, 'Reason posted; closing could not be confirmed. Inspect the pull request before retrying.', true); }
    }
    return { ok: true, decision, commentPosted: true, ownerAssigned, ...(ownerAssigned ? { owner } : {}) };
  } finally { decisionsInFlight.delete(key); }
}
