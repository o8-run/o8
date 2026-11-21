import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.CORTEX_IDE_DATA_DIR = mkdtempSync(join(os.tmpdir(), 'o8-settled-missions-'));
process.env.O8_DATA_DIR = process.env.CORTEX_IDE_DATA_DIR;

vi.mock('server-only', () => ({}));

const passes = vi.hoisted(() => new Map<string, number>());
vi.mock('@/lib/orchestrator/control-plane', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/orchestrator/control-plane')>();
  return {
    ...actual,
    // Count full passes per mission; the registry pass reconciles each mission once.
    reconcileOrchestratorControlPlaneState: (...args: Parameters<typeof actual.reconcileOrchestratorControlPlaneState>) => {
      const id = args[0]?.missionId ?? '';
      passes.set(id, (passes.get(id) ?? 0) + 1);
      return actual.reconcileOrchestratorControlPlaneState(...args);
    },
  };
});

import { getSqlite } from '@/lib/db';
import { createLane } from '@/lib/lane/registry';
import { writeOrchestratorControlPlaneState } from './control-plane';
import { runHeadlessSprintTick } from './headless-loop';
import { withMissionRegistryState } from './mission-registry';
import { missionIsSettled, resetSettledMissions, SETTLED_REFRESH_MS } from './settled-missions';
import { normalizeOrchestratorMissionState } from './store';
import type { OrchestratorPacket } from './types';

function insertMission(id: string, at: number, packet: Partial<OrchestratorPacket>) {
  const state = {
    version: 2,
    missionId: id,
    prompt: '',
    summary: '',
    repoPath: '/repo',
    packets: [{ id: `${id}-p`, title: 'packet', ...packet }],
    updatedAt: new Date(at).toISOString(),
  };
  getSqlite().prepare(`
    INSERT INTO missions (id, repo_path, mission_state_json, created_at, updated_at, archived_at)
    VALUES (?, '/repo', ?, ?, ?, NULL)
  `).run(id, JSON.stringify(state), at, at);
}

// Registry missions only; the control-plane mission has its own generated id.
const registryEntries = () => [...passes].filter(([id]) => id === 'unpinned' || id.startsWith('held'));
const registryPasses = () => registryEntries().reduce((sum, [, n]) => sum + n, 0);

describe('headless tick over settled missions', () => {
  beforeEach(() => {
    getSqlite().prepare('DELETE FROM missions').run();
    passes.clear();
    resetSettledMissions();
  });

  it('skips held and never-pinned queued missions until a mission or lane changes', async () => {
    // A queued packet queued before the last boot has no runtime pin, so the
    // boot-recovery guard holds it on every tick.
    insertMission('unpinned', 999, { status: 'queued', queueState: 'queued' });
    for (let index = 0; index < 12; index += 1) {
      insertMission(`held-${index}`, 1_000 + index, {
        status: 'blocked', queueState: 'held', operatorStopped: true, blockedReason: 'operator_stopped',
      });
    }

    // The first pass normalizes the stored rows; the second changes nothing and settles them.
    await runHeadlessSprintTick();
    await runHeadlessSprintTick();
    expect(registryPasses()).toBe(26);

    passes.clear();
    await runHeadlessSprintTick();
    await runHeadlessSprintTick();
    expect(registryPasses()).toBe(0);

    // A change to the queued mission re-checks that mission only.
    await withMissionRegistryState('unpinned', (state) => ({ state: { ...state, summary: 'changed' }, result: null }));
    await runHeadlessSprintTick();
    expect(registryEntries()).toEqual([['unpinned', 1]]);

    // A lane write can change any mission's reconciled state, so every mission is re-checked once.
    passes.clear();
    createLane({ repoPath: '/repo', branch: 'fix/other', runtime: 'codex', packetId: 'unrelated-packet' });
    await runHeadlessSprintTick();
    expect(registryPasses()).toBe(13);
    passes.clear();
    await runHeadlessSprintTick();
    expect(registryPasses()).toBe(0);
  });

  it('skips the current mission while its file and lanes are unchanged', async () => {
    writeOrchestratorControlPlaneState(normalizeOrchestratorMissionState({
      version: 2, missionId: 'current', prompt: '', summary: '', repoPath: '/repo',
      packets: [{ id: 'current-p', title: 'unpinned', status: 'queued', queueState: 'queued' }],
    }));
    await runHeadlessSprintTick();
    await runHeadlessSprintTick();
    expect(passes.get('current')).toBeGreaterThan(0);
    passes.clear();
    await runHeadlessSprintTick();
    expect(passes.get('current')).toBeUndefined();
    // Another writer of the current mission unsettles it.
    writeOrchestratorControlPlaneState(normalizeOrchestratorMissionState({
      version: 2, missionId: 'current', prompt: '', summary: 'edited', repoPath: '/repo',
      packets: [{ id: 'current-p', title: 'unpinned', status: 'queued', queueState: 'queued' }],
    }));
    await runHeadlessSprintTick();
    expect(passes.get('current')).toBeGreaterThan(0);
    writeOrchestratorControlPlaneState(normalizeOrchestratorMissionState({ version: 2, missionId: '', prompt: '', summary: '', packets: [] }));
  });

  it('re-checks settled missions after the refresh period', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      resetSettledMissions();
      insertMission('held', 1_000, { status: 'blocked', queueState: 'held', operatorStopped: true });
      insertMission('unpinned', 1_001, { status: 'queued', queueState: 'queued' });
      await runHeadlessSprintTick();
      passes.clear();
      vi.setSystemTime(Date.now() + SETTLED_REFRESH_MS + 1);
      await runHeadlessSprintTick();
      expect(registryPasses()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never settles a mission with live work or a blocker that clears on its own', () => {
    const mission = (packet: Partial<OrchestratorPacket>) => normalizeOrchestratorMissionState({
      version: 2, missionId: 'm', prompt: '', summary: '', repoPath: '/repo',
      packets: [{ id: 'p', title: 'p', ...packet }],
    });
    expect(missionIsSettled(mission({ status: 'running', queueState: 'held' }))).toBe(false);
    expect(missionIsSettled(mission({ status: 'recovering', queueState: 'queued' }))).toBe(false);
    // Waiting only on disk space: the hold clears when space frees.
    expect(missionIsSettled(mission({
      status: 'queued', queueState: 'queued', dispatchRuntimePin: 'codex', workspaceTargetPath: process.cwd(),
      storageAdmission: { state: 'held' } as OrchestratorPacket['storageAdmission'],
    }))).toBe(false);
    // A stale hold on a packet that is not queued does not keep the mission awake.
    expect(missionIsSettled(mission({ status: 'archived', queueState: 'held', storageAdmission: { state: 'held' } as OrchestratorPacket['storageAdmission'] }))).toBe(true);
    expect(missionIsSettled(mission({
      // A manual launch claim clears when its owner process exits.
      status: 'queued', queueState: 'queued', dispatchRuntimePin: 'codex', workspaceTargetPath: process.cwd(),
      manualLaunchClaim: { token: 'claim', ownerPid: process.pid, startedAt: new Date().toISOString() },
    }))).toBe(false);
    expect(missionIsSettled(mission({ status: 'queued', queueState: 'queued' }))).toBe(true);
    expect(missionIsSettled(mission({ status: 'blocked', queueState: 'held', operatorStopped: true }))).toBe(true);
  });
});
