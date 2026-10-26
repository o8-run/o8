import { correctionStopVersion } from '@/lib/db/worker-correction-fences';
import { handleWorkerRuntimeFailure } from '@/lib/dispatch/worker-quota-fallback';
import { buildWorkerHandoffContext } from '@/lib/dispatch/worker-handoff-context';
import { getLane } from '@/lib/lane/registry';
import { currentRecoveryRun, recoveryInterrupted, recoveryPacketHoldReason } from './automatic-recovery';
import type { OwnedRunController } from './run-controller';
import type { OwnedSessionIo } from './session-io';
import type { OwnedRuntimeAdapter } from './types';

/** Detached exits and restart/daemon reconciliation share one durable effect. Caller holds the surface lock. */
export function createWorkerFailureHandler(options: {
  adapter: OwnedRuntimeAdapter;
  io: OwnedSessionIo;
  readRunArtifacts: OwnedRunController['readRunArtifacts'];
  park(surfaceId: string, expectedStopVersion?: number): Promise<string | null>;
}) {
  return async (surfaceId: string, runId: string): Promise<void> => {
    const expectedStopVersion = correctionStopVersion(`worker:${surfaceId}`);
    const current = await options.io.findSession(surfaceId);
    const run = current && currentRecoveryRun(current);
    const lane = current?.laneId ? getLane(current.laneId) : null;
    if (!current || current.executionPolicy !== undefined || current.activeRun || current.detachedAt || current.orphanedAt
      || recoveryInterrupted(current) || recoveryPacketHoldReason(current) || run?.id !== runId || run.outcome !== 'failed'
      || current.workerFailureHandledRunId === runId || !lane || lane.sessionKey !== surfaceId || lane.status !== 'running') return;
    const artifacts = await options.readRunArtifacts(run);
    const result = await handleWorkerRuntimeFailure({ laneId: lane.id, runtime: options.adapter.runtimeId,
      model: current.model, surfaceId, prompt: current.latestPrompt, expectedStopVersion,
      rawFailure: `${artifacts.stdoutRaw}\n${artifacts.stderrRaw || run.childExit?.stderrTail || ''}`.slice(-16_000),
      waitForCapacity: () => options.park(surfaceId, expectedStopVersion),
      buildHandoffContext: () => buildWorkerHandoffContext(current, options.readRunArtifacts),
    });
    const settled = await options.io.findSession(surfaceId);
    if (result.handled && settled && currentRecoveryRun(settled)?.id === runId) {
      settled.workerFailureHandledRunId = runId;
      await options.io.saveSession(settled);
    }
  };
}
