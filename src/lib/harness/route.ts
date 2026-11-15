export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { Buffer } from 'node:buffer';
import { resolveRequestPrincipalContext, workerPacketRefusal } from '@/lib/auth/principal';
import { handleHarnessAction } from '@/lib/harness/service';
import { getSprint } from '@/lib/harness/store';
import { findLatestLaneByPacket } from '@/lib/lane/registry';

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const WORKER_ACTIONS = new Set([
  'capabilities',
  'feature_list',
  'feature_next',
  'feature_checks',
  'feature_verify',
  'ground',
  'boot',
  'contract_list',
  'contract_propose',
  'sprint_list',
  'sprint_tick',
  'verify',
]);

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

function statusForError(message: string): number {
  if (/not found/i.test(message)) return 404;
  if (/different repository|invalid .* transition|not ready|must be accepted|belongs to/i.test(message)) return 409;
  return 400;
}

function sprintOwnershipRefusal(body: Record<string, unknown>, packetId: string): string | null {
  const sprintId = typeof body.sprintId === 'string' ? body.sprintId.trim() : '';
  if (!sprintId) return null;
  const sprint = getSprint(sprintId);
  if (!sprint) return null;
  if (sprint.packetId === packetId) return null;
  return sprint.packetId
    ? `Worker credential for packet ${packetId} cannot mutate sprint owned by ${sprint.packetId}.`
    : `Sprint ${sprintId} is operator-owned and cannot be mutated by a worker.`;
}

export async function POST(request: NextRequest) {
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return errorResponse(413, 'request_too_large', `request exceeds ${MAX_REQUEST_BYTES} bytes`);
  }
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return errorResponse(400, 'invalid_json', 'request body must be a JSON object');
  }
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_REQUEST_BYTES) {
    return errorResponse(413, 'request_too_large', `request exceeds ${MAX_REQUEST_BYTES} bytes`);
  }
  const action = typeof body.action === 'string' ? body.action.trim() : '';
  if (!action) return errorResponse(400, 'missing_action', 'action is required');

  const principal = resolveRequestPrincipalContext(request);
  if (principal.role !== 'operator' && principal.role !== 'worker') {
    return errorResponse(403, 'operator_or_worker_required', 'Harness routes require an operator or packet-bound worker credential.');
  }

  let packetId: string | null = null;
  let repoPath: string | null = null;
  if (principal.role === 'worker') {
    packetId = principal.packetId;
    const refusal = workerPacketRefusal(principal, packetId);
    if (refusal) return errorResponse(403, refusal.code, refusal.message);
    if (!packetId) return errorResponse(403, 'worker_packet_required', 'Worker credential is not bound to a packet.');
    if (!WORKER_ACTIONS.has(action)) {
      return errorResponse(403, 'operator_required', `${action} requires operator authority.`);
    }
    const lane = findLatestLaneByPacket(packetId);
    if (!lane) return errorResponse(404, 'worker_lane_not_found', `No lane is registered for packet ${packetId}.`);
    repoPath = lane.repoPath;
    const sprintRefusal = sprintOwnershipRefusal(body, packetId);
    if (sprintRefusal) return errorResponse(403, 'worker_sprint_mismatch', sprintRefusal);
  }

  try {
    const result = await handleHarnessAction(body, {
      actor: principal.role,
      packetId,
      repoPath,
    });
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[harness] action failed:', error);
    const status = statusForError(message);
    return errorResponse(status, 'harness_action_failed', 'Harness action failed.');
  }
}
