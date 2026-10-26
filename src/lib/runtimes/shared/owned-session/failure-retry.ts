import { AUTO_RETRY_FRESHNESS_MS, MAX_AUTO_RETRIES } from './helpers';
import { currentRecoveryRun, recoveryInterrupted, recoveryPacketHoldReason } from './automatic-recovery';
import { withOwnedActionGuard } from './action-admission';
import type { OwnedRunController } from './run-controller';
import type { OwnedSessionIo } from './session-io';
import type { OwnedRuntimeAdapter, OwnedSessionRecord } from './types';

/** Delayed retries re-read their generation under the same lock as Stop. */
export function createFailureRetry(options: {
  adapter: OwnedRuntimeAdapter;
  io: OwnedSessionIo;
  withSurfaceLock: <T>(surfaceId: string, fn: () => Promise<T>) => Promise<T>;
  spawnOwnedRun: OwnedRunController['spawnOwnedRun'];
  readRunArtifacts: OwnedRunController['readRunArtifacts'];
  notify(session: OwnedSessionRecord, from: string, to: string, reason: string): Promise<void>;
  invalidateFleetCache(): void;
  retryDelayMs: number;
}) {
  const pending = new Set<string>();
  return (session: OwnedSessionRecord) => {
    const run = currentRecoveryRun(session);
    const age = run?.finishedAt ? Date.now() - Date.parse(run.finishedAt) : Infinity;
    const budget = options.adapter.chooseRetryModel ? MAX_AUTO_RETRIES : 1;
    if (session.executionPolicy !== undefined || !session.autoRetry || session.activeRun || recoveryInterrupted(session) || recoveryPacketHoldReason(session)
      || !run || run.outcome !== 'failed' || run.sandboxDenial || (session.retryCount ?? 0) >= budget
      || !Number.isFinite(age) || age >= AUTO_RETRY_FRESHNESS_MS
      || pending.has(session.surfaceId)) return;
    pending.add(session.surfaceId);
    setTimeout(async () => {
      try {
        await options.withSurfaceLock(session.surfaceId, async () => {
          const current = await options.io.findSession(session.surfaceId);
          const failed = current && currentRecoveryRun(current);
          if (!current || current.executionPolicy !== undefined || current.activeRun || current.detachedAt || current.orphanedAt || !current.autoRetry
            || recoveryInterrupted(current) || recoveryPacketHoldReason(current) || failed?.id !== run.id || failed.outcome !== 'failed'
            || (current.retryCount ?? 0) >= budget) return;
          if (options.adapter.chooseRetryModel) {
            try {
              const { stdoutRaw } = await options.readRunArtifacts(failed);
              const decision = options.adapter.chooseRetryModel({ failedRunRaw: stdoutRaw, currentModel: current.model });
              if (decision && decision.nextModel !== current.model) {
                const from = current.model ?? '(default)';
                current.model = decision.nextModel;
                console.log(`[owned-store] ${options.adapter.runtimeId} fallback ${from} → ${decision.nextModel} (${decision.reason})`);
                void options.notify(current, from, decision.nextModel, decision.reason);
              }
            } catch (error) { console.error('[owned-store] Retry model selection failed:', error); }
          }
          current.retryCount = (current.retryCount ?? 0) + 1;
          await options.io.saveSession(current);
          console.log(`[owned-store] Auto-retrying ${options.adapter.runtimeId} session ${current.surfaceId} after failure (attempt ${current.retryCount})`);
          await withOwnedActionGuard(() => {
            if (recoveryPacketHoldReason(current)) throw new Error('Automatic retry refused: the packet is held.');
          }, () => options.spawnOwnedRun(current, current.latestPrompt, current.threadId ? 'resume' : 'launch'));
          options.invalidateFleetCache();
        });
      } catch (error) { console.error('[owned-store] Auto-retry failed:', error); }
      finally { pending.delete(session.surfaceId); }
    }, options.retryDelayMs);
  };
}
