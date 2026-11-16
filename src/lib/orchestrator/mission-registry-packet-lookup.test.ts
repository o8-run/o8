import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.CORTEX_IDE_DATA_DIR = mkdtempSync(join(os.tmpdir(), 'o8-packet-lookup-'));
process.env.O8_DATA_DIR = process.env.CORTEX_IDE_DATA_DIR;

vi.mock('server-only', () => ({}));

const parsed = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/lib/orchestrator/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/orchestrator/store')>();
  return {
    ...actual,
    normalizeOrchestratorMissionState: (raw: Parameters<typeof actual.normalizeOrchestratorMissionState>[0]) => {
      parsed.count += 1;
      return actual.normalizeOrchestratorMissionState(raw);
    },
  };
});

import { getSqlite } from '@/lib/db';
import { findMissionRegistryEntryByPacketId } from './mission-registry';

let clock = 1_000;
function insertMission(id: string, packetIds: string[], extra: { prompt?: string; archived?: boolean } = {}) {
  clock += 1;
  const state = {
    version: 2,
    missionId: id,
    prompt: extra.prompt ?? '',
    summary: '',
    repoPath: '/repo',
    packets: packetIds.map((packetId) => ({ id: packetId, title: packetId, status: 'merged' })),
    updatedAt: new Date(clock).toISOString(),
  };
  getSqlite().prepare(`
    INSERT INTO missions (id, repo_path, mission_state_json, created_at, updated_at, archived_at)
    VALUES (?, '/repo', ?, ?, ?, ?)
  `).run(id, JSON.stringify(state), clock, clock, extra.archived ? clock : null);
}

describe('finding a mission by packet id', () => {
  beforeEach(() => {
    getSqlite().prepare('DELETE FROM missions').run();
    parsed.count = 0;
  });

  it('parses only the missions whose text names the packet', () => {
    for (let index = 0; index < 300; index += 1) insertMission(`m-${index}`, [`p-${index}-a`, `p-${index}-b`]);
    parsed.count = 0;
    expect(findMissionRegistryEntryByPacketId('p-250-b')?.id).toBe('m-250');
    expect(parsed.count).toBe(1);
    expect(findMissionRegistryEntryByPacketId('missing')).toBeNull();
    expect(parsed.count).toBe(1);
  });

  it('ignores a mission that only mentions the id in its text', () => {
    insertMission('mentions', ['other'], { prompt: 'retry packet target-1 after review' });
    insertMission('owner', ['target-1']);
    expect(findMissionRegistryEntryByPacketId('target-1')?.id).toBe('owner');
  });

  it('keeps the oldest owner first and honours archived and excluded missions', () => {
    insertMission('archived-owner', ['shared'], { archived: true });
    insertMission('live-owner', ['shared']);
    expect(findMissionRegistryEntryByPacketId('shared')?.id).toBe('live-owner');
    expect(findMissionRegistryEntryByPacketId('shared', { includeArchived: true })?.id).toBe('archived-owner');
    expect(findMissionRegistryEntryByPacketId('shared', { includeArchived: true, excludeMissionId: 'archived-owner' })?.id)
      .toBe('live-owner');
  });

  it('matches ids JSON escapes or stores with spaces around them', () => {
    insertMission('quoted', ['say "hi" \\ 100%_done']);
    insertMission('padded', ['  padded-id  ']);
    expect(findMissionRegistryEntryByPacketId('say "hi" \\ 100%_done')?.id).toBe('quoted');
    expect(findMissionRegistryEntryByPacketId(' padded-id ')?.id).toBe('padded');
    expect(findMissionRegistryEntryByPacketId('100%')).toBeNull();
  });
});
