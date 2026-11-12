import { isNativeCortexReader } from '@/lib/cortex/owner-process';
import { createHash, randomUUID } from 'node:crypto';
import { getSqlite } from '@/lib/db';
import { appendEvent, findLaneByPacket, getLane } from '@/lib/lane/registry';
import type { Lane, LaneCommandResult, LaneEventActor } from '@/lib/lane/types';
import { inspectPacketManagedRunAdmission } from '@/lib/lane/packet-stop-hold';
import { withPacketLifecycleMutationLock, withPacketLifecycleSpawnLock } from '@/lib/orchestrator/lifecycle-mutation-lock';
import { withOwnedActionGuard } from '@/lib/runtimes/shared/owned-session/action-admission';
import type { TaskMutationResult } from './actions';

export interface TaskDispatchAdmission { dispatchId: string; intentHash: string; packetId: string | null }
function latestAdmission(laneId: string): TaskDispatchAdmission | null {
  const row = getSqlite().prepare(`SELECT payload_json FROM lane_events
    WHERE lane_id = ? AND verb = 'task_dispatch_accepted' ORDER BY rowid DESC LIMIT 1`).get(laneId) as { payload_json: string } | undefined;
  return row ? JSON.parse(row.payload_json) as TaskDispatchAdmission : null;
}

/** Short durable admission; provisioning runs after the caller has its receipt. */
export async function dispatchWithReceipt(input: {
  packetId: string | null;
  laneId: string | null;
  actor: LaneEventActor;
  intent: unknown;
  waitForLaunch: boolean;
  conflict: (message: string) => Error;
  prepare: (admission: TaskDispatchAdmission) => Promise<Lane>;
  receipt: (lane: Lane, admission: TaskDispatchAdmission | null, replayed: boolean) => Promise<TaskMutationResult>;
  launch: (lane: Lane, dispatchId: string) => Promise<LaneCommandResult>;
  settle: (lane: Lane, result: LaneCommandResult, guard: () => void) => Promise<TaskMutationResult>;
}): Promise<TaskMutationResult> {
  if (process.env.O8_NEXT_O8D === '1' && !isNativeCortexReader()) {
    throw input.conflict('Task dispatch admission requires the native owner.');
  }
  const key = input.packetId ?? input.laneId!;
  const intentHash = createHash('sha256').update(JSON.stringify(input.intent)).digest('hex');
  const replay = async () => {
    const lane = input.packetId ? findLaneByPacket(input.packetId) : getLane(input.laneId!);
    if (!lane || !['launching', 'running', 'awaiting_input'].includes(lane.status)) return null;
    if (input.packetId && !inspectPacketManagedRunAdmission(input.packetId).allowed) throw input.conflict('Task is held or stopped. Inspect it before dispatching.');
    const previous = latestAdmission(lane.id);
    if (!previous || previous.intentHash !== intentHash) {
      throw input.conflict('Task already has an active launch. Inspect it before changing the dispatch intent.');
    }
    const failure = getSqlite().prepare("SELECT payload_json FROM lane_events WHERE lane_id = ? AND verb = 'task_dispatch_failed' ORDER BY rowid DESC LIMIT 1").get(lane.id) as { payload_json: string } | undefined;
    if (failure && JSON.parse(failure.payload_json).dispatchId === previous.dispatchId) throw input.conflict('The accepted dispatch could not settle. Inspect mission_tail before retrying.');
    return input.receipt(lane, previous, true);
  };
  // A retry must not wait behind the provisioning lease it is inspecting.
  const previous = await replay();
  if (previous) return previous;
  const accepted = await withPacketLifecycleSpawnLock(key, async () => {
    const replayed = await replay();
    if (replayed) return { replayed };
    const admission = { dispatchId: randomUUID(), intentHash, packetId: input.packetId };
    const lane = await input.prepare(admission);
    return { lane, admission };
  });
  if ('replayed' in accepted) return accepted.replayed!;
  const { lane, admission } = accepted;
  const guard = () => {
    const current = getLane(lane.id);
    const stopped = getSqlite().prepare(`SELECT 1 FROM lane_events WHERE lane_id = ?
      AND rowid > (SELECT rowid FROM lane_events WHERE lane_id = ? AND verb = 'task_dispatch_accepted' ORDER BY rowid DESC LIMIT 1)
      AND verb = 'status_change' AND (json_extract(payload_json, '$.status') = 'paused'
        OR json_extract(payload_json, '$.eventLabel') IN ('operator_stopped', 'interrupted')) LIMIT 1`).get(lane.id, lane.id);
    if (stopped || !current || ['paused', 'archived', 'completed'].includes(current.status)
      || current.packetId !== input.packetId || latestAdmission(lane.id)?.dispatchId !== admission.dispatchId
      || (input.packetId !== null && !inspectPacketManagedRunAdmission(input.packetId).allowed)) {
      throw input.conflict('Task dispatch was stopped or superseded. Inspect its current receipt before retrying.');
    }
  };
  // Schedule outside the short admission lease/ALS scope. Reset and newer
  // lifecycle intent serialize with launch; Stop is checked at actual spawn,
  // lane attachment, and inside the final control-plane write.
  const completion = new Promise<TaskMutationResult>((resolve, reject) => setImmediate(() => {
    void withPacketLifecycleMutationLock(key, () => withOwnedActionGuard(guard, async () => {
      guard();
      if (getLane(lane.id)?.lastEventLabel !== 'dispatch_accepted') throw input.conflict('Task dispatch admission changed before launch.');
      let result: LaneCommandResult;
      try { result = await input.launch(lane, admission.dispatchId); }
      catch (error) { result = { ok: false, laneId: lane.id, note: error instanceof Error ? error.message : 'Dispatch failed.' }; }
      guard();
      return input.settle(lane, result, guard);
    })).then(resolve, reject);
  }));
  const settled = completion.catch(async (error: unknown) => {
    // Only the exact current admission may record a failure. Stop/reset and
    // superseding admissions retain their state without a stale failure write.
    guard();
    const note = 'Accepted dispatch could not settle. Inspect its lane events before retrying.';
    appendEvent(lane.id, 'task_dispatch_failed', 'system', { dispatchId: admission.dispatchId, packetId: input.packetId, note });
    try {
      return await withPacketLifecycleSpawnLock(key, async () => {
        guard();
        return input.settle(lane, { ok: false, laneId: lane.id, note }, guard);
      });
    } catch { throw error; }
  });
  if (input.waitForLaunch) return settled;
  // The durable failure event remains readable even if its control-plane
  // settlement also fails. No unhandled rejection can terminate the MCP host.
  void settled.catch(() => {});
  return input.receipt(lane, admission, false);
}
