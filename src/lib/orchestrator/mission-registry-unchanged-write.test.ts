import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.CORTEX_IDE_DATA_DIR = mkdtempSync(join(os.tmpdir(), 'o8-unchanged-write-'));
process.env.O8_DATA_DIR = process.env.CORTEX_IDE_DATA_DIR;

vi.mock('server-only', () => ({}));

import { getSqlite } from '@/lib/db';
import { withMissionRegistryState } from './mission-registry';

function insertMission(id: string, archivedAt: number | null = null) {
  const state = {
    version: 2,
    missionId: id,
    prompt: 'ship it',
    summary: '',
    repoPath: '/repo',
    packets: [{ id: `${id}-p1`, title: 'one', status: 'running' }],
    updatedAt: '2026-11-16T00:00:00.000Z',
  };
  getSqlite().prepare(`
    INSERT INTO missions (id, repo_path, mission_state_json, created_at, updated_at, archived_at)
    VALUES (?, '/repo', ?, 1, 1, ?)
  `).run(id, JSON.stringify(state), archivedAt);
}
const row = (id: string) => getSqlite().prepare('SELECT mission_state_json, updated_at, archived_at FROM missions WHERE id = ?')
  .get(id) as { mission_state_json: string; updated_at: number; archived_at: number | null };
const unchanged = async (id: string) => withMissionRegistryState(id, (state) => ({ state, result: null }));

describe('writing a mission back to the registry', () => {
  beforeEach(() => {
    getSqlite().prepare('DELETE FROM missions').run();
  });

  it('leaves the row and its version alone when nothing changed', async () => {
    insertMission('m1');
    await unchanged('m1');
    const first = row('m1');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await unchanged('m1');
    expect(row('m1')).toEqual(first);
  });

  it('still writes a real change and bumps the version', async () => {
    insertMission('m2');
    await unchanged('m2');
    const before = row('m2');
    const { state } = await withMissionRegistryState('m2', (current) => ({
      state: { ...current, summary: 'now with a summary' },
      result: null,
    }));
    expect(state.summary).toBe('now with a summary');
    const after = row('m2');
    expect(after.updated_at).toBeGreaterThan(before.updated_at);
    expect(JSON.parse(after.mission_state_json).summary).toBe('now with a summary');
  });

  it('still clears an archive mark on a live mission as before', async () => {
    insertMission('m3');
    await unchanged('m3');
    getSqlite().prepare('UPDATE missions SET archived_at = 5 WHERE id = ?').run('m3');
    await unchanged('m3');
    expect(row('m3').archived_at).toBeNull();
  });
});
