import { readStandingLane } from '@/lib/lane/standing-store';
import type { OwnedSessionIo } from './session-io';
import type { OwnedRunController } from './run-controller';
import type { OwnedRuntimeAdapter, OwnedSessionRecord } from './types';

/** Serialize recovery with launch/resume, and retain the rejected run as evidence. */
export function createModelCompatibilityRecovery({ adapter, io, withSurfaceLock, readRunArtifacts, spawnOwnedRun }: {
  adapter: OwnedRuntimeAdapter;
  io: OwnedSessionIo;
  withSurfaceLock: <T>(surfaceId: string, fn: () => Promise<T>) => Promise<T>;
  readRunArtifacts: OwnedRunController['readRunArtifacts'];
  spawnOwnedRun: OwnedRunController['spawnOwnedRun'];
}) {
  return async (session: OwnedSessionRecord, surfaceLockHeld = false): Promise<boolean> => {
    if (session.laneId && readStandingLane(session.laneId)) return false;
    if (session.executionPolicy !== undefined || !adapter.modelCompatibilityFallback || session.activeRun || session.recentRuns[0]?.outcome !== 'failed') return false;
    const recover = async () => {
      const current = await io.findSession(session.surfaceId);
      const run = current?.recentRuns[0];
      if (!current || current.executionPolicy !== undefined || !current.model || !run || run.id !== session.recentRuns[0]?.id || run.outcome !== 'failed' || current.activeRun
        || current.orphanedAt || current.detachedAt || run.interruptRequestedAt || run.sandboxDenial || run.modelFallback) return false;
      const { stdoutRaw, stderrRaw, parsed } = await readRunArtifacts(run);
      if (parsed.entries.some((entry) => entry.kind !== 'event')) return false;
      const decision = adapter.modelCompatibilityFallback!(current.model, `${stdoutRaw}\n${stderrRaw}`);
      if (!decision || decision.nextModel === current.model) return false;
      run.modelFallback = { fromModel: current.model, toModel: decision.nextModel, notice: decision.notice };
      current.model = decision.nextModel;
      // General failure retry must not run the same rejected model again.
      current.autoRetry = false;
      await io.saveSession(current);
      await spawnOwnedRun(current, run.prompt, current.threadId ? 'resume' : 'launch');
      Object.assign(session, current);
      return true;
    };
    return surfaceLockHeld ? recover() : withSurfaceLock(session.surfaceId, recover);
  };
}
