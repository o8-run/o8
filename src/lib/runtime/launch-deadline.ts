import { AsyncLocalStorage } from 'node:async_hooks';
import { appendEvent, attachSession, getLane, setLaneStatus } from '@/lib/lane/registry';
import { withOwnedActionGuard } from '@/lib/runtimes/shared/owned-session/action-admission';

export const POST_WORKTREE_LAUNCH_MS = 30_000;
export const POST_SPAWN_LAUNCH_MS = 10 * 60_000;
const STEP_LIMITS: Record<string, number> = { backend_gate: 20_000, reviewer_checkout: 60_000 };
type Launch = { laneId?: string; packetId?: string; surfaceId?: string };
type Bound = { step: string; started: number; limit: number };
interface Deadline {
  started: number; step: string; effectStarted: boolean; effectCreated: boolean;
  limitMs: number; postSpawnMs: number; effectAt: number; surfaceId?: string;
  clock: () => number; paused: number; pauseStarted: number; bounds: Bound[];
  stepTimeoutMs?: number; failure?: RuntimeLaunchTimeoutError; cancelRead?: (error: unknown) => void;
}
const deadline = new AsyncLocalStorage<Deadline>();
const launchClock = new AsyncLocalStorage<() => number>();
export function withRuntimeLaunchClock<T>(clock: () => number, operation: () => T): T { return launchClock.run(clock, operation); }

export class RuntimeLaunchTimeoutError extends Error {
  readonly code: 'runtime_launch_timeout' | 'runtime_launch_held';
  constructor(readonly step: string, readonly elapsedMs: number, readonly effectStarted: boolean, limitMs = POST_WORKTREE_LAUNCH_MS) {
    super(`${effectStarted ? 'runtime_launch_held' : 'runtime_launch_timeout'}: ${step} did not settle after ${Math.round(elapsedMs)}ms (limit ${limitMs}ms).${effectStarted ? ' A held spawn may still exist; inspect its original session before retrying.' : ''}`);
    this.code = effectStarted ? 'runtime_launch_held' : 'runtime_launch_timeout';
  }
}
function check(context: Deadline): void {
  if (context.failure) throw context.failure;
  const now = context.clock();
  const stalled = context.bounds.find(bound => now - bound.started >= bound.limit);
  const elapsed = context.effectStarted ? now - context.effectAt : now - context.started;
  const limit = context.effectStarted ? context.postSpawnMs : context.limitMs;
  if (stalled || ((!context.paused || context.effectStarted) && elapsed >= limit)) {
    context.failure = new RuntimeLaunchTimeoutError(stalled?.step ?? context.step, stalled ? now - stalled.started : elapsed, context.effectStarted, stalled?.limit ?? limit);
    throw context.failure;
  }
}
/** Preparation is bounded separately from the held, potentially live spawn. */
export async function withRuntimeLaunchDeadline<T>(input: Launch & { runtime: string; timeoutMs?: number; postSpawnTimeoutMs?: number; stepTimeoutMs?: number; clock?: () => number }, operation: () => Promise<T>): Promise<T> {
  const clock = input.clock ?? launchClock.getStore() ?? performance.now.bind(performance);
  const context: Deadline = { started: clock(), clock, paused: 0, pauseStarted: 0, bounds: [], step: 'runtime_preparation', effectStarted: false, effectCreated: false, effectAt: 0,
    limitMs: input.timeoutMs ?? POST_WORKTREE_LAUNCH_MS, postSpawnMs: input.postSpawnTimeoutMs ?? POST_SPAWN_LAUNCH_MS, stepTimeoutMs: input.stepTimeoutMs };
  return deadline.run(context, () => withOwnedActionGuard(() => { if (!context.effectStarted) check(context); }, async () => {
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      const expired = new Promise<never>((_, reject) => {
        timer = setInterval(() => {
          try { check(context); } catch (error) {
            clearInterval(timer);
            if (context.cancelRead && !context.effectStarted) context.cancelRead(error);
            else reject(error);
          }
        }, 25);
      });
      return await Promise.race([operation(), expired]);
    } catch (error) {
      if (error instanceof RuntimeLaunchTimeoutError && input.laneId) {
        appendEvent(input.laneId, 'runtime_launch_step', 'system', { packetId: input.packetId, runtime: input.runtime, step: error.step, phase: error.effectStarted ? 'held' : 'failed', code: error.code, elapsedMs: error.elapsedMs, effectStarted: error.effectStarted, surfaceId: context.surfaceId });
        const lane = getLane(input.laneId);
        // The stall reaper may escalate this same launch first. Its `launch_stalled` is ours to
        // refine with the held surface and step; any other state belongs to someone else.
        const reaped = error.effectStarted && lane?.status === 'awaiting_orchestrator' && lane.lastEventLabel === 'launch_stalled';
        if (lane && (lane.status === 'launching' || reaped)) {
          if (error.effectStarted && context.surfaceId && !lane.sessionKey) attachSession(lane.id, context.surfaceId, 'system');
          setLaneStatus(lane.id, 'awaiting_orchestrator', 'system', error.effectStarted ? `${error.code}:${error.step}` : error.code);
        }
      }
      throw error;
    } finally { clearInterval(timer); }
  }));
}
export async function runtimeLaunchStep<T>(launch: Launch, step: string, operation: () => T | Promise<T>): Promise<T> {
  const context = deadline.getStore();
  const parentStep = context?.step;
  let bound: Bound | undefined;
  if (context) {
    context.step = step;
    if (STEP_LIMITS[step]) {
      if (context.paused++ === 0) context.pauseStarted = context.clock();
      bound = { step, started: context.clock(), limit: context.stepTimeoutMs ?? STEP_LIMITS[step] };
      context.bounds.push(bound);
    } else if (!context.effectStarted || step === 'process_spawn') check(context);
    if (step === 'process_spawn') {
      context.effectStarted = true; context.effectAt = context.clock(); context.surfaceId = launch.surfaceId;
    }
  }
  const started = performance.now();
  const emit = (phase: string) => { if (launch.laneId) appendEvent(launch.laneId, 'runtime_launch_step', 'system', { packetId: launch.packetId, step, phase, elapsedMs: Math.max(0, performance.now() - started) }); };
  emit('started');
  try {
    const result = await operation();
    if (context && step === 'process_spawn') context.effectCreated = true;
    if (context && !context.effectStarted) check(context);
    emit('succeeded'); return result;
  } catch (error) { emit('failed'); throw error; }
  finally {
    if (context && bound) {
      context.bounds.splice(context.bounds.indexOf(bound), 1);
      if (--context.paused === 0) context.started += context.clock() - context.pauseStarted;
    }
    if (context && parentStep) context.step = parentStep;
  }
}
export function hasRuntimeLaunchDeadline(): boolean { return deadline.getStore() !== undefined; }
/** Called immediately before OS creation, even if the spawn operation has begun. */
export function assertRuntimeSpawnDeadline(): void {
  const context = deadline.getStore();
  if (!context || context.effectCreated) return;
  const elapsed = context.clock() - context.started;
  if (!context.failure && !context.paused && elapsed >= context.limitMs) {
    context.failure = new RuntimeLaunchTimeoutError(context.step, elapsed, false, context.limitMs);
  }
  check(context);
}
/** Only preparation reads can safely abandon a late result. */
export async function runtimeLaunchRead<T>(operation: () => Promise<T>): Promise<T> {
  const context = deadline.getStore();
  if (!context || context.effectStarted || context.paused) return operation();
  check(context);
  const parent = context.cancelRead;
  const cancelled = new Promise<never>((_, reject) => { context.cancelRead = reject; });
  try { return await Promise.race([operation(), cancelled]); }
  finally { context.cancelRead = parent; }
}
