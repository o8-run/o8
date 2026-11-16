import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

process.env.CORTEX_IDE_DATA_DIR = mkdtempSync(join(os.tmpdir(), 'o8-idle-mission-budget-'));
process.env.O8_DATA_DIR = process.env.CORTEX_IDE_DATA_DIR;

vi.mock('server-only', () => ({}));

const budget = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@/lib/orchestrator/dispatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/orchestrator/dispatch')>();
  return {
    ...actual,
    // No launch room, so the one mission with queued work is checked but never dispatched.
    buildRemainingLaunchBudget: () => {
      budget.calls += 1;
      return { maxLaunches: 0, perRuntime: {} };
    },
  };
});

import { getSqlite } from '@/lib/db';
import { runHeadlessSprintTick } from './headless-loop';

function insertMission(id: string, at: number, queued = false) {
  const state = {
    version: 2,
    missionId: id,
    prompt: '',
    summary: '',
    repoPath: '/repo',
    packets: [queued
      ? { id: `${id}-p`, title: 'queued packet', status: 'queued', queueState: 'queued' }
      : {
        id: `${id}-p`,
        title: 'held packet',
        status: 'blocked',
        queueState: 'held',
        operatorStopped: true,
        blockedReason: 'operator_stopped',
      }],
    updatedAt: new Date(at).toISOString(),
  };
  getSqlite().prepare(`
    INSERT INTO missions (id, repo_path, mission_state_json, created_at, updated_at, archived_at)
    VALUES (?, '/repo', ?, ?, ?, NULL)
  `).run(id, JSON.stringify(state), at, at);
}

describe('headless tick over idle registry missions', () => {
  it('does not build a launch budget for a mission with nothing to launch', async () => {
    // One queued mission keeps the tick from short-circuiting, as on a real
    // machine; the 12 held missions beside it have nothing to launch.
    insertMission('queued', 999, true);
    for (let index = 0; index < 12; index += 1) insertMission(`held-${index}`, 1_000 + index);
    await runHeadlessSprintTick();
    // At most the control-plane mission and the queued mission build a budget.
    expect(budget.calls).toBeGreaterThanOrEqual(1);
    expect(budget.calls).toBeLessThanOrEqual(2);
    expect(getSqlite().prepare('SELECT COUNT(*) AS n FROM missions WHERE archived_at IS NULL').get()).toEqual({ n: 13 });
  });
});
