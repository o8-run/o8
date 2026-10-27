import { AsyncLocalStorage } from 'node:async_hooks';
import { appendEvent, getLane, updateLane } from '@/lib/lane/registry';

export const DEPENDENCY_INSTALL_DEADLINE_MS = 300_000;
type Launch = { laneId?: string; packetId?: string };
interface Preparation { launch: Launch; started: number; expired: boolean }
const preparation = new AsyncLocalStorage<Preparation>();

export class DependencyInstallTimeoutError extends Error {
  readonly code = 'dependency_install_timeout';
  constructor() {
    super(`dependency_install_timeout: dependency_install exceeded its ${DEPENDENCY_INSTALL_DEADLINE_MS}ms deadline.`);
  }
}

export function withDependencyPreparationTiming<T>(launch: Launch | undefined, operation: () => Promise<T>): Promise<T> {
  return launch?.laneId ? preparation.run({ launch, started: performance.now(), expired: false }, operation) : operation();
}

/** Start the install budget only at the actual package-manager invocation. */
export async function timedDependencyInstall<T>(operation: (signal?: AbortSignal) => Promise<T>): Promise<T> {
  const context = preparation.getStore();
  if (!context) return operation();
  if (context.expired) throw new DependencyInstallTimeoutError();
  const { launch } = context;
  const started = performance.now();
  const emit = (stage: string, phase: string, elapsedMs: number, extra = {}) => appendEvent(launch.laneId!, 'worktree_preparation_timing', 'system', {
    packetId: launch.packetId, stage, phase, elapsedMs: Math.round(elapsedMs), ...extra,
  });
  emit('dependency_preparation', 'completed', started - context.started);
  emit('dependency_install', 'started', 0, { deadlineMs: DEPENDENCY_INSTALL_DEADLINE_MS });
  const controller = new AbortController();
  let timer: ReturnType<typeof setInterval> | undefined;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<T> | undefined;
  try {
    const expired = new Promise<never>((_, reject) => {
      timer = setInterval(() => {
        if (performance.now() - started < DEPENDENCY_INSTALL_DEADLINE_MS) return;
        context.expired = true;
        const error = new DependencyInstallTimeoutError();
        controller.abort(error);
        reject(error);
      }, 25);
    });
    pending = operation(controller.signal);
    const result = await Promise.race([pending, expired]);
    emit('dependency_install', 'completed', performance.now() - started);
    return result;
  } catch (error) {
    let failure = error;
    if (context.expired) {
      clearInterval(timer);
      // Abort requests teardown. Wait for its receipt before returning a failure
      // to the installer, which owns the cache lease and private runtime.
      await Promise.race([
        pending?.catch(reason => { failure = reason; }),
        new Promise<void>(resolve => { cleanupTimer = setTimeout(() => {
          failure = new Error('Dependency install exceeded its deadline and cleanup could not be confirmed; its cache reservation remains protected.');
          resolve();
        }, 11_000); }),
      ]);
      const lane = getLane(launch.laneId!);
      if (lane?.status === 'launching' && lane.packetId === launch.packetId) updateLane(lane.id, {
        status: 'failed', outcomeNote: (failure as Error).message, lastEventLabel: 'dependency_install_timeout',
      }, 'system', { stage: 'dependency_install', reason: 'deadline_exceeded' });
    }
    emit('dependency_install', 'failed', performance.now() - started, {
      reason: context.expired ? 'deadline_exceeded' : 'operation_failed', deadlineMs: DEPENDENCY_INSTALL_DEADLINE_MS,
    });
    throw failure;
  } finally { clearInterval(timer); clearTimeout(cleanupTimer); }
}
