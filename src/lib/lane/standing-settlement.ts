import { executionRunIsClear } from '@/lib/mcp/task-execution-admission';
import { processCwdRowsInside, readProcessCwdSnapshot } from '@/lib/runtime/process-cwd-snapshot';
import { terminatePacketManagedRuns } from '@/lib/runtimes/managed-runs/packet-lifecycle';
import { listManagedRuns } from '@/lib/runtimes/managed-runs/registry';
import { inspectOwnedManagedRun } from '@/lib/runtimes/managed-runs/termination';
import { readOwnedSessionRecord } from '@/lib/runtimes/shared/owned-session-index';
import { MAX_RETAINED_OWNED_RUNS } from '@/lib/runtimes/shared/owned-session/run-ledger';
import { getLane } from './registry';
import { saveStandingLane, type StandingLaneState } from './standing-store';

/** Compose packet settlement and fresh process proof under the standing mutation lease. */
export async function settleStandingTaskProcesses(laneId: string, state: StandingLaneState): Promise<void> {
  const lane = getLane(laneId);
  if (!lane?.sessionKey) return;
  if (!lane.packetId || !lane.worktreePath) throw new Error('Previous task process ownership is unavailable.');
  const managed = await terminatePacketManagedRuns(lane.packetId);
  if (managed.failures.length) throw new Error('Previous task managed process settlement is unconfirmed; checkout reuse refused.');
  // A terminal command receipt alone does not prove that its descendants exited.
  const retainedManaged = (await listManagedRuns()).filter(run => run.packetId === lane.packetId);
  if (!(await Promise.all(retainedManaged.map(inspectOwnedManagedRun))).every(Boolean)) {
    throw new Error('Previous task still has live or unconfirmed managed processes; checkout reuse refused.');
  }
  const session = await readOwnedSessionRecord(lane.sessionKey);
  if (!session || session.activeRun) throw new Error('Previous task runtime process is still live or unconfirmed.');
  const ledger = session.runIdentityLedger;
  const runs = session.recentRuns;
  const total = ledger?.totalRuns;
  if (ledger?.version !== 1 || typeof total !== 'number' || !Number.isSafeInteger(total) || total < runs.length || !runs.length
    || runs.length > MAX_RETAINED_OWNED_RUNS || new Set(runs.map(run => run.id)).size !== runs.length || runs.some(run => !run.id.trim())) {
    throw new Error('Previous task process ledger is incomplete; checkout reuse refused.');
  }
  const boundary = state.processSettlement;
  const boundaryIndex = boundary ? total - boundary.totalRuns : runs.length - 1;
  if (boundary ? !Number.isSafeInteger(boundary.totalRuns) || boundary.totalRuns < 1
    || boundaryIndex < 0 || runs[boundaryIndex]?.id !== boundary.runId
    : !ledger.complete || total !== runs.length) {
    throw new Error('Previous task process settlement boundary is missing or inconsistent; checkout reuse refused.');
  }
  // Include the proven boundary itself and every newer run, including idle steers.
  // Older identities can roll out only after their entire process tree was proved absent.
  const settlingRuns = runs.slice(0, boundaryIndex + 1);
  const processesClear = async () => (await Promise.all(settlingRuns.map(executionRunIsClear))).every(Boolean);
  // One unavailable observation must not permanently latch a settled lane.
  // Recheck every exact run; persistent uncertainty still refuses reuse.
  if (!await processesClear() && !await processesClear()) {
    throw new Error('Previous task processes are still live or unconfirmed; checkout reuse refused.');
  }
  const cwd = await readProcessCwdSnapshot({ forceRefresh: true });
  if (cwd.status !== 'ready' || processCwdRowsInside(cwd, lane.worktreePath).length) {
    throw new Error('Previous task checkout still has live or unconfirmed process users; checkout reuse refused.');
  }
  state.processSettlement = { runId: runs[0].id, totalRuns: total };
  saveStandingLane(laneId, state);
}
