import { getSqlite } from '@/lib/db';
import { recordLaneEvent } from '@/lib/lane/events';
import type { LaneEvent } from '@/lib/lane/types';
import type { SteerPacketResult } from './steer';
import { isMetadataLockProcessIdentity, probeMetadataLockProcessIdentitySync,
  sameMetadataLockProcessIdentity } from '@/lib/worktree/metadata-lock-process-identity';

export class SteerDeferredError extends Error {}
export const QUEUED_STEER_NOTE = 'Queued. o8 will deliver this message when the worker is ready.';

/** Only these known pre-send refusals are safe to retry automatically. */
export function steerCanWait(note: string): boolean {
  return /still finishing its current turn|still has an active run|does not have a thread id yet|unresolved prepared run|artifact accounting changed; retry after writers settle|another lifecycle operation owns this runtime root/i.test(note);
}

export function operatorSteerFailure(note: string): string {
  if (/artifact|admission|accounting/i.test(note)) {
    return 'The worker could not start another turn. Inspect its retained session and storage before sending a new message.';
  }
  return note;
}

type DeliveryState = 'queued' | 'sending' | 'delivered' | 'failed';
interface QueueRow { id: string; lane_id: string; payload_json: string; timestamp: string; state: DeliveryState; receipt_json: string | null }

// Lane events are append-only. The newest linked receipt is the delivery state,
// independent of event timestamps, history pagination, and process restarts.
function openSteers(): QueueRow[] {
  return getSqlite().prepare(`SELECT *, COALESCE(json_extract(receipt_json, '$.state'), 'queued') AS state FROM (
    SELECT e.id, e.lane_id, e.payload_json, e.timestamp,
      (SELECT d.payload_json FROM lane_events d
        WHERE d.lane_id = e.lane_id AND d.verb = 'steer_delivery'
          AND json_extract(d.payload_json, '$.steerEventId') = e.id
        ORDER BY d.rowid DESC LIMIT 1) AS receipt_json
    FROM lane_events e WHERE e.verb = 'steered_packet'
      AND json_extract(e.payload_json, '$.deliveryState') = 'queued'
    ORDER BY e.rowid
  ) WHERE state IN ('queued', 'sending')`).all() as QueueRow[];
}

function recordState(event: LaneEvent, state: DeliveryState, note: string, extra: Record<string, unknown> = {}): LaneEvent {
  return recordLaneEvent(event.laneId, 'steer_delivery', 'orchestrator', { steerEventId: event.id, state, note, ...extra });
}

export async function deliverSteerEvent(
  event: LaneEvent,
  deliver: (deliveryAttemptId: string) => Promise<SteerPacketResult>,
): Promise<SteerPacketResult> {
  const queued: SteerPacketResult = { packetId: String(event.payload.packetId), laneId: event.laneId,
    note: QUEUED_STEER_NOTE, deliveryState: 'queued' };
  const owner = probeMetadataLockProcessIdentitySync(process.pid);
  if (owner.state !== 'live') return queued;
  // Claim before crossing the runtime seam. A crashed sending claim is never
  // replayed: its provider-side outcome is unknown and requires inspection.
  const claimed = getSqlite().transaction(() => {
    const first = openSteers().find(row => row.lane_id === event.laneId);
    if (first?.id !== event.id || first.state !== 'queued') return null;
    return recordState(event, 'sending', 'Delivery in progress. If interrupted, inspect the worker before sending again.',
      { ownerPid: process.pid, ownerIdentity: owner.identity }).id;
  }).immediate();
  if (!claimed) return queued;
  try {
    const result = await deliver(claimed);
    recordState(event, 'delivered', 'Delivered to the worker.');
    return { ...result, deliveryState: 'delivered' };
  } catch (error) {
    if (error instanceof SteerDeferredError) {
      recordState(event, 'queued', QUEUED_STEER_NOTE);
      return queued;
    }
    const note = operatorSteerFailure(error instanceof Error ? error.message : 'Unable to deliver the message. Inspect the worker before sending again.');
    recordLaneEvent(event.laneId, 'steer_failed', 'orchestrator', {
      ...event.payload, steerEventId: event.id, note,
    });
    recordState(event, 'failed', note);
    throw error;
  }
}

function reconcileAbandonedSend(row: QueueRow, event: LaneEvent): void {
  const receipt = row.receipt_json ? JSON.parse(row.receipt_json) : null;
  if (!receipt || !Number.isInteger(receipt.ownerPid) || !isMetadataLockProcessIdentity(receipt.ownerIdentity)) return;
  const owner = probeMetadataLockProcessIdentitySync(receipt.ownerPid);
  if (owner.state === 'unknown' || (owner.state === 'live'
    && sameMetadataLockProcessIdentity(owner.identity, receipt.ownerIdentity))) return;
  getSqlite().transaction(() => {
    if (openSteers().find(item => item.id === row.id)?.receipt_json !== row.receipt_json) return;
    const note = 'Delivery was interrupted and may already have reached the worker. Inspect it before sending a new message.';
    recordLaneEvent(event.laneId, 'steer_failed', 'orchestrator', { ...event.payload, steerEventId: event.id, note });
    recordState(event, 'failed', note);
  }).immediate();
}

/** The existing authenticated server wake owns delivery, including after restart. */
export async function drainQueuedPacketSteers(laneId?: string): Promise<void> {
  const { deliverQueuedPacketSteer } = await import('./steer');
  // One message per lane per wake preserves FIFO even if inventory lags a new turn.
  const lanes = new Set<string>();
  let attempted = 0;
  for (const row of openSteers()) {
    if (laneId && row.lane_id !== laneId) continue;
    if (lanes.has(row.lane_id)) continue;
    lanes.add(row.lane_id);
    const event: LaneEvent = { id: row.id, laneId: row.lane_id, verb: 'steered_packet',
      actor: 'orchestrator', payload: JSON.parse(row.payload_json), timestamp: row.timestamp };
    if (row.state === 'sending') { reconcileAbandonedSend(row, event); continue; }
    if (attempted++ >= 32) break;
    // A refusal has its own persisted receipt and must not block other workers.
    await deliverQueuedPacketSteer(event).catch(() => {});
  }
}

export function hasQueuedPacketSteers(laneId: string): boolean {
  return openSteers().some(row => row.lane_id === laneId);
}
