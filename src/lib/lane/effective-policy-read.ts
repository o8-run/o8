import 'server-only';
import { readFile } from 'node:fs/promises';
import { getLegacyOperatorDefaultsPath } from '@/lib/settings/operator-defaults-store';
import { composeEffectivePolicy, type EffectivePolicyInput } from './effective-policy';
import { getLane, findLaneByPacket, getLaneEvents } from './registry';
import { readHeadSha } from './head-sha-lock';
import { validateReviewMode } from './review-mode';
import { laneGit } from './lane-git';
import { isProtectedPath } from '../../../scripts/ci/flag-test-deletions.mjs';
import { evaluatePolicy } from '@/lib/approvals/policies';
import { buildLanePolicyContext } from './commands-approval';
import { readRecordedPolicyRisk } from './effective-policy-risk';
import { currentLaneMergePolicy } from './dogfood-guard';
import { assessDurableApprovedReview } from './durable-review-approval';
import { isPacketMergeHeld } from './merge-hold';
import { assertSessionMergeAllowed } from '@/lib/orchestrator/session-merge-restriction';
import { findMissionRegistryEntryByPacketId } from '@/lib/orchestrator/mission-registry';
import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { readReviewCorrectionBounds } from '@/lib/orchestrator/review-author-correction';
import { getOperatorDefaultsSync, getOperatorDefaultsTomlState, isRequireApproval } from '@/lib/operator/defaults';

export async function readEffectivePolicy(id: string) {
  const lane = getLane(id) ?? findLaneByPacket(id);
  if (!lane) return null;
  const input: EffectivePolicyInput = {
    projectId: lane.projectId ?? null, laneId: lane.id, headSha: null, comparisonRef: null, readAt: new Date().toISOString(),
    reviewMode: null, reviewOverride: process.env.O8_REVIEW_MODE !== undefined,
    risk: null, correctionBounds: null, mergePolicy: null, approvalPosture: null,
    review: null, createPrApproval: null, holds: [], errors: [],
  };
  // Keep failure reasons bounded: parser errors and filesystem paths may contain
  // secrets. A failed read must never be mistaken for an inherited default.
  if (!['reviewing', 'paused'].includes(lane.status)) input.holds.push({ source: 'lane-state', precedence: 'derived', blocks: ['create_pr'],
    reason: `Creating a PR is blocked in lane status ${lane.status}; inspect the lane before continuing.` });
  if (!lane.worktreePath) input.holds.push({ source: 'missing-worktree', precedence: 'derived', blocks: ['create_pr'],
    reason: 'Creating a PR is blocked: the lane has no worktreePath.' });
  if (lane.prNumber !== null) input.holds.push({ source: 'existing-pull-request', precedence: 'derived', blocks: ['create_pr'],
    reason: 'Creating another PR is blocked: this lane already has a pull request; inspect its open or merged outcome.' });
  let reading = 'review-mode';
  try {
    input.reviewMode = validateReviewMode();
    reading = 'operator-defaults';
    const settings = await getOperatorDefaultsTomlState();
    if (settings.error) throw new Error('settings unreadable');
    // The normal startup reader deliberately tolerates malformed legacy JSON.
    // A policy read must report that uncertainty instead of presenting fallback
    // values as a confirmed operator choice.
    let legacy: string | null = null;
    try { legacy = await readFile(getLegacyOperatorDefaultsPath(), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (legacy !== null) {
      const stored = JSON.parse(legacy) as Record<string, unknown>;
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)
        || (stored.requireApproval !== undefined && !isRequireApproval(stored.requireApproval))) throw new Error('legacy settings unreadable');
    }
    const defaults = getOperatorDefaultsSync();
    input.approvalPosture = { value: defaults.values.requireApproval, source: defaults.sources.requireApproval };
    reading = 'merge-mode';
    input.mergePolicy = currentLaneMergePolicy();
    reading = 'work-revision';
    const head = await readHeadSha(lane.worktreePath || lane.repoPath, lane.repoPath);
    input.headSha = head;
    reading = 'review-risk';
    const recorded = readRecordedPolicyRisk(lane.id, head);
    input.risk = recorded.risk;
    input.comparisonRef = recorded.comparisonRef;
    if (recorded.uncertain) input.holds.push({ source: 'review-risk-uncertain', precedence: 'derived', blocks: ['create_pr', 'merge'],
      reason: 'PR preparation is held: no trustworthy risk receipt and comparison base are pinned to this HEAD. Request independent review again.' });
    if (recorded.comparisonRef) {
      const names = await laneGit(lane.worktreePath || lane.repoPath, lane.repoPath,
        ['--no-optional-locks', 'diff', '--name-only', '-z', `${recorded.comparisonRef}..${head}`]);
      if (names.stdout.split('\0').some(isProtectedPath)) input.holds.push({ source: 'protected-test-change', precedence: 'derived', blocks: ['create_pr', 'merge'],
        reason: 'PR preparation requires maintainer inspection: this revision changes protected test-control paths identified by the CI policy.' });
    }
    reading = 'durable-review';
    input.review = await assessDurableApprovedReview(lane, head, { readOnly: true });
    reading = 'packet-policy';
    const entry = lane.packetId ? findMissionRegistryEntryByPacketId(lane.packetId, { includeArchived: true }) : null;
    const packet = readOrchestratorControlPlaneState().packets.find(packet => packet.id === lane.packetId)
      ?? entry?.mission.packets.find(packet => packet.id === lane.packetId);
    if (packet) {
      input.correctionBounds = readReviewCorrectionBounds(packet);
      if (packet.queueState === 'held') input.holds.push({ source: 'packet-hold', precedence: 'saved', blocks: ['create_pr', 'merge', 'correction'], reason: 'PR preparation and correction are held by the packet queue hold.' });
    }
    else input.errors.push('The packet correction budget could not be resolved for this work revision.');
    if (packet?.taskContractRequired === true && input.review.approved) {
      input.review = { ...input.review, approved: false, highConfidence: false,
        reason: 'Required contract coverage is unevaluated by this read; PR creation must verify it through execution.' };
    }
    reading = 'approval-posture';
    const approval = evaluatePolicy(buildLanePolicyContext(lane, 'create_pr', 'orchestrator', { hasApprovedReview: input.review.approved }));
    input.createPrApproval = { requiresApproval: approval.requiresApproval, ruleId: approval.ruleId ?? null, reason: approval.reason };
    const events = getLaneEvents(lane.id, 1000);
    if (packet?.lastEventLabel === 'scope_expansion_requested' || events.some(event => event.verb === 'scope_expansion_requested' && event.payload.expanded === true)) {
      input.holds.push({ source: 'scope-expansion', precedence: 'saved', blocks: ['create_pr', 'merge', 'correction'],
        reason: 'PR preparation and further correction require maintainer inspection of the recorded scope expansion.' });
    }
    if (packet?.mergeHold === true || isPacketMergeHeld(lane.packetId)) input.holds.push({ source: 'merge-hold', precedence: 'saved', blocks: ['merge'], reason: 'Merging is held for the operator; a review does not release the hold.' });
    try { assertSessionMergeAllowed(lane.packetId); }
    catch { input.holds.push({ source: 'session-restriction', precedence: 'saved', blocks: ['merge'], reason: 'Merging is blocked by a session restriction or inconsistent parent identity; operator inspection is required.' }); }
    if (input.mergePolicy.mode === 'pr_only') input.holds.push({ source: 'dogfood-guard', precedence: 'run-effective', blocks: ['merge'], reason: 'Direct merging is blocked by the PR-only safety wall.' });
    if (await readHeadSha(lane.worktreePath || lane.repoPath, lane.repoPath) !== head) {
      input.errors.push('Work revision changed during the policy read; read it again.');
    }
  } catch {
    input.errors.push(`${reading} state is unreadable; maintainer inspection is required before continuing.`);
  }
  return composeEffectivePolicy(input);
}
