import { describe, expect, it } from 'vitest';
import { conversationVerdict, idleVerdict, laneVerdict, packetsVerdict, prVerdict, type AutoSettleLane, type AutoSettlePacket } from './auto-settle-rules';
import { autoSettleEligible } from './store';

const lane = (packetId: string, status: string, updatedAt = '2026-10-30T10:00:00.000Z'): AutoSettleLane =>
  ({ packetId, sessionKey: `codex:${packetId}`, status, updatedAt, repoPath: '/r' });
const packet = (id: string, releaseState = 'pending', releasedAt: string | null = null): AutoSettlePacket =>
  ({ id, threadId: 't', status: releaseState === 'released' ? 'released' : 'idle', releaseState, releasedAt });

describe('auto-settle rules', () => {
  it('settles on merged PRs only when every linked PR merged', () => {
    expect(prVerdict([])).toBeNull();
    expect(prVerdict([{ threadId: 't', mergedAt: '2026-10-30T09:00:00Z' }, { threadId: 't', mergedAt: null }])).toBeNull();
    expect(prVerdict([{ threadId: 't', mergedAt: '2026-10-30T09:00:00Z' }, { threadId: 't', mergedAt: '2026-10-30T11:00:00Z' }]))
      .toEqual({ reason: 'pr-merged', evidenceAt: '2026-10-30T11:00:00Z' });
  });
  it('needs every owned packet released or cleaned up', () => {
    expect(packetsVerdict([], [])).toBeNull();
    expect(packetsVerdict([packet('a', 'released', '2026-10-30T12:00:00Z'), packet('b')], [lane('b', 'idle')])).toBeNull();
    expect(packetsVerdict([packet('b')], [])).toBeNull();
    expect(packetsVerdict([packet('a', 'released', '2026-10-30T12:00:00Z'), packet('b')], [lane('b', 'archived')]))
      .toEqual({ reason: 'released', evidenceAt: '2026-10-30T12:00:00Z' });
    expect(packetsVerdict([packet('b')], [lane('b', 'archived')])).toMatchObject({ reason: 'cleaned' });
  });
  it('lets an open PR or open packet keep the conversation active', () => {
    const merged = [{ threadId: 't', mergedAt: '2026-10-30T09:00:00Z' }];
    expect(conversationVerdict(merged, [packet('b')], [lane('b', 'running')])).toBeNull();
    expect(conversationVerdict([{ threadId: 't', mergedAt: null }], [packet('a', 'released', '2026-10-30T12:00:00Z')], [])).toBeNull();
    expect(conversationVerdict(merged, [], [])).toMatchObject({ reason: 'pr-merged' });
  });
  it('settles a standalone worker when its lane is released or archived', () => {
    expect(laneVerdict(lane('x', 'idle'), undefined)).toBeNull();
    expect(laneVerdict(lane('x', 'archived'), undefined)).toMatchObject({ reason: 'cleaned' });
    expect(laneVerdict(lane('x', 'completed'), packet('x', 'released', '2026-10-31T00:00:00Z'))).toMatchObject({ reason: 'released' });
  });
  it('never overrides the operator, a pin, an opt-out, a run or newer work', () => {
    const at = '2026-10-30T10:00:00.000Z';
    const base = { settledOverride: null, settledAt: null, unsettledAt: null } as const;
    expect(autoSettleEligible({ ...base }, at)).toBe(true);
    expect(autoSettleEligible({ ...base, settledOverride: 'active' }, at)).toBe(false);
    expect(autoSettleEligible({ ...base, settledOverride: 'settled', settledAt: at }, at)).toBe(false);
    expect(autoSettleEligible({ ...base, pinnedAt: at }, at)).toBe(false);
    expect(autoSettleEligible({ ...base }, at, true)).toBe(false);
    expect(autoSettleEligible({ ...base, pinnedAt: null }, at, true)).toBe(true);
    expect(autoSettleEligible({ ...base, autoSettleDisabledAt: at }, at)).toBe(false);
    expect(autoSettleEligible({ ...base, runStatus: 'running' }, at)).toBe(false);
    expect(autoSettleEligible({ ...base, runAt: '2026-10-30T11:00:00.000Z' }, at)).toBe(false);
    expect(autoSettleEligible({ ...base, unsettledAt: '2026-10-30T11:00:00.000Z' }, at)).toBe(false);
    expect(autoSettleEligible({ ...base }, 'not a date')).toBe(false);
  });
});

describe('idleVerdict', () => {
  const now = Date.parse('2026-10-31T12:00:00Z');
  it('settles after N whole days of no activity, and 0 is off', () => {
    expect(idleVerdict('2026-10-28T11:00:00Z', 3, now)).toEqual({ reason: 'idle', evidenceAt: '2026-10-28T11:00:00.000Z' });
    expect(idleVerdict('2026-10-29T12:00:00Z', 3, now)).toBeNull();
    expect(idleVerdict('2026-01-01T00:00:00Z', 0, now)).toBeNull();
    expect(idleVerdict(null, 3, now)).toBeNull();
  });
});
