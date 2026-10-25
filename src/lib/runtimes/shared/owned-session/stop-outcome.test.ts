import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chainOnKey } from '@/lib/util/keyed-promise-chain';
import type { InterruptEscalationResult } from '@/lib/runtime/interrupt-escalation';
import type { OwnedActiveRun } from '../owned-session-index';
import type { OwnedSessionIo } from './session-io';
import type { OwnedSessionRecord } from './types';
import { registerOwnedStopHandler, withOwnedStopOutcome } from './stop-outcome';

const surfaceId = 'stop-fixture:session';
const expected: OwnedActiveRun = {
  id: 'run-1', pid: 42, processGroupId: 42, processMarker: 'marker-1', tmuxSession: undefined,
};
const delivered: InterruptEscalationResult = {
  attempted: true, confirmedDead: true, alreadyDead: false, note: 'Stopped',
  steps: [{ signal: 'SIGINT', mechanism: 'SIGINT', sent: true, confirmedDead: true, aliveAfter: false }],
};

describe('owned Stop outcome transaction', () => {
  let saved: OwnedSessionRecord;
  let io: OwnedSessionIo;
  let lock: <T>(key: string, operation: () => Promise<T>) => Promise<T>;
  const invalidate = vi.fn();

  beforeEach(() => {
    const run = { ...expected, outcome: 'running' };
    saved = { surfaceId, activeRun: run, recentRuns: [run, { id: 'prior', outcome: 'finished' }] } as OwnedSessionRecord;
    io = {
      findSession: vi.fn(async () => structuredClone(saved)),
      saveSession: vi.fn(async (value) => { saved = structuredClone(value); }),
    } as unknown as OwnedSessionIo;
    const chains = new Map<string, Promise<unknown>>();
    lock = (key, operation) => chainOnKey(chains, key, operation);
    invalidate.mockReset();
    registerOwnedStopHandler('stop-fixture:', io, lock, invalidate);
  });

  it('records delivered Stop before an exit writer or resume can acquire the store lock', async () => {
    let release!: () => void;
    const operation = vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return delivered;
    });
    const pending = withOwnedStopOutcome(surfaceId, expected, operation);
    await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce());
    let observed: string | undefined;
    const exitWriter = lock(surfaceId, async () => { observed = saved.recentRuns[0].outcome; });
    expect(observed).toBeUndefined();
    release();
    expect(await pending).toBe(delivered);
    await exitWriter;
    expect(observed).toBe('interrupted');
    expect(saved.activeRun).toBeUndefined();
    expect(saved.recentRuns[0].interruptRequestedAt).toEqual(expect.any(String));
    expect(saved.recentRuns[1]).toEqual({ id: 'prior', outcome: 'finished' });
    expect(invalidate).toHaveBeenCalledOnce();
  });

  it('refuses a captured run that settles before the stop lock without signaling', async () => {
    const exitWriter = lock(surfaceId, async () => {
      saved.activeRun = undefined;
      Object.assign(saved.recentRuns[0], { outcome: 'interrupted', finishedAt: '2026-09-10T00:00:00.000Z',
        childExit: { code: null, signal: 'SIGINT', classification: 'signal-kill' } });
    });
    const operation = vi.fn(async () => delivered);
    const pending = withOwnedStopOutcome(surfaceId, expected, operation);
    await exitWriter;
    const terminal = structuredClone(saved);
    expect(await pending).toMatchObject({ attempted: false, confirmedDead: false, alreadyDead: false });
    expect(operation).not.toHaveBeenCalled();
    expect(io.saveSession).not.toHaveBeenCalled();
    expect(saved).toEqual(terminal);
  });

  it.each([
    { id: 'successor' }, { id: undefined }, { pid: 43 }, { processGroupId: 43 },
    { processMarker: 'successor-marker' }, { tmuxSession: 'successor-bridge' },
    { processIdentity: { version: 1 as const, platform: 'darwin' as const, bootId: 'boot', startId: 'kernel:1:000001' } },
    { processIdentitySource: 'ps' as const },
  ])('refuses changed or missing exact-run evidence %j', async (change) => {
    const operation = vi.fn(async () => delivered);
    expect(await withOwnedStopOutcome(surfaceId, { ...expected, ...change }, operation))
      .toMatchObject({ attempted: false, confirmedDead: false });
    expect(operation).not.toHaveBeenCalled();
    expect(io.saveSession).not.toHaveBeenCalled();
  });

  it.each(['absent', 'denied'] as const)('does not relabel an %s signal', async (kind) => {
    const result = { ...delivered, alreadyDead: kind === 'absent',
      steps: kind === 'absent' ? [] : [{ ...delivered.steps[0], sent: false, confirmedDead: false }] };
    expect(await withOwnedStopOutcome(surfaceId, expected, async () => result)).toBe(result);
    expect(io.saveSession).not.toHaveBeenCalled();
    expect(saved.recentRuns[0].outcome).toBe('running');
  });

  it('preserves concurrent tail settlement while labeling only the signaled historical run', async () => {
    await withOwnedStopOutcome(surfaceId, expected, async () => {
      saved.activeRun = undefined;
      saved.recentRuns[0].outcome = 'failed';
      saved.recentRuns[0].finishedAt = '2026-09-10T00:00:00.000Z';
      saved.latestSummary = 'Fresh tail';
      return delivered;
    });
    expect(saved.activeRun).toBeUndefined();
    expect(saved.latestSummary).toBe('Fresh tail');
    expect(saved.recentRuns[0]).toMatchObject({ outcome: 'interrupted', finishedAt: '2026-09-10T00:00:00.000Z' });
  });
});
