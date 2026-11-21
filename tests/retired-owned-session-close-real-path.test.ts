import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { ParsedRunLog } from '@/lib/runtimes/shared/owned-session/types';

const ensureDispatchBackendReady = vi.hoisted(() => vi.fn(async () => ({
  ready: true,
  reason: 'http_200',
  waitedMs: 0,
  attempts: 1,
  lastCheck: {
    ready: true,
    reason: 'http_200',
    apiBase: 'http://o8.test',
    status: 200,
    portSource: 'file',
    apiPortFilePresent: true,
  },
})));

vi.mock('@/lib/runtimes/shared/dispatch-readiness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtimes/shared/dispatch-readiness')>();
  return { ...actual, ensureDispatchBackendReady };
});

vi.mock('@/lib/receipts/packet-receipt', () => ({
  createPacketReceiptForClosedPacket: async () => {},
}));

// This test drives the terminal cleanup seam explicitly so its assertions can
// observe the partial state before the background scheduler races ahead.
vi.mock('@/lib/lane/terminal-lane-cleanup', () => ({
  scheduleTerminalLaneCleanup: vi.fn(),
}));

const root = mkdtempSync(join(os.tmpdir(), 'o8-retired-session-close-'));
const dataDir = join(root, 'data');
const ownedRoot = join(dataDir, 'owned-codex');
const operatorToken = 'operator-retired-session-close-0123456789';
const originalEnv = {
  dataDir: process.env.CORTEX_IDE_DATA_DIR,
  o8DataDir: process.env.O8_DATA_DIR,
  ownedRoot: process.env.CORTEX_IDE_OWNED_CODEX_ROOT,
  binary: process.env.O8_TEST_RETIRED_SESSION_BIN,
};

process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_OWNED_CODEX_ROOT = ownedRoot;
process.env.O8_TEST_RETIRED_SESSION_BIN = process.execPath;
mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, 'ws-token'), `${operatorToken}\n`, 'utf8');

await import('@/lib/runtimes');

const [{ createOwnedSessionStore }, closeRoute, laneRoute] = await Promise.all([
  import('@/lib/runtimes/shared/owned-session/store'),
  import('@/app/api/orchestrator/discard-packet/route'),
  import('@/app/api/lanes/route'),
]);
const { closeDb } = await import('@/lib/db');
const {
  attachSession,
  createLane,
  getLane,
  getLaneEvents,
  setLaneStatus,
  updateLane,
} = await import('@/lib/lane/registry');
const {
  readOrchestratorControlPlaneState,
  writeOrchestratorControlPlaneState,
} = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');

const store = createOwnedSessionStore({
  runtimeId: 'codex',
  surfaceIdPrefix: 'codex-owned:',
  rootEnvVar: 'CORTEX_IDE_OWNED_CODEX_ROOT',
  rootDefault: ownedRoot,
  binaryName: 'node',
  binaryEnvOverride: 'O8_TEST_RETIRED_SESSION_BIN',
  humanLabel: 'Owned close fixture',
  squadShortName: 'CloseFixture',
  sessionIdPrefix: 'codex-owned-close-fixture-',
  // A launch may append run notes to the prompt (the verified o8 command note
  // since #4800), so the fixture keys on how the prompt starts.
  launchArgs: ({ prompt }) => ['-e', prompt.startsWith('wait-for-stop')
    ? 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000);'
    : 'process.stdout.write("done\\n");'],
  resumeArgs: () => null,
  parseRunLog: (raw): ParsedRunLog => ({
    entries: [],
    outcome: raw.includes('done') ? 'finished' : 'running',
    completedTurn: raw.includes('done'),
  }),
}, {
  workspaceSpawnGuard: async () => ({ status: 'available', source: 'no-snapshot' }),
});

const fixtureRoots: string[] = [];

function restoreEnv(name: keyof typeof originalEnv, envName: string): void {
  const value = originalEnv[name];
  if (value === undefined) delete process.env[envName];
  else process.env[envName] = value;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function operatorRequest(pathname: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost:3001${pathname}`, {
    method: 'POST',
    headers: {
      host: 'localhost:3001',
      authorization: `Bearer ${operatorToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function waitForEvent(laneId: string, verb: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (getLaneEvents(laneId, 200).some((event) => event.verb === verb)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${verb} on ${laneId}.`);
}

async function createFixture(label: string, prompt: 'wait-for-stop' | 'exit-clean') {
  const fixtureRoot = mkdtempSync(join(dataDir, `${label}-`));
  fixtureRoots.push(fixtureRoot);
  const repoPath = join(fixtureRoot, 'repo');
  const worktreePath = join(fixtureRoot, 'worktree');
  const branch = `issue/${label}`;
  const packetId = `pkt-${label}`;
  git(fixtureRoot, ['init', '--initial-branch=main', repoPath]);
  git(repoPath, ['config', 'user.name', 'o8-test']);
  git(repoPath, ['config', 'user.email', 'o8@example.test']);
  writeFileSync(join(repoPath, 'base.txt'), 'base\n', 'utf8');
  git(repoPath, ['add', 'base.txt']);
  git(repoPath, ['commit', '-m', 'base']);
  git(repoPath, ['worktree', 'add', '-b', branch, worktreePath]);

  const lane = createLane({
    repoPath,
    worktreePath,
    branch,
    baseBranch: 'main',
    runtime: 'codex',
    packetId,
    label,
  });
  const launched = await store.launch({
    cwd: worktreePath,
    prompt,
    laneId: lane.id,
    packetId,
  });
  expect(launched.ok, launched.note).toBe(true);
  attachSession(lane.id, launched.surfaceId, 'system');
  setLaneStatus(lane.id, 'running', 'system', 'session_launched');
  const now = new Date().toISOString();
  writeOrchestratorControlPlaneState({
    ...createEmptyOrchestratorMissionState(),
    missionId: `mission-${label}`,
    repoPath,
    runtime: 'codex',
    packets: [{
      id: packetId,
      referenceLabel: '#2984',
      title: label,
      summary: label,
      workspaceTargetPath: repoPath,
      branchTarget: branch,
      runtime: 'codex',
      dependencyLabels: [],
      dependencyPacketIds: [],
      queueState: 'queued',
      releaseState: 'pending',
      status: 'running',
      operatorStopped: false,
      blockedReason: null,
      lane: {
        tileId: lane.id,
        tabId: lane.id,
        repoPath,
        worktreePath,
        runtime: 'codex',
        laneId: lane.id,
        sessionKey: launched.surfaceId,
      },
      review: null,
      lastEventAt: now,
      lastEventLabel: 'session_launched',
    } as OrchestratorPacket],
    updatedAt: now,
  });
  return { branch, lane, packetId, repoPath, surfaceId: launched.surfaceId, worktreePath };
}

async function stopThroughLaneRoute(fixture: Awaited<ReturnType<typeof createFixture>>): Promise<void> {
  const response = await laneRoute.POST(operatorRequest('/api/lanes', {
    verb: 'stop',
    laneId: fixture.lane.id,
  }));
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ ok: true });
  await waitForEvent(fixture.lane.id, 'runtime_process_exit');
  expect(getLaneEvents(fixture.lane.id, 200).filter((event) => (
    event.verb === 'kill_escalated' && event.payload.confirmed === true
  ))).toHaveLength(1);
}

function commitResult(fixture: Awaited<ReturnType<typeof createFixture>>): string {
  writeFileSync(join(fixture.worktreePath, 'result.txt'), `${fixture.packetId}\n`, 'utf8');
  git(fixture.worktreePath, ['add', 'result.txt']);
  git(fixture.worktreePath, ['commit', '-m', 'test result']);
  return git(fixture.worktreePath, ['rev-parse', 'HEAD']);
}

async function archiveLaneAndSession(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  removeWorktree: boolean,
): Promise<string> {
  const archived = await store.archiveSession(fixture.surfaceId);
  expect(archived.archived, archived.note).toBe(true);
  expect(archived.archivePath).toBeTruthy();
  setLaneStatus(fixture.lane.id, 'archived', 'system', 'closed_unmerged');
  const state = readOrchestratorControlPlaneState();
  const packet = state.packets.find((candidate) => candidate.id === fixture.packetId);
  if (!packet) throw new Error(`Missing packet ${fixture.packetId}.`);
  packet.status = 'blocked';
  packet.queueState = 'held';
  packet.operatorStopped = true;
  packet.blockedReason = 'operator_stopped';
  writeOrchestratorControlPlaneState({ ...state, updatedAt: new Date().toISOString() });
  if (removeWorktree) {
    // Simulate an externally removed workspace. This is fixture setup, not
    // proof of supported retirement after owned-session authority is archived.
    git(fixture.repoPath, ['worktree', 'remove', '--force', fixture.worktreePath]);
    expect(existsSync(fixture.worktreePath)).toBe(false);
  }
  updateLane(fixture.lane.id, {
    sessionKey: null,
    ...(removeWorktree ? { worktreePath: null } : {}),
  }, 'system', { phase: 'terminal_cleanup' });
  return archived.archivePath!;
}

async function closePacket(packetId: string, acknowledgeMissingWorktree = false) {
  return closeRoute.POST(operatorRequest('/api/orchestrator/discard-packet', {
    packetId,
    disposition: 'wontfix',
    acknowledgeMissingWorktree,
    clientMutationId: `close-${packetId}`,
  }));
}

afterAll(() => {
  closeDb();
  for (const fixtureRoot of fixtureRoots) rmSync(fixtureRoot, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  restoreEnv('dataDir', 'CORTEX_IDE_DATA_DIR');
  restoreEnv('o8DataDir', 'O8_DATA_DIR');
  restoreEnv('ownedRoot', 'CORTEX_IDE_OWNED_CODEX_ROOT');
  restoreEnv('binary', 'O8_TEST_RETIRED_SESSION_BIN');
});

describe('discard packet after an owned session already retired', () => {
  it('retains a present workspace when its exact owned-session authority was already archived', async () => {
    const fixture = await createFixture('first-clean-close', 'wait-for-stop');
    await stopThroughLaneRoute(fixture);
    const preservedSha = commitResult(fixture);
    const archived = await store.archiveSession(fixture.surfaceId);
    expect(archived.archived, archived.note).toBe(true);
    expect(archived.archivePath).toBeTruthy();
    expect(getLane(fixture.lane.id)).toMatchObject({
      status: 'paused',
      sessionKey: fixture.surfaceId,
      worktreePath: fixture.worktreePath,
    });
    const eventsBeforeClose = getLaneEvents(fixture.lane.id, 200);
    const killCount = eventsBeforeClose.filter((event) => event.verb === 'kill_escalated').length;
    const detachCount = eventsBeforeClose.filter((event) => event.verb === 'detach_session').length;

    const response = await closePacket(fixture.packetId);
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toMatchObject({ ok: false, error: { code: 'close_failed' } });
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      id: fixture.packetId,
      status: 'blocked',
      blockedReason: 'worktree_cleanup_failed',
      lane: { laneId: fixture.lane.id, sessionKey: fixture.surfaceId },
    });
    const preservedRef = git(fixture.repoPath, [
      'for-each-ref',
      '--format=%(refname:short)',
      `refs/heads/preserved/packet-${fixture.packetId}-*`,
    ]);
    expect(preservedRef).toMatch(/^preserved\//);
    expect(git(fixture.repoPath, ['rev-parse', preservedRef])).toBe(preservedSha);
    expect(existsSync(fixture.worktreePath)).toBe(true);
    expect(readFileSync(join(fixture.worktreePath, 'result.txt'), 'utf8')).toBe(`${fixture.packetId}\n`);
    expect(getLane(fixture.lane.id)?.worktreePath).toBe(fixture.worktreePath);
    const eventsAfterClose = getLaneEvents(fixture.lane.id, 200);
    expect(eventsAfterClose.filter((event) => event.verb === 'kill_escalated')).toHaveLength(killCount);
    expect(eventsAfterClose.filter((event) => event.verb === 'detach_session')).toHaveLength(detachCount);
    expect(JSON.parse(readFileSync(join(archived.archivePath!, 'session.json'), 'utf8')))
      .not.toHaveProperty('detachedAt');
  }, 20_000);

  it('closes a stale packet binding without signaling or detaching the retired session again', async () => {
    const fixture = await createFixture('retired-binding', 'wait-for-stop');
    await stopThroughLaneRoute(fixture);
    const preservedSha = commitResult(fixture);
    const archivePath = await archiveLaneAndSession(fixture, true);
    const eventsBeforeClose = getLaneEvents(fixture.lane.id, 200);
    const killIndex = eventsBeforeClose.findIndex((event) => event.verb === 'kill_escalated');
    const exitIndex = eventsBeforeClose.findIndex((event) => event.verb === 'runtime_process_exit');
    expect(killIndex).toBeGreaterThanOrEqual(0);
    expect(exitIndex).toBeGreaterThan(killIndex);
    const archivedSession = JSON.parse(readFileSync(join(archivePath, 'session.json'), 'utf8')) as {
      recentRuns?: Array<{ id?: string }>;
    };
    expect(eventsBeforeClose[exitIndex]?.payload.runId).toBe(archivedSession.recentRuns?.[0]?.id);
    const killCount = eventsBeforeClose
      .filter((event) => event.verb === 'kill_escalated').length;

    const response = await closePacket(fixture.packetId, true);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      result: {
        closed: true,
        packetId: fixture.packetId,
        worktreeCleanup: 'missing',
      },
    });
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      id: fixture.packetId,
      status: 'archived',
      lane: null,
    });
    const preservedRef = git(fixture.repoPath, [
      'for-each-ref',
      '--format=%(refname:short)',
      `refs/heads/preserved/packet-${fixture.packetId}-*`,
    ]);
    expect(preservedRef).toMatch(/^preserved\//);
    expect(git(fixture.repoPath, ['rev-parse', preservedRef])).toBe(preservedSha);
    expect(getLane(fixture.lane.id)).toMatchObject({
      status: 'archived',
      sessionKey: null,
      worktreePath: null,
    });
    expect(getLaneEvents(fixture.lane.id, 200)
      .filter((event) => event.verb === 'kill_escalated')).toHaveLength(killCount);
    expect(JSON.parse(readFileSync(join(archivePath, 'session.json'), 'utf8')))
      .not.toHaveProperty('detachedAt');
  }, 20_000);

  it('holds the packet when its archived session has no confirmed kill receipt', async () => {
    const fixture = await createFixture('missing-kill', 'exit-clean');
    await waitForEvent(fixture.lane.id, 'runtime_process_exit');
    expect(getLaneEvents(fixture.lane.id, 200)
      .filter((event) => event.verb === 'kill_escalated')).toEqual([]);
    commitResult(fixture);
    const archivePath = await archiveLaneAndSession(fixture, false);

    const response = await closePacket(fixture.packetId);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'session_archive_unconfirmed' },
    });
    expect(existsSync(fixture.worktreePath)).toBe(true);
    expect(existsSync(archivePath)).toBe(true);
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      status: 'blocked',
      queueState: 'held',
      blockedReason: 'session_archive_unconfirmed',
      lane: { laneId: fixture.lane.id, sessionKey: fixture.surfaceId },
    });
  }, 20_000);

  it('holds the packet when a later attach invalidates the retired-run receipts', async () => {
    const fixture = await createFixture('later-attach', 'wait-for-stop');
    await stopThroughLaneRoute(fixture);
    commitResult(fixture);
    const archivePath = await archiveLaneAndSession(fixture, false);
    attachSession(fixture.lane.id, fixture.surfaceId, 'system');

    const response = await closePacket(fixture.packetId);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'session_archive_unconfirmed' },
    });
    expect(existsSync(fixture.worktreePath)).toBe(true);
    expect(existsSync(archivePath)).toBe(true);
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      status: 'blocked',
      queueState: 'held',
      blockedReason: 'session_archive_unconfirmed',
      lane: { laneId: fixture.lane.id, sessionKey: fixture.surfaceId },
    });
  }, 20_000);

  it('archives a packet that never launched with the operator disposition', async () => {
    const packetId = 'pkt-never-launched';
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-never-launched',
      repoPath: root,
      packets: [{
        id: packetId, referenceLabel: '#9001', title: 'never launched', summary: '',
        workspaceTargetPath: root, branchTarget: 'main', runtime: 'codex',
        dependencyLabels: [], dependencyPacketIds: [],
        queueState: 'queued', releaseState: 'pending', status: 'queued', blockedReason: null, lane: null,
      } as OrchestratorPacket],
      updatedAt: new Date().toISOString(),
    });

    const response = await closeRoute.POST(operatorRequest('/api/orchestrator/discard-packet', {
      packetId, disposition: 'superseded', note: 'Replaced by a newer plan.', clientMutationId: `close-${packetId}`,
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true, result: { closed: true, disposition: 'superseded', laneId: null, worktreeRemoved: false },
    });
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      status: 'archived', queueState: 'held', operatorStopped: true, lastEventLabel: 'closed_unmerged',
      completionSummary: expect.stringContaining('Replaced by a newer plan.'),
    });
  }, 20_000);

  it('closes a held packet whose session was archived long ago and whose lane record is gone', async () => {
    const fixture = await createFixture('long-gone-session', 'exit-clean');
    let archived = await store.archiveSession(fixture.surfaceId);
    for (let attempt = 0; !archived.archived && attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      archived = await store.archiveSession(fixture.surfaceId);
    }
    expect(archived.archived, archived.note).toBe(true);
    // The worktree was removed and the lane row is gone; only the packet's own binding remains.
    git(fixture.repoPath, ['worktree', 'remove', '--force', fixture.worktreePath]);
    const { getSqlite } = await import('@/lib/db');
    getSqlite().prepare('DELETE FROM lane_events WHERE lane_id = ?').run(fixture.lane.id);
    getSqlite().prepare('DELETE FROM lanes WHERE id = ?').run(fixture.lane.id);
    const state = readOrchestratorControlPlaneState();
    Object.assign(state.packets[0]!, {
      status: 'blocked', queueState: 'held', blockedReason: 'session_archive_unconfirmed', lastEventLabel: 'agent_completed',
    });
    writeOrchestratorControlPlaneState(state);

    const response = await closePacket(fixture.packetId, true);
    const payload = await response.json();

    expect(response.status, JSON.stringify(payload)).toBe(200);
    expect(payload).toMatchObject({ ok: true, result: { closed: true } });
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({ status: 'archived', queueState: 'held' });
    // The archived session stays where it was.
    expect(existsSync(archived.archivePath!)).toBe(true);
  }, 30_000);
});
