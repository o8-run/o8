import { withOwnedBridgeMutation } from '@/lib/runtime/owned-bridge-launch';
import type { InterruptEscalationResult } from '@/lib/runtime/interrupt-escalation';
import type { OwnedActiveRun } from '../owned-session-index';
import type { OwnedSessionIo } from './session-io';
import { assertOwnedActionAdmission } from './action-admission';

type StopOperation = () => Promise<InterruptEscalationResult>;
type StopHandler = (
  surfaceId: string, expected: OwnedActiveRun, operation: StopOperation,
) => Promise<InterruptEscalationResult>;

const handlers = new Map<string, StopHandler>();

/** Use the store's lock so exit recording and resume cannot overtake Stop. */
export function registerOwnedStopHandler(
  prefix: string,
  io: OwnedSessionIo,
  lock: <T>(surfaceId: string, operation: () => Promise<T>) => Promise<T>,
  invalidate: () => void,
): void {
  handlers.set(prefix, (surfaceId, expected, operation) => lock(surfaceId, async () => {
    const session = await io.findSession(surfaceId);
    assertOwnedActionAdmission(session);
    const run = session?.activeRun;
    if (!run || !expected.id || run.id !== expected.id
      || run.pid !== expected.pid || run.tmuxSession !== expected.tmuxSession
      || run.processMarker !== expected.processMarker
      || JSON.stringify(run.processIdentity) !== JSON.stringify(expected.processIdentity)
      || run.processIdentitySource !== expected.processIdentitySource
      || run.processGroupId !== expected.processGroupId) {
      return {
        attempted: false, confirmedDead: false, alreadyDead: false, steps: [],
        note: 'The owned run changed before Stop acquired its session lock; no process was signaled.',
      };
    }
    const stop = async () => {
      const requestedAt = new Date().toISOString();
      const result = await operation();
      // An absent process or a denied signal is not an intentional interruption.
      if (!result.steps.some((step) => step.sent)) return result;

      // Tail refresh can settle a dead run while the ladder verifies its children.
      // Reload that state and label only the exact run whose signal was delivered.
      const current = await io.findSession(surfaceId);
      if (!current) throw new Error('Stop signaled the owned run but its outcome record is unavailable.');
      const stamp = <T extends { id: string; interruptRequestedAt?: string; finishedAt?: string }>(entry: T) => (
        entry.id === run.id
          ? { ...entry, outcome: 'interrupted' as const, interruptRequestedAt: entry.interruptRequestedAt ?? requestedAt,
              ...(result.confirmedDead ? { finishedAt: entry.finishedAt ?? new Date().toISOString() } : {}) }
          : entry
      );
      current.recentRuns = current.recentRuns.map(stamp);
      if (current.activeRun) current.activeRun = stamp(current.activeRun);
      if (result.confirmedDead && current.activeRun?.id === run.id) current.activeRun = undefined;
      await io.saveSession(current);
      invalidate();
      return result;
    };
    return run.tmuxSession ? withOwnedBridgeMutation(surfaceId, stop) : stop();
  }));
}

export function withOwnedStopOutcome(
  surfaceId: string, expected: OwnedActiveRun, operation: StopOperation,
): Promise<InterruptEscalationResult> {
  const handler = [...handlers.entries()].find(([prefix]) => surfaceId.startsWith(prefix))?.[1];
  // ACP stores have a separate lifecycle and do not use shared run outcomes.
  return handler ? handler(surfaceId, expected, operation) : operation();
}
