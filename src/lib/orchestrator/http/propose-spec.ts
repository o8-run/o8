import { NextRequest } from 'next/server';
import { createApproval } from '@/lib/approvals/store';
import { buildSpecUpdateDiff } from '@/lib/approvals/spec-update';
import { invalidateCommandCenterSnapshotCaches } from '@/lib/command-center/snapshot';
import { findLaneByPacket } from '@/lib/lane/registry';
import { invalidateInboxCache } from '@/lib/mobile/inbox';
import { currentMissionState } from '@/lib/orchestrator/operator-mission-service/shared';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveRequestPrincipalContext, workerPacketRefusal } from '@/lib/auth/principal';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import { asRecord, operatorError, operatorSuccess, parseJsonBody } from '@/app/api/orchestrator/_utils';

/**
 * POST /api/orchestrator/propose-spec — backs the `cortex_propose_spec` MCP tool.
 *
 * Closes the agent-proposal half of #773 (tracked separately as #857). The
 * orchestrator agent calls this to suggest a new spec.md body for a packet.
 * The proposal sits in the approval queue (kind = 'spec-update' continuation)
 * until the operator approves (we apply via writePacketSpec) or rejects
 * (we leave the spec on disk untouched). Either way, an audit trail lands
 * in approvalEvents through the standard approval lifecycle.
 *
 * Atomic resolution comes from `resolveApproval` (SQLite single-row update);
 * concurrent approves can't double-write because only the winner of the race
 * sees `approval.resolvedAt === approval.updatedAt`.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PACKET_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_SPEC_BYTES = 64 * 1024;
const MAX_RATIONALE_LENGTH = 1_024;

function readPacketId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return PACKET_ID_PATTERN.test(trimmed) ? trimmed : null;
}

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = await parseJsonBody(request);
  const record = asRecord(body);
  if (!record) {
    return operatorError('invalid_request', 'Invalid JSON body.', 400);
  }

  const packetId = readPacketId(record.packetId);
  if (!packetId) {
    return operatorError('invalid_request', 'packetId is required.', 400);
  }
  const ownershipRefusal = workerPacketRefusal(resolveRequestPrincipalContext(request), packetId);
  if (ownershipRefusal) {
    return operatorError(ownershipRefusal.code, ownershipRefusal.message, 403);
  }

  const proposedSpec = typeof record.proposedSpec === 'string' ? record.proposedSpec : '';
  if (!proposedSpec.trim()) {
    return operatorError('invalid_request', 'proposedSpec is required.', 400);
  }
  if (Buffer.byteLength(proposedSpec, 'utf8') > MAX_SPEC_BYTES) {
    return operatorError(
      'invalid_request',
      `proposedSpec exceeds ${MAX_SPEC_BYTES} bytes — break into linked docs.`,
      400,
    );
  }

  const rationaleRaw = typeof record.rationale === 'string' ? record.rationale.trim() : '';
  if (!rationaleRaw) {
    return operatorError('invalid_request', 'rationale is required.', 400);
  }
  const rationale = rationaleRaw.slice(0, MAX_RATIONALE_LENGTH);

  // Verify the packet exists in the active mission.
  let packetTitle = packetId;
  try {
    const state = currentMissionState();
    const packet = state.packets.find((candidate) => candidate.id === packetId);
    if (!packet) {
      return operatorError('packet_not_found', `Packet ${packetId} is not in the active mission.`, 404);
    }
    packetTitle = packet.referenceLabel || packet.title || packetId;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to read mission state.';
    return operatorError('mission_state_unavailable', message, 500, error);
  }

  const lane = findLaneByPacket(packetId);

  let diff;
  try {
    diff = await buildSpecUpdateDiff(packetId, proposedSpec);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to read current packet spec.';
    return operatorError('spec_read_failed', message, 500, error);
  }

  const summary = `Agent proposed spec update for packet ${packetId}: ${rationale}`;

  try {
    const approval = createApproval({
      source: 'runtime',
      runtime: lane?.runtime ?? 'codex',
      agent: 'Orchestrator',
      sessionKey: lane?.sessionKey || `packet:${packetId}`,
      title: `Spec update: ${packetTitle}`,
      description: rationale,
      summary,
      toolName: 'cortex_propose_spec',
      args: {
        packetId,
        rationale,
      },
      editable: false,
      diff,
      risk: 'low',
      metadata: {
        Packet: packetId,
        ...(lane ? { Lane: lane.id, Branch: lane.branch, Base: lane.baseBranch } : {}),
      },
      continuation: {
        kind: 'spec-update',
        packetId,
        proposedSpec,
      },
    });

    invalidateCommandCenterSnapshotCaches();
    invalidateInboxCache();
    await publishRealtimeMutation({
      mutation: {
        mutationId: `approval-create-${approval.id}`,
        source: 'desktop',
        action: 'approve',
        sessionKey: approval.sessionKey,
        surfaceId: approval.sessionKey,
        status: 'pending',
        note: `Spec update proposed for ${packetId}`,
        createdAt: new Date().toISOString(),
      },
      refreshTargets: ['global', 'mobileInbox'],
      sessionKeys: [approval.sessionKey],
      fresh: true,
    });

    return operatorSuccess({ approvalId: approval.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to enqueue spec proposal.';
    return operatorError('enqueue_failed', message, 500, error);
  }
}
