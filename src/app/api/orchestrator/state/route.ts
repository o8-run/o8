import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveRequestPrincipalContext, workerPacketRefusal } from '@/lib/auth/principal';
import {
  syncOrchestratorControlPlaneState,
  withLockedState,
} from '@/lib/orchestrator/control-plane';
import { buildDagMetadata } from '@/lib/orchestrator/dag';
import { currentLaneMergePolicy } from '@/lib/lane/dogfood-guard';
import { getLaneEvents, findLaneByPacket, listLanes } from '@/lib/lane/registry';
import { listApprovals } from '@/lib/approvals/store';
import { getRuntimeInventorySnapshot } from '@/lib/runtime/inventory';
import { getSqlite } from '@/lib/db';
import { StorageAdmissionStore } from '@/lib/workspace/storage-admission';
import { manualLaunchClaimIsLive } from '@/lib/orchestrator/manual-launch-claim';
import { resolveAgentSummaryStatuses } from '@/lib/orchestrator/operator-status-model';
import { packetStatusWriteRejection } from '@/lib/orchestrator/packet-patch-policy';
import { hasCanonicalReleaseEvidence } from '@/lib/orchestrator/packet-release-truth';
import { normalizePacketStorageAdmissionEpoch } from '@/lib/orchestrator/packet-storage-admission-normalize';
import { autoResolveMergedPacketVerificationIncidents } from '@/lib/supervisor/merged-incident-resolution';
import { listTerminalReviewQueueEvidence } from '@/lib/terminal-status/store';
import { resolveTerminalStatusEvidence } from '@/lib/terminal-status/resolve';
import type { ApprovalRecord } from '@/lib/approvals/types';
import type { Lane } from '@/lib/lane/types';
import type {
  OrchestratorMissionState,
  OrchestratorPacket,
  OrchestratorStateApiErrorResponse,
  OrchestratorStateApiResponse,
} from '@/lib/orchestrator/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Enrich packets with live lane info from the lane registry. The persisted
// packet.lane field is rarely populated (lane bindings live in their own
// registry, not in the orchestrator state file), so without this pass the
// React-side mission state sees lane=null on every packet — which breaks
// the dashboard's tab-badge rebind, the orange "latest dispatch" marker,
// the WorkspaceChatPane live-status lookup, and anything else that needs
// lane.sessionKey to thread the in-flight session into the UI. The MCP
// path (operator-mission-service/mission.ts:294) already does the same
// merge; keeping the HTTP path in lockstep means dispatch flows look
// identical regardless of which surface launched the work.
function enrichMissionWithLanes(mission: OrchestratorMissionState): OrchestratorMissionState {
  // Merge policy (#1367) — this rebuild is the LAST shape the desktop provider
  // sees; dropping the policy here left the chat banner rendering a doomed
  // Approve & merge in PR-only mode (live-hit 2026-07-04).
  const mergePolicy = currentLaneMergePolicy();
  const packets = mission.packets.map((packet) => {
    const lane = findLaneByPacket(packet.id);
    if (!lane) return packet;
    return {
      ...packet,
      lane: {
        tileId: packet.lane?.tileId ?? '',
        tabId: packet.lane?.tabId ?? '',
        repoPath: lane.worktreePath ?? lane.repoPath ?? packet.lane?.repoPath ?? null,
        worktreePath: lane.worktreePath ?? packet.lane?.worktreePath ?? null,
        runtime: lane.runtime,
        sessionKey: lane.sessionKey,
        laneId: lane.id,
        lastHeartbeatAt: packet.lane?.lastHeartbeatAt ?? null,
        lastEventAt: lane.lastEventAt,
        lastEventLabel: lane.lastEventLabel,
        mergeMode: mergePolicy.mode,
        mergeModeNote: mergePolicy.note,
      },
    };
  });
  return { ...mission, packets };
}

function approvalMatchesLane(approval: ApprovalRecord, lane: Lane): boolean {
  if (lane.sessionKey && approval.sessionKey === lane.sessionKey) return true;
  if (approval.continuation?.kind === 'lane' && approval.continuation.laneId === lane.id) return true;
  return approval.metadata?.laneId === lane.id || approval.metadata?.LaneId === lane.id;
}

async function buildStateResponse(mission: OrchestratorMissionState): Promise<OrchestratorStateApiResponse> {
  const enriched = enrichMissionWithLanes(mission);
  // Desktop, mobile, MCP, and CLI poll this route; reuse the inventory TTL and
  // read at most 50 events only for agent or packet lanes the response carries.
  const snapshot = await getRuntimeInventorySnapshot({ fresh: false });
  const lanes = listLanes();
  const laneById = new Map(lanes.map((lane) => [lane.id, lane]));
  const laneByPacketId = new Map(
    lanes.flatMap((lane) => lane.packetId ? [[lane.packetId, lane] as const] : []),
  );
  const inventorySessionKeys = new Set((snapshot.agents ?? []).map((agent) => agent.sessionKey));
  const responsePacketLaneIds = new Set(
    enriched.packets.flatMap((packet) => packet.lane?.laneId ? [packet.lane.laneId] : []),
  );
  const laneEventsByLaneId = new Map(
    lanes
      .filter((lane) => responsePacketLaneIds.has(lane.id)
        || Boolean(lane.sessionKey && inventorySessionKeys.has(lane.sessionKey)))
      .map((lane) => [lane.id, getLaneEvents(lane.id, 50)]),
  );
  const approvals = listApprovals({ status: 'pending' });
  const reviewQueue = listTerminalReviewQueueEvidence();
  const agents = resolveAgentSummaryStatuses(snapshot.agents ?? [], lanes, {
    laneEventsByLaneId,
    approvals,
    reviewQueue,
  });
  const evidenceBySessionKey = new Map(agents.map((agent) => [agent.sessionKey, agent.statusEvidence]));
  const packets = enriched.packets.map((packet) => {
    const lane = (packet.lane?.laneId ? laneById.get(packet.lane.laneId) : undefined)
      ?? laneByPacketId.get(packet.id);
    if (!lane) return packet;
    const agentEvidence = lane.sessionKey ? evidenceBySessionKey.get(lane.sessionKey) : undefined;
    const statusEvidence = agentEvidence ?? resolveTerminalStatusEvidence({
      lane,
      laneEvents: laneEventsByLaneId.get(lane.id) ?? [],
      approvals: approvals.filter((approval) => approvalMatchesLane(approval, lane)),
      reviewQueue: reviewQueue.filter((review) => review.laneId === lane.id),
    });
    return { ...packet, statusEvidence };
  });
  const projectedMission = { ...enriched, packets };
  return {
    mission: projectedMission,
    dag: buildDagMetadata(projectedMission.packets),
    agents,
  };
}

function buildErrorResponse(message: string, status = 500) {
  const payload: OrchestratorStateApiErrorResponse = {
    error: {
      code: 'orchestrator_state_failed',
      message,
    },
  };

  return NextResponse.json(payload, {
    status,
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}

export async function GET(req: NextRequest) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  try {
    // Pass undefined so sync re-reads inside the mutex — reading outside the
    // lock and then passing the snapshot in races against concurrent writers
    // (e.g. /api/orchestrator/delegate's packet synthesis) whose writes land
    // between our read and the lock acquisition. undefined → reconcile reads
    // fresh state inside the lock.
    const mission = await syncOrchestratorControlPlaneState();
    return NextResponse.json(await buildStateResponse(mission), {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to read orchestrator state.';
    return buildErrorResponse(message);
  }
}

/**
 * #596 — Mission-identity guard. The browser caches the last-loaded mission
 * and periodically POSTs it back after client-side reconciles. When MCP
 * (or any other server-side actor) creates a NEW mission, the browser's
 * next POST arrives with the STALE missionId and clobbers the fresh
 * pointer.
 *
 * Rule: mission identity (`missionId`, `prompt`, `summary`, `repoPath`,
 * `runtime`, `constraints`) is server-owned. Only the server-side
 * createMission / dispatchMission / review / merge paths are allowed to
 * change these. The POST endpoint (driven by the browser) can only update
 * PACKET-LEVEL fields within the mission whose identity currently matches
 * what the server holds.
 *
 * When the incoming missionId doesn't match the server's current mission,
 * the POST is treated as stale: the stale body is dropped and the server's
 * current state is returned unchanged. The comparison runs inside the
 * control-plane lock so a createMission landing between our read and our
 * write can't be clobbered.
 */
function mergeClientMissionUnderLock(
  incoming: OrchestratorMissionState,
  current: OrchestratorMissionState,
  removedPacketIds: ReadonlySet<string>,
): OrchestratorMissionState | null {
  const serverMissionId = (current.missionId ?? '').trim();
  const incomingMissionId = (incoming.missionId ?? '').trim();

  if (serverMissionId && incomingMissionId !== serverMissionId) {
    console.warn(
      `[orchestrator-state] POST dropped stale client mission `
      + `(client=${incomingMissionId || 'empty'}, server=${serverMissionId}). `
      + `Client will re-hydrate on next load.`,
    );
    return null;
  }

  // Identity matches (or server has no mission yet): accept the body,
  // but pin identity fields to the server's values so a client that
  // synthesized partial state can't overwrite them to empty/different
  // strings. A whole-client snapshot is not a lifecycle command: it must not
  // erase a server hold, replay an older hold after reset, or cross a reset's
  // generation floor. Targeted metadata PATCHes still work on held packets.
  const serverPackets = new Map(current.packets.map((packet) => [packet.id, packet]));
  const packets: OrchestratorPacket[] = Array.isArray(incoming.packets)
    ? incoming.packets.map((packet) => {
        const serverPacket = serverPackets.get(packet.id);
        const staleAdmission = serverPacket
          && (serverPacket.storageAdmission?.mutationId ?? null)
            !== (packet.storageAdmission?.mutationId ?? null);
        const sameAdmissionEpoch = serverPacket
          && normalizePacketStorageAdmissionEpoch(serverPacket.storageAdmissionEpoch)
            === normalizePacketStorageAdmissionEpoch(packet.storageAdmissionEpoch);
        const serverLifecycleTerminal = serverPacket && (
          serverPacket.operatorStopped === true
          || (serverPacket.releaseState === 'released' && hasCanonicalReleaseEvidence(serverPacket))
        );
        const serverOperatorHold = serverPacket?.queueState === 'held'
          && serverPacket.holdIntent === 'operator';
        const preserveLifecycle = serverPacket && (
          serverLifecycleTerminal
          || serverOperatorHold
          || Boolean(serverPacket.manualLaunchClaim)
          || packet.holdIntent !== serverPacket.holdIntent
          || packet.operatorStopped === true
          || staleAdmission
          || !sameAdmissionEpoch
        );
        const persisted = { ...(preserveLifecycle ? serverPacket : packet) };
        // Admission is written by the server's reservation/launch path. A
        // browser snapshot from the same epoch can still contain an older
        // held attempt after a later launch committed a new generation. Keep
        // the entire server lifecycle in that case, while accepting a title
        // or summary edit from the browser only within the same reset epoch.
        if (serverPacket) {
          if (staleAdmission && sameAdmissionEpoch && !serverLifecycleTerminal) {
            if (typeof packet.title === 'string') persisted.title = packet.title;
            if (typeof packet.summary === 'string') persisted.summary = packet.summary;
          }
          persisted.storageAdmission = serverPacket.storageAdmission ?? null;
          persisted.storageAdmissionEpoch = serverPacket.storageAdmissionEpoch;
          persisted.manualLaunchClaim = serverPacket.manualLaunchClaim ?? null;
        }
        if (!serverPacket) persisted.manualLaunchClaim = null;
        delete persisted.statusEvidence;
        return persisted;
      })
    : [];
  // An old snapshot may not contain the packet at all: a packet persisted by
  // the server after the client cached its mission (#2351, a delegated packet
  // erased by the dashboard's lane-reconcile POST). Omission is never a delete.
  // Only an explicit `removedPacketIds` entry removes a packet, and even that
  // cannot delete a durable stop or a packet whose lifecycle has advanced.
  const incomingIds = new Set(packets.map((packet) => packet.id));
  for (const packet of current.packets) {
    if (incomingIds.has(packet.id)) continue;
    const lifecycleProtected = packet.operatorStopped === true
      || Boolean(packet.manualLaunchClaim)
      || normalizePacketStorageAdmissionEpoch(packet.storageAdmissionEpoch) > 1;
    if (lifecycleProtected || !removedPacketIds.has(packet.id)) packets.push(packet);
  }
  return {
    ...incoming,
    missionId: current.missionId || incoming.missionId,
    prompt: current.prompt || incoming.prompt,
    summary: current.summary || incoming.summary,
    repoPath: current.repoPath ?? incoming.repoPath,
    runtime: current.runtime || incoming.runtime,
    constraints: current.constraints ?? incoming.constraints,
    lifecycleHold: current.lifecycleHold,
    packets,
  };
}

export async function POST(req: NextRequest) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  try {
    const body = await req.json().catch(() => ({})) as {
      mission?: OrchestratorMissionState;
      removedPacketIds?: unknown;
    };
    const incoming = body.mission;
    const removedPacketIds = new Set(Array.isArray(body.removedPacketIds)
      ? body.removedPacketIds.filter((id): id is string => typeof id === 'string')
      : []);

    if (!incoming) {
      // No payload — fall back to the existing "reconcile current" behavior.
      const mission = await syncOrchestratorControlPlaneState();
      return NextResponse.json(await buildStateResponse(mission), {
        headers: { 'Cache-Control': 'no-store, max-age=0' },
      });
    }

    // Do the mission-identity compare inside the control-plane lock so a
    // concurrent createMission (MCP path) landing between our read and
    // our write can't be clobbered. If the client is stale, drop the body
    // and just return the server's current state.
    const { state: mission } = await withLockedState((current) => {
      const merged = mergeClientMissionUnderLock(incoming, current, removedPacketIds);
      if (!merged) return { dropped: true } as const;

      // Replace the in-lock state with the merged body so the post-callback
      // reconcile persists it. Preserve the `current` object identity so
      // the reconcile/write in withLockedState uses the mutated fields.
      Object.assign(current, merged);
      return { dropped: false } as const;
    });

    return NextResponse.json(await buildStateResponse(mission), {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to update orchestrator state.';
    return buildErrorResponse(message);
  }
}

/**
 * Atomic single-packet update. `cortex_update_packet` (MCP) previously read the
 * whole mission, mutated one packet client-side, and POSTed the entire packets
 * array back — racing concurrent packet edits (browser reconcile, other MCP
 * calls) and silently reverting their writes. PATCH applies a packet-level
 * delta INSIDE the control-plane lock so only the targeted fields change.
 * Mission-identity fields stay server-owned (see #596) and cannot be patched.
 */
export async function PATCH(req: NextRequest) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  try {
    const body = await req.json().catch(() => ({})) as {
      packetId?: string;
      updates?: Record<string, unknown>;
    };
    const packetId = (body.packetId ?? '').trim();
    const updates = body.updates && typeof body.updates === 'object' ? body.updates : null;
    if (!packetId || !updates) {
      return buildErrorResponse('packetId and a non-empty updates object are required.', 400);
    }
    const ownershipRefusal = workerPacketRefusal(resolveRequestPrincipalContext(req), packetId);
    if (ownershipRefusal) {
      return NextResponse.json({ ok: false, error: ownershipRefusal }, { status: 403 });
    }

    const statusRejection = packetStatusWriteRejection(updates);
    if (statusRejection) {
      return NextResponse.json(
        { error: statusRejection },
        {
          status: 422,
          headers: { 'Cache-Control': 'no-store, max-age=0' },
        },
      );
    }

    const FORBIDDEN_FIELDS = new Set(['id', 'missionId', 'holdIntent', 'manualLaunchClaim']);
    const { state: mission, result } = await withLockedState((current) => {
      const packet = current.packets.find((p) => p.id === packetId);
      if (!packet) return { found: false } as const;
      if (packet.manualLaunchClaim && !manualLaunchClaimIsLive(packet.manualLaunchClaim)) packet.manualLaunchClaim = null;
      const holding = updates.queueState === 'held';
      // Archiving hides a packet from Workers and marks its mission complete, so a
      // worker that is still launching, running, recovering or merging must be
      // stopped first. Restoring (archivedAt: null) is always allowed.
      const archiving = typeof updates.archivedAt === 'string' && updates.archivedAt.trim() !== '' && !packet.archivedAt;
      const liveLane = holding || archiving ? findLaneByPacket(packetId) : null;
      const launchReservation = holding || archiving
        ? new StorageAdmissionStore(getSqlite()).getLatestReservationForOwner(packetId)
        : null;
      const launched = launchReservation?.state === 'reserved' || Boolean(packet.manualLaunchClaim);
      if (holding && (
        (liveLane && (liveLane.status === 'idle' || liveLane.status === 'launching' || liveLane.status === 'running' || liveLane.status === 'recovering'))
        || launched
      )) {
        return { found: true, alreadyLaunched: true } as const;
      }
      if (archiving && (
        (liveLane && (liveLane.status === 'launching' || liveLane.status === 'running' || liveLane.status === 'recovering' || liveLane.status === 'merging'))
        || launched
      )) {
        return { found: true, workerLive: true } as const;
      }
      const mutablePacket = packet as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(updates)) {
        if (FORBIDDEN_FIELDS.has(key)) continue;
        mutablePacket[key] = value;
      }
      if (updates.queueState === 'held') packet.holdIntent = 'operator';
      if (updates.queueState === 'queued') packet.holdIntent = undefined;
      return { found: true } as const;
    });

    if (!result.found) return buildErrorResponse(`Packet ${packetId} not found.`, 404);
    if ('alreadyLaunched' in result) return buildErrorResponse(`Packet ${packetId} is launching or running; stop its worker before holding it.`, 409);
    if ('workerLive' in result) return buildErrorResponse(`Packet ${packetId} has a worker that is still running; stop it before archiving the packet.`, 409);
    if (typeof updates.archivedAt === 'string' && updates.archivedAt.trim()) {
      autoResolveMergedPacketVerificationIncidents({ packetId, event: 'packet_archived' });
    }

    return NextResponse.json(await buildStateResponse(mission), {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to patch packet.';
    return buildErrorResponse(message);
  }
}
