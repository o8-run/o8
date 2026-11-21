import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

process.env.O8_DATA_DIR = mkdtempSync(join(tmpdir(), 'o8-mission-normalization-'));
process.env.CORTEX_IDE_DATA_DIR = process.env.O8_DATA_DIR;
vi.mock('server-only', () => ({}));
vi.mock('./store', async (original) => {
  const actual = await original<typeof import('./store')>();
  return { ...actual, normalizeOrchestratorMissionState: vi.fn(actual.normalizeOrchestratorMissionState) };
});

const { getSqlite } = await import('@/lib/db');
const { normalizeOrchestratorMissionState } = await import('./store');
const { readMissionRegistryEntry, listMissionRegistryEntries } = await import('./mission-registry');

function insert(id: string, packets: unknown = [{ id: 'packet', branchTarget: 'main', title: 'original' }]) {
  getSqlite().prepare(`INSERT INTO missions (id, repo_path, mission_state_json, created_at, updated_at)
    VALUES (?, '/repo', ?, 1, 1)`).run(id, JSON.stringify({ missionId: id, packets }));
  vi.mocked(normalizeOrchestratorMissionState).mockClear();
}

it('normalizes an unchanged registry row once and re-normalizes a new version', () => {
  insert('versioned');
  readMissionRegistryEntry('versioned');
  readMissionRegistryEntry('versioned');
  expect(normalizeOrchestratorMissionState).toHaveBeenCalledTimes(1);
  getSqlite().prepare('UPDATE missions SET updated_at = 2 WHERE id = ?').run('versioned');
  readMissionRegistryEntry('versioned');
  expect(normalizeOrchestratorMissionState).toHaveBeenCalledTimes(2);
});

it('does not share mutable packets with another registry read', () => {
  insert('isolated');
  readMissionRegistryEntry('isolated')!.mission.packets[0]!.title = 'mutated';
  expect(readMissionRegistryEntry('isolated')!.mission.packets[0]!.title).toBe('original');
});

it('sees a raw writer changing JSON without advancing the row version', () => {
  insert('raw-writer');
  readMissionRegistryEntry('raw-writer');
  getSqlite().prepare("UPDATE missions SET mission_state_json = json_set(mission_state_json, '$.summary', 'changed') WHERE id = ?")
    .run('raw-writer');
  expect(readMissionRegistryEntry('raw-writer')!.mission.summary).toBe('changed');
});

it('still rejects an invalid snapshot after a permissive read cached it', () => {
  insert('invalid', [{ title: 'missing identity' }]);
  expect(readMissionRegistryEntry('invalid')).not.toBeNull();
  expect(() => listMissionRegistryEntries({ strict: true })).toThrow('Stored packet snapshot is unavailable.');
});

it('reads archived history without retaining its normalized snapshot', () => {
  insert('archive-transition');
  expect(readMissionRegistryEntry('archive-transition')?.mission.packets[0]?.title).toBe('original');
  getSqlite().prepare('UPDATE missions SET archived_at = 2 WHERE id = ?').run('archive-transition');
  expect(readMissionRegistryEntry('archive-transition')).toBeNull();

  const first = readMissionRegistryEntry('archive-transition', { includeArchived: true });
  expect(first?.archivedAt).toBe(2);
  first!.mission.packets[0]!.title = 'changed by caller';
  expect(readMissionRegistryEntry('archive-transition', { includeArchived: true })?.mission.packets[0]?.title)
    .toBe('original');
  expect(normalizeOrchestratorMissionState).toHaveBeenCalledTimes(3);

  getSqlite().prepare('UPDATE missions SET archived_at = NULL WHERE id = ?').run('archive-transition');
  expect(readMissionRegistryEntry('archive-transition')?.mission.packets[0]?.title).toBe('original');
  expect(normalizeOrchestratorMissionState).toHaveBeenCalledTimes(4);
});
