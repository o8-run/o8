import { observeWsHealthHandler } from '@/lib/ws-server/handler-activity';
import type { MergePreviewResult } from '@/lib/lane/preview-merge';
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';
import type { MergeOrderRecommendation } from '@/lib/worktree/conflicts';
import type { WorktreeInfo } from '@/lib/worktree/types';
import type { ApproveAndMergeInput, MergePacketResult, PickComparisonWinnerInput } from './types';
import { autoResolveMergedPacketVerificationIncidents } from '@/lib/supervisor/merged-incident-resolution';
import { attachQualitySearchReceipt, ensureComparisonWinnerReview, resolveQualitySearchComparison } from './quality-search-selection';
import { alreadyReleasedResultForPacketId } from './release-truth';
export { isTerminalReleaseLane } from './release-truth';
import { HeadShaMismatchError } from './merge-head-error';
export { HeadShaMismatchError, isHeadShaMismatchError } from './merge-head-error';
import { markPacketReleased } from '@/lib/orchestrator/packet-release-truth';
import { packetReleaseGeneration, packetReleaseIdentityIsCurrent } from '@/lib/orchestrator/release-ownership';
import { withPacketMergeWorkspace } from './merge-workspace-guard';
import { findLatestMergeApproval } from '@/lib/lane/merge-approval-context';
import { selectMergeSequence } from './merge-order';
export { selectMergeSequence } from './merge-order';
type LaneRegistryModule = typeof import('@/lib/lane/registry');
type ActivePacketLane = NonNullable<ReturnType<LaneRegistryModule['findLatestLaneByPacket']>>;

const loadApprovalsStore = () => import('@/lib/approvals/store');
const loadDirectiveMerges = () => import('@/lib/cortex/directive-merges');
const loadLaneCommands = () => import('@/lib/lane/commands');
const loadPreviewMerge = () => import('@/lib/lane/preview-merge');
const loadLaneRegistry = () => import('@/lib/lane/registry');
const loadLaneEvents = () => import('@/lib/lane/events');
const loadReviewHeadIntegrity = () => import('@/lib/lane/review-head-integrity');
const loadControlPlane = () => import('@/lib/orchestrator/control-plane');
const loadDag = () => import('@/lib/orchestrator/dag');
const loadDispatch = () => import('@/lib/orchestrator/dispatch');
const loadWorktreeCleanup = () => import('@/lib/orchestrator/worktree-cleanup');
const loadWorktreeConflicts = () => import('@/lib/worktree/conflicts');
const loadWorktreeLaunch = () => import('@/lib/worktree/launch');
const loadPostMergeCleanup = () => import('./post-merge-cleanup');
const loadReviewCarry = () => import('./review-carry');
const loadReview = () => import('./review');
const loadShared = () => import('./shared');

export async function warmMergePath() {
  await Promise.all([
    loadApprovalsStore(),
    loadDirectiveMerges(),
    loadLaneCommands(),
    loadPreviewMerge(),
    loadLaneRegistry(),
    loadControlPlane(),
    loadReviewHeadIntegrity(),
    loadDag(),
    loadDispatch(),
    loadWorktreeCleanup(),
    loadWorktreeConflicts(),
    loadWorktreeLaunch(),
    loadPostMergeCleanup(),
    loadReview(),
    loadShared(),
  ]);
}

interface MergeOrderCandidate {
  packet: OrchestratorPacket;
  lane: ActivePacketLane;
  worktree: WorktreeInfo;
}

interface OrderedMergeCandidate extends MergeOrderCandidate {
  recommendation: MergeOrderRecommendation;
  /** Worktree ids whose diffs touch at least one file this candidate also touches (#1525). */
  overlappingWorktreeIds: Set<string>;
}

function isPacketAwaitingMerge(packet: OrchestratorPacket) {
  return packet.status === 'awaiting_review'
    && packet.releaseState !== 'released'
    && packet.review?.approved !== false;
}

export async function getWaveMergeOrder(
  state: OrchestratorMissionState,
  packetId: string,
): Promise<OrderedMergeCandidate[] | null> {
  const [
    { buildDependencyGraph },
    { findLatestLaneByPacket },
    { getWorktreeManager },
    { detectFileOverlaps, recommendMergeOrder },
  ] = await Promise.all([
    loadDag(),
    loadLaneRegistry(),
    loadWorktreeLaunch(),
    loadWorktreeConflicts(),
  ]);
  const graph = buildDependencyGraph(state.packets);
  const packetById = new Map(state.packets.map((packet) => [packet.id, packet] as const));
  const targetNode = graph.find((node) => node.packetId === packetId);
  if (!targetNode) {
    return null;
  }

  const targetPacket = packetById.get(packetId);
  // Same ownership rule as the merge dispatch below: the packet names its own
  // repository, and the ambient mission is only a fallback.
  const repoPath = targetPacket?.workspaceTargetPath ?? state.repoPath ?? null;
  if (!repoPath) {
    return null;
  }

  const sameWavePackets = graph
    .filter((node) => node.wave === targetNode.wave)
    .map((node) => packetById.get(node.packetId))
    .filter((packet): packet is OrchestratorPacket => packet !== undefined && isPacketAwaitingMerge(packet));

  if (sameWavePackets.length <= 1) {
    return null;
  }

  const worktrees = await getWorktreeManager(repoPath).list();
  const worktreeByPath = new Map(worktrees.map((worktree) => [worktree.path, worktree] as const));
  const candidates = sameWavePackets.flatMap((packet) => {
    const lane = findLatestLaneByPacket(packet.id);
    if (!lane?.worktreePath) {
      return [];
    }

    const worktree = worktreeByPath.get(lane.worktreePath);
    if (!worktree) {
      return [];
    }

    return [{ packet, lane, worktree }];
  });

  if (candidates.length <= 1) {
    return null;
  }

  // Adversarial F9 — the worktree dirty-files probe swallows partial failures
  // (committed-diff vs an unreachable base resolves to ''), which since #1525
  // could turn a real overlap into a false negative and let coupled siblings
  // merge out of order. Augment each candidate with the lane's own diff facts:
  // a second independent probe that can only ADD overlaps, never remove them.
  const { getLaneDiffFacts } = await import('@/lib/lane/lane-diff-facts');
  const enrichedCandidates = candidates.map((candidate) => {
    try {
      const facts = getLaneDiffFacts(candidate.lane);
      const merged = new Set([...candidate.worktree.dirtyFiles, ...facts.changedFiles]);
      return { ...candidate, worktree: { ...candidate.worktree, dirtyFiles: [...merged] } };
    } catch {
      return candidate;
    }
  });

  const candidateWorktrees = enrichedCandidates.map((candidate) => candidate.worktree);
  const overlaps = detectFileOverlaps(candidateWorktrees);
  const recommendations = await recommendMergeOrder(candidateWorktrees, overlaps);
  const candidateByWorktreeId = new Map(enrichedCandidates.map((candidate) => [candidate.worktree.id, candidate] as const));

  // #1525 — symmetric overlap index, so enforcement can be scoped to packets
  // that actually touch the same files.
  const overlapsByWorktreeId = new Map<string, Set<string>>();
  for (const overlap of overlaps) {
    if (!overlapsByWorktreeId.has(overlap.worktreeA)) overlapsByWorktreeId.set(overlap.worktreeA, new Set());
    if (!overlapsByWorktreeId.has(overlap.worktreeB)) overlapsByWorktreeId.set(overlap.worktreeB, new Set());
    overlapsByWorktreeId.get(overlap.worktreeA)!.add(overlap.worktreeB);
    overlapsByWorktreeId.get(overlap.worktreeB)!.add(overlap.worktreeA);
  }

  const ordered = recommendations.flatMap((recommendation) => {
    const candidate = candidateByWorktreeId.get(recommendation.worktreeId);
    return candidate
      ? [{
          ...candidate,
          recommendation,
          overlappingWorktreeIds: overlapsByWorktreeId.get(candidate.worktree.id) ?? new Set<string>(),
        }]
      : [];
  });

  if (ordered.length <= 1) {
    return null;
  }

  console.log('[merge-order]', {
    wave: targetNode.wave,
    requestedPacketId: packetId,
    sequence: ordered.map(({ packet, worktree, recommendation }) => ({
      position: recommendation.position,
      packetId: packet.id,
      referenceLabel: packet.referenceLabel,
      title: packet.title,
      worktreeId: worktree.id,
      agentType: recommendation.agentType,
      fileCount: recommendation.fileCount,
      totalChanges: recommendation.totalChanges,
      reason: recommendation.reason,
    })),
  });

  return ordered;
}

/**
 * #623 — Decorate a failing merge result with structured gate verdict fields.
 * Populates `checks[]`, `blockers[]`, and the back-compat `reason` string so
 * callers see the same structured shape the preview tool returns.
 * No-op on success results.
 */
async function withGateVerdict(
  packetId: string,
  result: MergePacketResult,
  orchestratorApproved = false,
): Promise<MergePacketResult> {
  if (result.merged) return result;
  // Preserve prior decoration if merge.ts already populated the fields.
  if (result.checks && result.blockers) return result;

  const [{ findLatestLaneByPacket }, { buildPreviewForLane }] = await Promise.all([
    loadLaneRegistry(),
    loadPreviewMerge(),
  ]);
  const lane = findLatestLaneByPacket(packetId);
  if (!lane) return result;

  let preview: MergePreviewResult;
  try {
    preview = await buildPreviewForLane(lane, packetId, { orchestratorApproved });
  } catch (error) {
    console.warn(`${'[mcp-operator]'} gate verdict decoration failed for packet ${packetId}:`, error);
    return result;
  }

  const blockers = preview.blockers;
  // Keep the policy's named refusal stable; the full blocker list remains available.
  const runPolicyBlocker = blockers.find(blocker => blocker.startsWith('review_run_'));
  const reason = result.reason ?? runPolicyBlocker ?? (blockers.length > 0 ? blockers.join(', ') : result.note);
  return {
    ...result,
    checks: preview.checks,
    blockers,
    reason,
    ...(!result.reason && runPolicyBlocker ? { note: preview.checks.find(check => check.name === runPolicyBlocker)?.detail ?? result.note } : {}),
  };
}

async function dispatchPacketMerge(
  packet: OrchestratorPacket,
  input: ApproveAndMergeInput,
  actor: 'orchestrator' | 'user',
  workspaceLockHeld = false,
): Promise<MergePacketResult> {
  const [
    { findLatestLaneByPacket, appendEvent, setLaneStatus },
    { capturePostMergeCleanupTarget, postMergeCleanup },
    { dispatch: dispatchLaneCommand },
    { mapReviewSummary },
    { currentMissionState, log },
    { checkReviewedHeadIntegrity, formatReviewedHeadMismatchNote },
  ] = await Promise.all([
    loadLaneRegistry(),
    loadPostMergeCleanup(),
    loadLaneCommands(),
    loadReview(),
    loadShared(),
    loadReviewHeadIntegrity(),
  ]);
  const missionState = currentMissionState();
  const alreadyReleased = await alreadyReleasedResultForPacketId(packet.id, missionState.packets);
  if (alreadyReleased) {
    return alreadyReleased;
  }

  const lane = findLatestLaneByPacket(packet.id);
  if (!lane) {
    throw new Error(`Packet ${packet.id} is not bound to an active lane.`);
  }
  if (!workspaceLockHeld) {
    return withPacketMergeWorkspace(lane, () => dispatchPacketMerge(packet, input, actor, true));
  }
  const releaseGeneration = packetReleaseGeneration(packet, lane.id);
  let carriedReviewedHeadSha: string | undefined;
  const reviewedHead = await checkReviewedHeadIntegrity(lane, lane.worktreePath || lane.repoPath);
  if (!reviewedHead.ok) {
    const { carryReviewAcrossRebaseIfSamePatch } = await loadReviewCarry();
    const carried = await carryReviewAcrossRebaseIfSamePatch({
      packet,
      lane,
      reviewedHeadSha: reviewedHead.reviewedHeadSha,
      currentHeadSha: reviewedHead.currentHeadSha,
      actor,
    });
    if (carried) {
      carriedReviewedHeadSha = reviewedHead.currentHeadSha;
      log(`Carried review pin across rebase for packet ${packet.id}.`, {
        from: reviewedHead.reviewedHeadSha,
        to: reviewedHead.currentHeadSha,
        actor,
      });
    } else {
      setLaneStatus(lane.id, 'reviewing', 'system', 'review_invalidated');
      appendEvent(lane.id, 'review_invalidated', actor, {
        reviewedHeadSha: reviewedHead.reviewedHeadSha,
        currentHeadSha: reviewedHead.currentHeadSha,
        branch: lane.branch,
        baseBranch: lane.baseBranch,
        packetId: lane.packetId,
      });
      return {
        merged: false,
        note: formatReviewedHeadMismatchNote(reviewedHead),
        reason: 'head_moved_since_review',
        reviewedHeadSha: reviewedHead.reviewedHeadSha,
        currentHeadSha: reviewedHead.currentHeadSha,
      };
    }
  }
  const cleanupTarget = await capturePostMergeCleanupTarget(lane);

  const result = await dispatchLaneCommand({
    verb: 'merge',
    laneId: lane.id,
    commitMessage: input.commitMessage?.trim() || undefined,
    reviewSummary: mapReviewSummary(packet),
    // Advisory only; commands.ts re-derives authorization from durable review rows.
    orchestratorReviewed: packet.review?.approved === true,
    expectedHeadSha: input.expectedHeadSha?.trim() || carriedReviewedHeadSha || packet.review?.reviewedHeadSha?.trim() || undefined,
    // #2308 — the packet's own workspace target is the canonical repository for
    // its merge. `currentMissionState().repoPath` belongs to whichever mission
    // the control plane currently holds, and dispatched packets (delegate, board
    // tasks, intake) are appended to that state without changing it — so leading
    // with it aimed locking, integration, publication and evidence capture at a
    // repository the packet never targeted. Mission state stays the fallback for
    // packets with no recorded target; #1630's rule still holds — a lane's own
    // repoPath can be a relocated packet clone, so it remains last.
    canonicalRepoPath: packet.workspaceTargetPath?.trim() || missionState.repoPath?.trim() || lane.repoPath,
    surfaceDispatcherApproved: input.actor === 'user',
    actor,
  });
  const { mergePacketResultFromLaneCommand } = await import('@/lib/lane/worktree-side-merge-verify');

  if (!result.ok && result.reason === 'head_moved_since_review' && result.reviewedHeadSha && result.currentHeadSha) {
    const { carryReviewAcrossRebaseIfSamePatch } = await loadReviewCarry();
    const carried = await carryReviewAcrossRebaseIfSamePatch({
      packet,
      lane,
      reviewedHeadSha: result.reviewedHeadSha,
      currentHeadSha: result.currentHeadSha,
      actor,
    });
    if (carried) {
      return dispatchPacketMerge(packet, input, actor);
    }
    log(`Merge refused for packet ${packet.id}: reviewed HEAD moved.`, {
      reviewedHeadSha: result.reviewedHeadSha,
      currentHeadSha: result.currentHeadSha,
      actor,
    });
    return {
      merged: false,
      note: result.note,
      reason: 'head_moved_since_review',
      reviewedHeadSha: result.reviewedHeadSha,
      currentHeadSha: result.currentHeadSha,
    };
  }

  if (!result.ok && result.expectedHeadSha && result.currentHeadSha) {
    throw new HeadShaMismatchError(packet.id, result.expectedHeadSha, result.currentHeadSha);
  }

  // Persist canonical release evidence before lane reconciliation projects the
  // retired workspace as archived. Evidence-backed release then survives sync.
  const [
    { readOrchestratorControlPlaneState, syncOrchestratorControlPlaneState, withLockedState },
    { runDispatchTick },
  ] = await Promise.all([
    loadControlPlane(),
    loadDispatch(),
  ]);
  if (result.ok) {
    await withLockedState(async (fresh) => {
      const packetState = fresh.packets.find((candidate) => candidate.id === input.packetId);
      if (!packetState || !packetReleaseIdentityIsCurrent(packetState, lane.id, releaseGeneration)) return;
      markPacketReleased(packetState, {
        source: 'approve_and_merge',
        mergeCommit: result.mergeSha ?? null,
        headSha: result.reviewedHeadSha ?? result.mergeSha ?? null,
        evidenceKind: 'merge_command',
      });
      packetState.lastEventAt = packetState.releaseStatePayload!.releasedAt!;
      packetState.lastEventLabel = 'merged';
      if (packetState.lane) {
        packetState.lane.lastEventAt = packetState.lastEventAt;
        packetState.lane.lastEventLabel = 'merged';
      }
      const { persistReleasedPacketToMission } = await import('@/lib/orchestrator/mission-registry');
      if (!(await persistReleasedPacketToMission(packetState, lane.id, releaseGeneration))) {
        throw new Error('Durable packet ownership changed before merge release could be persisted.');
      }
    });
  }

  // #622 — Synchronous worktree cleanup guarantee.
  if (result.ok) {
    // #1110 follow-up — stamp mergedClean on the session_outcomes row so the
    // routing recommender (#747) can score successful merges. Fire-and-forget:
    // a ledger update failure must NEVER roll back a successful merge.
    void import('@/lib/orchestrator/context-relay').then(({ markOutcomeMerged }) =>
      markOutcomeMerged({ laneId: lane.id, packetId: packet.id }),
    ).catch((err) => {
      console.warn(`[session-outcome-merge] mergedClean backfill failed for packet ${packet.id}:`, err);
    });

    const [{ removeMergedWorktree, recordSkippedMergeCleanup }, { appendDirectiveTrailer }] = await Promise.all([
      loadWorktreeCleanup(),
      loadDirectiveMerges(),
    ]);
    const cleanup = await removeMergedWorktree(lane);
    if (!cleanup.removed) recordSkippedMergeCleanup(lane, packet.id, cleanup);
    void postMergeCleanup(cleanupTarget).catch((error) => {
      console.warn(`[merge-cleanup] Unexpected cleanup failure for lane ${lane.id}:`, error);
    });

    // #769 — Living Specs. Append a one-line trailer to every directive
    // matching this repo so each directive accumulates evidence of which
    // merges respected (or, once #732 ships violation flags, violated)
    // it. Best-effort — never roll back a successful merge over a markdown
    // bug. `violated` is wired off `packet.review.approved === false`,
    // matching the same flag that gates `[REJECTED]` in the outcomes block.
    try {
      const repoPath = packet.workspaceTargetPath?.trim() || lane.repoPath;
      if (repoPath) {
        const violated = packet.review?.approved === false;
        const updated = appendDirectiveTrailer({
          repoPath,
          entry: {
            date: new Date().toISOString().slice(0, 10),
            status: violated ? 'violated' : 'merged',
            title: packet.title,
            issueNumber: packet.issue?.number ?? null,
          },
          // #843 — Pass the merge commit message through so any
          // `Spec-Update: <directive-name>` lines in the body narrow the
          // trailer to a specific directive instead of blanket-appending.
          commitMessage: input.commitMessage ?? null,
        });
        if (updated.length > 0) {
          console.log(
            `[living-specs] Appended ${violated ? '[violated]' : '[merged]'} trailer to ${updated.length} directive${updated.length === 1 ? '' : 's'} for packet ${packet.id} (${updated.join(', ')})`,
          );
          // #840 — `appendDirectiveTrailer` itself fires
          // `publishCortexChange({ scope: 'directive' })` so any caller
          // (this path + REPL smoke tests + future external-merge handler)
          // refreshes the Recall Card without extra wiring here.
        }
      }
    } catch (error) {
      console.warn(
        `[living-specs] Trailer append failed for packet ${packet.id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  const synced = await syncOrchestratorControlPlaneState();

  const releasedAfterDispatch = await alreadyReleasedResultForPacketId(input.packetId, synced.packets);
  if (!result.ok && releasedAfterDispatch) {
    return releasedAfterDispatch;
  }
  // A reviewed failure is held by the lane command at an actionable state.
  // Don't run a dispatch tick for that case: it can relaunch recoverable work
  // while the operator is still resolving the gate.
  const failedLane = !result.ok ? findLatestLaneByPacket(packet.id) : null;
  if (!result.ok && (failedLane?.status === 'reviewing' || failedLane?.status === 'awaiting_orchestrator')) {
    log(`Merge command held for packet ${packet.id}.`, { note: result.note, actor });
    return withGateVerdict(packet.id, mergePacketResultFromLaneCommand(result), packet.review?.approved === true);
  }

  // The receipt signer re-reads the persisted release payload. Launch it only
  // after withLockedState releases, and never let artifact I/O delay a merge.
  if (result.ok && result.mergeSha) {
    void import('@/lib/receipts/packet-receipt')
      .then(({ createPacketReceiptForClosedPacket }) => createPacketReceiptForClosedPacket({
        packetId: packet.id,
        laneId: lane.id,
        repoPath: lane.repoPath,
        expectedMergeCommit: result.mergeSha,
      }))
      .catch((error) => {
        console.warn(`[receipts] Merge receipt failed for packet ${packet.id}:`, error);
      });
  }

  // The dispatch tick stays OUTSIDE the lock (it clones worktrees and spawns
  // sessions); its outcome is merged per changed packet under the lock so a
  // write that landed mid-tick survives.
  const tickBase = readOrchestratorControlPlaneState();
  const afterDispatch = await runDispatchTick(tickBase);
  const { mergeDispatchTickOutcome } = await loadDispatch();
  await withLockedState((fresh) => {
    mergeDispatchTickOutcome(fresh, tickBase, afterDispatch);
  });
  if (result.ok) autoResolveMergedPacketVerificationIncidents({ packetId: packet.id, laneId: lane.id, event: 'approve_and_merge' });

  // #1492 — auto buy-in doc. Fire-and-forget so it NEVER blocks or fails a
  // merge; the packet carries a generating→ready|failed status and the released
  // card only surfaces a link when ready. Off by default (operator opt-in).
  if (result.ok) {
    const { launchPostMergeBuyin } = await import('./post-merge-buyin');
    await launchPostMergeBuyin({
      repoPath: lane.repoPath,
      laneId: lane.id,
      packetId: packet.id,
      packetTitle: packet.title,
      packetSummary: packet.summary ?? '',
      mergeSha: result.mergeSha ?? null,
      deviationsRaw: packet.deviations?.raw ?? null,
    });
  }

  log(`Merge command finished for packet ${packet.id}.`, {
    ok: result.ok,
    approvalId: result.approvalId ?? null,
    actor,
  });

  return withGateVerdict(packet.id, mergePacketResultFromLaneCommand(result), packet.review?.approved === true);
}

async function approveAndMergeSinglePacket(input: ApproveAndMergeInput): Promise<MergePacketResult> {
  const { currentMissionState } = await loadShared();
  const state = currentMissionState();
  const packet = state.packets.find((candidate) => candidate.id === input.packetId);
  const alreadyReleased = await alreadyReleasedResultForPacketId(input.packetId, state.packets);
  if (alreadyReleased) {
    return alreadyReleased;
  }

  if (!packet) {
    // #557 — Fall through to lane-only merge when the mission packet is missing.
    // #622 — wrapper captures lane pre-merge and runs synchronous cleanup on
    // success, making the bash-merge fallback atomic with the merge commit.
    const { mergeOrphanLaneByPacket } = await import('../orphan-lane-merge');
    const { withSynchronousWorktreeCleanup } = await loadWorktreeCleanup();
    const orphanResult = await withSynchronousWorktreeCleanup(
      input.packetId,
      () => mergeOrphanLaneByPacket(input.packetId, input.commitMessage, input.expectedHeadSha),
    );
    const releasedAfterOrphanDispatch = await alreadyReleasedResultForPacketId(input.packetId, currentMissionState().packets);
    if (!orphanResult.merged && releasedAfterOrphanDispatch) {
      return releasedAfterOrphanDispatch;
    }
    if (!orphanResult.merged && orphanResult.expectedHeadSha && orphanResult.currentHeadSha) {
      throw new HeadShaMismatchError(input.packetId, orphanResult.expectedHeadSha, orphanResult.currentHeadSha);
    }
    if (!orphanResult.merged && orphanResult.reason === 'head_moved_since_review') {
      return orphanResult;
    }
    return withGateVerdict(input.packetId, orphanResult);
  }

  if (packet.review && !packet.review.approved) {
    return {
      merged: false,
      note: 'Packet review is not approved. Resolve findings before merging.',
    };
  }

  const [{ findLatestLaneByPacket }, { isPacketMergeHeld }] = await Promise.all([loadLaneRegistry(), import('@/lib/lane/merge-hold')]);
  const lane = findLatestLaneByPacket(packet.id);
  if (!lane) {
    throw new Error(`Packet ${packet.id} is not bound to an active lane.`);
  }
  let latestMergeApproval = await findLatestMergeApproval(packet.id, lane.id, lane.sessionKey);
  if (latestMergeApproval?.status === 'pending') {
    // A live human operator clicking merge IS the approval — resolve the
    // pending card (full audit trail) and fall through to the merge instead
    // of bouncing the human to the inbox for a second click (Q ruling
    // 2026-07-18). Gate violations stay a hard stop even for the operator:
    // that card carries findings a human must read. #3740: the lead shares the operator token, so a held packet merges only from the inbox.
    if (input.actor === 'user' && !isPacketMergeHeld(packet.id) && latestMergeApproval.policyRuleId === 'merge-gate-violation') {
      const { buildPreviewForLane } = await loadPreviewMerge();
      const preview = await buildPreviewForLane(lane, packet.id, {
        orchestratorApproved: packet.review?.approved === true,
        ignorePendingGateApproval: true,
      });
      if (preview.wouldMerge) {
        const { resolveApproval } = await import('@/lib/approvals/resolution');
        latestMergeApproval = resolveApproval(latestMergeApproval.id, 'approve', 'desktop', 'Operator waiver now satisfies the merge gate.');
      } else {
        return withGateVerdict(packet.id, {
          merged: false,
          note: 'Merge gate enforcement: human review required.',
          approvalId: latestMergeApproval.id,
        }, packet.review?.approved === true);
      }
    } else if (input.actor === 'user' && !isPacketMergeHeld(packet.id)) {
      const { resolveApproval } = await import('@/lib/approvals/resolution');
      latestMergeApproval = resolveApproval(latestMergeApproval.id, 'approve', 'desktop', 'Operator merged directly from the review surface.');
    } else {
      return withGateVerdict(packet.id, {
        merged: false,
        note: latestMergeApproval.policyRuleId === 'merge-gate-violation'
          ? 'Merge gate enforcement: human review required.'
          : `Approval required: ${latestMergeApproval.title}`,
        approvalId: latestMergeApproval.id,
      }, packet.review?.approved === true);
    }
  }
  if (latestMergeApproval?.status === 'approved' && (lane.status === 'completed' || lane.status === 'archived')) {
    const { syncOrchestratorControlPlaneState } = await loadControlPlane();
    const synced = await syncOrchestratorControlPlaneState();
    const releasedAfterSync = await alreadyReleasedResultForPacketId(packet.id, synced.packets);
    if (releasedAfterSync) return releasedAfterSync;
  }

  const mergeActor = latestMergeApproval?.status === 'approved' && !isPacketMergeHeld(packet.id) ? 'user' : 'orchestrator';
  return dispatchPacketMerge(packet, input, mergeActor);
}

export const approveAndMergePacket = observeWsHealthHandler('merge', async function approveAndMergePacket(input: ApproveAndMergeInput) {
  const { currentMissionState } = await loadShared();
  const state = currentMissionState();
  const packet = state.packets.find((candidate) => candidate.id === input.packetId);
  // #557 — Missing packet falls through to single-packet merge (lane fallback).
  if (!packet) return approveAndMergeSinglePacket(input);

  const orderedWavePackets = await getWaveMergeOrder(state, packet.id);
  if (!orderedWavePackets) {
    return approveAndMergeSinglePacket(input);
  }

  const targetIndex = orderedWavePackets.findIndex((candidate) => candidate.packet.id === packet.id);
  if (targetIndex === -1) {
    return approveAndMergeSinglePacket(input);
  }

  // #1525 — only overlap-coupled siblings are prerequisites; disjoint
  // parallel packets merge in any order.
  const mergeSequence = selectMergeSequence(orderedWavePackets, targetIndex);
  const mergedPrerequisites: string[] = [];
  let requestedResult: MergePacketResult | null = null;
  for (const candidate of mergeSequence) {
    const result = await approveAndMergeSinglePacket({
      packetId: candidate.packet.id,
      commitMessage: candidate.packet.id === packet.id ? input.commitMessage : undefined,
      expectedHeadSha: candidate.packet.id === packet.id ? input.expectedHeadSha : undefined,
      actor: candidate.packet.id === packet.id ? input.actor : undefined,
    });

    if (!result.merged) {
      return {
        merged: false,
        note: candidate.packet.id === packet.id
          ? result.note
          : `Merge order requires ${candidate.packet.referenceLabel} to merge before ${packet.referenceLabel}: ${result.note}`,
        ...(result.approvalId ? { approvalId: result.approvalId } : {}),
        ...(result.checks ? { checks: result.checks } : {}),
        ...(result.blockers ? { blockers: result.blockers } : {}),
        ...(result.reason ? { reason: result.reason } : result.blockers ? { reason: result.blockers.join(', ') || result.note } : {}),
        ...(result.reviewedHeadSha ? { reviewedHeadSha: result.reviewedHeadSha } : {}),
        ...(result.currentHeadSha ? { currentHeadSha: result.currentHeadSha } : {}),
      };
    }

    if (candidate.packet.id !== packet.id) {
      mergedPrerequisites.push(candidate.packet.referenceLabel);
      continue;
    }

    requestedResult = result;
  }

  if (!requestedResult) {
    return {
      merged: false,
      note: `Packet ${packet.referenceLabel} was not included in the recommended merge sequence.`,
    };
  }

  return {
    ...requestedResult,
    note: mergedPrerequisites.length > 0
      ? `Merged ${mergedPrerequisites.join(', ')} before ${packet.referenceLabel} based on recommended same-wave merge order. ${requestedResult.note}`
      : requestedResult.note,
  };
});
export async function pickComparisonWinner(input: PickComparisonWinnerInput) {
  const [
    { currentMissionState },
    { withLockedState },
    { archiveLane },
    { recordLaneEvent },
  ] = await Promise.all([
    loadShared(),
    loadControlPlane(),
    loadLaneRegistry(),
    loadLaneEvents(),
  ]);
  const state = currentMissionState();
  const requestedWinner = state.packets.find((candidate) => candidate.id === input.packetId);
  if (!requestedWinner) {
    throw new Error(`Packet ${input.packetId} not found.`);
  }

  const comparisonGroupId = requestedWinner.comparisonGroupId?.trim();
  if (!comparisonGroupId) {
    throw new Error(`Packet ${requestedWinner.id} is not part of a comparison group.`);
  }

  const comparisonPackets = state.packets.filter((packet) => packet.comparisonGroupId === comparisonGroupId);
  if (comparisonPackets.length < 2) {
    throw new Error(`Comparison group ${comparisonGroupId} has no alternate candidates to compare.`);
  }
  const qualityResolution = await resolveQualitySearchComparison({ comparisonPackets, comparisonGroupId, requestedWinner });
  if (qualityResolution.terminalResult) return qualityResolution.terminalResult;
  const qualitySearchGroup = qualityResolution.enabled;
  const winner = qualityResolution.winner;
  const qualitySearchReceipt = qualityResolution.receipt;

  const archivedPacketIds = comparisonPackets
    .filter((packet) => packet.id !== winner.id)
    .map((packet) => packet.id);
  const archivedAt = new Date().toISOString();

  await withLockedState(async (current) => {
    const activeComparisonGroups = new Set(current.activeComparisonGroups ?? []);
    activeComparisonGroups.delete(comparisonGroupId);
    current.activeComparisonGroups = [...activeComparisonGroups];

    for (const packet of current.packets) {
      if (packet.comparisonGroupId !== comparisonGroupId) {
        continue;
      }

      if (packet.id === winner.id) {
        attachQualitySearchReceipt(packet, qualitySearchReceipt);
        packet.lastEventAt = archivedAt;
        packet.lastEventLabel = 'comparison_winner_selected';
        if (packet.lane) {
          packet.lane.lastEventAt = archivedAt;
          packet.lane.lastEventLabel = 'comparison_winner_selected';
        }
        continue;
      }

      packet.archivedAt = archivedAt;
      attachQualitySearchReceipt(packet, qualitySearchReceipt);
      packet.status = 'archived';
      packet.queueState = 'held';
      packet.blockedReason = null;
      packet.lastEventAt = archivedAt;
      packet.lastEventLabel = 'comparison_loser_archived';
      if (packet.lane) {
        packet.lane.lastEventAt = archivedAt;
        packet.lane.lastEventLabel = 'comparison_loser_archived';
      }

      if (packet.lane?.laneId) {
        archiveLane(packet.lane.laneId, 'user', { outcome: 'discarded', outcomeNote: 'Comparison alternative was not selected.' });
      }
    }
  });
  for (const packetId of archivedPacketIds) {
    autoResolveMergedPacketVerificationIncidents({ packetId, event: 'comparison_loser_archived' });
  }

  await ensureComparisonWinnerReview(qualitySearchGroup, winner.id);

  // Gap B (audit): the pick is a first-class, governed decision — record it on the
  // winner's lane so the ledger answers "why W over X, Y" (parity with browser_acted).
  if (winner.lane?.laneId) {
    try {
      recordLaneEvent(winner.lane.laneId, 'comparison_resolved', 'user', {
        groupId: comparisonGroupId,
        winnerPacketId: winner.id,
        archivedPacketIds,
        ...(qualitySearchReceipt ? { qualitySearch: qualitySearchReceipt } : {}),
      });
    } catch (error) {
      console.error('[comparison-pick] comparison_resolved event failed:', error);
    }
  }

  const mergeResult = await approveAndMergePacket({
    packetId: winner.id,
    commitMessage: input.commitMessage,
  });

  return {
    ...mergeResult,
    groupId: comparisonGroupId,
    archivedPacketIds,
    ...(qualitySearchReceipt ? { qualitySearch: qualitySearchReceipt } : {}),
  };
}
