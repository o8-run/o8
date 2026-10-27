import { expect, it } from 'vitest';
import { groupThreads, replayThreadModels } from '@/lib/threads/grouping';
import type { ProjectThread } from '@/lib/threads/types';
const packet = { id: 'packet', summary: 'Current outcome', thread: { kind: 'packet', sessionKey: 'codex:owned', childIds: [], history: [], artifacts: [], merges: [] } } as unknown as ProjectThread;
const mission = { ...packet, id: 'mission', thread: { ...packet.thread, kind: 'mission', sessionKey: null, childIds: ['packet'] } } as ProjectThread;
const outside = { ...packet, id: 'outside', thread: { ...packet.thread, kind: 'session', sessionKey: 'claude:discovered' } } as ProjectThread;
it('replays all grouping candidates without hiding discovered attention or duplicating session ownership', () => {
  const tasks = [mission, packet, outside];
  const snapshots = Array.from({ length: 14 }, (_, day) => ({ at: `2026-10-${String(day + 1).padStart(2, '0')}T12:00:00Z`, tasks, attentionIds: ['packet', 'outside'] }));
  const results = replayThreadModels(snapshots);
  expect(results.map(result => result.missedAttention)).toEqual([14, 14, 0]);
  expect(results[2].duplicates).toBe(0);
  expect(Object.keys(results[2].rowsPerDay)).toHaveLength(14);
  expect(groupThreads(tasks, 'B').map(task => task.id)).toEqual(['mission']);
  expect(groupThreads(tasks, 'C').map(task => task.id)).toEqual(['mission', 'packet', 'outside']);
});
