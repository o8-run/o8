import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorLaneBinding, OrchestratorPacket } from '@/lib/orchestrator/types';

process.env.CORTEX_IDE_DATA_DIR = mkdtempSync(join(tmpdir(), 'o8-liveness-probes-data-'));
process.env.O8_DATA_DIR = process.env.CORTEX_IDE_DATA_DIR;

const { getSqlite } = await import('@/lib/db');
const { createLane, deleteLane, setLaneStatus } = await import('@/lib/lane/registry');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { enqueueInboxItem, listInboxItems } = await import('@/lib/supervisor/inbox');
const { runLivenessProbeSweep } = await import('@/lib/supervisor/liveness-probes');

const tempDirs: string[] = [];
const laneIds: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commitAll(cwd: string, message: string): string {
  git(cwd, ['add', '-A']);
  git(cwd, ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

function makeRepo(name: string) {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const clone = join(root, 'clone');
  tempDirs.push(root);

  execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
  execFileSync('git', ['clone', origin, seed], { stdio: 'pipe' });
  git(seed, ['checkout', '-b', 'main']);
  writeFileSync(join(seed, 'README.md'), 'base\n');
  commitAll(seed, 'base');
  git(seed, ['push', '-u', 'origin', 'main']);

  execFileSync('git', ['clone', origin, clone], { stdio: 'pipe' });
  git(clone, ['checkout', '-b', 'main', 'origin/main']);
  git(clone, ['checkout', '-b', 'packet']);

  return { seed, clone };
}

function packetFixture(repoPath: string, packetId: string, laneId: string): OrchestratorPacket {
  return {
    id: packetId,
    referenceLabel: packetId,
    title: packetId,
    summary: packetId,
    workspaceTargetPath: repoPath,
    branchTarget: 'packet',
    runtime: 'codex',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'held',
    releaseState: 'pending',
    status: 'running',
    blockedReason: null,
    lastEventAt: null,
    lastEventLabel: null,
    archivedAt: null,
    review: null,
    lane: {
      tileId: laneId,
      tabId: laneId,
      repoPath,
      worktreePath: repoPath,
      runtime: 'codex',
      laneId,
      sessionKey: `codex-owned:${laneId}`,
    } satisfies OrchestratorLaneBinding,
  };
}

function seedPacket(repoPath: string, packetId: string, status: OrchestratorPacket['status'] = 'running') {
  const lane = createLane({
    repoPath,
    worktreePath: repoPath,
    branch: 'packet',
    baseBranch: 'main',
    runtime: 'codex',
    packetId,
  });
  laneIds.push(lane.id);
  writeOrchestratorControlPlaneState({
    ...createEmptyOrchestratorMissionState(),
    missionId: `mission-${packetId}`,
    repoPath,
    packets: [packetFixture(repoPath, packetId, lane.id)].map((packet) => ({ ...packet, status })),
  });
  return lane;
}

function inboxItem(id: string) {
  return listInboxItems({ includeAllProjects: true, includeDismissed: true })
    .find((item) => item.id === id);
}

function ageInboxItem(id: string, createdAt: string) {
  getSqlite().prepare(`
    UPDATE supervisor_inbox
    SET created_at = ?, last_seen_at = ?
    WHERE id = ?
  `).run(createdAt, createdAt, id);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
  while (laneIds.length > 0) {
    deleteLane(laneIds.pop()!);
  }
  writeOrchestratorControlPlaneState(createEmptyOrchestratorMissionState());
});

describe('runLivenessProbeSweep', () => {
  it('resolves merge_blocked with sha evidence when the branch head is merged', async () => {
    const { clone, seed } = makeRepo('o8-liveness-merged');
    writeFileSync(join(clone, 'packet.txt'), 'packet\n');
    commitAll(clone, 'packet work');
    git(clone, ['push', 'origin', 'packet']);
    git(seed, ['fetch', 'origin', 'packet', '--quiet']);
    git(seed, ['merge', '--ff-only', 'origin/packet']);
    const mergedSha = git(seed, ['rev-parse', 'HEAD']);
    git(seed, ['push', 'origin', 'main']);
    git(clone, ['fetch', 'origin', 'main', '--quiet']);

    const lane = seedPacket(clone, 'pkt-merge-blocked-resolves');
    const item = enqueueInboxItem({
      repoPath: clone,
      packetId: 'pkt-merge-blocked-resolves',
      kind: 'merge_blocked',
      payload: { laneId: lane.id, baseBranch: 'main', error: 'Merge blocked.' },
    });

    await expect(runLivenessProbeSweep({ now: new Date('2026-07-09T12:00:00.000Z') }))
      .resolves.toMatchObject({ resolved: 1 });

    const resolved = inboxItem(item.id);
    expect(resolved?.status).toBe('resolved');
    expect(resolved?.payload.autoResolutionNote).toContain(`merged at ${mergedSha}`);
    expect(resolved?.payload.autoResolution).toMatchObject({
      probeKind: 'merge_blocked_ancestry',
      evidence: {
        mergeCommit: mergedSha,
        ahead: 0,
      },
    });
  }, 20_000);

  it('leaves merge_blocked active when the branch head is not merged', async () => {
    const { clone } = makeRepo('o8-liveness-unmerged');
    writeFileSync(join(clone, 'packet.txt'), 'packet\n');
    commitAll(clone, 'packet work');
    const lane = seedPacket(clone, 'pkt-merge-blocked-stays');
    const item = enqueueInboxItem({
      repoPath: clone,
      packetId: 'pkt-merge-blocked-stays',
      kind: 'merge_blocked',
      payload: { laneId: lane.id, baseBranch: 'main', error: 'Merge blocked.' },
    });

    await expect(runLivenessProbeSweep({ now: new Date('2026-07-09T12:00:00.000Z') }))
      .resolves.toMatchObject({ resolved: 0 });

    const active = inboxItem(item.id);
    expect(active?.status).toBe('human_required');
    expect(active?.payload.autoResolution).toBeUndefined();
  }, 20_000);

  it('expires packet_missing only after the 7-day packet-gone TTL', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'o8-liveness-packet-missing-'));
    tempDirs.push(repoPath);
    writeOrchestratorControlPlaneState(createEmptyOrchestratorMissionState());
    const recent = enqueueInboxItem({
      repoPath,
      packetId: 'pkt-missing-recent',
      kind: 'packet_missing',
      payload: { error: 'Packet missing.' },
    });
    const expired = enqueueInboxItem({
      repoPath,
      packetId: 'pkt-missing-expired',
      kind: 'packet_missing',
      payload: { error: 'Packet missing.' },
    });
    ageInboxItem(recent.id, '2026-07-03T12:00:01.000Z');
    ageInboxItem(expired.id, '2026-07-02T12:00:00.000Z');

    await expect(runLivenessProbeSweep({ now: new Date('2026-07-09T12:00:00.000Z') }))
      .resolves.toMatchObject({ resolved: 1 });

    expect(inboxItem(recent.id)?.status).toBe('human_required');
    const expiredItem = inboxItem(expired.id);
    expect(expiredItem?.status).toBe('resolved');
    expect(expiredItem?.payload.autoResolutionNote).toContain('expired after 7 days');
    expect(expiredItem?.payload.autoResolution).toMatchObject({
      probeKind: 'packet_gone_ttl',
      terminalState: 'expired',
    });
  });

  it('leaves bounded_retry_exhausted active when the latest lane has not merged', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'o8-liveness-bounded-retry-'));
    tempDirs.push(repoPath);
    const lane = seedPacket(repoPath, 'pkt-bounded-retry-stays');
    setLaneStatus(lane.id, 'running', 'system', 'still_running');
    const item = enqueueInboxItem({
      repoPath,
      packetId: 'pkt-bounded-retry-stays',
      kind: 'bounded_retry_exhausted',
      payload: { laneId: lane.id, error: 'Retry budget exhausted.' },
    });

    await expect(runLivenessProbeSweep({ now: new Date('2026-07-09T12:00:00.000Z') }))
      .resolves.toMatchObject({ resolved: 0 });

    expect(inboxItem(item.id)?.status).toBe('human_required');
    expect(inboxItem(item.id)?.payload.autoResolution).toBeUndefined();
  });
});

describe('subject-gone TTL fallthrough', () => {
  it('expires a merge_blocked card whose packet left the control plane after 7 days, with evidence', async () => {
    const { runLivenessProbeSweep } = await import('./liveness-probes');
    const { enqueueInboxItem, listInboxItems } = await import('./inbox');
    const item = enqueueInboxItem({
      repoPath: '/tmp/o8-liveness-subject-gone',
      packetId: 'pkt-subject-gone-ttl',
      kind: 'merge_blocked',
      payload: { stage: 'pre_launch_rebase', branch: 'inline/gone-branch', baseBranch: 'main' },
      status: 'human_required',
    });
    const eightDays = new Date(Date.now() + 8 * 24 * 60 * 60_000);
    const result = await runLivenessProbeSweep({ now: eightDays });
    expect(result.resolved).toBeGreaterThanOrEqual(1);
    const after = listInboxItems({ includeDismissed: true, includeAllProjects: true }).find((row) => row.id === item.id);
    expect(after?.status).not.toBe('human_required');
    expect(JSON.stringify(after?.payload ?? {})).toContain('subject_gone_ttl');
  });

  it('keeps a young subject-gone card human_required (under TTL)', async () => {
    const { runLivenessProbeSweep } = await import('./liveness-probes');
    const { enqueueInboxItem, listInboxItems } = await import('./inbox');
    const item = enqueueInboxItem({
      repoPath: '/tmp/o8-liveness-subject-gone-young',
      packetId: 'pkt-subject-gone-young',
      kind: 'session_lost',
      payload: {},
      status: 'human_required',
    });
    const result = await runLivenessProbeSweep({ now: new Date() });
    void result;
    const after = listInboxItems({ includeAllProjects: true }).find((row) => row.id === item.id);
    expect(after?.status).toBe('human_required');
  });
});

describe('the timed sweep', () => {
  it('probes again only when an open incident, its packet or lane changes, or an expiry falls due', async () => {
    const start = Date.parse('2026-09-01T12:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(start);
    try {
      getSqlite().prepare('DELETE FROM supervisor_inbox').run();
      const repoPath = mkdtempSync(join(tmpdir(), 'o8-liveness-timed-'));
      tempDirs.push(repoPath);
      const lane = seedPacket(repoPath, 'pkt-timed');
      setLaneStatus(lane.id, 'running', 'system', 'still_running');
      const retry = enqueueInboxItem({ repoPath, packetId: 'pkt-timed', kind: 'bounded_retry_exhausted',
        payload: { laneId: lane.id, error: 'Retry budget exhausted.' } });
      const gone = enqueueInboxItem({ repoPath, packetId: 'pkt-timed-gone', kind: 'session_lost', payload: {}, status: 'human_required' });
      ageInboxItem(gone.id, new Date(start - 7 * 24 * 60 * 60_000 + 60 * 60_000).toISOString());

      await expect(runLivenessProbeSweep()).resolves.toMatchObject({ scanned: 2, resolved: 0 });
      // Nothing the probes read changed: they do not run.
      await expect(runLivenessProbeSweep()).resolves.toMatchObject({ scanned: 0 });

      // The lane completes: the next sweep probes and clears the card.
      setLaneStatus(lane.id, 'completed', 'system', 'merged');
      await expect(runLivenessProbeSweep()).resolves.toMatchObject({ resolved: 1 });
      expect(inboxItem(retry.id)?.status).not.toBe('human_required');
      await expect(runLivenessProbeSweep()).resolves.toMatchObject({ scanned: 1, resolved: 0 });
      await expect(runLivenessProbeSweep()).resolves.toMatchObject({ scanned: 0 });

      // The packet-gone card reaches its 7-day expiry with no other change.
      vi.setSystemTime(start + 61 * 60_000);
      await expect(runLivenessProbeSweep()).resolves.toMatchObject({ resolved: 1 });
      expect(inboxItem(gone.id)?.status).not.toBe('human_required');
    } finally {
      vi.useRealTimers();
    }
  });
});
