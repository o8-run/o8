/**
 * Adapted from T3 Code (https://github.com/pingdotgg/t3code),
 * packages/client-runtime/src/state/threadSettled.ts and
 * apps/server/src/orchestration-v2/Orchestrator.ts, commit
 * f58fad04162165653bf06f0c987bbfb0074a8a4b.
 * Copyright (c) 2026 T3 Tools Inc.; MIT; see licenses/t3code-MIT.txt.
 * Adapted for o8: boundary fixtures for the ported TypeScript rules.
 */
import { describe, expect, it } from 'vitest';
import { emptySettlement, hasQueuedTurnStart, transitionSettlement } from './settlement';

describe('ported settlement rules', () => {
  it.each([[-120_001, false], [-120_000, true], [0, true], [120_000, true], [120_001, false]] as const)(
    'bounds queued grace on both sides at age %s', (age, expected) => {
      expect(hasQueuedTurnStart({ latestUserMessageAt: 1_000_000 - age }, 1_000_000)).toBe(expected);
    });
  it('does not mistake a failed or adopted turn for a queued start', () => {
    expect(hasQueuedTurnStart({ latestUserMessageAt: 10, failed: true }, 10)).toBe(false);
    expect(hasQueuedTurnStart({ latestUserMessageAt: 10, latestRunAt: 10 }, 10)).toBe(false);
    expect(hasQueuedTurnStart({ latestUserMessageAt: NaN }, 10)).toBe(false);
    expect(hasQueuedTurnStart({ status: 'starting' }, 10)).toBe(true);
  });
  it('keeps retry ordering and clears overrides when a real run starts', () => {
    const settled = transitionSettlement(emptySettlement(), 'settle', '2026-10-29T10:00:00.000Z');
    expect(transitionSettlement(settled, 'settle', '2026-10-29T11:00:00.000Z')).toEqual(settled);
    const active = transitionSettlement(settled, 'unsettle', '2026-10-29T12:00:00.000Z');
    expect(transitionSettlement(active, 'unsettle', '2026-10-29T13:00:00.000Z')).toEqual(active);
    expect(transitionSettlement(active, 'run', '2026-10-29T14:00:00.000Z')).toEqual({ ...active, settledOverride: null });
    expect(transitionSettlement(settled, 'run', '2026-10-29T14:00:00.000Z')).toEqual({
      settledOverride: null, settledAt: null, unsettledAt: '2026-10-29T14:00:00.000Z',
    });
  });
});
