import 'server-only';
import { createHash } from 'node:crypto';
import { describeWorkflowStage } from '@/lib/workflows/status';
import { isPacketMergeHeld } from '@/lib/lane/merge-hold';
import { previewPacketMerge } from '@/lib/lane/preview-merge';
import { probeLaneSessionAlive } from '@/lib/lane/owned-session-liveness';
import { lookupOwnedActiveRunFresh } from '@/lib/runtimes/shared/owned-session-index';
import { fetchGitHubPullRequestComments, fetchGitHubPullRequestDetail } from './details';
import { prMergeMembership } from './pr-merge-membership';
import { LaneBranchUnresolvedError } from '@/lib/lane/review-target';

export interface PrMergeGate {
  repo: string; number: number; headSha: string; baseSha: string; baseRefName: string;
  allowed: boolean; snapshot: string;
  checks: Array<{ name: string; verdict: 'pass' | 'fail' | 'skipped'; detail?: string; actions?: string[] }>;
  packets: Array<{ id: string; preview: Awaited<ReturnType<typeof previewPacketMerge>> | null }>;
}
type Detail = Awaited<ReturnType<typeof fetchGitHubPullRequestDetail>>;
type Discussion = Awaited<ReturnType<typeof fetchGitHubPullRequestComments>>;

/** The same fresh decision is displayed by both clients and enforced before publication. */
export async function assessPrMergeGate(repo: string, pr: Detail, discussion: Discussion): Promise<PrMergeGate> {
  const reviews = discussion.reviews;
  const checks: PrMergeGate['checks'] = [];
  const packets: PrMergeGate['packets'] = [];
  const add = (name: string, pass: boolean, detail: string) => { checks.push({ name, verdict: pass ? 'pass' : 'fail', detail }); };
  add('pr-identity', Boolean(pr.headSha && pr.baseSha && pr.baseRefName && pr.headRepoFullName), 'Review an exact head, head repository and base before merging.');
  const identity = pr.githubIdentity;
  add('github-identity', Boolean(identity && Number.isSafeInteger(identity.repositoryId) && identity.repositoryId > 0
    && Number.isSafeInteger(identity.pullRequestId) && identity.pullRequestId > 0 && pr.githubScope && pr.githubScope === discussion.githubScope),
  'The repository, pull request and GitHub authorization must be verified by the same fresh read.');
  add('pr-state', pr.state.toLowerCase() === 'open' && !pr.mergedAt && !pr.draft, 'The pull request must be open and ready for review.');
  add('pr-mergeable', pr.mergeable, 'GitHub must confirm this pull request is mergeable.');
  const failedChecks = pr.statusCheckRollup.filter(c => c.conclusion && c.conclusion.toLowerCase() !== 'success').length;
  const pendingChecks = pr.statusCheckRollup.filter(c => !c.conclusion || c.status?.toLowerCase() !== 'completed').length;
  const requestedChanges = reviews.filter(r => r.state?.toLowerCase() === 'changes_requested').length;
  // Match the existing desktop PRHeader workflow rules, including neutral/skipped conclusions.
  const workflow = describeWorkflowStage({ prState: pr.state, failedChecks, pendingChecks, requestedChanges });
  add('pr-checks', !pr.checksUnavailable && failedChecks === 0 && pendingChecks === 0, 'Checks must be available, finished and successful.');
  add('pr-review', discussion.reviewsIncomplete === false && requestedChanges === 0 && !['CHANGES_REQUESTED', 'REVIEW_REQUIRED'].includes(pr.reviewDecision?.toUpperCase() ?? ''), 'Read the complete review state and resolve requested changes before merging.');
  add('pr-workflow', workflow.mergeAllowed, workflow.mergeDetail);
  let membership: unknown = null;
  try {
    const found = await prMergeMembership(repo, pr);
    membership = { packets: found.packets, unresolved: found.unresolved, lanes: found.lanes.map(l => ({ id: l.id, packetId: l.packetId, status: l.status, sessionKey: l.sessionKey, prNumber: l.prNumber })) };
    for (const [id, versions] of found.packets) {
      add(`packet:${id}:merge-hold`, !isPacketMergeHeld(id) && !versions.some(p => p.mergeHold), 'An operator merge hold cannot be bypassed through a pull request.');
      add(`packet:${id}:state`, versions.length > 0 && !versions.some(p => p.status === 'blocked' || p.blockedReason || p.review?.approved === false), 'The linked packet must have an available, unblocked review state.');
      try {
        const preview = await previewPacketMerge(id);
        packets.push({ id, preview });
        for (const check of preview.checks) checks.push({ ...check, name: `packet:${id}:${check.name}` });
        add(`packet:${id}:preview`, preview.wouldMerge && !preview.blockers.length && !preview.mergeUnavailableReason, 'Every packet merge-preview gate must pass.');
      } catch (error) {
        if (error instanceof LaneBranchUnresolvedError) {
          const check = { name: 'worktree-branch' as const, verdict: 'fail' as const, detail: error.reason,
            actions: [`Restore the packet checkout to its recorded branch ${error.lane.branch} at the reviewed HEAD, then rerun merge-preview.`] };
          packets.push({ id, preview: { packetId: id, wouldMerge: false, branch: null, blockers: ['worktree-branch'], checks: [check] } });
          checks.push({ ...check, name: `packet:${id}:worktree-branch` });
        } else packets.push({ id, preview: null });
        add(`packet:${id}:preview`, false, 'Packet merge gates could not be read.');
      }
      // Preserve the existing refusal: the PR protocol cannot publish a governed packet atomically.
      add(`packet:${id}:protocol`, false, 'Use the governed packet merge path; PR merge cannot preserve its publication guarantees.');
    }
    for (const lane of found.lanes) {
      let alive: boolean | undefined;
      if (lane.sessionKey) {
        if (lane.sessionKey.includes('-owned:')) { await import('@/lib/runtimes'); await lookupOwnedActiveRunFresh(lane.sessionKey); }
        alive = await probeLaneSessionAlive(lane);
      } else if (['idle', 'completed', 'archived'].includes(lane.status)) alive = false;
      add(`runtime:${lane.id}`, alive === false, alive === true ? 'The linked runtime is still live.' : 'Runtime quiescence must be confirmed before merging.');
    }
    add('packet-membership', found.unresolved.length === 0, found.unresolved.length
      ? 'A possible PR owner has unavailable repository metadata. Restore its identity before merging.'
      : 'Repository/PR membership was read across all stored missions and linked worktrees.');
  } catch { add('packet-membership', false, 'Packet membership or runtime state is unavailable. Refresh before merging.'); }
  const snapshot = createHash('sha256').update(JSON.stringify({ repo: repo.toLowerCase(), number: pr.number, head: pr.headSha,
    base: pr.baseSha, baseRef: pr.baseRefName, headRef: pr.headRefName, headRepo: pr.headRepoFullName,
    state: pr.state, draft: pr.draft, mergedAt: pr.mergedAt, mergeable: pr.mergeable,
    identity: pr.githubIdentity, scope: pr.githubScope, methods: pr.allowedMergeMethods, autoMergeEnabled: pr.autoMergeEnabled,
    checks: pr.statusCheckRollup, checksUnavailable: pr.checksUnavailable, reviewsIncomplete: discussion.reviewsIncomplete,
    reviewDecision: pr.reviewDecision, reviews: reviews.map(r => [r.id, r.state]), membership, gates: checks })).digest('hex');
  return { repo, number: pr.number, headSha: pr.headSha, baseSha: pr.baseSha, baseRefName: pr.baseRefName,
    allowed: checks.every(c => c.verdict === 'pass' || c.verdict === 'skipped'), snapshot, checks, packets };
}

export class PrMergeRefused extends Error {
  constructor(public gate: PrMergeGate | null, changed: boolean) {
    super(changed ? 'Merge gates changed. Refresh and review before confirming again.'
      : gate?.checks.find(c => c.verdict === 'fail')?.detail ?? 'Merge gates could not be read before publication.');
  }
}
export async function assertPrMergeAllowed(repo: string, number: number, head: string, method: string, expectedSnapshot?: string) {
  try {
  const comments = fetchGitHubPullRequestComments(repo, number);
  const [pr, discussion] = await Promise.all([fetchGitHubPullRequestDetail(repo, number,
    comments.then(c => [...c.reviews].reverse().find(r => r.state && r.state !== 'COMMENTED')?.state ?? null)), comments]);
  const gate = await assessPrMergeGate(repo, pr, discussion);
  const changed = Boolean(expectedSnapshot && expectedSnapshot !== gate.snapshot) || head !== pr.headSha;
  if (changed || !gate.allowed || !pr.allowedMergeMethods.includes(method as 'merge' | 'squash' | 'rebase')) throw new PrMergeRefused(gate, changed);
  } catch (error) { if (error instanceof PrMergeRefused) throw error; throw new PrMergeRefused(null, false); }
}
