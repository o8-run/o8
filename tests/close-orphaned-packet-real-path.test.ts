import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { bindOwnedPacketSession } from './helpers/managed-packet-worktree';

const root = mkdtempSync(path.join(os.tmpdir(), 'o8-orphan-close-'));
const token = 'orphan-close-operator-fixture';
const sessionRoot = path.join(root, 'sessions');
process.env.O8_DATA_DIR = root;
process.env.CORTEX_IDE_DATA_DIR = root;
process.env.O8_WORKTREE_ROOT = path.join(root, 'worktrees');
process.env.CORTEX_IDE_OWNED_CODEX_ROOT = sessionRoot;
writeFileSync(path.join(root, 'ws-token'), token);
const route = await import('@/app/api/orchestrator/discard-packet/route');
const { mintPacketWorkerToken, bindPacketWorkerTokenProcess } = await import('@/lib/auth/packet-worker-token');
const { ownedProcessExitPayload } = await import('@/lib/runtimes/shared/owned-session/helpers');
const { resolveSpawnedProcessGroupId } = await import('@/lib/runtimes/shared/owned-session/run-process-proof');
const { recordLaneEvent } = await import('@/lib/lane/events');
const { recordMission } = await import('@/lib/db/missions-store');
const { closeDb, getSqlite } = await import('@/lib/db');
const { createLane, getLane, getLaneEvents, setLaneStatus } = await import('@/lib/lane/registry');
const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { resetOwnedSessionIndex } = await import('@/lib/runtimes/shared/owned-session-index');
const { withWorktreeMetaTransaction } = await import('@/lib/worktree/metadata-store');
const { captureWorktreeMaterializationIdentity } = await import('@/lib/worktree/materialization-identity');
const { canonicalRepoRoot, resolveWorktreeRootLayout } = await import('@/lib/worktree/root-layout');
const { addRepo } = await import('@/lib/repos/registry');
const { archiveOwnedSessionDir } = await import('@/lib/runtimes/shared/owned-session/archive');
const { handleClosePacketUnmerged } = await import('@/lib/mcp/operator-handlers/close-packet');
const { setApiBase } = await import('@/lib/mcp/operator-handlers/shared');
const exactRetirement = await import('@/lib/workspace/exact-managed-directory-retirement');
const exactPurge = await import('@/lib/workspace/exact-directory-purge');
const { readExactWorkspaceClaim } = await import('@/lib/workspace/exact-workspace-claim-state');
const worktreeCleanup = await import('@/lib/orchestrator/worktree-cleanup');
const { removeMergedWorktree } = worktreeCleanup;
const { exactSnapshot } = await import('@/lib/workspace/workspace-materialization-retirement');
const { preservationIdForSnapshot, readWorkspacePreservation } = await import('@/lib/workspace/preservation-store');
let server: Server;
let base: string;
const children = new Set<ChildProcess>();

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

type SessionState = 'archived' | 'missing' | 'unbound';
async function fixture(sessionState: SessionState) {
  const packetId = `pkt-${randomUUID()}`;
  const repoPath = path.join(root, packetId);
  mkdirSync(repoPath);
  git(repoPath, 'init', '-q', '-b', 'main');
  git(repoPath, 'config', 'user.name', 'o8-test');
  git(repoPath, 'config', 'user.email', 'o8@example.test');
  writeFileSync(path.join(repoPath, 'source.txt'), 'base\n');
  git(repoPath, 'add', 'source.txt');
  git(repoPath, 'commit', '-qm', 'base');
  const branch = `fix/${packetId}`;
  await addRepo(repoPath);
  const worktreeId = `packet-${packetId}`;
  const worktreePath = path.join(resolveWorktreeRootLayout(repoPath).primaryBase, worktreeId);
  mkdirSync(path.dirname(worktreePath), { recursive: true });
  git(repoPath, 'worktree', 'add', '-qb', branch, worktreePath);
  const materializationIdentity = await captureWorktreeMaterializationIdentity(worktreePath);
  const materializationParentIdentity = await captureWorktreeMaterializationIdentity(path.dirname(worktreePath));
  await withWorktreeMetaTransaction(repoPath, (transaction) => transaction.save(worktreeId, {
    id: worktreeId, packetId, agentType: 'codex', baseBranch: 'main', createdAt: Date.now(),
    claudeManaged: false, taskName: packetId, branchName: branch, status: 'ready',
    isolationKind: 'git-worktree', materializationIdentity, materializationParentIdentity,
  }));
  const sessionKey = await bindOwnedPacketSession(repoPath, { id: worktreeId, path: worktreePath }, { packetId, branch });
  const worktree = { id: worktreeId, path: worktreePath, sessionKey };
  writeFileSync(path.join(worktree.path, 'source.txt'), 'completed work\n');
  git(worktree.path, 'commit', '-qam', 'completed work');
  const head = git(worktree.path, 'rev-parse', 'HEAD');
  const lane = createLane({
    repoPath, worktreePath: worktree.path, branch, baseBranch: 'main', runtime: 'codex',
    packetId, sessionKey: sessionState === 'unbound' ? undefined : worktree.sessionKey,
    ownership: 'managed',
  });
  const runMarker = randomUUID();
  const workerToken = mintPacketWorkerToken(packetId, { processMarker: runMarker });
  const worker = spawn(process.execPath, ['-e', 'process.stdin.once("data", () => process.exit(0));process.stdout.write("ready")'], {
    cwd: worktree.path, detached: true, env: { ...process.env, O8_OWNED_RUN_MARKER: runMarker },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(worker);
  const workerClosed = once(worker, 'close');
  await once(worker.stdout!, 'data');
  const processGroupId = await resolveSpawnedProcessGroupId(worker.pid!);
  bindPacketWorkerTokenProcess(workerToken, { pid: worker.pid!, processGroupId, processMarker: runMarker });
  worker.stdin.end('finish');
  const [exitCode] = await workerClosed;
  children.delete(worker);
  expect(exitCode).toBe(0);
  const run = { id: runMarker, mode: 'launch' as const, prompt: 'fixture',
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    pid: worker.pid!, processGroupId, processMarker: runMarker, commandIdentity: 'node',
    spawnState: 'started' as const, outcome: 'finished' as const,
    stdoutPath: path.join(root, 'fixture-output'), stderrPath: path.join(root, 'fixture-error'),
    childExit: { code: 0, signal: null, classification: 'clean-exit' as const } };
  const sessionFile = path.join(sessionRoot, `codex-owned-${packetId}`, 'session.json');
  const session = JSON.parse(readFileSync(sessionFile, 'utf8'));
  writeFileSync(sessionFile, JSON.stringify({ ...session, laneId: lane.id,
    recentRuns: [run], runIdentityLedger: { version: 1, complete: true, totalRuns: 1 } }));
  recordLaneEvent(lane.id, 'runtime_process_exit', 'system', ownedProcessExitPayload(
    'codex', worktree.sessionKey, run, run.childExit, undefined, '',
  ));
  setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
  let archivedRecordPath: string | null = null;
  if (sessionState === 'archived') {
    const archived = await archiveOwnedSessionDir(sessionRoot, JSON.parse(readFileSync(sessionFile, 'utf8')));
    expect(archived.archived).toBe(true);
    archivedRecordPath = path.join(archived.archivePath!, 'session.json');
  } else {
    rmSync(path.join(sessionRoot, `codex-owned-${packetId}`), { recursive: true });
    if (sessionState === 'unbound') {
      await withWorktreeMetaTransaction(repoPath, async (transaction) => {
        const metadata = (await transaction.readAll())[worktree.id];
        await transaction.save(worktree.id, { ...metadata, sessionKey: undefined });
      });
    }
  }
  resetOwnedSessionIndex();
  const mission = writeOrchestratorControlPlaneState({
    ...createEmptyOrchestratorMissionState(), missionId: `mission-${packetId}`, repoPath,
    runtime: 'codex', updatedAt: new Date().toISOString(),
    packets: [{
      id: packetId, referenceLabel: '#4080', title: 'Close an orphaned review packet',
      summary: 'Close persisted review state without a live worker.', workspaceTargetPath: repoPath,
      branchTarget: branch, runtime: 'codex', dependencyLabels: [], dependencyPacketIds: [],
      queueState: 'held', releaseState: 'pending', status: 'awaiting_review', blockedReason: null,
      lane: { tileId: lane.id, tabId: lane.id, laneId: lane.id, repoPath,
        worktreePath: worktree.path, runtime: 'codex', sessionKey: lane.sessionKey }, review: null,
    } as OrchestratorPacket],
  });
  recordMission({ id: mission.missionId!, repoPath, runtime: 'codex', prompt: '', summary: '',
    constraints: '', totalWaves: 1, missionState: mission,
    packetMeta: mission.packets.map(({ id, title, referenceLabel }) => ({ id, title, referenceLabel })),
  });
  return { packetId, repoPath, branch, worktree, lane, head, runMarker, archivedRecordPath };
}

async function httpClose(packetId: string, acknowledgeMissingWorktree = false) {
  return fetch(`${base}/api/orchestrator/discard-packet`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ packetId, disposition: 'superseded', clientMutationId: randomUUID(),
      ...(acknowledgeMissingWorktree ? { acknowledgeMissingWorktree } : {}) }),
  });
}

async function cliClose(packetId: string, command = 'close') {
  const child = spawn(process.execPath, [path.join(process.cwd(), 'cli/dist/o8.mjs'),
    'packet', command, packetId, '--reason', 'superseded', '--json'], {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: '', O8_API_PORT: new URL(base).port, O8_API_TOKEN: token,
      O8_WORKER_TOKEN: '', O8_WORKER_PACKET_ID: '', O8_PACKET_ID: '', O8_LANE_ID: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [exitCode] = await once(child, 'close');
  return { exitCode, stdout, stderr };
}

beforeAll(async () => {
  execFileSync(process.execPath, ['cli/esbuild.config.mjs'], { cwd: process.cwd(), stdio: 'pipe' });
  server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const url = new URL(request.url ?? '/', base);
      const next = new NextRequest(url, { method: request.method,
        headers: request.headers as HeadersInit,
        body: chunks.length ? Buffer.concat(chunks).toString() : undefined });
      let result: Response;
      if (url.pathname === '/api/orchestrator/discard-packet') result = await route.POST(next);
      else if (url.pathname === '/api/setup/status') result = (await import('@/app/api/setup/status/route')).GET();
      else if (url.pathname === '/api/lanes') result = await (await import('@/app/api/lanes/route')).GET(next);
      else result = Response.json({ error: 'Unknown route' }, { status: 404 });
      response.writeHead(result.status, { 'content-type': 'application/json' });
      response.end(await result.text());
    } catch (error) {
      response.writeHead(500);
      response.end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture server address.');
  base = `http://127.0.0.1:${address.port}`;
  writeFileSync(path.join(root, 'api-port'), String(address.port));
  setApiBase(base);
});

afterAll(async () => {
  for (const child of children) {
    const exited = once(child, 'close');
    child.kill();
    await exited;
  }
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

describe('orphaned review packet close through persisted HTTP, CLI and MCP entry points (#4080)', () => {
  for (const sessionState of ['archived', 'missing', 'unbound'] as const) {
    for (const entry of ['http', 'cli'] as const) {
      it(`${entry} retires a clean checkout with ${sessionState} session truth and preserves its commits`, async () => {
        const source = await fixture(sessionState);
        if (entry === 'http') {
          const response = await httpClose(source.packetId);
          const body = await response.json();
          expect(body, JSON.stringify(body)).toMatchObject({ ok: true, result: { closed: true, worktreeRemoved: true } });
          expect(response.status).toBe(200);
        } else {
          const result = await cliClose(source.packetId, sessionState === 'unbound' ? 'discard' : 'close');
          expect(result, result.stderr).toMatchObject({ exitCode: 0 });
        }
        expect(getLane(source.lane.id)?.status).toBe('archived');
        expect(readOrchestratorControlPlaneState().packets[0]?.status).toBe('archived');
        expect(existsSync(source.worktree.path)).toBe(false);
        expect(git(source.repoPath, 'rev-parse', source.branch)).toBe(source.head);
        expect(exactSnapshot(source.worktree.path)?.state).toBe('retired');
      }, 120_000);
    }
  }

  for (const entry of ['http', 'cli'] as const) {
    it(`${entry} retains dirty orphan source without rewriting its HEAD or index`, async () => {
      const source = await fixture(entry === 'http' ? 'archived' : 'missing');
      writeFileSync(path.join(source.worktree.path, 'source.txt'), 'staged work\n');
      git(source.worktree.path, 'add', 'source.txt');
      writeFileSync(path.join(source.worktree.path, 'source.txt'), 'unfinished work\n');
      writeFileSync(path.join(source.worktree.path, 'untracked.txt'), 'untracked work\n');
      if (entry === 'http') {
        const response = await httpClose(source.packetId);
        expect(response.status).toBe(409);
      } else {
        expect((await cliClose(source.packetId)).exitCode).not.toBe(0);
      }
      expect(existsSync(source.worktree.path)).toBe(true);
      expect(git(source.worktree.path, 'rev-parse', 'HEAD')).toBe(source.head);
      expect(git(source.worktree.path, 'show', ':source.txt')).toBe('staged work');
      expect(readFileSync(path.join(source.worktree.path, 'source.txt'), 'utf8')).toBe('unfinished work\n');
      expect(readFileSync(path.join(source.worktree.path, 'untracked.txt'), 'utf8')).toBe('untracked work\n');
    }, 120_000);
  }

  for (const interruption of ['after-rename', 'purging-replay'] as const) {
    it(`refuses unbanked source at ${interruption} and retains the exact claim`, async () => {
      const source = await fixture('missing');
      const retire = exactRetirement.retireExactManagedDirectory;
      const interception = vi.spyOn(exactRetirement, 'retireExactManagedDirectory').mockImplementation((input) => retire({
        ...input,
        ...{ [interruption === 'after-rename' ? 'afterRetirementRename' : 'beforeRetirementPurge']: async () => {
          const claim = readExactWorkspaceClaim('managed-retirement', canonicalRepoRoot(source.repoPath), source.worktree.id)!;
          if (interruption === 'purging-replay' && claim.state !== 'purging') return;
          writeFileSync(path.join(claim.claimPath, 'source.txt'), 'late unbanked work\n');
          if (interruption === 'after-rename') writeFileSync(path.join(claim.claimPath, 'late-untracked.txt'), 'late untracked work\n');
          if (interruption === 'purging-replay') throw new Error('Injected interruption with an unbanked purging claim.');
        } },
      }));
      try {
        let response = await httpClose(source.packetId);
        if (interruption === 'purging-replay') {
          expect(response.status).toBe(409);
          expect(readExactWorkspaceClaim('managed-retirement', canonicalRepoRoot(source.repoPath), source.worktree.id)?.state).toBe('purging');
          interception.mockRestore();
          response = await httpClose(source.packetId);
        }
        const body = await response.json();
        expect(response.status).toBe(409);
        expect(body.error.message).toMatch(/unbanked source|source.*uncertain/i);
        const claim = readExactWorkspaceClaim('managed-retirement', canonicalRepoRoot(source.repoPath), source.worktree.id)!;
        expect(readFileSync(path.join(claim.claimPath, 'source.txt'), 'utf8')).toBe('late unbanked work\n');
        if (interruption === 'after-rename') expect(readFileSync(path.join(claim.claimPath, 'late-untracked.txt'), 'utf8')).toBe('late untracked work\n');
        expect(exactSnapshot(source.worktree.path)?.state).not.toBe('retired');
        expect(git(source.repoPath, 'rev-parse', source.branch)).toBe(source.head);
      } finally { interception.mockRestore(); }
    }, 120_000);
  }

  it('closes a packet whose half-retired checkout is gone only with acknowledgement, leaving the claim untouched', async () => {
    const source = await fixture('missing');
    const retire = exactRetirement.retireExactManagedDirectory;
    const interception = vi.spyOn(exactRetirement, 'retireExactManagedDirectory').mockImplementation((input) => retire({
      ...input,
      beforeRetirementPurge: async () => { throw new Error('Injected interruption after the checkout was renamed.'); },
    }));
    let claimPath: string;
    try {
      expect((await httpClose(source.packetId)).status).toBe(409);
      const claim = readExactWorkspaceClaim('managed-retirement', canonicalRepoRoot(source.repoPath), source.worktree.id)!;
      claimPath = claim.claimPath;
    } finally { interception.mockRestore(); }
    // The renamed checkout is later lost too: nothing is left to retire.
    rmSync(claimPath, { recursive: true, force: true });
    expect(existsSync(source.worktree.path)).toBe(false);

    const refused = await httpClose(source.packetId);
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.message).toMatch(/retirement|unbanked source|uncertain/i);
    expect(getLane(source.lane.id)?.status).not.toBe('archived');

    const closed = await httpClose(source.packetId, true);
    const body = await closed.json();
    expect(closed.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.result.worktreeCleanup).toBe('missing');
    expect(getLane(source.lane.id)?.status).toBe('archived');
    expect(getLaneEvents(source.lane.id).some((event) => event.payload.code === 'worktree_missing_acknowledged')).toBe(true);
    // The retirement journal and the branch's committed work are left as they were.
    expect(readExactWorkspaceClaim('managed-retirement', canonicalRepoRoot(source.repoPath), source.worktree.id)).not.toBeNull();
    expect(git(source.repoPath, 'rev-parse', source.branch)).toBe(source.head);
  }, 120_000);

  it('keeps clean-source refusal when a warm orphan context resumes a claim without an orphan descriptor', async () => {
    const source = await fixture('missing');
    const retire = exactRetirement.retireExactManagedDirectory;
    const interception = vi.spyOn(exactRetirement, 'retireExactManagedDirectory').mockImplementation(input => retire({
      ...input, afterRetirementRename: async () => {
        const claim = readExactWorkspaceClaim('managed-retirement', canonicalRepoRoot(source.repoPath), source.worktree.id)!;
        const authority = { ...claim.authority };
        delete authority.orphanCloseOwner;
        // Model an earlier ordinary retirement that did not persist orphan authority.
        getSqlite().prepare(`UPDATE workspace_exact_claims SET authority_json = ?
          WHERE kind = 'managed-retirement' AND repository_path = ? AND worktree_id = ? AND operation_id = ?`)
          .run(JSON.stringify(authority), canonicalRepoRoot(source.repoPath), source.worktree.id, claim.operationId);
        writeFileSync(path.join(claim.claimPath, 'source.txt'), 'late unbanked warm-context source\n');
      },
    }));
    try {
      const response = await httpClose(source.packetId);
      const body = await response.json();
      expect(response.status).toBe(409);
      expect(body.error.message).toMatch(/unbanked source|source.*uncertain/i);
      const claim = readExactWorkspaceClaim('managed-retirement', canonicalRepoRoot(source.repoPath), source.worktree.id)!;
      expect(readFileSync(path.join(claim.claimPath, 'source.txt'), 'utf8')).toBe('late unbanked warm-context source\n');
      expect(exactSnapshot(source.worktree.path)?.state).not.toBe('retired');
      expect(git(source.repoPath, 'rev-parse', source.branch)).toBe(source.head);
    } finally { interception.mockRestore(); }
  }, 120_000);

  it('checks the paused purge seam for a warm orphan claim without its persisted descriptor', async () => {
    const source = await fixture('missing');
    const retire = exactRetirement.retireExactManagedDirectory;
    const purge = exactPurge.purgeExactDirectory;
    let holder: ChildProcess | undefined;
    const retirement = vi.spyOn(exactRetirement, 'retireExactManagedDirectory').mockImplementation(input => retire({
      ...input, afterRetirementRename: async () => {
        const claim = readExactWorkspaceClaim('managed-retirement', canonicalRepoRoot(source.repoPath), source.worktree.id)!;
        const authority = { ...claim.authority };
        delete authority.orphanCloseOwner;
        getSqlite().prepare(`UPDATE workspace_exact_claims SET authority_json = ?
          WHERE kind = 'managed-retirement' AND repository_path = ? AND worktree_id = ? AND operation_id = ?`)
          .run(JSON.stringify(authority), canonicalRepoRoot(source.repoPath), source.worktree.id, claim.operationId);
      },
    }));
    const capture = vi.spyOn(exactPurge, 'purgeExactDirectory').mockImplementation((candidate, identity, before, after, ...rest) =>
      purge(candidate, identity, before, async (capturedPath, witness) => {
        holder = spawn(process.execPath, ['-e', `
          const fs = require('node:fs');
          const fd = fs.openSync(process.argv[1], 'r+');
          fs.writeFileSync(fd, 'late warm orphan bytes');
          fs.ftruncateSync(fd, 22);
          process.stdout.write('ready');
          process.stdin.on('data', () => {
            const bytes = Buffer.alloc(fs.fstatSync(fd).size);
            fs.readSync(fd, bytes, 0, bytes.length, 0);
            process.stdout.write(JSON.stringify({ content: bytes.toString() }));
          });
        `, path.join(capturedPath, 'source.txt')], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
        children.add(holder);
        await once(holder.stdout!, 'data');
        await after?.(capturedPath, witness);
      }, ...rest));
    try {
      const response = await httpClose(source.packetId);
      const body = await response.json();
      expect(response.status).toBe(409);
      expect(body.error.message).toContain(String(holder?.pid));
      const observed = once(holder!.stdout!, 'data');
      holder!.stdin!.write('inspect');
      const [bytes] = await observed;
      expect(JSON.parse(bytes.toString()).content).toBe('late warm orphan bytes');
      expect(exactSnapshot(source.worktree.path)?.state).not.toBe('retired');
    } finally {
      retirement.mockRestore();
      capture.mockRestore();
      if (holder) {
        const closed = once(holder, 'close');
        holder.kill();
        await closed;
        children.delete(holder);
      }
    }
  }, 120_000);

  it('retains bytes written through a live descriptor after the purge helper captures the tree (P1-a)', async () => {
    const source = await fixture('missing');
    const purge = exactPurge.purgeExactDirectory;
    let holder: ChildProcess | undefined;
    const late = 'external late writer after helper capture\n';
    const interception = vi.spyOn(exactPurge, 'purgeExactDirectory').mockImplementation((candidate, identity, before, after, ...rest) =>
      purge(candidate, identity, before, async (capturedPath, witness) => {
        holder = spawn(process.execPath, ['-e', `
          const fs = require('node:fs');
          const fd = fs.openSync(process.argv[1], 'r+');
          const bytes = Buffer.from(process.argv[2]);
          fs.writeSync(fd, bytes, 0, bytes.length, 0);
          fs.ftruncateSync(fd, bytes.length);
          process.stdout.write('ready');
          process.stdin.on('data', () => {
            const observed = Buffer.alloc(fs.fstatSync(fd).size);
            fs.readSync(fd, observed, 0, observed.length, 0);
            process.stdout.write(JSON.stringify({ content: observed.toString() }));
          });
        `, path.join(capturedPath, 'source.txt'), late], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
        children.add(holder);
        await once(holder.stdout!, 'data');
        await after?.(capturedPath, witness);
      }, ...rest));
    try {
      const response = await httpClose(source.packetId);
      const body = await response.json();
      const observed = once(holder!.stdout!, 'data');
      holder!.stdin!.write('inspect');
      const [bytes] = await observed;
      expect.soft(JSON.parse(bytes.toString()).content).toBe(late);
      expect.soft(response.status).toBe(409);
      if (response.status === 409) expect(body.error.message).toContain(String(holder?.pid));
      const claim = readExactWorkspaceClaim('managed-retirement', canonicalRepoRoot(source.repoPath), source.worktree.id);
      expect.soft(claim && existsSync(claim.claimPath)).toBe(true);
      expect(exactSnapshot(source.worktree.path)?.state).not.toBe('retired');
      expect(git(source.repoPath, 'rev-parse', source.branch)).toBe(source.head);
    } finally {
      interception.mockRestore();
      if (holder) {
        const closed = once(holder, 'close');
        holder.kill();
        await closed;
        children.delete(holder);
      }
    }
  }, 120_000);

  it.each(['live holder', 'inconclusive probe'] as const)(
    'refuses %s arriving after purge settlement before final removal', async (evidence) => {
      const source = await fixture('missing');
      const purge = exactPurge.purgeExactDirectory;
      let holder: ChildProcess | undefined;
      const originalPath = process.env.PATH;
      const interception = vi.spyOn(exactPurge, 'purgeExactDirectory').mockImplementation(
        (candidate, identity, before, captured, released, ...rest) => purge(candidate, identity, before, captured,
          async (candidatePath) => {
            // Native content release and helper close have already completed.
            // Enter the still-owned empty claim before its final authority check.
            if (evidence === 'live holder') {
              holder = spawn(process.execPath, ['-e', 'process.stdout.write("ready");process.stdin.resume();'], {
                cwd: candidatePath, stdio: ['pipe', 'pipe', 'pipe'],
              });
              children.add(holder);
              await once(holder.stdout!, 'data');
            } else {
              const shims = path.join(root, 'final-probe-shim-' + randomUUID());
              mkdirSync(shims);
              const shim = path.join(shims, 'lsof');
              writeFileSync(shim, '#!/bin/sh\nprintf "native coverage unavailable" >&2\nexit 1\n');
              chmodSync(shim, 0o755);
              process.env.PATH = shims + path.delimiter + originalPath;
            }
            await released?.(candidatePath);
          }, ...rest),
      );
      try {
        const response = await httpClose(source.packetId);
        const body = await response.json();
        expect(response.status, JSON.stringify(body)).toBe(409);
        expect(body.error.code).toBe('close_failed');
        if (holder) expect(body.error.message).toContain(String(holder.pid));
        else expect(body.error.message).toMatch(/lsof.*unavailable or inconclusive/);
        const claim = readExactWorkspaceClaim('managed-retirement', canonicalRepoRoot(source.repoPath), source.worktree.id)!;
        expect(claim.state).toBe('purging');
        expect(existsSync(claim.claimPath)).toBe(true);
        expect(statSync(claim.claimPath).ino).toBe(claim.sourceIdentity?.inode);
        expect(getLane(source.lane.id)?.status).not.toBe('archived');
        expect(exactSnapshot(source.worktree.path)?.state).not.toBe('retired');
      } finally {
        process.env.PATH = originalPath;
        interception.mockRestore();
        if (holder) {
          const closed = once(holder, 'close');
          holder.stdin!.end();
          await closed;
          children.delete(holder);
        }
      }
    }, 120_000,
  );

  it.each(['--skip-worktree', '--assume-unchanged'] as const)(
    'keeps the original source-revision refusal for %s through HTTP, CLI and MCP', async (flag) => {
      const source = await fixture('missing');
      const retire = exactRetirement.retireExactManagedDirectory;
      const interception = vi.spyOn(exactRetirement, 'retireExactManagedDirectory').mockImplementation(input => retire({
        ...input, afterRetirementRename: async () => {
          const claim = readExactWorkspaceClaim('managed-retirement', canonicalRepoRoot(source.repoPath), source.worktree.id)!;
          git(claim.claimPath, 'update-index', flag, 'source.txt');
        },
      }));
      try {
        const response = await httpClose(source.packetId);
        const body = await response.json();
        expect(response.status).toBe(409);
        expect(body.error).toEqual({
          code: 'close_failed',
          message: 'Close refused: unbanked source or uncertain source/snapshot revision; preserve the edits before retrying. The checkout remains held.',
        });
        const cli = await cliClose(source.packetId);
        expect(cli.exitCode).not.toBe(0);
        expect(JSON.parse(cli.stderr.trim()).error).toMatchObject(body.error);
        const mcp = await handleClosePacketUnmerged({ packetId: source.packetId, disposition: 'superseded' });
        expect(mcp.isError).toBe(true);
        expect(JSON.parse((mcp.content[0] as { text: string }).text)).toMatchObject({ error: body.error });
        const claim = readExactWorkspaceClaim('managed-retirement', canonicalRepoRoot(source.repoPath), source.worktree.id)!;
        expect(readFileSync(path.join(claim.claimPath, 'source.txt'), 'utf8')).toBe('completed work\n');
        expect(git(claim.claimPath, 'ls-files', '-v', 'source.txt')).toMatch(/^[Sh] /);
        expect(exactSnapshot(source.worktree.path)?.state).not.toBe('retired');
      } finally { interception.mockRestore(); }
    }, 120_000,
  );

  it('refuses a forged purge helper witness without releasing captured bytes', async () => {
    const source = await fixture('missing');
    const purge = exactPurge.purgeExactDirectory;
    const interception = vi.spyOn(exactPurge, 'purgeExactDirectory').mockImplementation((candidate, identity, before, after, ...rest) =>
      purge(candidate, identity, before, async (capturedPath, witness) => {
        expect(after).toBeTypeOf('function');
        await after!(capturedPath, Object.create(witness) as typeof witness);
      }, ...rest));
    try {
      const response = await httpClose(source.packetId);
      const body = await response.json();
      expect(response.status).toBe(409);
      expect(body.error.message).toMatch(/paused purge helper.*(unavailable|inconclusive)/);
      const claim = readExactWorkspaceClaim('managed-retirement', canonicalRepoRoot(source.repoPath), source.worktree.id)!;
      expect(readFileSync(path.join(claim.claimPath, 'source.txt'), 'utf8')).toBe('completed work\n');
      expect(exactSnapshot(source.worktree.path)?.state).not.toBe('retired');
      expect(git(source.repoPath, 'rev-parse', source.branch)).toBe(source.head);
    } finally { interception.mockRestore(); }
  }, 120_000);

  it('refuses a same-inode unique ignored-file edit before purging replay (P1-b)', async () => {
    const source = await fixture('missing');
    const relative = '.orphan-note';
    writeFileSync(path.join(source.worktree.path, '.gitignore'), `${relative}\n`);
    git(source.worktree.path, 'add', '.gitignore');
    git(source.worktree.path, 'commit', '-qm', 'fixture ignored artifact');
    const head = git(source.worktree.path, 'rev-parse', 'HEAD');
    writeFileSync(path.join(source.worktree.path, relative), 'captured ignored bytes\n');
    expect(git(source.worktree.path, 'status', '--porcelain')).toBe('');
    const retire = exactRetirement.retireExactManagedDirectory;
    const interception = vi.spyOn(exactRetirement, 'retireExactManagedDirectory').mockImplementation((input) => retire({
      ...input, beforeRetirementPurge: async () => {
        const claim = readExactWorkspaceClaim('managed-retirement', canonicalRepoRoot(source.repoPath), source.worktree.id)!;
        if (claim.state === 'purging') throw new Error('Injected interruption before ignored-content release.');
      },
    }));
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const interrupted = await httpClose(source.packetId);
        expect(interrupted.status).toBe(409);
        if (readExactWorkspaceClaim('managed-retirement', canonicalRepoRoot(source.repoPath), source.worktree.id)?.state === 'purging') break;
        // A disappearing native process can make lsof refuse before the test
        // reaches its interruption. Only that safe refusal permits setup retry.
        const body = await interrupted.json();
        expect(body.error.message).toMatch(/lsof.*(incomplete|inconclusive)/);
        expect(existsSync(source.worktree.path)).toBe(true);
      }
      interception.mockRestore();
      const claim = readExactWorkspaceClaim('managed-retirement', canonicalRepoRoot(source.repoPath), source.worktree.id)!;
      expect(claim.state).toBe('purging');
      const artifactPath = path.join(claim.claimPath, relative);
      const inode = statSync(artifactPath).ino;
      writeFileSync(artifactPath, 'new unbanked ignored bytes\n');
      expect(statSync(artifactPath).ino).toBe(inode);
      const snapshot = exactSnapshot(source.worktree.path)!;
      const { payload } = await readWorkspacePreservation(preservationIdForSnapshot(snapshot)!);
      const captured = payload.capture.entries.find((entry) => entry.path === relative)!;
      expect(Buffer.from(captured.content!, 'base64').toString()).toBe('captured ignored bytes\n');
      const response = await httpClose(source.packetId);
      const body = await response.json();
      expect.soft(response.status).toBe(409);
      expect.soft(existsSync(artifactPath)).toBe(true);
      if (existsSync(artifactPath)) expect(readFileSync(artifactPath, 'utf8')).toBe('new unbanked ignored bytes\n');
      if (response.status === 409) expect(body.error.message).toMatch(/ignored.*(changed|uncertain)|preserv.*content/i);
      expect(exactSnapshot(source.worktree.path)?.state).not.toBe('retired');
      expect(git(source.repoPath, 'rev-parse', source.branch)).toBe(head);
    } finally { interception.mockRestore(); }
  }, 120_000);

  for (const holder of ['cwd', 'open-file', 'escaped-marker', 'revoked-marker', 'archived-cwd', 'archived-marker'] as const) {
    it(`HTTP, CLI and MCP refuse a live ${holder} process with the same code and message`, async () => {
      const source = await fixture(holder.startsWith('archived') ? 'archived' : 'missing');
      if (holder === 'revoked-marker') getSqlite().prepare('UPDATE worker_tokens SET revoked_at = ? WHERE packet_id = ?').run(new Date().toISOString(), source.packetId);
      const script = holder === 'open-file'
        ? 'require("node:fs").openSync(process.argv[1], "r");process.stdout.write("ready");setInterval(() => {}, 1000)'
        : 'process.stdout.write("ready");setInterval(() => {}, 1000)';
      const child = spawn(process.execPath, ['-e', script, path.join(source.worktree.path, 'source.txt')], {
        cwd: holder.endsWith('cwd') ? source.worktree.path : root,
        env: { ...process.env, ...(holder.endsWith('marker') ? { O8_OWNED_RUN_MARKER: source.runMarker } : {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.add(child);
      await once(child.stdout!, 'data');
      const response = await httpClose(source.packetId);
      const body = await response.json();
      const cli = await cliClose(source.packetId);
      const mcp = await handleClosePacketUnmerged({ packetId: source.packetId, disposition: 'superseded' });
      expect(response.status).toBe(409);
      expect(body.error.message).toContain(String(child.pid));
      expect(cli.exitCode).not.toBe(0);
      const cliError = JSON.parse(cli.stderr.trim()).error;
      expect(cliError).toMatchObject(body.error);
      expect(mcp.isError).toBe(true);
      expect(mcp.content[0]?.type).toBe('text');
      expect(JSON.parse((mcp.content[0] as { text: string }).text)).toMatchObject({ error: body.error });
      expect(getLane(source.lane.id)?.status).not.toBe('archived');
      expect(existsSync(source.worktree.path)).toBe(true);
      const exited = once(child, 'close');
      child.kill();
      await exited;
      children.delete(child);
      const retry = await httpClose(source.packetId);
      expect(await retry.json()).toMatchObject({ ok: true, result: { closed: true } });
      expect(existsSync(source.worktree.path)).toBe(false);
    }, 120_000);
  }
  it('keeps ordinary cleanup closed to orphan authority', async () => {
    const source = await fixture('missing');
    expect(await removeMergedWorktree(source.lane)).toMatchObject({ removed: false });
    expect(existsSync(source.worktree.path)).toBe(true);
  });

  for (const protocol of ['failed', 'partial'] as const) {
    it(`names ${protocol} native open-file evidence and keeps the checkout`, async () => {
      const source = await fixture('missing');
      const shims = path.join(root, 'probe-shims-' + protocol);
      mkdirSync(shims);
      const shim = path.join(shims, 'lsof');
      writeFileSync(shim, protocol === 'failed'
        ? '#!/bin/sh\nprintf "p123\\ncnode\\nf3\\nn/partial\\n"\nprintf "permission denied" >&2\nexit 1\n'
        : '#!/bin/sh\nprintf "p123\\ncnode\\nf3\\nn/unrelated\\np456\\ncnode\\nf4\\n"\nexit 0\n');
      chmodSync(shim, 0o755);
      const originalPath = process.env.PATH;
      try {
        process.env.PATH = shims + path.delimiter + originalPath;
        const response = await httpClose(source.packetId);
        const body = await response.json();
        expect(response.status).toBe(409);
        expect(body.error.message).toMatch(/lsof.*unavailable or inconclusive|lsof.*incomplete/);
        expect(existsSync(source.worktree.path)).toBe(true);
      } finally { process.env.PATH = originalPath; }
    });
  }

  it('holds a renamed retirement for a late process, then revalidates its durable authority on retry', async () => {
    const source = await fixture('missing');
    const retire = exactRetirement.retireExactManagedDirectory;
    let holder: ChildProcess | undefined;
    const interception = vi.spyOn(exactRetirement, 'retireExactManagedDirectory').mockImplementation((input) => retire({
      ...input,
      afterRetirementRename: async () => {
        const claim = readExactWorkspaceClaim('managed-retirement', canonicalRepoRoot(source.repoPath), source.worktree.id)!;
        holder = spawn(process.execPath, ['-e', 'process.stdout.write("ready");setInterval(() => {}, 1000)'], {
          cwd: claim.claimPath, stdio: ['ignore', 'pipe', 'pipe'],
        });
        children.add(holder);
        await once(holder.stdout!, 'data');
      },
    }));
    try {
      const response = await httpClose(source.packetId);
      const body = await response.json();
      expect(response.status).toBe(409);
      expect(body.error.message).toContain(String(holder?.pid));
      const claim = readExactWorkspaceClaim('managed-retirement', canonicalRepoRoot(source.repoPath), source.worktree.id)!;
      expect(existsSync(source.worktree.path)).toBe(false);
      expect(existsSync(claim.claimPath)).toBe(true);
      expect(getLane(source.lane.id)?.status).not.toBe('archived');
      expect(git(source.repoPath, 'rev-parse', source.branch)).toBe(source.head);
      interception.mockRestore();
      const exited = once(holder!, 'close');
      holder!.kill();
      await exited;
      children.delete(holder!);
      const retry = await httpClose(source.packetId);
      expect(await retry.json()).toMatchObject({ ok: true, result: { closed: true, worktreeRemoved: true } });
      expect(existsSync(claim.claimPath)).toBe(false);
      expect(getLane(source.lane.id)?.status).toBe('archived');
      expect(exactSnapshot(source.worktree.path)?.state).toBe('retired');
    } finally { interception.mockRestore(); }
  }, 120_000);

  for (const interruption of ['after-cleanup', 'before-claim-completion'] as const) {
    it(`finishes close after ${interruption} without recovering deletion authority`, async () => {
      const source = await fixture('missing');
      const cleanup = worktreeCleanup.removeMergedWorktree;
      const interception = interruption === 'after-cleanup'
        ? vi.spyOn(worktreeCleanup, 'removeMergedWorktree').mockImplementation(async (...args) => {
          const result = await cleanup(...args);
          if (result.removed) throw new Error('Injected failure after actual retirement.');
          return result;
        })
        : vi.spyOn(exactRetirement, 'completeExactManagedDirectoryRetirement').mockImplementation(() => {
          throw new Error('Injected interruption before clearing a completed exact claim.');
        });
      try {
        const response = await httpClose(source.packetId);
        expect(response.status).toBe(409);
        expect(existsSync(source.worktree.path)).toBe(false);
        expect(exactSnapshot(source.worktree.path)?.state).toBe('retired');
        expect(getLane(source.lane.id)?.status).toBe('archived');
        interception.mockRestore();
        const retry = await httpClose(source.packetId);
        expect(await retry.json()).toMatchObject({ ok: true, result: { closed: true } });
        expect(readOrchestratorControlPlaneState().packets[0]?.status).toBe('archived');
        expect(git(source.repoPath, 'rev-parse', source.branch)).toBe(source.head);
      } finally { interception.mockRestore(); }
    }, 120_000);
  }

  for (const mismatch of ['cwd', 'surfaceId', 'sessionDir', 'ledger'] as const) {
    it(`refuses inconsistent archived ${mismatch} identity`, async () => {
      const source = await fixture('archived');
      const record = JSON.parse(readFileSync(source.archivedRecordPath!, 'utf8'));
      if (mismatch === 'ledger') record.runIdentityLedger.complete = false;
      else record[mismatch] = mismatch === 'surfaceId' ? 'codex-owned:other' : source.repoPath;
      writeFileSync(source.archivedRecordPath!, JSON.stringify(record));
      resetOwnedSessionIndex();
      const response = await httpClose(source.packetId);
      const body = await response.json();
      expect(response.status).toBe(409);
      expect(body.error.message).toMatch(/archived|ownership/i);
      expect(existsSync(source.worktree.path)).toBe(true);
      expect(git(source.repoPath, 'rev-parse', source.branch)).toBe(source.head);
    });
  }

  for (const missing of ['run-identity', 'process-group', 'newer-launch', 'unbound-run', 'too-many-runs', 'controlled-exit', 'pid-reuse'] as const) {
    it(`refuses uncertain ${missing} evidence and preserves the checkout`, async () => {
      const source = await fixture('missing');
      if (missing === 'run-identity') getSqlite().prepare('DELETE FROM worker_tokens WHERE packet_id = ?').run(source.packetId);
      if (missing === 'process-group') getSqlite().prepare('UPDATE worker_tokens SET lease_process_group_id = NULL WHERE packet_id = ?').run(source.packetId);
      if (missing === 'newer-launch') recordLaneEvent(source.lane.id, 'status_change', 'system', { status: 'launching' });
      if (missing === 'unbound-run') mintPacketWorkerToken(source.packetId, { processMarker: randomUUID() });
      if (missing === 'too-many-runs') for (let count = 0; count < 16; count++) mintPacketWorkerToken(source.packetId, { processMarker: randomUUID() });
      if (missing === 'pid-reuse') getSqlite().prepare('UPDATE worker_tokens SET lease_process_pid = ? WHERE packet_id = ?').run(process.pid, source.packetId);
      if (missing === 'controlled-exit') recordLaneEvent(source.lane.id, 'runtime_process_exit', 'system', { runId: randomUUID(), runtime: 'codex', surfaceId: source.worktree.sessionKey });
      const response = await httpClose(source.packetId);
      const body = await response.json();
      expect(response.status).toBe(409);
      expect(body.error.message).toMatch(/identity|process.group|launch|run bound/i);
      expect(existsSync(source.worktree.path)).toBe(true);
      expect(getLane(source.lane.id)?.status).not.toBe('archived');
    });
  }
});
