import { headersIndicateLoopback } from '@/lib/auth/loopback-request';
import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { isNativeCortexReader } from '@/lib/cortex/owner-process';
import { getSqlite } from '@/lib/db';
import { ControlPlaneLockTimeoutError } from '@/lib/orchestrator/control-plane';
import { correctWorkers } from '@/lib/orchestrator/worker-corrections';
import { correctAuthorFromReview, inspectReviewAuthorCorrection } from '@/lib/orchestrator/review-author-correction';
import { deliverQueuedPacketSteer, steerPacket, SteerPacketUnavailableError, type SteerPacketInput } from './steer';
import type { LaneEvent } from '@/lib/lane/types';

export async function POST(request: Request): Promise<Response> {
  if (!isNativeCortexReader() || process.env.O8_NEXT_O8D !== '1') return Response.json({ error: 'Steer requires the native owner.' }, { status: 503 });
  if (!headersIndicateLoopback(name => request.headers.get(name)) || resolveRequestPrincipalContext(request).role !== 'operator') {
    return Response.json({ error: 'Steer ownership requires the local operator.' }, { status: 403 });
  }
  try {
    const body = await request.json();
    let result;
    if (body?.kind === 'steer') {
      const input = body.input;
      if (!input || typeof input.packetId !== 'string' || !input.packetId.trim()
        || typeof input.message !== 'string' || !input.message.trim()
        || ['source', 'clientMutationId'].some(key => input[key] !== undefined && typeof input[key] !== 'string')
        || (input.immediate !== undefined && typeof input.immediate !== 'boolean')) throw new Error('Invalid packet steer data.');
      result = await steerPacket(input as SteerPacketInput);
    } else if (body?.kind === 'deliver' && typeof body.eventId === 'string') {
      const row = getSqlite().prepare("SELECT * FROM lane_events WHERE id = ? AND verb = 'steered_packet'").get(body.eventId) as {
        id: string; lane_id: string; actor: LaneEvent['actor']; payload_json: string; timestamp: string;
      } | undefined;
      if (!row || JSON.parse(row.payload_json).deliveryState !== 'queued') {
        throw new SteerPacketUnavailableError('Queued steer event no longer exists.', 'terminal');
      }
      result = await deliverQueuedPacketSteer({ id: row.id, laneId: row.lane_id, verb: 'steered_packet', actor: row.actor,
        payload: JSON.parse(row.payload_json), timestamp: row.timestamp });
    } else if (body?.kind === 'correct') {
      result = await correctWorkers(body.input);
    } else if (body?.kind === 'review-inspect' && typeof body.packetId === 'string'
      && body.packetId.length > 0 && body.packetId.length <= 240) {
      result = await inspectReviewAuthorCorrection(body.packetId);
    } else if (body?.kind === 'review-correct') {
      result = await correctAuthorFromReview(body.input);
    } else {
      return Response.json({ error: 'Choose a supported steer operation.' }, { status: 400 });
    }
    return Response.json({ ok: true, result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    return Response.json({ error: error instanceof Error ? error.message : 'Steer failed.', code,
      errorClass: error instanceof SteerPacketUnavailableError ? 'SteerPacketUnavailableError'
        : error instanceof ControlPlaneLockTimeoutError ? 'ControlPlaneLockTimeoutError' : 'Error',
      ...(error instanceof SteerPacketUnavailableError ? { phase: error.phase } : {}),
      ...(error instanceof ControlPlaneLockTimeoutError ? { waitTimeoutMs: error.waitTimeoutMs } : {}),
    }, { status: error instanceof SteerPacketUnavailableError ? 409 : 500 });
  }
}
