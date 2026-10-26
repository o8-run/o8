import { viewerJson } from '@/lib/viewers/response';
/**
 * GET /api/orchestrator/review-state?packetId=<id>
 *
 * Returns the canonical review state for a single packet — the read-path
 * behind the `o8_review_state` MCP tool (#621).
 *
 * Combines:
 *   - packet state from the mission service
 *   - lane state from the lane registry
 *   - most-recent orchestrator review verdict from `packet.review`
 *   - current merge-gate verdict from `runMergeGate(lane)` (best-effort;
 *     the gate is computed on-demand — it reads the diff so it requires
 *     a lane with a worktree)
 */
import { type NextRequest } from 'next/server';
import { listApprovalsForContext } from '@/lib/approvals/store';
import type { ApprovalRecord } from '@/lib/approvals/types';
import type { LaneSpokenDiffFacts } from '@/lib/lane/lane-diff-facts';
import { readLaneSpokenDiffFacts } from '@/lib/lane/review-source';
import { normalizeHeadSha } from '@/lib/lane/head-sha-lock';
import { findLatestLaneByPacket, findLaneBySession, getLaneEvents } from '@/lib/lane/registry';
import { recoveryInfoFromLaneEvents } from '@/lib/lane/recovery-info';
import { classifyReviewRisk } from '@/lib/lane/review-risk';
import type { Lane } from '@/lib/lane/types';
import { buildPreviewForLane, type MergePreviewResult } from '@/lib/lane/preview-merge';
import {
  derivePacketReviewState,
  type DeriveReviewStateMergeGate,
  type DeriveReviewStateOrchestratorReview,
} from '@/lib/orchestrator/derive-review-state';
import { syncOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { readPacketCompletionContext } from '@/lib/orchestrator/context-relay';
import {
  buildSpokenReviewBrief,
  type SpokenReviewBrief,
  type SpokenReviewFinding,
  type SpokenSecondPassStatus,
} from '@/lib/orchestrator/spoken-review-brief';
import { findCurrentSpokenReviewApproval } from '@/lib/orchestrator/spoken-review-evidence';
import { fingerprintSpokenReviewGovernance } from '@/lib/orchestrator/spoken-review-governance';
import { synthesizePacketFromLane } from '@/lib/orchestrator/synthesize-packet';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveRequestPrincipalContext, workerPacketRefusal } from '@/lib/auth/principal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LOG_PREFIX = '[review-state]';
const JSON_HEADERS = { 'Cache-Control': 'no-store, max-age=0' };

function errorResponse(code: string, message: string, status = 500) {
  return viewerJson({ error: { code, message } }, { status, headers: JSON_HEADERS });
}

function toOrchestratorReview(review: {
  approved: boolean;
  summary: string;
  recordedAt: string;
} | null | undefined): DeriveReviewStateOrchestratorReview | null {
  if (!review) return null;
  return {
    verdict: review.approved ? 'approved' : 'rejected',
    ts: review.recordedAt,
    summary: review.summary,
  };
}

function approvalReviewedAt(approval: ApprovalRecord): string {
  const ts = approval.resolvedAt ?? approval.updatedAt ?? approval.createdAt;
  return new Date(ts).toISOString();
}

function latestApproval(approvals: ApprovalRecord[], toolName: string) {
  return approvals
    .filter((candidate) => candidate.toolName === toolName && candidate.args?.reviewSuperseded !== true)
    .sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;
}

function toDurableOrchestratorReview(approval: ApprovalRecord | null): DeriveReviewStateOrchestratorReview | null {
  if (!approval || typeof approval.args?.approved !== 'boolean') return null;
  const approved = approval.args.approved;
  return {
    verdict: approved ? 'approved' : 'rejected',
    ts: approvalReviewedAt(approval),
    summary: approval.description || approval.summary || '',
  };
}

function toSpokenFinding(value: unknown): SpokenReviewFinding | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const file = typeof record.file === 'string' ? record.file.trim() : '';
  const description = typeof record.description === 'string' ? record.description.trim() : '';
  if (!file || !description) return null;
  const rawSeverity = typeof record.severity === 'string' ? record.severity : 'note';
  const severity = rawSeverity === 'bug' || rawSeverity === 'high'
    ? 'high'
    : rawSeverity === 'rule_violation' || rawSeverity === 'warning'
      ? 'warning'
      : 'info';
  return {
    file,
    line: typeof record.line === 'number' ? record.line : null,
    severity,
    description,
    resolution: typeof record.resolution === 'string' ? record.resolution : null,
  };
}

function spokenFindings(value: unknown): SpokenReviewFinding[] {
  return Array.isArray(value)
    ? value.map(toSpokenFinding).filter((finding): finding is SpokenReviewFinding => finding !== null)
    : [];
}

function secondPassState(
  approvals: ApprovalRecord[],
  reviewApproval: ApprovalRecord | null,
): { status: SpokenSecondPassStatus; detail?: string } {
  if (reviewApproval?.args?.requiresSecondPass !== true) {
    return { status: 'not-required' };
  }
  if (reviewApproval.args?.secondPassAgreed === true) {
    return { status: 'agreed' };
  }
  const reviewedHeadSha = typeof reviewApproval.args?.reviewedHeadSha === 'string'
    ? reviewApproval.args.reviewedHeadSha
    : reviewApproval.metadata?.['Reviewed HEAD'];
  const secondPass = approvals
    .filter((candidate) => candidate.toolName === 'orchestrator_second_pass')
    .filter((candidate) => candidate.args?.reviewSuperseded !== true)
    .filter((candidate) => (
      candidate.args?.approvalId === reviewApproval.id
      || (reviewedHeadSha && candidate.args?.reviewedHeadSha === reviewedHeadSha)
    ))
    .sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;
  if (secondPass) {
    const detail = typeof secondPass.args?.finding === 'string'
      ? secondPass.args.finding
      : secondPass.summary || secondPass.description;
    return { status: 'blocked', ...(detail ? { detail } : {}) };
  }
  return { status: 'pending' };
}

// #1476 lie 3b — the gate is recomputed on every poll, so its timestamp must
// be "when could this last have changed" (the lane's latest event), never
// now(). Stamping now() made stateChangedAt track poll cadence (~60s bumps
// all session) instead of actual transitions.
function toMergeGate(
  preview: MergePreviewResult | null,
  lastChangedAt: string | null,
): DeriveReviewStateMergeGate | null {
  if (!preview) return null;
  return {
    verdict: preview.wouldMerge ? 'passing' : 'failing',
    ts: lastChangedAt ?? new Date(0).toISOString(),
    checks: preview.checks.map((check) => check.name),
    diffBase: preview.diffBase,
  };
}

// #1476 lie 3a — final verdict fallback: the append-only review_recorded lane
// event. Mission state is an in-memory singleton (evicted by the next
// create_mission) and the approvals lookup is score-based (misses when the
// lane's sessionKey detaches mid-merge); lane events are keyed by lane id
// alone and never mutated, so a recorded verdict is always recoverable here.
function toLaneEventOrchestratorReview(lane: Lane | null): DeriveReviewStateOrchestratorReview | null {
  if (!lane) return null;
  const events = getLaneEvents(lane.id);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.verb !== 'review_recorded') continue;
    const payload = (event.payload ?? {}) as { approved?: unknown; summary?: unknown };
    if (typeof payload.approved !== 'boolean') continue;
    return {
      verdict: payload.approved ? 'approved' : 'rejected',
      ts: event.timestamp,
      summary: typeof payload.summary === 'string' ? payload.summary : '',
    };
  }
  return null;
}

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  let packetId = request.nextUrl.searchParams.get('packetId')?.trim() ?? '';
  // sessionKey fallback — a detached packet (dropped from mission state after its
  // worker finished) has no client-resolvable packetId, but the tab always knows
  // its lane sessionKey. Resolve packetId server-side so the decision banner works
  // for detached/parked packets (Q ruling 2026-07-11). Same fallback pattern as
  // packet-transcript (#1389).
  const sessionKey = request.nextUrl.searchParams.get('sessionKey')?.trim() ?? '';
  if (!packetId && sessionKey) {
    const laneBySession = findLaneBySession(sessionKey);
    if (laneBySession?.packetId) packetId = laneBySession.packetId;
  }
  if (!packetId) {
    return errorResponse('invalid_request', 'packetId or sessionKey query parameter is required.', 400);
  }
  const ownershipRefusal = workerPacketRefusal(resolveRequestPrincipalContext(request), packetId);
  if (ownershipRefusal) {
    return errorResponse(ownershipRefusal.code, ownershipRefusal.message, 403);
  }
  const includeSpokenReview = request.nextUrl.searchParams.get('spoken') === '1';
  const spokenApprovalId = request.nextUrl.searchParams.get('approvalId')?.trim() ?? '';

  try {
    const mission = await syncOrchestratorControlPlaneState();
    const lane = findLatestLaneByPacket(packetId);

    // #1112 — Mission state is an in-memory singleton that gets overwritten
    // by each new `create_mission`, so packets from a prior mission lose
    // their entry even though the lane is alive. Fall through to the lane
    // registry (same pattern as #1106) and synthesize a minimal packet stub
    // so review-state still surfaces something useful. Only 404 if neither
    // mission state nor the lane registry knows about the packet.
    const missionPacket = mission.packets.find((candidate) => candidate.id === packetId);
    if (!missionPacket && !lane) {
      return errorResponse('packet_not_found', `Packet ${packetId} not found.`, 404);
    }
    const packet = missionPacket ?? synthesizePacketFromLane(packetId, lane!);
    const approvals = listApprovalsForContext({
      packetId,
      laneId: lane?.id,
      sessionKey: lane?.sessionKey ?? undefined,
    });
    const targetApproval = spokenApprovalId
      ? approvals.find((candidate) => candidate.id === spokenApprovalId) ?? null
      : null;
    if (spokenApprovalId && (!targetApproval || targetApproval.status !== 'pending')) {
      return errorResponse(
        'spoken_review_approval_changed',
        'The pending approval changed while the spoken review was being prepared. Refresh and review it again.',
        409,
      );
    }
    const reviewApproval = latestApproval(approvals, 'orchestrator_review');
    let spokenDiffFacts: LaneSpokenDiffFacts | null = null;
    let spokenReviewApproval: ApprovalRecord | null = null;
    if (includeSpokenReview) {
      if (!lane) {
        return errorResponse(
          'spoken_review_unavailable',
          `Packet ${packetId} has no reviewable lane worktree.`,
          409,
        );
      }
      try {
        spokenDiffFacts = await readLaneSpokenDiffFacts(lane);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to read packet diff evidence.';
        console.warn(`${LOG_PREFIX} spoken diff evidence failed for packet ${packetId}:`, error);
        return errorResponse('spoken_review_unavailable', message, 409);
      }
      spokenReviewApproval = spokenDiffFacts.dirtyFiles.length === 0
        && spokenDiffFacts.untrackedFiles.length === 0
        ? findCurrentSpokenReviewApproval(
            approvals,
            packetId,
            lane,
            spokenDiffFacts.headSha,
          )
        : null;
    }

    // Merge preview is computed on-demand from the lane's diff. If the lane is
    // gone (archived / never spawned) we can't run the gate — fall back to
    // null and let the derivation treat it as unwired. This uses the same
    // preview shape as the review card/CLI so dirty worktrees are re-checked at
    // read time, not only when the review transition first fired.
    let mergePreview: MergePreviewResult | null = null;
    if (lane) {
      try {
        mergePreview = await buildPreviewForLane(lane, packetId, {
          orchestratorApproved: includeSpokenReview
            ? spokenReviewApproval?.status === 'approved'
              && spokenReviewApproval.args?.approved === true
            : packet.review?.approved === true,
        });
      } catch (error) {
        console.warn(`${LOG_PREFIX} buildPreviewForLane failed for packet ${packetId}:`, error);
        mergePreview = null;
      }
    }
    if (includeSpokenReview && lane && spokenDiffFacts) {
      try {
        const verifiedFacts = await readLaneSpokenDiffFacts(lane);
        if (
          verifiedFacts.headSha !== spokenDiffFacts.headSha
          || verifiedFacts.fingerprint !== spokenDiffFacts.fingerprint
        ) {
          return errorResponse(
            'spoken_review_changed',
            'Packet evidence changed while the spoken review was being prepared. Retry the review.',
            409,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to verify packet diff evidence.';
        console.warn(`${LOG_PREFIX} spoken diff verification failed for packet ${packetId}:`, error);
        return errorResponse('spoken_review_unavailable', message, 409);
      }
    }

    const orchestratorReview = includeSpokenReview
      ? toDurableOrchestratorReview(spokenReviewApproval)
      : toOrchestratorReview(packet.review ?? null)
        ?? toDurableOrchestratorReview(reviewApproval)
        ?? toLaneEventOrchestratorReview(lane);
    const mergeGate = toMergeGate(mergePreview, lane?.lastEventAt ?? packet.lastEventAt ?? null);
    const recovery = packet.releaseState === 'released' || (lane?.status === 'completed' && lane.outcome === 'merged')
      ? null
      : packet.recovery ?? (lane ? recoveryInfoFromLaneEvents(getLaneEvents(lane.id, 100)) : null);
    let spokenReview: SpokenReviewBrief | null = null;
    if (includeSpokenReview && spokenDiffFacts && lane) {
      const diffFacts = spokenDiffFacts;
      const completionContext = await readPacketCompletionContext(packetId);
      const reviewRisk = classifyReviewRisk(diffFacts.changedFiles, diffFacts.addedDiffLines);
      const durableFindings = spokenFindings(spokenReviewApproval?.args?.findings);
      const completionHeadSha = normalizeHeadSha(completionContext?.headSha);
      const completionEvidenceCurrent = Boolean(
        completionContext
        && lane.sessionKey
        && completionContext.sessionKey === lane.sessionKey
        && completionHeadSha === diffFacts.headSha
        && completionContext.diffFingerprint === diffFacts.fingerprint,
      );
      spokenReview = buildSpokenReviewBrief({
        packetId,
        title: packet.title ?? lane?.label ?? `Packet ${packetId}`,
        evidence: {
          headSha: diffFacts.headSha,
          fingerprint: diffFacts.fingerprint,
          diffBase: diffFacts.against,
          diffBaseWarning: diffFacts.diffBase.warning,
          stat: diffFacts.stat,
        },
        fileChanges: diffFacts.fileChanges,
        review: {
          verdict: orchestratorReview?.verdict ?? 'unreviewed',
          summary: orchestratorReview?.summary ?? '',
          findings: durableFindings,
        },
        approvalRisk: spokenReviewApproval?.risk ?? null,
        reviewRiskReasons: [
          ...reviewRisk.reasons,
          ...(diffFacts.diffBase.usedFallback || diffFacts.diffBase.warning
            ? [`diff base unverified: ${diffFacts.diffBase.warning ?? `using fallback ${diffFacts.against}`}`]
            : []),
          ...(diffFacts.dirtyFiles.length > 0
            ? [`uncommitted tracked changes: ${diffFacts.dirtyFiles.length} file${diffFacts.dirtyFiles.length === 1 ? '' : 's'}`]
            : []),
          ...(diffFacts.untrackedFiles.length > 0
            ? [`untracked changes: ${diffFacts.untrackedFiles.length} file${diffFacts.untrackedFiles.length === 1 ? '' : 's'}`]
            : []),
        ],
        mergeGate: {
          verdict: diffFacts.diffBase.usedFallback || diffFacts.diffBase.warning
            ? 'unavailable'
            : mergePreview
              ? (mergePreview.wouldMerge ? 'passing' : 'failing')
              : 'unavailable',
          checks: mergePreview?.checks ?? [],
        },
        secondPass: secondPassState(approvals, spokenReviewApproval),
        ...(completionContext ? {
          testEvidence: {
            current: completionEvidenceCurrent,
            selfReview: completionContext.selfReview,
          },
        } : {}),
      });
      if (targetApproval) {
        spokenReview = {
          ...spokenReview,
          evidence: {
            ...spokenReview.evidence,
            governanceFingerprint: fingerprintSpokenReviewGovernance({
              targetApproval,
              approvals,
              lane,
              completionContext,
              mergePreview,
            }),
          },
        };
      }
    }

    const { state, stateChangedAt } = derivePacketReviewState({
      packet,
      lane,
      orchestratorReview,
      mergeGate,
    });

    return viewerJson({
      packetId,
      state,
      stateChangedAt,
      orchestratorReview,
      mergeGate,
      lane: lane?.id ?? null,
      branch: lane?.branch ?? packet.branchTarget ?? null,
      // Title so a detached packet's decision banner can name itself instead of
      // falling back to a generic "Dispatched packet".
      title: packet.title ?? lane?.label ?? null,
      outcome: lane?.outcome ?? null,
      outcomeNote: lane?.outcomeNote ?? null,
      recovery,
      ...(spokenReview ? { spokenReview } : {}),
    }, { headers: JSON_HEADERS });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to read review state.';
    console.error(`${LOG_PREFIX} failed for packet ${packetId}: ${message}`);
    return errorResponse('review_state_failed', message);
  }
}
