import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'o8-preservation-cli-real-path-'));
const physicalRoot = path.join(fixtureRoot, 'physical');
mkdirSync(physicalRoot);
const aliasedRoot = path.join(fixtureRoot, 'alias');
// Exercise aliased temporary directories on every host, including CI.
symlinkSync(physicalRoot, aliasedRoot, process.platform === 'win32' ? 'junction' : 'dir');
const root = realpathSync(mkdtempSync(path.join(aliasedRoot, 'fixture-')));
const dataDir = path.join(root, 'data');
const token = 'preservation-operator-test-token';
const workerToken = 'preservation-worker-test-token';
mkdirSync(dataDir);
writeFileSync(path.join(dataDir, 'ws-token'), token);
writeFileSync(path.join(dataDir, 'worker-token'), workerToken);
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_WORKTREE_ROOT = path.join(root, 'worktrees');
process.env.CORTEX_IDE_OWNED_CODEX_ROOT = path.join(root, 'sessions');
const fakeCodex = path.join(root, 'fake-codex');
const spawnReceipt = path.join(root, 'unexpected-spawn');
writeFileSync(fakeCodex, '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "codex-cli 0.130.0\\n"; exit 0; fi\nprintf unexpected > "' + spawnReceipt + '"\nexit 17\n', { mode: 0o700 });
process.env.O8_CODEX_BIN = fakeCodex;

const lanesRoute = await import('@/app/api/lanes/route');
const { closeDb, getSqlite } = await import('@/lib/db');
const { createLane, getLaneEvents, setLaneStatus } = await import('@/lib/lane/registry');
const { addRepo } = await import('@/lib/repos/registry');
const { WorktreeManager } = await import('@/lib/worktree/manager');
const { captureWorktreeMaterializationIdentity } = await import('@/lib/worktree/materialization-identity');
const { withWorktreeMetaTransaction } = await import('@/lib/worktree/metadata-store');
const { resolveWorktreeRootLayout } = await import('@/lib/worktree/root-layout');
const { getWorkspaceSnapshot, listWorkspaceSnapshotTransitions } = await import('@/lib/worktree/snapshot-state');
const { writeOrchestratorControlPlaneState, readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { recordMission } = await import('@/lib/db/missions-store');
const { readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
const repoPath = path.join(root, 'repo');
let server: Server;
let port = 0;
let finished = false;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function ownedWorkspace(repo: Awaited<ReturnType<typeof addRepo>>, packetId: string, revision: string) {
  const worktreeId = 'packet-' + packetId;
  const branch = 'codex/' + packetId;
  const workspacePath = path.join(resolveWorktreeRootLayout(repo.localPath).primaryBase, worktreeId);
  mkdirSync(path.dirname(workspacePath), { recursive: true });
  git(repo.localPath, 'worktree', 'add', '-qb', branch, workspacePath, revision);
  const identity = await captureWorktreeMaterializationIdentity(workspacePath);
  const parentIdentity = await captureWorktreeMaterializationIdentity(path.dirname(workspacePath));
  const surfaceId = 'codex-owned:codex-owned-' + packetId;
  const sessionDir = path.join(root, 'sessions', 'codex-owned-' + packetId);
  mkdirSync(sessionDir, { recursive: true });
  const session: OwnedSessionRecord = {
    surfaceId, packetId, sessionDir, cwd: workspacePath, repoPath: workspacePath,
    branch, head: git(workspacePath, 'rev-parse', 'HEAD'), title: 'Preservation regression owned session',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), recentRuns: [],
    latestPrompt: 'Verify retained source and selected artifact recovery.', latestSummary: 'Owned idle recovery fixture.',
    runIdentityLedger: { version: 1, totalRuns: 0, complete: true },
    workspaceBinding: {
      logicalWorkspaceId: 'packet:' + packetId, repositoryUuid: repo.id, packetId,
      cwd: workspacePath, version: 1, verifiedAt: new Date().toISOString(),
    },
    threadId: '12345678-1234-1234-1234-123456789abc',
    laneId: undefined,
  };
  writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify(session), { mode: 0o600 });
  const { resetOwnedSessionIndex } = await import('@/lib/runtimes/shared/owned-session-index');
  resetOwnedSessionIndex();
  await withWorktreeMetaTransaction(repo.localPath, (transaction) => transaction.save(worktreeId, {
    id: worktreeId, agentType: 'codex', sessionKey: surfaceId, baseBranch: 'main', createdAt: Date.now(),
    claudeManaged: false, taskName: packetId, branchName: branch, status: 'ready', isolationKind: 'git-worktree',
    materializationIdentity: identity, materializationParentIdentity: parentIdentity,
  }));
  const lane = createLane({
    repoPath: repo.localPath, worktreePath: workspacePath, branch, baseBranch: 'main', runtime: 'codex',
    packetId, sessionKey: surfaceId, ownership: 'managed',
  });
  setLaneStatus(lane.id, 'reviewing');
  return { worktreeId, workspacePath, lane, identity };
}

function cli(args: string[], bearer = token): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env, O8_API_PORT: String(port), O8_API_TOKEN: bearer,
      O8_WORKER_TOKEN: '', O8_WORKER_PACKET_ID: '',
    };
    delete env.NODE_OPTIONS;
    const child = spawn(process.execPath, [path.join(process.cwd(), 'cli/dist/o8.mjs'), ...args], {
      cwd: repoPath, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

beforeAll(async () => {
  mkdirSync(repoPath);
  git(repoPath, 'init', '-q', '-b', 'main');
  git(repoPath, 'config', 'user.name', 'o8 regression');
  git(repoPath, 'config', 'user.email', 'o8@example.test');
  writeFileSync(path.join(repoPath, '.gitignore'), '.o8/\nnode_modules/\n');
  writeFileSync(path.join(repoPath, 'tracked.txt'), 'base source\n');
  git(repoPath, 'add', '.gitignore', 'tracked.txt');
  git(repoPath, 'commit', '-qm', 'base');
  execFileSync(process.execPath, [path.join(process.cwd(), 'cli/esbuild.config.mjs')], { stdio: 'pipe' });
  server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const next = new NextRequest(new URL(request.url ?? '/', 'http://127.0.0.1:' + port), {
        method: request.method, headers: request.headers as HeadersInit,
        body: chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined,
      });
      let route: Response;
      if (next.nextUrl.pathname === '/api/setup/status') route = (await import('@/app/api/setup/status/route')).GET();
      else if (next.nextUrl.pathname === '/api/lanes') {
        route = request.method === 'POST' ? await lanesRoute.POST(next) : await lanesRoute.GET(next);
      } else if (next.nextUrl.pathname === '/api/orchestrator/discard-packet') {
        route = await (await import('@/app/api/orchestrator/discard-packet/route')).POST(next);
      }
      else if (next.nextUrl.pathname === '/api/orchestrator/workspace/retention') {
        const retention = await import('@/app/api/orchestrator/workspace/retention/route');
        route = request.method === 'GET' ? await retention.GET(next) : await retention.POST(next);
      } else if (next.nextUrl.pathname === '/api/orchestrator/workspace/preservation') {
        const preservation = await import('@/app/api/orchestrator/workspace/preservation/route');
        route = request.method === 'GET' ? await preservation.GET(next) : await preservation.POST(next);
      } else if (next.nextUrl.pathname === '/api/orchestrator/workspace') {
        route = await (await import('@/app/api/orchestrator/workspace/route')).POST(next);
      } else if (next.nextUrl.pathname === '/api/worktrees') {
        const worktrees = await import('@/app/api/worktrees/route');
        route = request.method === 'POST' ? await worktrees.POST(next) : await worktrees.DELETE(next);
      } else route = Response.json({ ok: false, error: 'Unknown route' }, { status: 404 });
      response.writeHead(route.status, { 'content-type': 'application/json' });
      response.end(await route.text());
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Regression server did not bind.');
  port = address.port;
  process.env.O8_API_PORT = String(port);
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  closeDb();
  if (finished) rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('workspace preservation compiled CLI and persisted owner', () => {
  it('stops and closes through the CLI only after retention release and restores bytes into a newer successor', async () => {
    finished = false;
    const packetId = 'close-preservation-source';
    const repo = await addRepo(repoPath);
    const source = await ownedWorkspace(repo, packetId, 'main');
    const head = git(source.workspacePath, 'rev-parse', 'HEAD');
    const binary = Buffer.from([0, 255, 254, 71, 0, 128]);
    const note = 'Continue the unfinished task from this exact checkpoint.\n';
    mkdirSync(path.join(source.workspacePath, '.o8'));
    writeFileSync(path.join(source.workspacePath, '.o8', 'checkpoint.bin'), binary, { mode: 0o400 });
    writeFileSync(path.join(source.workspacePath, '.o8', 'remaining.md'), note);
    setLaneStatus(source.lane.id, 'running');
    const mission = writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-close-preservation', repoPath: repo.localPath, runtime: 'codex',
      packets: [{
        id: packetId, referenceLabel: '#3278', title: 'Close preservation regression',
        summary: 'Retire through the supported stop and close commands.',
        workspaceTargetPath: repo.localPath, branchTarget: source.lane.branch, runtime: 'codex',
        dependencyLabels: [], dependencyPacketIds: [], queueState: 'held', releaseState: 'pending',
        status: 'running', blockedReason: null, review: null,
        lane: { tileId: source.lane.id, tabId: source.lane.id, repoPath: repo.localPath,
          worktreePath: source.workspacePath, runtime: 'codex', laneId: source.lane.id, sessionKey: source.lane.sessionKey },
      } as OrchestratorPacket], updatedAt: new Date().toISOString(),
    });
    recordMission({ id: mission.missionId!, repoPath: repo.localPath, runtime: 'codex',
      prompt: '', summary: '', constraints: '', totalWaves: 1, missionState: mission,
      packetMeta: mission.packets.map(({ id, title, referenceLabel }) => ({ id, title, referenceLabel })),
    });
    const hold = await cli(['packet', 'retain', packetId, '--reason', 'Preserve unfinished checkpoint',
      '--idempotency-key', 'close-preservation-hold']);
    expect(hold.exitCode, hold.stderr + hold.stdout).toBe(0);
    const stop = await cli(['packet', 'stop', packetId]);
    expect(stop.exitCode, stop.stderr + stop.stdout).toBe(0);
    closeDb();
    for (const stopped of [readOrchestratorControlPlaneState(), readMissionRegistryEntry(mission.missionId!)!.mission]) {
      expect(stopped.packets[0]).toMatchObject({ operatorStopped: true, queueState: 'held', status: 'blocked',
        blockedReason: 'operator_stopped', lane: { laneId: source.lane.id, sessionKey: source.lane.sessionKey } });
    }
    const closeArgs = ['packet', 'close', packetId, '--reason', 'superseded',
      '--note', 'Continue in a distinct successor', '--idempotency-key', 'close-preservation-held'];
    const heldClose = await cli(closeArgs);
    expect(heldClose.exitCode, heldClose.stderr + heldClose.stdout).toBe(5);
    expect(readFileSync(path.join(source.workspacePath, '.o8', 'checkpoint.bin'))).toEqual(binary);
    expect(existsSync(path.join(root, 'sessions', 'codex-owned-' + packetId, 'session.json'))).toBe(true);
    closeDb();
    const released = await cli(['packet', 'release-retention', packetId, '--hold-id', 'close-preservation-hold',
      '--idempotency-key', 'close-preservation-release']);
    expect(released.exitCode, released.stderr + released.stdout).toBe(0);
    closeArgs[closeArgs.length - 1] = 'close-preservation-released';
    const beforeClose = [readOrchestratorControlPlaneState(), readMissionRegistryEntry(mission.missionId!)!.mission]
      .map((state) => {
        const packet = state.packets.find((candidate) => candidate.id === packetId)!;
        return { status: packet.status, queueState: packet.queueState, operatorStopped: packet.operatorStopped,
          source: packet.releaseStatePayload?.source, epoch: packet.storageAdmissionEpoch,
          attempt: packet.attemptCount, laneId: packet.lane?.laneId };
      });
    const closed = await cli(closeArgs);
    expect(closed.exitCode, JSON.stringify({ beforeClose, stderr: closed.stderr, stdout: closed.stdout })).toBe(0);
    expect(JSON.parse(closed.stdout)).toMatchObject({ packet: { id: packetId, worktreeRemoved: true, worktreeCleanup: 'removed' } });
    expect(existsSync(source.workspacePath)).toBe(false);
    expect(getWorkspaceSnapshot(repo.id, packetId)).toMatchObject({ state: 'retired', headCommit: head });
    const terminal = listWorkspaceSnapshotTransitions(repo.id, packetId).findLast((entry) => entry.toState === 'retired');
    expect(terminal?.receipt?.preservationId).toMatch(/^[a-f0-9]{64}$/);
    closeDb();
    expect(readMissionRegistryEntry(mission.missionId!, { includeArchived: true })?.mission.packets[0])
      .toMatchObject({ status: 'archived', lane: null, queueState: 'held', operatorStopped: true });
    const retiredTransitions = listWorkspaceSnapshotTransitions(repo.id, packetId);
    const retiredEvents = getLaneEvents(source.lane.id);
    const replayedClose = await cli(closeArgs);
    expect(replayedClose.exitCode, replayedClose.stderr + replayedClose.stdout).toBe(0);
    expect(listWorkspaceSnapshotTransitions(repo.id, packetId)).toEqual(retiredTransitions);
    expect(getLaneEvents(source.lane.id)).toEqual(retiredEvents);
    const archiveResponse = await fetch('http://127.0.0.1:' + port + '/api/orchestrator/workspace/preservation?packetId=' + packetId, {
      headers: { authorization: 'Bearer ' + token },
    });
    expect(archiveResponse.status).toBe(200);
    expect((await archiveResponse.json()).result).toMatchObject({ artifactCount: 2,
      artifactBytes: binary.length + Buffer.byteLength(note), headCommit: head });
    writeFileSync(path.join(repo.localPath, 'newer-source.txt'), 'Successor uses a newer source revision.\n');
    git(repo.localPath, 'add', 'newer-source.txt');
    git(repo.localPath, 'commit', '-qm', 'newer successor source');
    const newerHead = git(repo.localPath, 'rev-parse', 'HEAD');
    const newerTree = git(repo.localPath, 'rev-parse', 'HEAD^{tree}');
    expect(newerHead).not.toBe(head);
    const successor = await ownedWorkspace(repo, 'close-preservation-successor', newerHead);
    const restoreArgs = ['packet', 'restore-artifacts', packetId, '--to', 'close-preservation-successor',
      '--paths-json', '[".o8/checkpoint.bin",".o8/remaining.md"]', '--idempotency-key', 'close-preservation-restore'];
    const restored = await cli(restoreArgs);
    expect(restored.exitCode, restored.stderr + restored.stdout).toBe(0);
    expect(JSON.parse(restored.stdout)).toMatchObject({ restoredFiles: 2, retained: true,
      targetHeadCommit: newerHead, targetTreeSha: newerTree });
    expect(readFileSync(path.join(successor.workspacePath, '.o8', 'checkpoint.bin'))).toEqual(binary);
    expect(readFileSync(path.join(successor.workspacePath, '.o8', 'remaining.md'), 'utf8')).toBe(note);
    expect(git(successor.workspacePath, 'rev-parse', 'HEAD')).toBe(newerHead);
    expect(getWorkspaceSnapshot(repo.id, packetId)?.headCommit).toBe(head);
    const checkpoint = path.join(successor.workspacePath, '.o8', 'checkpoint.bin');
    const before = statSync(checkpoint);
    git(successor.workspacePath, 'commit', '--allow-empty', '-qm', 'successor advanced after recovery');
    closeDb();
    const revised = await cli(restoreArgs);
    expect(revised.exitCode).toBe(5);
    expect(revised.stderr + revised.stdout).toContain('persisted target revision');
    expect(readFileSync(checkpoint)).toEqual(binary);
    expect(statSync(checkpoint).ino).toBe(before.ino);
    expect(statSync(checkpoint).mtimeMs).toBe(before.mtimeMs);
    expect(existsSync(spawnReceipt)).toBe(false);
    finished = true;
  }, 60_000);

  it('keeps a manager refusal authoritative at the merge tail even after the durable path is cleared', async () => {
    finished = false;
    const repo = await addRepo(repoPath);
    const source = await ownedWorkspace(repo, 'merge-tail-held', 'main');
    const note = 'Unique unfinished merge evidence.\n';
    mkdirSync(path.join(source.workspacePath, '.o8'));
    writeFileSync(path.join(source.workspacePath, '.o8', 'remaining.md'), note);
    const held = await cli(['packet', 'retain', 'merge-tail-held', '--reason', 'Review unfinished merge evidence',
      '--idempotency-key', 'merge-tail-retention']);
    expect(held.exitCode, held.stderr + held.stdout).toBe(0);
    const manager = new WorktreeManager(repo.localPath);
    const { updateLane } = await import('@/lib/lane/registry');
    const { removeMergedWorktree, withSynchronousWorktreeCleanup } = await import('@/lib/orchestrator/worktree-cleanup');
    const result = await withSynchronousWorktreeCleanup('merge-tail-held', async () => {
      expect(await manager.cleanup(source.worktreeId, { workspaceRetirementAction: 'merge' })).toBe(false);
      return { merged: true };
    });
    expect(result).toEqual({ merged: true });
    expect(readFileSync(path.join(source.workspacePath, '.o8', 'remaining.md'), 'utf8')).toBe(note);
    updateLane(source.lane.id, { worktreePath: null }, 'system');
    expect(await removeMergedWorktree(source.lane)).toMatchObject({ removed: false, reason: 'ownership-unavailable' });
    expect(readFileSync(path.join(source.workspacePath, '.o8', 'remaining.md'), 'utf8')).toBe(note);
    finished = true;
  }, 30_000);

  it('replays exact retirement using a matching archived owned binding', async () => {
    finished = false;
    const repo = await addRepo(repoPath);
    const source = await ownedWorkspace(repo, 'retirement-replay-owner', 'main');
    mkdirSync(path.join(source.workspacePath, '.o8'));
    writeFileSync(path.join(source.workspacePath, '.o8', 'checkpoint.bin'), Buffer.from([0, 255, 128]));
    const { prepareWorkspaceMaterializationRetirement } = await import('@/lib/workspace/workspace-materialization-retirement');
    const { retireExactManagedDirectory, finishPendingExactManagedDirectoryRetirements } = await import('@/lib/workspace/exact-managed-directory-retirement');
    const { readExactWorkspaceClaim } = await import('@/lib/workspace/exact-workspace-claim-state');
    const { getOwnedSessionLifecycle } = await import('@/lib/runtimes/shared/owned-session-lifecycle');
    await prepareWorkspaceMaterializationRetirement(repo.localPath, source.workspacePath, 'cleanup');
    const parent = await captureWorktreeMaterializationIdentity(path.dirname(source.workspacePath));
    await expect(retireExactManagedDirectory({
      repositoryPath: repo.localPath, worktreeId: source.worktreeId, directoryPath: source.workspacePath,
      identity: source.identity, parentIdentity: parent,
      afterRetirementRename: async () => { throw new Error('Interrupted after exact rename'); },
    })).rejects.toThrow('Interrupted after exact rename');
    const claim = readExactWorkspaceClaim('managed-retirement', repo.localPath, source.worktreeId)!;
    expect(readFileSync(path.join(claim.claimPath, '.o8', 'checkpoint.bin'))).toEqual(Buffer.from([0, 255, 128]));
    const lifecycle = getOwnedSessionLifecycle(source.lane.sessionKey!)!;
    expect((await lifecycle.archiveSession(source.lane.sessionKey!)).archived).toBe(true);
    closeDb();
    expect(await finishPendingExactManagedDirectoryRetirements(repo.localPath, path.dirname(source.workspacePath), parent))
      .toEqual({ completed: 1, refused: 0 });
    expect(existsSync(claim.claimPath)).toBe(false);
    expect(readExactWorkspaceClaim('managed-retirement', repo.localPath, source.worktreeId)?.state).toBe('purging');
    finished = true;
  }, 30_000);

  it('holds retirement, preserves unique binary content, and restores a retained idle successor after DB reopen', async () => {
    const repo = await addRepo(repoPath);
    const source = await ownedWorkspace(repo, 'preservation-source', 'main');
    writeFileSync(path.join(source.workspacePath, 'tracked.txt'), 'useful source change\n');
    git(source.workspacePath, 'add', 'tracked.txt');
    git(source.workspacePath, 'commit', '-qm', 'useful source');
    const head = git(source.workspacePath, 'rev-parse', 'HEAD');
    const binary = Buffer.from([0, 255, 254, 128, 65, 0, 239, 191, 189]);
    const note = 'Continue from the retained revision; verify the binary proof before resuming.\n';
    mkdirSync(path.join(source.workspacePath, '.o8'));
    writeFileSync(path.join(source.workspacePath, '.o8', 'proof.bin'), binary, { mode: 0o400 });
    writeFileSync(path.join(source.workspacePath, '.o8', 'resume.md'), note);
    mkdirSync(path.join(source.workspacePath, 'node_modules'));
    writeFileSync(path.join(source.workspacePath, 'node_modules', 'rebuildable.bin'), Buffer.alloc(1024 * 1024));
    const held = await cli(['packet', 'retain', 'preservation-source', '--reason', 'Verify recovery before retirement', '--idempotency-key', 'source-retention-1']);
    expect(held.exitCode, held.stderr + held.stdout).toBe(0);
    expect(JSON.parse(held.stdout).hold).toMatchObject({ held: true, holdId: 'source-retention-1' });
    setLaneStatus(source.lane.id, 'completed');
    const { runWorktreeMaintenanceTick } = await import('@/lib/lane/worktree-reaper');
    await runWorktreeMaintenanceTick();
    closeDb();
    const manager = new WorktreeManager(repo.localPath);
    expect(await manager.cleanup(source.worktreeId)).toBe(false);
    expect(readFileSync(path.join(source.workspacePath, '.o8', 'proof.bin'))).toEqual(binary);
    const released = await cli(['packet', 'release-retention', 'preservation-source', '--hold-id', 'source-retention-1', '--idempotency-key', 'source-release-1']);
    expect(released.exitCode, released.stderr + released.stdout).toBe(0);
    expect(await manager.cleanup(source.worktreeId)).toBe(true);
    expect(existsSync(source.workspacePath)).toBe(false);
    expect(getWorkspaceSnapshot(repo.id, 'preservation-source')).toMatchObject({ state: 'retired', headCommit: head });
    const terminal = listWorkspaceSnapshotTransitions(repo.id, 'preservation-source')
      .findLast((entry) => entry.toState === 'retired');
    expect(terminal?.receipt?.preservationId).toMatch(/^[a-f0-9]{64}$/);
    closeDb();
    const archiveResponse = await fetch('http://127.0.0.1:' + port + '/api/orchestrator/workspace/preservation?packetId=preservation-source', {
      headers: { authorization: 'Bearer ' + token },
    });
    expect(archiveResponse.status).toBe(200);
    const archive = (await archiveResponse.json()).result;
    expect(archive).toMatchObject({ artifactCount: 2, artifactBytes: binary.length + Buffer.byteLength(note), headCommit: head });
    expect(archive.artifacts.some((entry: { path: string }) => entry.path.startsWith('node_modules'))).toBe(false);
    const successor = await ownedWorkspace(repo, 'preservation-successor', head);
    const args = ['packet', 'restore-artifacts', 'preservation-source', '--to', 'preservation-successor',
      '--paths-json', '[".o8/proof.bin",".o8/resume.md"]', '--idempotency-key', 'binary-restore-1'];
    const restored = await cli(args);
    expect(restored.exitCode, restored.stderr + restored.stdout).toBe(0);
    const receipt = JSON.parse(restored.stdout);
    expect(receipt).toMatchObject({ restoredFiles: 2, restoredBytes: binary.length + Buffer.byteLength(note), retained: true });
    expect(readFileSync(path.join(successor.workspacePath, '.o8', 'proof.bin'))).toEqual(binary);
    expect(readFileSync(path.join(successor.workspacePath, '.o8', 'resume.md'), 'utf8')).toBe(note);
    expect(statSync(path.join(successor.workspacePath, '.o8', 'proof.bin')).mode & 0o777).toBe(0o400);
    expect(getSqlite().prepare("SELECT COUNT(*) AS total FROM workspace_artifact_restore_files WHERE phase = 'complete' AND restore_id = ?").get(receipt.restoreId)).toEqual({ total: 2 });
    const beforeReplay = statSync(path.join(successor.workspacePath, '.o8', 'proof.bin'));
    // Simulate the selection-only binding persisted by an earlier release.
    getSqlite().prepare('UPDATE workspace_artifact_restores SET selection_sha256 = ? WHERE restore_id = ?')
      .run(createHash('sha256').update(JSON.stringify(['.o8/proof.bin', '.o8/resume.md'])).digest('hex'), receipt.restoreId);
    closeDb();
    const replayed = await cli(args);
    expect(replayed.exitCode, replayed.stderr + replayed.stdout).toBe(0);
    const afterReplay = statSync(path.join(successor.workspacePath, '.o8', 'proof.bin'));
    expect(afterReplay.ino).toBe(beforeReplay.ino);
    expect(afterReplay.mtimeMs).toBe(beforeReplay.mtimeMs);
    expect(await manager.cleanup(successor.worktreeId)).toBe(false);
    expect(restored.stdout).not.toContain(root);
    if (process.env.O8_THIN_WORKSPACE_DOGFOOD === '1') console.info('[preservation-real-path]', JSON.stringify({
      sourceHead: head, preservationId: archive.preservationId, restoreId: receipt.restoreId,
      binarySha256: createHash('sha256').update(binary).digest('hex'), restoredFiles: receipt.restoredFiles,
      bytes: receipt.restoredBytes, persistedHoldRespected: true, readOnlyReplayStable: true,
    }));
    finished = true;
  }, 60_000);

  it('binds a newer successor revision when resuming an earlier intent that published no files', async () => {
    finished = false;
    const repo = await addRepo(repoPath);
    const snapshot = getWorkspaceSnapshot(repo.id, 'preservation-source')!;
    const successor = await ownedWorkspace(repo, 'preservation-legacy-empty', snapshot.headCommit);
    git(successor.workspacePath, 'commit', '--allow-empty', '-qm', 'newer recovery destination');
    const targetHead = git(successor.workspacePath, 'rev-parse', 'HEAD');
    const key = 'legacy-empty-restore';
    const restoreId = createHash('sha256').update(JSON.stringify({
      repositoryUuid: repo.id, targetPacketId: 'preservation-legacy-empty', clientMutationId: key,
    })).digest('hex');
    const preservation = getSqlite().prepare('SELECT preservation_id FROM workspace_preservations WHERE packet_id = ?')
      .get('preservation-source') as { preservation_id: string };
    const selection = createHash('sha256').update(JSON.stringify(['.o8/proof.bin'])).digest('hex');
    getSqlite().prepare(`INSERT INTO workspace_artifact_restores (
      restore_id, preservation_id, repository_uuid, target_packet_id, target_lane_id, workspace_path,
      source_device, source_inode, selection_sha256, state, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'preparing', ?, ?)`).run(
      restoreId, preservation.preservation_id, repo.id, 'preservation-legacy-empty', successor.lane.id,
      successor.workspacePath, successor.identity.device, successor.identity.inode, selection, Date.now(), Date.now(),
    );
    closeDb();
    const restored = await cli(['packet', 'restore-artifacts', 'preservation-source', '--to', 'preservation-legacy-empty',
      '--paths-json', '[".o8/proof.bin"]', '--idempotency-key', key]);
    expect(restored.exitCode, restored.stderr + restored.stdout).toBe(0);
    expect(JSON.parse(restored.stdout)).toMatchObject({ restoreId, restoredFiles: 1, targetHeadCommit: targetHead });
    expect(readFileSync(path.join(successor.workspacePath, '.o8', 'proof.bin')))
      .toEqual(Buffer.from([0, 255, 254, 128, 65, 0, 239, 191, 189]));
    expect(getSqlite().prepare('SELECT state FROM workspace_artifact_restores WHERE restore_id = ?').get(restoreId))
      .toEqual({ state: 'complete' });
    expect(getSqlite().prepare('SELECT phase FROM workspace_artifact_restore_files WHERE restore_id = ?').all(restoreId))
      .toEqual([{ phase: 'complete' }]);
    finished = true;
  }, 30_000);

  it('refuses a dirty newer successor before creating a recovery intent', async () => {
    finished = false;
    const repo = await addRepo(repoPath);
    const source = getWorkspaceSnapshot(repo.id, 'preservation-source')!;
    const successor = await ownedWorkspace(repo, 'preservation-dirty-newer', source.headCommit);
    git(successor.workspacePath, 'commit', '--allow-empty', '-qm', 'newer dirty recovery destination');
    const tracked = path.join(successor.workspacePath, 'tracked.txt');
    writeFileSync(tracked, 'Unbanked successor source must remain untouched.\n');
    const before = readFileSync(tracked);
    const refused = await cli(['packet', 'restore-artifacts', 'preservation-source', '--to', 'preservation-dirty-newer',
      '--paths-json', '[".o8/proof.bin"]', '--idempotency-key', 'dirty-newer-restore']);
    expect(refused.exitCode).toBe(5);
    expect(readFileSync(tracked)).toEqual(before);
    expect(existsSync(path.join(successor.workspacePath, '.o8', 'proof.bin'))).toBe(false);
    expect(getSqlite().prepare('SELECT restore_id FROM workspace_artifact_restores WHERE target_packet_id = ?')
      .all('preservation-dirty-newer')).toEqual([]);
    finished = true;
  }, 30_000);

  it('keeps an earlier published recovery bound to its original source revision', async () => {
    finished = false;
    const repo = await addRepo(repoPath);
    const source = getWorkspaceSnapshot(repo.id, 'preservation-source')!;
    const successor = await ownedWorkspace(repo, 'preservation-legacy-published', source.headCommit);
    const args = ['packet', 'restore-artifacts', 'preservation-source', '--to', 'preservation-legacy-published',
      '--paths-json', '[".o8/proof.bin"]', '--idempotency-key', 'legacy-published-restore'];
    const restored = await cli(args);
    expect(restored.exitCode, restored.stderr + restored.stdout).toBe(0);
    const receipt = JSON.parse(restored.stdout);
    getSqlite().prepare('UPDATE workspace_artifact_restores SET selection_sha256 = ? WHERE restore_id = ?')
      .run(createHash('sha256').update(JSON.stringify(['.o8/proof.bin'])).digest('hex'), receipt.restoreId);
    const destination = path.join(successor.workspacePath, '.o8', 'proof.bin');
    const before = statSync(destination);
    const bytes = readFileSync(destination);
    git(successor.workspacePath, 'commit', '--allow-empty', '-qm', 'legacy destination advanced');
    closeDb();
    const refused = await cli(args);
    expect(refused.exitCode).toBe(5);
    expect(refused.stderr + refused.stdout).toContain('bound to the retired source revision');
    expect(readFileSync(destination)).toEqual(bytes);
    expect(statSync(destination).ino).toBe(before.ino);
    expect(statSync(destination).mtimeMs).toBe(before.mtimeMs);
    finished = true;
  }, 30_000);

  it('refuses an occupied successor file and denies worker access before mutation', async () => {
    finished = false;
    const repo = await addRepo(repoPath);
    const head = getWorkspaceSnapshot(repo.id, 'preservation-source')!.headCommit;
    const successor = await ownedWorkspace(repo, 'preservation-occupied', head);
    mkdirSync(path.join(successor.workspacePath, '.o8'));
    const destination = path.join(successor.workspacePath, '.o8', 'proof.bin');
    const original = Buffer.from([91, 0, 255, 12]);
    writeFileSync(destination, original);
    const before = statSync(destination);
    const refused = await cli([
      'packet', 'restore-artifacts', 'preservation-source', '--to', 'preservation-occupied',
      '--paths-json', '[".o8/proof.bin"]', '--idempotency-key', 'occupied-restore-1',
    ]);
    expect(refused.exitCode).toBe(5);
    expect(readFileSync(destination)).toEqual(original);
    expect(statSync(destination).ino).toBe(before.ino);
    const prior = getSqlite().prepare('SELECT COUNT(*) AS total FROM workspace_artifact_restores').get();
    const denied = await fetch('http://127.0.0.1:' + port + '/api/orchestrator/workspace/preservation', {
      method: 'POST', headers: { authorization: 'Bearer ' + workerToken, 'content-type': 'application/json' },
      body: JSON.stringify({ sourcePacketId: 'preservation-source', targetPacketId: 'preservation-occupied',
        paths: ['.o8/proof.bin'], clientMutationId: 'worker-must-not-restore' }),
    });
    expect(denied.status).toBe(403);
    expect(getSqlite().prepare('SELECT COUNT(*) AS total FROM workspace_artifact_restores').get()).toEqual(prior);
    expect(readFileSync(destination)).toEqual(original);
    finished = true;
  }, 30_000);

  it('refuses changed intent and operator-modified completed restore bytes after a DB reopen', async () => {
    finished = false;
    const lane = (await import('@/lib/lane/registry')).findLatestLaneByPacket('preservation-successor')!;
    const destination = path.join(lane.worktreePath!, '.o8', 'resume.md');
    const revised = 'Operator revised this retained recovery note.\n';
    writeFileSync(destination, revised);
    const before = statSync(destination);
    closeDb();
    const changedIntent = await cli([
      'packet', 'restore-artifacts', 'preservation-source', '--to', 'preservation-successor',
      '--paths-json', '[".o8/resume.md"]', '--idempotency-key', 'binary-restore-1',
    ]);
    expect(changedIntent.exitCode).toBe(5);
    expect(readFileSync(destination, 'utf8')).toBe(revised);
    const replay = await cli([
      'packet', 'restore-artifacts', 'preservation-source', '--to', 'preservation-successor',
      '--paths-json', '[".o8/proof.bin",".o8/resume.md"]', '--idempotency-key', 'binary-restore-1',
    ]);
    expect(replay.exitCode).toBe(5);
    expect(readFileSync(destination, 'utf8')).toBe(revised);
    expect(statSync(destination).ino).toBe(before.ino);
    expect(statSync(destination).mtimeMs).toBe(before.mtimeMs);
    finished = true;
  }, 30_000);

  it('recovers a prepared read-only file after interruption while durable state blocks resume, parking and publication', async () => {
    finished = false;
    const repo = await addRepo(repoPath);
    const successor = await ownedWorkspace(repo, 'preservation-interrupted', getWorkspaceSnapshot(repo.id, 'preservation-source')!.headCommit);
    getSqlite().exec(`CREATE TRIGGER interrupt_artifact_completion BEFORE INSERT ON workspace_artifact_restore_files
      WHEN NEW.phase = 'complete' BEGIN SELECT RAISE(ABORT, 'simulated crash after read-only publication'); END;`);
    const args = ['packet', 'restore-artifacts', 'preservation-source', '--to', 'preservation-interrupted',
      '--paths-json', '[".o8/proof.bin"]', '--idempotency-key', 'interrupted-restore-1'];
    const interrupted = await cli(args);
    expect(interrupted.exitCode).toBe(5);
    const destination = path.join(successor.workspacePath, '.o8', 'proof.bin');
    const before = statSync(destination);
    expect(before.mode & 0o777).toBe(0o400);
    expect(getSqlite().prepare("SELECT phase FROM workspace_artifact_restore_files WHERE phase = 'prepared'").all()).toEqual([{ phase: 'prepared' }]);
    getSqlite().exec('DROP TRIGGER interrupt_artifact_completion');
    closeDb();
    const { continueOwnedCodexSession } = await import('@/lib/codex/owned');
    const resume = await continueOwnedCodexSession(successor.lane.sessionKey!, 'Resume the retained recovery.');
    expect(resume).toMatchObject({ ok: false, sideEffect: 'none' });
    expect(resume.note).toContain('Artifact recovery is incomplete');
    expect(existsSync(spawnReceipt)).toBe(false);
    const parking = await fetch('http://127.0.0.1:' + port + '/api/orchestrator/workspace', {
      method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'park', packetId: 'preservation-interrupted', clientMutationId: 'park-during-recovery' }),
    });
    expect(parking.status).toBe(409);
    const { withWorkspaceMaterializedMutation } = await import('@/lib/workspace/mutation-materialization-guard');
    await expect(withWorkspaceMaterializedMutation(successor.lane, async () => {
      writeFileSync(path.join(successor.workspacePath, 'must-not-publish'), 'unsafe');
    })).rejects.toThrow('snapshot truth');
    expect(existsSync(path.join(successor.workspacePath, 'must-not-publish'))).toBe(false);
    const recovered = await cli(args);
    expect(recovered.exitCode, recovered.stderr + recovered.stdout).toBe(0);
    expect(statSync(destination).ino).toBe(before.ino);
    expect(statSync(destination).mtimeMs).toBe(before.mtimeMs);
    expect(statSync(destination).mode & 0o777).toBe(0o400);
    expect(getSqlite().prepare("SELECT state FROM workspace_artifact_restores WHERE target_packet_id = ?").get('preservation-interrupted')).toEqual({ state: 'complete' });
    closeDb();
    expect((await cli(args)).exitCode).toBe(0);
    expect(statSync(destination).mtimeMs).toBe(before.mtimeMs);
    finished = true;
  }, 60_000);

  it('refuses an owned spawn promptly while another lifecycle operation owns the target', async () => {
    finished = false;
    const { findLatestLaneByPacket } = await import('@/lib/lane/registry');
    const { withPacketLifecycleMutationLock } = await import('@/lib/orchestrator/lifecycle-mutation-lock');
    const { continueOwnedCodexSession } = await import('@/lib/codex/owned');
    const successor = findLatestLaneByPacket('preservation-interrupted')!;
    let runInherited!: () => void;
    let inheritedAttempt!: ReturnType<typeof continueOwnedCodexSession>;
    await withPacketLifecycleMutationLock('preservation-interrupted', async () => {
      inheritedAttempt = (async () => {
        await new Promise<void>((resolve) => { runInherited = resolve; });
        return continueOwnedCodexSession(successor.sessionKey!, 'Deferred callback after its lifecycle lease was released.');
      })();
    });
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const held = withPacketLifecycleMutationLock('preservation-interrupted', async () => {
      enter();
      await new Promise<void>((resolve) => { release = resolve; });
    });
    await entered;
    try {
      await expect(continueOwnedCodexSession(successor.sessionKey!, 'Resume during lifecycle ownership.')).resolves.toMatchObject({
        ok: false, sideEffect: 'none', note: expect.stringContaining('another lifecycle operation'),
      });
      runInherited();
      await expect(inheritedAttempt).resolves.toMatchObject({
        ok: false, sideEffect: 'none', note: expect.stringContaining('another lifecycle operation'),
      });
      expect(existsSync(spawnReceipt)).toBe(false);
    } finally { release(); await held; }
    finished = true;
  }, 30_000);

  it('expires inherited publication authority after its original mutation has completed', async () => {
    finished = false;
    const { findLatestLaneByPacket } = await import('@/lib/lane/registry');
    const { withPacketLifecycleMutationLock } = await import('@/lib/orchestrator/lifecycle-mutation-lock');
    const { withWorkspaceMaterializedMutation } = await import('@/lib/workspace/mutation-materialization-guard');
    const successor = findLatestLaneByPacket('preservation-interrupted')!;
    const publication = path.join(successor.worktreePath!, 'expired-authority-write');
    let runInherited!: () => void;
    let begin!: () => void;
    const began = new Promise<void>((resolve) => { begin = resolve; });
    let inheritedAttempt!: Promise<void>;
    await withWorkspaceMaterializedMutation(successor, async () => {
      inheritedAttempt = (async () => {
        await new Promise<void>((resolve) => { runInherited = resolve; });
        begin();
        await withWorkspaceMaterializedMutation(successor, async () => { writeFileSync(publication, 'unsafe'); });
      })();
      void inheritedAttempt.catch(() => {});
    });
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const held = withPacketLifecycleMutationLock('preservation-interrupted', async () => {
      enter();
      await new Promise<void>((resolve) => { release = resolve; });
    });
    await entered;
    try { runInherited(); await began; } finally { release(); await held; }
    await expect(inheritedAttempt).rejects.toThrow('Another workspace lifecycle mutation ran first');
    expect(existsSync(publication)).toBe(false);
    finished = true;
  }, 30_000);

  it('refuses newer ignored content when replaying discard from its old retiring archive', async () => {
    finished = false;
    const repo = await addRepo(repoPath);
    const source = await ownedWorkspace(repo, 'preservation-discard-replay', 'main');
    mkdirSync(path.join(source.workspacePath, '.o8'));
    const proof = path.join(source.workspacePath, '.o8', 'proof.bin');
    writeFileSync(proof, Buffer.from([0, 255, 81]), { mode: 0o400 });
    const { prepareWorkspaceMaterializationRetirement } = await import('@/lib/workspace/workspace-materialization-retirement');
    await prepareWorkspaceMaterializationRetirement(repo.localPath, source.workspacePath, 'discard');
    expect(getWorkspaceSnapshot(repo.id, 'preservation-discard-replay')?.state).toBe('retiring');
    chmodSync(proof, 0o600);
    const newer = Buffer.from([9, 255, 0, 82]);
    writeFileSync(proof, newer);
    writeFileSync(path.join(source.workspacePath, '.o8', 'newer-note.md'), 'Newer unique recovery bytes.');
    closeDb();
    const { discardExactManagedWorktree } = await import('@/lib/workspace/exact-discard');
    const { probeOwnedSessionProcessQuiescence } = await import('@/lib/workspace/process-probes');
    await expect(discardExactManagedWorktree({ lane: source.lane, worktreeId: source.worktreeId,
      isolationKind: 'git-worktree', processProbe: probeOwnedSessionProcessQuiescence })).rejects.toThrow();
    expect(readFileSync(proof)).toEqual(newer);
    expect(readFileSync(path.join(source.workspacePath, '.o8', 'newer-note.md'), 'utf8')).toBe('Newer unique recovery bytes.');
    expect(git(source.workspacePath, 'rev-parse', 'HEAD')).toBe(git(repo.localPath, 'rev-parse', 'main'));
    finished = true;
  }, 30_000);

  it('keeps an earlier rolled-back archive historical after confirmed missing-source cleanup', async () => {
    finished = false;
    const repo = await addRepo(repoPath);
    const source = await ownedWorkspace(repo, 'preservation-missing-after-rollback', 'main');
    mkdirSync(path.join(source.workspacePath, '.o8'));
    const original = 'Earlier captured content.\n';
    writeFileSync(path.join(source.workspacePath, '.o8', 'resume.md'), original);
    const { prepareWorkspaceMaterializationRetirement, rollbackWorkspaceMaterializationRetirement,
      getWorkspaceRetirementPreservationId } = await import('@/lib/workspace/workspace-materialization-retirement');
    await prepareWorkspaceMaterializationRetirement(repo.localPath, source.workspacePath, 'cleanup');
    const earlierId = getWorkspaceRetirementPreservationId(source.workspacePath)!;
    expect(earlierId).toMatch(/^[a-f0-9]{64}$/);
    rollbackWorkspaceMaterializationRetirement(source.workspacePath, 'cleanup', new Error('Interrupted before exact claim admission'));
    expect(getWorkspaceRetirementPreservationId(source.workspacePath)).toBeNull();
    writeFileSync(path.join(source.workspacePath, '.o8', 'resume.md'), 'Later uncaptured content.\n');
    rmSync(source.workspacePath, { recursive: true });
    closeDb();
    expect(await new WorktreeManager(repo.localPath).cleanup(source.worktreeId, { deleteBranch: true })).toBe(true);
    closeDb();
    expect(getWorkspaceSnapshot(repo.id, 'preservation-missing-after-rollback')?.state).toBe('retired');
    expect(getWorkspaceRetirementPreservationId(source.workspacePath)).toBeNull();
    const terminal = listWorkspaceSnapshotTransitions(repo.id, 'preservation-missing-after-rollback')
      .findLast((entry) => entry.toState === 'retired');
    expect(terminal?.receipt).toMatchObject({ sourceMissingAtAdmission: true, preservationUnavailable: 'source-already-absent' });
    expect(terminal?.receipt?.preservationId).toBeUndefined();
    const response = await fetch('http://127.0.0.1:' + port + '/api/orchestrator/workspace/preservation?packetId=preservation-missing-after-rollback', {
      headers: { authorization: 'Bearer ' + token },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'preservation_unavailable' } });
    const { readWorkspacePreservation } = await import('@/lib/workspace/preservation-store');
    const historical = await readWorkspacePreservation(earlierId);
    expect(historical.payload.capture.entries.find((entry) => entry.path === '.o8/resume.md')?.content)
      .toBe(Buffer.from(original).toString('base64'));
    finished = true;
  }, 30_000);

  it('keeps clean standalone create/cleanup working and retains standalone unique ignored bytes', async () => {
    finished = false;
    async function request(method: string, body: Record<string, unknown>) {
      return fetch('http://127.0.0.1:' + port + '/api/worktrees', {
        method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({ repo: repoPath, ...body }),
      });
    }
    for (const unique of [false, true]) {
      const created = await request('POST', { agentType: 'codex', taskName: 'standalone-recovery-' + String(unique),
        baseBranch: 'main', skipSetup: true, envMode: 'skip', isolationPreference: 'git-worktree' });
      expect(created.status, await created.clone().text()).toBe(201);
      const { worktree } = await created.json();
      expect(worktree.id).toBeTruthy();
      const sourceHead = git(worktree.path, 'rev-parse', 'HEAD');
      if (unique) {
        mkdirSync(path.join(worktree.path, '.o8'));
        writeFileSync(path.join(worktree.path, '.o8', 'standalone-note.md'), 'Unique standalone recovery bytes.');
      }
      const cleaned = await request('DELETE', { action: 'cleanup', worktreeId: worktree.id, deleteBranch: true });
      if (unique) {
        expect(cleaned.status).toBe(409);
        expect(readFileSync(path.join(worktree.path, '.o8', 'standalone-note.md'), 'utf8')).toBe('Unique standalone recovery bytes.');
      } else {
        expect(cleaned.status, await cleaned.clone().text()).toBe(200);
        expect(existsSync(worktree.path)).toBe(false);
        const refs = git(repoPath, 'for-each-ref', '--format=%(objectname)', 'refs/o8/recovery/standalone').split('\n');
        expect(refs).toContain(sourceHead);
      }
    }
    finished = true;
  }, 60_000);
});
