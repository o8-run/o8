import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { createManagedOpenCodeWorktree } from './helpers/managed-opencode-worktree';
import { createOpenCodeServiceFixture } from './helpers/opencode-service-fixture';

const realDataDir = mkdtempSync(join(os.tmpdir(), 'o8-close-unmerged-'));
// Reached through a symlink, as /tmp is on macOS, so a path-spelling mismatch fails on every platform.
const dataDir = `${realDataDir}-link`;
symlinkSync(realDataDir, dataDir);
const wsToken = 'operator-close-unmerged-token-0123456789';
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
const ownedRoot = join(dataDir, 'owned-opencode');
process.env.O8_OWNED_OPENCODE_ROOT = ownedRoot;
writeFileSync(join(dataDir, 'ws-token'), `${wsToken}\n`, 'utf-8');

const closeRoute = await import('@/app/api/orchestrator/discard-packet/route');
const { getDb, getSqlite, closeDb } = await import('@/lib/db');
const { sessionOutcomes } = await import('@/lib/db/schema');
const { createLane, getLane, getLaneEvents, setLaneStatus } = await import('@/lib/lane/registry');
const { startReviewTurn } = await import('@/lib/lane/review-turn-state');
const { recordMission } = await import('@/lib/db/missions-store');
const { readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { listInboxItems } = await import('@/lib/supervisor/inbox');

afterAll(() => {
  closeDb();
  rmSync(dataDir, { force: true });
  rmSync(realDataDir, { recursive: true, force: true });
});

function operatorRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost:3001/api/orchestrator/discard-packet', {
    method: 'POST',
    headers: {
      host: 'localhost:3001',
      authorization: `Bearer ${wsToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ clientMutationId: `close-test-${randomUUID()}`, ...body }),
  });
}

function persistOpenCodeClosePacket(input: {
  packetId: string;
  repoPath: string;
  worktreePath: string;
  branch: string;
  sessionKey: string;
}) {
  const lane = createLane({
    repoPath: input.repoPath,
    worktreePath: input.worktreePath,
    branch: input.branch,
    baseBranch: 'main',
    runtime: 'opencode',
    label: 'OpenCode service cleanup',
    packetId: input.packetId,
    sessionKey: input.sessionKey,
    ownership: 'managed',
  });
  setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
  writeOrchestratorControlPlaneState({
    ...createEmptyOrchestratorMissionState(),
    missionId: `mission-${input.packetId}`,
    repoPath: input.repoPath,
    runtime: 'opencode',
    packets: [{
      id: input.packetId,
      referenceLabel: '#1799',
      title: 'Release OpenCode workspace before close',
      summary: 'The completed worker no longer owns its worktree.',
      workspaceTargetPath: input.repoPath,
      branchTarget: input.branch,
      runtime: 'opencode',
      dependencyLabels: [],
      dependencyPacketIds: [],
      queueState: 'held',
      releaseState: 'pending',
      status: 'awaiting_review',
      blockedReason: null,
      lane: {
        tileId: lane.id,
        tabId: lane.id,
        repoPath: input.repoPath,
        worktreePath: input.worktreePath,
        runtime: 'opencode',
        laneId: lane.id,
      },
      review: null,
    } as OrchestratorPacket],
    updatedAt: new Date().toISOString(),
  });
  return lane;
}

describe('close_packet_unmerged real path (#1570)', () => {
  it('archives an awaiting-review packet and stops its dangling terminal-attempt review turn', async () => {
    const packetId = 'pkt-close-unmerged-real-path';
    const repoPath = join(dataDir, 'repo');
    const lane = createLane({
      repoPath,
      branch: 'issue/close-unmerged',
      baseBranch: 'main',
      runtime: 'codex',
      label: 'Close unmerged real path',
      packetId,
    });
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');

    const packet = {
      id: packetId,
      referenceLabel: '#1570',
      title: 'Close packet unmerged',
      summary: 'This work moved to another repository.',
      workspaceTargetPath: repoPath,
      branchTarget: 'main',
      runtime: 'codex',
      dependencyLabels: [],
      dependencyPacketIds: [],
      queueState: 'held',
      releaseState: 'pending',
      status: 'awaiting_review',
      blockedReason: null,
      lane: {
        tileId: lane.id,
        tabId: lane.id,
        repoPath,
        runtime: 'codex',
        laneId: lane.id,
      },
      review: null,
    } as OrchestratorPacket;
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-close-unmerged-real-path',
      repoPath,
      runtime: 'codex',
      packets: [packet],
      updatedAt: new Date().toISOString(),
    });

    const db = getDb();
    expect(db).not.toBeNull();
    const reviewId = 'review-close-terminal-attempt';
    const reviewedHeadSha = 'a'.repeat(40);
    getSqlite().prepare(
      `INSERT INTO review_queue (
         id, lane_id, repo_path, status, attempts, head_sha, created_at, updated_at
       ) VALUES (?, ?, ?, 'completed', 0, ?, datetime('now'), datetime('now'))`,
    ).run(reviewId, lane.id, repoPath, reviewedHeadSha);
    const reviewTurnId = startReviewTurn({
      laneId: lane.id,
      threadId: `auto-review-${lane.id}-${reviewId}`,
      backend: 'codex',
      surface: 'auto-review',
      expectedHeadSha: reviewedHeadSha,
    });

    const response = await closeRoute.POST(operatorRequest({
      packetId,
      disposition: 'adopted_elsewhere',
      note: 'Implemented in o8-mobile.',
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      result: {
        closed: true,
        disposition: 'adopted_elsewhere',
        packetId,
        stoppedReviewTurns: 1,
      },
    });
    expect(getLaneEvents(lane.id, 100).find((event) => (
      event.verb === 'review_turn_stopped'
      && event.payload.reviewTurnId === reviewTurnId
    ))).toMatchObject({
      payload: {
        reason: 'packet_discarded',
        abortRequested: false,
      },
    });

    expect(getLane(lane.id)).toMatchObject({
      status: 'archived',
      outcome: 'closed_unmerged',
      outcomeNote: expect.stringContaining('Adopted elsewhere'),
    });
    const persistedPacket = readOrchestratorControlPlaneState().packets.find((candidate) => candidate.id === packetId);
    expect(persistedPacket).toMatchObject({
      status: 'archived',
      queueState: 'held',
      lastEventLabel: 'closed_unmerged',
    });
    expect(persistedPacket?.archivedAt).toEqual(expect.any(String));

    const outcome = await db!
      .select({
        outcome: sessionOutcomes.outcome,
        summary: sessionOutcomes.summary,
        mergedClean: sessionOutcomes.mergedClean,
      })
      .from(sessionOutcomes)
      .where(eq(sessionOutcomes.packetId, packetId))
      .get();
    expect(outcome).toEqual({
      outcome: 'adopted_elsewhere',
      summary: expect.stringContaining('Implemented in o8-mobile.'),
      mergedClean: false,
    });
    expect(listInboxItems({ includeAllProjects: true, includeDismissed: true }).filter((item) => (
      item.packetId === packetId && item.kind === 'packet_no_changes'
    ))).toEqual([]);
  });

  it('persists closure in the non-current mission registry row that owns the packet', async () => {
    const packetId = 'pkt-close-unmerged-registry';
    const missionId = 'mission-close-unmerged-registry';
    const repoPath = join(dataDir, 'repo-registry');
    const lane = createLane({
      repoPath,
      branch: 'issue/close-unmerged-registry',
      baseBranch: 'main',
      runtime: 'codex',
      label: 'Close registry packet',
      packetId,
    });
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
    const packet = {
      id: packetId,
      referenceLabel: '#registry-close',
      title: 'Close a non-current packet',
      summary: 'Durable registry state must follow lane retirement.',
      workspaceTargetPath: repoPath,
      branchTarget: 'main',
      runtime: 'codex',
      dependencyLabels: [],
      dependencyPacketIds: [],
      queueState: 'held',
      releaseState: 'pending',
      status: 'awaiting_review',
      blockedReason: null,
      lane: {
        tileId: lane.id,
        tabId: lane.id,
        repoPath,
        runtime: 'codex',
        laneId: lane.id,
      },
      review: null,
    } as OrchestratorPacket;
    const missionState = {
      ...createEmptyOrchestratorMissionState(),
      missionId,
      repoPath,
      runtime: 'codex' as const,
      packets: [packet],
      updatedAt: new Date().toISOString(),
    };
    recordMission({
      id: missionId,
      repoPath,
      runtime: 'codex',
      prompt: 'Close registry packet',
      summary: missionState.summary,
      constraints: '',
      packetMeta: [{ id: packetId, title: packet.title, referenceLabel: packet.referenceLabel }],
      missionState,
      totalWaves: 1,
    });
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'different-current-close-mission',
    });

    const response = await closeRoute.POST(operatorRequest({
      packetId,
      disposition: 'wontfix',
      note: 'No longer needed.',
    }));

    expect(response.status).toBe(200);
    expect(getLane(lane.id)?.status).toBe('archived');
    expect(readMissionRegistryEntry(missionId, { includeArchived: true })?.mission.packets[0]).toMatchObject({
      id: packetId,
      status: 'archived',
      queueState: 'held',
      archivedAt: expect.any(String),
      lastEventLabel: 'closed_unmerged',
    });
    expect(readOrchestratorControlPlaneState().missionId).toBe('different-current-close-mission');
  });

  it('closes with a durable warning when process death cannot be confirmed', async () => {
    const packetId = 'pkt-close-unmerged-live-worker';
    const repoPath = join(dataDir, 'repo-live-worker');
    const lane = createLane({
      repoPath,
      branch: 'issue/close-unmerged-live-worker',
      baseBranch: 'main',
      runtime: 'codex',
      label: 'Close unmerged live worker guard',
      packetId,
      sessionKey: 'codex:unverified-live-worker',
    });
    setLaneStatus(lane.id, 'paused', 'system', 'interrupt_requested');
    const packet = {
      id: packetId,
      referenceLabel: '#live-worker',
      title: 'Record unconfirmed worker closure',
      summary: 'Close must preserve the uncertainty.',
      workspaceTargetPath: repoPath,
      branchTarget: lane.branch,
      runtime: 'codex',
      dependencyLabels: [],
      dependencyPacketIds: [],
      queueState: 'held',
      releaseState: 'pending',
      status: 'blocked',
      blockedReason: 'operator_stopped',
      lane: {
        tileId: lane.id,
        tabId: lane.id,
        repoPath,
        runtime: 'codex',
        laneId: lane.id,
        sessionKey: lane.sessionKey,
      },
      review: null,
    } as OrchestratorPacket;
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-close-unmerged-live-worker',
      repoPath,
      runtime: 'codex',
      packets: [packet],
      updatedAt: new Date().toISOString(),
    });

    const response = await closeRoute.POST(operatorRequest({
      packetId,
      disposition: 'wontfix',
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      result: {
        closed: true,
        worktreeRemoved: false,
        worktreeCleanup: 'preserved',
        note: expect.stringContaining('Kill unconfirmed'),
      },
    });
    expect(getLane(lane.id)).toMatchObject({
      status: 'archived',
      sessionKey: 'codex:unverified-live-worker',
      outcomeNote: expect.stringContaining('Kill unconfirmed'),
    });
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      id: packetId,
      status: 'archived',
      archivedAt: expect.any(String),
    });
    expect(getLaneEvents(lane.id).find((event) => (
      event.verb === 'update' && event.payload.code === 'kill_unconfirmed'
    ))).toMatchObject({
      payload: {
        resolution: 'closed_unmerged_worker_ownership_preserved',
      },
    });
  });

  it('records every unconfirmed worker when duplicate packet lanes close', async () => {
    const packetId = 'pkt-close-unmerged-duplicate-live-worker';
    const repoPath = join(dataDir, 'repo-duplicate-live-worker');
    const first = createLane({
      repoPath,
      branch: 'issue/duplicate-live-worker-a',
      runtime: 'codex',
      label: 'Duplicate worker A',
      packetId,
      sessionKey: 'codex:duplicate-worker-a',
    });
    const second = createLane({
      repoPath,
      branch: 'issue/duplicate-live-worker-b',
      runtime: 'codex',
      label: 'Duplicate worker B',
      packetId,
      sessionKey: 'codex:duplicate-worker-b',
    });
    setLaneStatus(first.id, 'paused', 'system', 'interrupt_requested');
    setLaneStatus(second.id, 'paused', 'system', 'interrupt_requested');
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-close-unmerged-duplicate-live-worker',
      repoPath,
      runtime: 'codex',
      packets: [{
        id: packetId,
        referenceLabel: '#duplicate-worker',
        title: 'Keep every live worker visible',
        summary: 'Close must inspect every packet lane.',
        workspaceTargetPath: repoPath,
        branchTarget: second.branch,
        runtime: 'codex',
        dependencyLabels: [],
        dependencyPacketIds: [],
        queueState: 'held',
        releaseState: 'pending',
        status: 'blocked',
        blockedReason: 'operator_stopped',
        lane: null,
        review: null,
      } as OrchestratorPacket],
      updatedAt: new Date().toISOString(),
    });

    const response = await closeRoute.POST(operatorRequest({ packetId, disposition: 'wontfix' }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      result: { note: expect.stringContaining('Kill unconfirmed for 2 worker session class processes') },
    });
    expect(getLane(first.id)).toMatchObject({
      status: 'archived',
      outcomeNote: expect.stringContaining('Kill unconfirmed for 2 worker session class processes'),
    });
    expect(getLane(second.id)?.status).toBe('archived');
    expect(readOrchestratorControlPlaneState().packets[0]?.archivedAt).toEqual(expect.any(String));
  });

  it('never reports a preserved branch when the production ref postcondition fails (#1631)', async () => {
    const packetId = 'pkt-preservation-postcondition';
    const branch = 'issue/preservation-postcondition';
    const repoPath = mkdtempSync(join(dataDir, 'preservation-repo-'));
    const worktreePath = join(dataDir, 'preservation-source');
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    git(repoPath, 'init', '--initial-branch=main');
    git(repoPath, '-c', 'user.email=test@o8.test', '-c', 'user.name=o8-test',
      'commit', '--allow-empty', '-m', 'init');
    git(dataDir, 'clone', repoPath, worktreePath);
    git(worktreePath, 'checkout', '-b', branch);
    writeFileSync(join(worktreePath, 'preserved.ts'), 'export const preserved = true;\n');
    git(worktreePath, 'add', 'preserved.ts');
    git(worktreePath, '-c', 'user.email=test@o8.test', '-c', 'user.name=o8-test',
      'commit', '-m', 'work to preserve');

    const lane = createLane({
      repoPath,
      worktreePath,
      branch,
      baseBranch: 'main',
      runtime: 'codex',
      label: 'Preservation postcondition real path',
      packetId,
    });
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-preservation-postcondition',
      repoPath,
      runtime: 'codex',
      packets: [{
        id: packetId,
        referenceLabel: '#1631',
        title: 'Prove preservation ref exists',
        summary: 'Discard must not claim a missing branch.',
        workspaceTargetPath: repoPath,
        branchTarget: branch,
        runtime: 'codex',
        dependencyLabels: [],
        dependencyPacketIds: [],
        queueState: 'held',
        releaseState: 'pending',
        status: 'awaiting_review',
        blockedReason: null,
        lane: {
          tileId: lane.id,
          tabId: lane.id,
          repoPath,
          runtime: 'codex',
          laneId: lane.id,
        },
        review: null,
      } as OrchestratorPacket],
      updatedAt: new Date().toISOString(),
    });

    // Sabotage the real git seam after a successful fetch: delete the fetched
    // ref before returning success. Old code trusted that exit code and emitted
    // a false preservedBranch; the production show-ref postcondition must catch it.
    const realGit = execFileSync('/usr/bin/which', ['git'], {
      encoding: 'utf-8',
    }).trim();
    const fakeBin = mkdtempSync(join(dataDir, 'fake-git-'));
    const fakeGit = join(fakeBin, 'git');
    writeFileSync(fakeGit, `#!${process.execPath}
import { spawnSync } from 'node:child_process';
const realGit = ${JSON.stringify(realGit)};
const args = process.argv.slice(2);
const run = spawnSync(realGit, args, { cwd: process.cwd(), encoding: 'utf-8' });
if (run.stdout) process.stdout.write(run.stdout);
if (run.stderr) process.stderr.write(run.stderr);
if ((run.status ?? 1) === 0 && args[0] === 'fetch') {
  const refspec = args.at(-1) ?? '';
  const separator = refspec.indexOf(':');
  const ref = separator >= 0 ? refspec.slice(separator + 1) : '';
  if (ref.startsWith('refs/heads/')) {
    const deleted = spawnSync(realGit, ['update-ref', '-d', ref], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });
    if ((deleted.status ?? 1) !== 0) {
      if (deleted.stderr) process.stderr.write(deleted.stderr);
      process.exit(deleted.status ?? 1);
    }
  }
}
process.exit(run.status ?? 1);
`);
    chmodSync(fakeGit, 0o755);

    const originalPath = process.env.PATH;
    let response: Response;
    try {
      process.env.PATH = `${fakeBin}:${originalPath ?? ''}`;
      response = await closeRoute.POST(operatorRequest({
        packetId,
        disposition: 'wontfix',
      }));
    } finally {
      process.env.PATH = originalPath;
    }

    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(payload).toMatchObject({
      ok: false,
      error: {
        code: 'branch_preservation_failed',
        message: expect.stringContaining('could not be preserved'),
      },
    });
    expect(() => git(repoPath, 'show-ref', '--verify', `refs/heads/${branch}`)).toThrow();
    expect(getLane(lane.id)).toMatchObject({ status: 'reviewing', worktreePath });
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      status: 'blocked',
      queueState: 'held',
      blockedReason: 'branch_preservation_failed',
      lane: { laneId: lane.id },
    });

    const failureEvent = getLaneEvents(lane.id)
      .find((event) => event.verb === 'branch_preservation_failed');
    expect(failureEvent).toMatchObject({
      actor: 'system',
      payload: {
        code: 'branch_preservation_failed',
        reason: 'ref_verification_failed',
        packetId,
        branch,
        ref: expect.stringMatching(/^refs\/heads\/o8-close-check\//),
        gcRisk: false,
        note: expect.stringContaining('worktree remains intact'),
      },
    });
  });

  it('keeps a checkout o8 does not own visible, with its uncommitted work, and holds the packet', async () => {
    const packetId = 'pkt-close-dirty-worktree';
    const branch = 'issue/close-dirty-worktree';
    const repoPath = mkdtempSync(join(dataDir, 'dirty-close-repo-'));
    const worktreePath = mkdtempSync(join(dataDir, 'dirty-close-source-'));
    rmSync(worktreePath, { recursive: true, force: true });
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    git(repoPath, 'init', '--initial-branch=main');
    git(repoPath, '-c', 'user.email=test@o8.test', '-c', 'user.name=o8-test',
      'commit', '--allow-empty', '-m', 'init');
    git(dataDir, 'clone', repoPath, worktreePath);
    git(worktreePath, 'checkout', '-b', branch);
    writeFileSync(join(worktreePath, 'committed.ts'), 'export const committed = true;\n');
    git(worktreePath, 'add', 'committed.ts');
    git(worktreePath, '-c', 'user.email=test@o8.test', '-c', 'user.name=o8-test',
      'commit', '-m', 'committed work');
    git(repoPath, 'fetch', worktreePath, `${branch}:refs/heads/${branch}`);
    git(repoPath, 'merge', '--ff-only', branch);
    writeFileSync(join(worktreePath, 'dirty.ts'), 'export const dirty = true;\n');

    const lane = createLane({
      repoPath,
      worktreePath,
      branch,
      baseBranch: 'main',
      runtime: 'codex',
      label: 'Dirty close cleanup truth',
      packetId,
    });
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-close-dirty-worktree',
      repoPath,
      runtime: 'codex',
      packets: [{
        id: packetId,
        referenceLabel: '#dirty-close',
        title: 'Keep dirty checkout visible',
        summary: 'Close must fail when cleanup preserves uncommitted work.',
        workspaceTargetPath: repoPath,
        branchTarget: branch,
        runtime: 'codex',
        dependencyLabels: [],
        dependencyPacketIds: [],
        queueState: 'queued',
        releaseState: 'pending',
        status: 'awaiting_review',
        blockedReason: null,
        lane: {
          tileId: lane.id,
          tabId: lane.id,
          repoPath,
          worktreePath,
          runtime: 'codex',
          laneId: lane.id,
          sessionKey: null,
        },
        review: null,
      } as OrchestratorPacket],
      updatedAt: new Date().toISOString(),
    });

    const response = await closeRoute.POST(operatorRequest({ packetId, disposition: 'wontfix' }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'close_failed', message: expect.stringContaining('(ownership-unavailable)') },
    });
    expect(existsSync(join(worktreePath, 'dirty.ts'))).toBe(true);
    expect(getLane(lane.id)).toMatchObject({ status: 'reviewing', worktreePath });
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      status: 'blocked',
      queueState: 'held',
      blockedReason: 'worktree_cleanup_failed',
      lane: { laneId: lane.id, worktreePath },
    });
  });

  it('releases the OpenCode service location before close removes the worktree', { timeout: 90_000 }, async () => {
    const packetId = 'pkt-opencode-close-release';
    const branch = 'issue/opencode-close-release';
    const { root, repoPath, worktreePath, sessionKey } = await createManagedOpenCodeWorktree({ parent: dataDir, prefix: 'opencode-close-', branch, packetId, ownedRoot });
    const lane = persistOpenCodeClosePacket({ packetId, repoPath, worktreePath, branch, sessionKey });
    const fixture = createOpenCodeServiceFixture(root, worktreePath);
    const originalPath = process.env.PATH;
    const originalBinary = process.env.O8_OPENCODE_BIN;

    let response: Response;
    try {
      process.env.PATH = `${fixture.binDir}:${originalPath ?? ''}`;
      process.env.O8_OPENCODE_BIN = fixture.opencodeBin;
      response = await closeRoute.POST(operatorRequest({ packetId, disposition: 'wontfix' }));
    } finally {
      process.env.PATH = originalPath;
      if (originalBinary === undefined) delete process.env.O8_OPENCODE_BIN;
      else process.env.O8_OPENCODE_BIN = originalBinary;
    }

    expect(response.status).toBe(200);
    expect(existsSync(worktreePath)).toBe(false);
    expect(getLane(lane.id)?.status).toBe('archived');
    const calls = fixture.readLog();
    const releaseIndex = calls.findIndex((call) => call.startsWith('opencode api delete /api/debug/location?'));
    const removalProbeIndex = calls.findIndex((call) => call === 'lsof -nP -FpcLftn');
    expect(releaseIndex).toBeGreaterThanOrEqual(0);
    expect(removalProbeIndex).toBeGreaterThan(releaseIndex);
    expect(calls.filter((call) => call.startsWith('opencode api delete /api/debug/location?'))).toHaveLength(1);
  });

  it.each([false, true])('holds an owned checkout when cleanup proof fails (dirty=%s)', { timeout: 90_000 }, async (hasDirtyBytes) => {
    const packetId = `pkt-opencode-close-incomplete-${hasDirtyBytes}`;
    const branch = `issue/opencode-close-incomplete-${hasDirtyBytes}`;
    const { root, repoPath, worktreePath, sessionKey } = await createManagedOpenCodeWorktree({ parent: dataDir, prefix: 'opencode-incomplete-', branch, packetId, ownedRoot });
    const lane = persistOpenCodeClosePacket({ packetId, repoPath, worktreePath, branch, sessionKey });
    const fixture = createOpenCodeServiceFixture(root, worktreePath);
    const dirty = 'export const unsent = "keep these exact bytes";\n';
    if (hasDirtyBytes) writeFileSync(join(worktreePath, 'dirty.ts'), dirty);
    // Independently exercise dirty-source refusal and incomplete native evidence
    // through the same route and owned binding as successful cleanup.
    if (!hasDirtyBytes) writeFileSync(join(fixture.binDir, 'lsof'), `#!${process.execPath}\nprocess.stdout.write('p43210\\ncopencode\\n');\n`);
    const originalPath = process.env.PATH;
    const originalBinary = process.env.O8_OPENCODE_BIN;
    let response: Response;
    try {
      process.env.PATH = `${fixture.binDir}:${originalPath ?? ''}`;
      process.env.O8_OPENCODE_BIN = fixture.opencodeBin;
      response = await closeRoute.POST(operatorRequest({ packetId, disposition: 'wontfix' }));
    } finally {
      process.env.PATH = originalPath;
      if (originalBinary === undefined) delete process.env.O8_OPENCODE_BIN;
      else process.env.O8_OPENCODE_BIN = originalBinary;
    }
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false, error: { code: 'close_failed', message: expect.stringContaining(hasDirtyBytes ? '(dirty)' : '(retirement-refused)') },
    });
    expect(existsSync(worktreePath)).toBe(true);
    if (hasDirtyBytes) expect(readFileSync(join(worktreePath, 'dirty.ts'), 'utf8')).toBe(dirty);
    expect(getLane(lane.id)).toMatchObject({ status: 'reviewing', worktreePath });
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      status: 'blocked', queueState: 'held', blockedReason: 'worktree_cleanup_failed',
      lane: { laneId: lane.id, worktreePath },
    });
  });

  it('retries OpenCode cleanup once and names the remaining holder PID', { timeout: 90_000 }, async () => {
    const packetId = 'pkt-opencode-close-held';
    const branch = 'issue/opencode-close-held';
    const { root, repoPath, worktreePath, sessionKey } = await createManagedOpenCodeWorktree({ parent: dataDir, prefix: 'opencode-held-', branch, packetId, ownedRoot });
    const lane = persistOpenCodeClosePacket({ packetId, repoPath, worktreePath, branch, sessionKey });
    const fixture = createOpenCodeServiceFixture(root, worktreePath, {
      stickyLocation: true,
      holderPid: 54321,
    });
    const originalPath = process.env.PATH;
    const originalBinary = process.env.O8_OPENCODE_BIN;

    let response: Response;
    try {
      process.env.PATH = `${fixture.binDir}:${originalPath ?? ''}`;
      process.env.O8_OPENCODE_BIN = fixture.opencodeBin;
      response = await closeRoute.POST(operatorRequest({ packetId, disposition: 'wontfix' }));
    } finally {
      process.env.PATH = originalPath;
      if (originalBinary === undefined) delete process.env.O8_OPENCODE_BIN;
      else process.env.O8_OPENCODE_BIN = originalBinary;
    }

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'close_failed',
        message: expect.stringContaining('Holder PID: 54321'),
      },
    });
    expect(existsSync(worktreePath)).toBe(true);
    expect(getLane(lane.id)).toMatchObject({ status: 'reviewing', worktreePath });
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      status: 'blocked',
      queueState: 'held',
      blockedReason: 'worktree_cleanup_failed',
      lane: { laneId: lane.id, worktreePath },
    });
    const calls = fixture.readLog();
    expect(calls.filter((call) => call.startsWith('opencode api delete /api/debug/location?'))).toHaveLength(2);
    // Admission refuses before rename; cwd and descriptors share one snapshot.
    expect(calls.filter((call) => call === 'lsof -nP -FpcLftn')).toHaveLength(1);
    expect(getLaneEvents(lane.id).find((event) => event.payload.phase === 'retirement_process_refused')).toMatchObject({
      payload: { state: 'live', failed: expect.arrayContaining([['filesystem_users', 'live', 'owned_process_live']]) },
    });
    expect(calls.filter((call) => call.startsWith('lsof -Fn +D'))).toHaveLength(1);
  });
});
