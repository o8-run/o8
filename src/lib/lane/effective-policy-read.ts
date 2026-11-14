import 'server-only';
import { readFile } from 'node:fs/promises';
import { getLegacyOperatorDefaultsPath } from '@/lib/settings/operator-defaults-store';
import { composeEffectivePolicy, type EffectivePolicyInput } from './effective-policy';
import { getLane, findLaneByPacket } from './registry';
import { readHeadSha } from './head-sha-lock';
import { validateReviewMode } from './review-mode';
import { classifyReviewRisk } from './review-risk';
import { extractAddedDiffLines } from './lane-diff-facts';
import { laneGit } from './lane-git';
import { resolveLaneAttributionBase } from './attribution-base';
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
    projectId: lane.projectId ?? null, laneId: lane.id, headSha: null,
    reviewMode: null, reviewOverride: process.env.O8_REVIEW_MODE !== undefined,
    risk: null, correctionBounds: null, mergePolicy: null, approvalPosture: null,
    review: null, holds: [], errors: [],
  };
  // Keep failure reasons bounded: parser errors and filesystem paths may contain
  // secrets. A failed read must never be mistaken for an inherited default.
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
    const base = await resolveLaneAttributionBase(lane, lane.worktreePath || lane.repoPath, head);
    const comparison = base.mergeBase ?? base.comparisonRef;
    if (!comparison) throw new Error('diff base unreadable');
    const range = `${comparison}..${head}`;
    const [names, diff] = await Promise.all([
      laneGit(lane.worktreePath || lane.repoPath, lane.repoPath, ['diff', '--name-only', '-z', range]),
      laneGit(lane.worktreePath || lane.repoPath, lane.repoPath, ['diff', '--no-color', '-U2', range]),
    ]);
    input.risk = classifyReviewRisk(names.stdout.split('\0').filter(Boolean), extractAddedDiffLines(diff.stdout));
    reading = 'durable-review';
    input.review = await assessDurableApprovedReview(lane, head);
    reading = 'packet-policy';
    const entry = lane.packetId ? findMissionRegistryEntryByPacketId(lane.packetId, { includeArchived: true }) : null;
    const packet = readOrchestratorControlPlaneState().packets.find(packet => packet.id === lane.packetId)
      ?? entry?.mission.packets.find(packet => packet.id === lane.packetId);
    if (packet) {
      input.correctionBounds = readReviewCorrectionBounds(packet);
      if (packet.queueState === 'held') input.holds.push({ source: 'packet-hold', precedence: 'saved', reason: 'The packet is held.' });
    }
    else input.errors.push('The packet correction budget could not be resolved for this work revision.');
    if (packet?.mergeHold === true || isPacketMergeHeld(lane.packetId)) input.holds.push({ source: 'merge-hold', precedence: 'saved', reason: 'Merging is held for the operator.' });
    try { assertSessionMergeAllowed(lane.packetId); }
    catch { input.holds.push({ source: 'session-restriction', precedence: 'saved', reason: 'Session merge restrictions require operator inspection.' }); }
    if (input.mergePolicy.mode === 'pr_only') input.holds.push({ source: 'dogfood-guard', reason: input.mergePolicy.note ?? 'PR-only mode is active.' });
    if (await readHeadSha(lane.worktreePath || lane.repoPath, lane.repoPath) !== head) {
      input.errors.push('Work revision changed during the policy read; read it again.');
    }
  } catch {
    input.errors.push(`${reading} state is unreadable; maintainer inspection is required before continuing.`);
  }
  return composeEffectivePolicy(input);
}
