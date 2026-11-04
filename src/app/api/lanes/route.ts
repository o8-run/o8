import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveRequestPrincipalContext, workerPacketRefusal } from '@/lib/auth/principal';
import { findLaneByPacket, getLane, getLaneEvents, listLanes, listActiveLanes } from '@/lib/lane/registry';
import { summarizeLaneArchive, wasArchivedByOperator } from '@/lib/lane/archive-summary';
import { collapseArchivedLanesByTask } from '@/lib/lanes/collapse-archived-by-task';
import { codename } from '@/lib/agents/codename';
import { dispatch } from '@/lib/lane/commands';
import { currentLaneMergePolicy } from '@/lib/lane/dogfood-guard';
import { reconcileOrphanedWorktrees } from '@/lib/lane/reconcile';
import { serverTimingHeaders } from '@/lib/performance/server-timing';
import { resolvePacketLaunchContexts } from '@/lib/orchestrator/packet-launch-context';
import { withLockedState } from '@/lib/orchestrator/control-plane';
import { manualLaunchClaimIsLive } from '@/lib/orchestrator/manual-launch-claim';
import { getSqlite } from '@/lib/db';
import { StorageAdmissionStore } from '@/lib/workspace/storage-admission';
import { repoActionLeaseMaxWaitMsForTests } from '@/lib/lane/lane-route-test-seams';
import { resolveLaneTranscriptHealth } from '@/lib/lane/transcript-health';
import { readTerminalWorktreeStorage } from '@/lib/lane/terminal-worktree-storage';
import { getLaneDiffStat } from '@/lib/lane/lane-diff-facts';
import { deriveIdempotencyKey, withIdempotency } from '@/lib/orchestrator/idempotency-store';
import type { LaneCommand } from '@/lib/lane/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DIFF_STAT_LANE_LIMIT = 16;
const ROUTE_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
let lastRouteReconcileAt = 0;

async function reconcileLanesIfDue(): Promise<void> {
  const now = Date.now();
  if (now - lastRouteReconcileAt < ROUTE_RECONCILE_INTERVAL_MS) return;
  lastRouteReconcileAt = now;
  await reconcileOrphanedWorktrees();
}

export async function GET(req: NextRequest) {
  const startedAt = performance.now();
  // Cross-packet safety checks need occupancy, never task content or credentials.
  // Resolve authority here too: middleware recognition alone survives revocation.
  if (req.nextUrl.searchParams.get('view') === 'live') {
    const principal = resolveRequestPrincipalContext(req);
    if (principal.role !== 'operator'
      && !(principal.role === 'worker' && !principal.readOnly && principal.packetId && principal.tokenId)) {
      return NextResponse.json({
        ok: false,
        error: { code: 'live_status_forbidden', message: 'Live status requires an operator or packet-bound worker credential.' },
      }, { status: 403 });
    }
    // Deliberately skip reconciliation: this bounded read must not mutate lanes.
    const lanes = listActiveLanes().map(({ id, packetId, status, worktreePath }) => (
      { id, packetId, status, worktreePath }
    ));
    return NextResponse.json({ lanes }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  }
  const denied = requirePanelAuth(req);
  if (denied) return denied;
  const principal = resolveRequestPrincipalContext(req);
  if (principal.role !== 'operator' && principal.role !== 'worker') {
    return NextResponse.json(
      { ok: false, error: { code: 'operator_or_worker_required', message: 'Lane routes require an operator or packet-bound worker credential.' } },
      { status: 403 },
    );
  }

  // #534 follow-up — reconcile lanes whose worktrees were deleted out-of-band
  // (orchestrator bash-merge bypasses the merge verb) so the sidebar doesn't
  // keep showing stale 'reviewing' rows. Awaited (async git probes since #1498)
  // so the response below reflects the reconciled lane state.
  await reconcileLanesIfDue();

  const url = new URL(req.url);
  const activeOnly = url.searchParams.get('active') !== 'false';
  // #1292 — collapse=true folds the archived multiply (many lanes per task, one
  // per reset/redispatch/supervisor-relaunch) into one row per task via the
  // shared primitive, so a structured-state query an agent makes returns "one
  // task = one entry" — the same view the history sidebar renders. Active lanes
  // pass through untouched; only retired (archived/completed) lanes collapse.
  const collapse = url.searchParams.get('collapse') === 'true';
  // A roster names the finished lanes whose diff stat it shows; ordinary
  // polling runs no Git. Bounded so one request cannot walk every worktree.
  const diffStatLaneIds = new Set((url.searchParams.get('diffStat') ?? '')
    .split(',').map((id) => id.trim()).filter(Boolean).slice(0, DIFF_STAT_LANE_LIMIT));

  const visibleLanes = activeOnly ? listActiveLanes() : listLanes();
  const baseLanes = principal.role === 'worker'
    ? visibleLanes.filter((lane) => Boolean(principal.packetId) && lane.packetId === principal.packetId)
    : visibleLanes;
  const resolvedLanes = collapse
    ? [
        ...baseLanes.filter((lane) => lane.status !== 'archived' && lane.status !== 'completed'),
        ...collapseArchivedLanesByTask(
          baseLanes.filter((lane) => lane.status === 'archived' || lane.status === 'completed'),
        ),
      ]
    : baseLanes;

  // Stamp the memorable codename (same pure fn that labels the canvas card and
  // resolves voice "[Name], [task]") so every lane consumer — the canvas, voice
  // status, mobile — sees the agent by the SAME name. Additive, deterministic.
  const mergePolicy = currentLaneMergePolicy();
  const launchContexts = resolvePacketLaunchContexts(
    resolvedLanes.flatMap((lane) => lane.packetId ? [lane.packetId] : []),
  );
  const lanes = await Promise.all(resolvedLanes.map(async (lane) => {
    const retired = lane.status === 'archived' || lane.status === 'completed';
    const archiveEvents = retired ? getLaneEvents(lane.id, 80) : [];
    return {
      ...lane,
      ...await resolveLaneTranscriptHealth(lane),
      launchContext: lane.packetId
        ? launchContexts.get(lane.packetId)?.launchContext ?? null
        : null,
      codename: codename(lane.id),
      mergeMode: mergePolicy.mode,
      mergeModeNote: mergePolicy.note,
      archiveSummary: retired ? summarizeLaneArchive(lane, archiveEvents) : null,
      // #2154 — the rail needs to tell an operator's dismissal apart from the
      // headless loop's auto-archive: the first clears the row, the second
      // keeps its 24h outcome chip.
      archivedByOperator: lane.status === 'archived' && wasArchivedByOperator(archiveEvents),
      ...(diffStatLaneIds.has(lane.id)
        ? { diffStat: lane.worktreePath ? await getLaneDiffStat(lane).catch(() => null) : null }
        : {}),
    };
  }));

  // Use principal-filtered lanes so display collapsing cannot hide bytes.
  // Ordinary lane polling does not start storage walks.
  const terminalStorage = url.searchParams.get('storage') === 'terminal'
    ? await readTerminalWorktreeStorage(baseLanes) : undefined;
  return NextResponse.json({ lanes, ...(terminalStorage ? { terminalStorage } : {}) }, {
    headers: serverTimingHeaders(startedAt, { 'Cache-Control': 'no-store, max-age=0' }),
  });
}


function createPrIdempotencyBody(command: Extract<LaneCommand, { verb: 'create_pr' }>): string {
  return JSON.stringify({
    laneId: command.laneId,
    commitMessage: command.commitMessage ?? null,
    reviewSummary: command.reviewSummary ?? null,
    expectedDiffFingerprint: command.expectedDiffFingerprint ?? null,
    expectedGovernanceFingerprint: command.expectedGovernanceFingerprint ?? null,
    spokenReviewApprovalId: command.spokenReviewApprovalId ?? null,
    spokenReviewClaimId: command.spokenReviewClaimId ?? null,
    spokenReviewUpdatedAt: command.spokenReviewUpdatedAt ?? null,
    spokenReviewLaneStatus: command.spokenReviewLaneStatus ?? null,
    actor: command.actor ?? null,
  });
}

export async function POST(req: NextRequest) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;
  const principal = resolveRequestPrincipalContext(req);
  if (principal.role !== 'operator' && principal.role !== 'worker') {
    return NextResponse.json(
      { ok: false, error: { code: 'operator_or_worker_required', message: 'Lane routes require an operator or packet-bound worker credential.' } },
      { status: 403 },
    );
  }

  const body = await req.json().catch(() => null) as LaneCommand | null;
  if (!body || !body.verb) {
    return NextResponse.json({ ok: false, note: 'Missing command verb.' }, { status: 400 });
  }

  // Actor comes from the CREDENTIAL, never the body (#1173 H1: a self-asserted
  // actor defaulted to trusted 'user', which pre-approves merges and skips the
  // governance card — so any loopback caller, including a dispatched worker's
  // token or a prompt-injected same-origin fetch, could merge to main
  // silently). Only a live operator credential (ws-token) may act as 'user';
  // authenticated workers are clamped to 'orchestrator', which routes governed
  // verbs through the approval card exactly like /api/orchestrator/merge's
  // worker branch. The allowlist above rejects other principals. Internal
  // server callers import dispatch() directly and are unaffected.
  const commandPacketId = body.verb === 'open_lane'
    ? body.packetId ?? null
    : 'laneId' in body
      ? getLane(body.laneId)?.packetId ?? null
      : null;
  const ownershipRefusal = workerPacketRefusal(principal, commandPacketId);
  if (ownershipRefusal) {
    return NextResponse.json(
      { ok: false, error: { code: ownershipRefusal.code, message: ownershipRefusal.message } },
      { status: 403 },
    );
  }
  const command: LaneCommand = {
    ...body,
    actor: principal.role === 'operator' ? (body.actor ?? 'user') : 'orchestrator',
  };

  try {
    if (command.verb === 'open_lane' && command.packetId) {
      const token = randomUUID();
      const { result: claim } = await withLockedState((state) => {
        const packet = state.packets.find((entry) => entry.id === command.packetId);
        if (!packet) return 'packet_missing' as const;
        if (packet.queueState === 'held' && packet.holdIntent === 'operator') return 'packet_held' as const;
        if (manualLaunchClaimIsLive(packet.manualLaunchClaim)) return 'already_launching' as const;
        const lane = findLaneByPacket(packet.id);
        if (lane && (lane.status === 'idle' || lane.status === 'launching' || lane.status === 'running' || lane.status === 'recovering')) return 'already_launching' as const;
        const reservation = new StorageAdmissionStore(getSqlite()).getLatestReservationForOwner(packet.id);
        if (reservation?.state === 'reserved') return 'already_launching' as const;
        packet.manualLaunchClaim = { token, ownerPid: process.pid, startedAt: new Date().toISOString() };
        return 'claimed' as const;
      });
      if (claim !== 'claimed') {
        const status = claim === 'packet_missing' ? 404 : 409;
        return NextResponse.json({
          ok: false, reason: claim,
          note: claim === 'packet_held' ? 'This packet is held by the operator.'
            : claim === 'already_launching' ? 'This packet is already opening a lane.'
              : 'This packet is no longer in the current mission.',
        }, { status });
      }
      try {
        const result = await dispatch(command);
        return NextResponse.json(result, {
          status: result.ok ? 200 : 422,
          headers: { 'Cache-Control': 'no-store, max-age=0' },
        });
      } finally {
        await withLockedState((state) => {
          const packet = state.packets.find((entry) => entry.id === command.packetId);
          if (packet?.manualLaunchClaim?.token === token) packet.manualLaunchClaim = null;
        });
      }
    }
    if (command.verb === 'create_pr') {
      const key = deriveIdempotencyKey({
        verb: 'lane_create_pr',
        scopeId: command.laneId,
        body: createPrIdempotencyBody(command),
      });
      const outcome = await withIdempotency({
        key,
        verb: 'lane_create_pr',
        scopeId: command.laneId,
        attachToInFlight: true,
      }, () => dispatch(command, {
        repoActionLeaseMaxWaitMs: repoActionLeaseMaxWaitMsForTests(),
      }));
      if (outcome.inProgress) {
        return NextResponse.json(outcome.result, {
          status: 202,
          headers: { 'Cache-Control': 'no-store, max-age=0' },
        });
      }
      const result = outcome.result;
      return NextResponse.json(result, {
        status: result.ok ? 200 : 422,
        headers: { 'Cache-Control': 'no-store, max-age=0' },
      });
    }

    const result = await dispatch(command);
    return NextResponse.json(result, {
      status: result.ok ? 200 : 422,
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (err) {
    console.error('[api] lanes failed:', err);
    const message = 'Command failed.';
    return NextResponse.json({ ok: false, note: message }, { status: 500 });
  }
}
