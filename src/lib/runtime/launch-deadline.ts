import { AsyncLocalStorage } from 'node:async_hooks';
import { appendEvent, getLane, setLaneStatus } from '@/lib/lane/registry';
import { listDeclarativeRuntimes, type OrchestratorRuntime } from '@/lib/orchestrator/runtime-capabilities';
import { withOwnedActionGuard } from '@/lib/runtimes/shared/owned-session/action-admission';

export const POST_WORKTREE_LAUNCH_MS = 30_000;
type Launch = { laneId?: string; packetId?: string };
interface Deadline { started: number; step: string; expired: boolean; effectStarted: boolean; effectCreated: boolean }
const deadline = new AsyncLocalStorage<Deadline>();

export class RuntimeLaunchTimeoutError extends Error {
  readonly code = 'runtime_launch_timeout';
  constructor(readonly step: string, readonly elapsedMs: number, readonly effectStarted: boolean) {
    super(`runtime_launch_timeout: ${step} did not settle after ${Math.round(elapsedMs)}ms (limit ${POST_WORKTREE_LAUNCH_MS}ms).${effectStarted ? ' A process may exist; inspect the original launch receipt before retrying.' : ''}`);
  }
}

function check(context: Deadline) {
  const elapsed = performance.now() - context.started;
  if (context.expired || elapsed >= POST_WORKTREE_LAUNCH_MS) {
    context.expired = true;
    throw new RuntimeLaunchTimeoutError(context.step, elapsed, context.effectStarted);
  }
}

/** A deadline fences preparation; an uncertain spawn remains a held receipt. */
export async function withRuntimeLaunchDeadline<T>(input: Launch & { runtime: string }, operation: () => Promise<T>): Promise<T> {
  if (!listDeclarativeRuntimes().includes(input.runtime as OrchestratorRuntime)) return operation();
  const context: Deadline = { started: performance.now(), step: 'runtime_preparation', expired: false, effectStarted: false, effectCreated: false };
  return deadline.run(context, () => withOwnedActionGuard(() => { if (!context.effectCreated) check(context); }, async () => {
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      const expired = new Promise<never>((_, reject) => {
        timer = setInterval(() => { try { check(context); } catch (error) { reject(error); } }, 25);
      });
      return await Promise.race([operation(), expired]);
    } catch (error) {
      if (error instanceof RuntimeLaunchTimeoutError && input.laneId) {
        appendEvent(input.laneId, 'runtime_launch_step', 'system', {
          packetId: input.packetId, runtime: input.runtime, step: error.step, phase: 'failed',
          code: error.code, elapsedMs: error.elapsedMs, deadlineMs: POST_WORKTREE_LAUNCH_MS,
          effectStarted: error.effectStarted,
        });
        const lane = getLane(input.laneId);
        if (lane?.status === 'launching' && !lane.sessionKey) {
          setLaneStatus(lane.id, 'awaiting_orchestrator', 'system', error.code);
        }
      }
      throw error;
    } finally { clearInterval(timer); }
  }));
}

export async function runtimeLaunchStep<T>(launch: Launch, step: string, operation: () => T | Promise<T>): Promise<T> {
  const context = deadline.getStore();
  const parentStep = context?.step;
  if (context) { if (!context.effectCreated || step === 'process_spawn') check(context); context.step = step; if (step === 'process_spawn') context.effectStarted = true; }
  const started = performance.now();
  const emit = (phase: string) => {
    if (launch.laneId) appendEvent(launch.laneId, 'runtime_launch_step', 'system', {
      packetId: launch.packetId, step, phase, elapsedMs: Math.max(0, performance.now() - started),
    });
  };
  emit('started');
  try {
    const result = await operation();
    if (context && step === 'process_spawn') context.effectCreated = true;
    if (context && !context.effectCreated) check(context);
    emit('succeeded');
    return result;
  } catch (error) { emit('failed'); throw error; }
  finally { if (context && parentStep) context.step = parentStep; }
}

export function hasRuntimeLaunchDeadline(): boolean { return deadline.getStore() !== undefined; }

export function assertRuntimeSpawnDeadline(): void { const context = deadline.getStore(); if (context) check(context); }
