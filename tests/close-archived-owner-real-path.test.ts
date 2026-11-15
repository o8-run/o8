import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { OwnedSessionRecord, ParsedRunLog } from '@/lib/runtimes/shared/owned-session/types';

vi.mock('@/lib/runtimes/shared/dispatch-readiness', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/runtimes/shared/dispatch-readiness')>(),
  ensureDispatchBackendReady: async () => ({ ready: true }),
}));
// Keep terminal cleanup from racing the explicit Close endpoint under test.
const cleanupMode = vi.hoisted(() => ({ automatic: false }));
vi.mock('@/lib/lane/terminal-lane-cleanup', async original => {
  const actual = await original<typeof import('@/lib/lane/terminal-lane-cleanup')>();
  return { ...actual, scheduleTerminalLaneCleanup: (...args: Parameters<typeof actual.scheduleTerminalLaneCleanup>) => {
    if (cleanupMode.automatic) actual.scheduleTerminalLaneCleanup(...args);
  } };
});

const root = mkdtempSync(join(os.tmpdir(), 'o8-archived-close-'));
const ownedRoot = join(root, 'owned-codex');
const operatorToken = 'archived-close-operator-fixture-0123456789';
process.env.O8_DATA_DIR = root;
process.env.CORTEX_IDE_DATA_DIR = root;
process.env.O8_WORKTREE_ROOT = join(root, 'worktrees');
process.env.CORTEX_IDE_OWNED_CODEX_ROOT = ownedRoot;
process.env.O8_TEST_ARCHIVED_CLOSE_BIN = process.execPath;
writeFileSync(join(root, 'ws-token'), `${operatorToken}\n`);

await import('@/lib/runtimes');
const closeRoute = await import('@/app/api/orchestrator/discard-packet/route');
const { closeDb } = await import('@/lib/db');
const { createOwnedSessionStore } = await import('@/lib/runtimes/shared/owned-session/store');
const { attachSession, createLane, getLane, getLaneEvents, setLaneStatus, updateLane } = await import('@/lib/lane/registry');
const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const worktreeCleanup = await import('@/lib/orchestrator/worktree-cleanup');
const { listStoredPacketReceipts } = await import('@/lib/receipts/packet-receipt');
const { addRepo } = await import('@/lib/repos/registry');
const { captureWorktreeMaterializationIdentity } = await import('@/lib/worktree/materialization-identity');
const { withWorktreeMetaTransaction } = await import('@/lib/worktree/metadata-store');
const { resolveWorktreeRootLayout } = await import('@/lib/worktree/root-layout');

const { codexParseRunLog } = await import('@/lib/codex/owned-log');

// Simulated provider output, real owned-process lifecycle and persisted exit evidence.
const store = createOwnedSessionStore({
  runtimeId: 'codex', surfaceIdPrefix: 'codex-owned:',
  rootEnvVar: 'CORTEX_IDE_OWNED_CODEX_ROOT', rootDefault: ownedRoot,
  binaryName: 'node', binaryEnvOverride: 'O8_TEST_ARCHIVED_CLOSE_BIN',
  humanLabel: 'Archived close fixture', squadShortName: 'CloseFixture',
  sessionIdPrefix: 'codex-owned-archived-close-',
  launchArgs: request => ['-e', request.prompt.includes('review-fixture')
    ? `console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'done <self-review>'+JSON.stringify({passed:true,confidence:'high',summary:'Review complete',outcome:'The reviewed change meets the request.',evidence:['Inspected the pinned commit and its tests.'],residual:'none',decision:'finding_ready',recurrenceProtection:'none'})+'</self-review>'}})); console.log(JSON.stringify({type:'turn.completed'}));`
    : 'process.stdout.write("done\\n");'],
  resumeArgs: () => null,
  parseRunLog: (raw, run): ParsedRunLog => ({
    entries: codexParseRunLog(raw, run).entries, outcome: raw.includes('done') ? 'finished' : 'running',
    completedTurn: raw.includes('done'),
  }),
}, { workspaceSpawnGuard: async () => ({ status: 'available', source: 'no-snapshot' }) });

// Cases drive refresh explicitly; no inventory scan may outlive fixture teardown.
const refreshTimer = (globalThis as unknown as Record<symbol, NodeJS.Timeout | undefined>)[Symbol.for('o8.ownedSession.refreshTimer.codex')];
if (refreshTimer) clearInterval(refreshTimer);

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

let currentLaneId: string | null = null;
let caseStartedAt = 0;
beforeEach(() => { currentLaneId = null; caseStartedAt = performance.now(); });
afterEach(({ task }) => {
  const timing = currentLaneId ? getLaneEvents(currentLaneId, 200).filter(event => event.verb === 'close_timing').map(event => event.payload) : [];
  if (process.env.O8_CLOSE_TIMING_RECEIPTS) appendFileSync(process.env.O8_CLOSE_TIMING_RECEIPTS, JSON.stringify({
    name: task.name, caseMs: performance.now() - caseStartedAt, timing,
  }) + '\n');
});

async function fixture(label: string, readOnly = false) {
  const fixtureRoot = mkdtempSync(join(root, `${label}-`));
  const repoPath = join(fixtureRoot, 'repo');
  const packetId = `pkt-${label}`;
  const branch = `issue/${label}`;
  git(fixtureRoot, ['init', '--initial-branch=main', repoPath]);
  git(repoPath, ['config', 'user.name', 'o8-test']);
  git(repoPath, ['config', 'user.email', 'o8@example.test']);
  writeFileSync(join(repoPath, 'base.txt'), 'base\n');
  git(repoPath, ['add', 'base.txt']);
  git(repoPath, ['commit', '-m', 'base']);
  await addRepo(repoPath);
  const worktreeId = `packet-${packetId}`;
  const worktreePath = join(resolveWorktreeRootLayout(repoPath).primaryBase, worktreeId);
  mkdirSync(join(worktreePath, '..'), { recursive: true });
  git(repoPath, ['worktree', 'add', '-b', branch, worktreePath]);
  const lane = createLane({
    repoPath, worktreePath, branch, baseBranch: 'main', runtime: 'codex',
    packetId, label, ownership: 'managed',
  });
  currentLaneId = lane.id;
  const launched = await store.launch({ cwd: worktreePath, prompt: readOnly ? 'review-fixture' : 'exit-clean', laneId: lane.id, packetId });
  attachSession(lane.id, launched.surfaceId, 'system', { fixture: label });
  const deadline = Date.now() + 10_000;
  while (!getLaneEvents(lane.id, 100).some((event) => event.verb === 'runtime_process_exit')) {
    if (Date.now() > deadline) throw new Error('Owned fixture did not finish.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const archived = readOnly ? { archived: true, note: '', archivePath: join(ownedRoot, launched.surfaceId.split(':')[1]!) }
    : await store.archiveSession(launched.surfaceId);
  expect(archived.archived, archived.note).toBe(true);
  const archivePath = archived.archivePath!;
  const recordPath = join(archivePath, 'session.json');
  const record = JSON.parse(readFileSync(recordPath, 'utf8')) as OwnedSessionRecord;
  expect(record).toMatchObject({
    laneId: lane.id, packetId, runIdentityLedger: { totalRuns: 1, complete: true },
    recentRuns: [{ outcome: 'finished', childExit: { code: 0, classification: 'clean-exit' } }],
  });
  await withWorktreeMetaTransaction(repoPath, async (transaction) => transaction.save(worktreeId, {
    id: worktreeId, agentType: 'codex', sessionKey: launched.surfaceId,
    baseBranch: 'main', createdAt: Date.now(), claudeManaged: false,
    taskName: packetId, branchName: branch, status: 'ready', isolationKind: 'git-worktree',
    materializationIdentity: await captureWorktreeMaterializationIdentity(worktreePath),
    materializationParentIdentity: await captureWorktreeMaterializationIdentity(join(worktreePath, '..')),
  }));
  if (!readOnly) {
    setLaneStatus(lane.id, 'paused', 'user', 'operator_stopped');
    updateLane(lane.id, { sessionKey: null });
    writeFileSync(join(worktreePath, 'result.txt'), 'retained result\n');
    git(worktreePath, ['add', 'result.txt']);
    git(worktreePath, ['commit', '-m', 'result']);
  } else setLaneStatus(lane.id, 'running', 'system', 'session_running');
  const resultHead = git(worktreePath, ['rev-parse', 'HEAD']);
  writeOrchestratorControlPlaneState({
    ...createEmptyOrchestratorMissionState(), missionId: `mission-${label}`, repoPath, runtime: 'codex',
    packets: [{
      id: packetId, referenceLabel: '#archived-close-fixture', title: label, summary: label,
      workspaceTargetPath: repoPath, branchTarget: branch, runtime: 'codex',
      dependencyLabels: [], dependencyPacketIds: [], queueState: 'held', releaseState: 'pending',
      status: readOnly ? 'running' : 'blocked', operatorStopped: !readOnly, blockedReason: readOnly ? null : 'operator_stopped', review: null,
      ...(readOnly ? { workerIntent: 'reviewer', launchContext: { source: 'agent', presentation: 'tab', repoContext: 'registered', workMode: 'read-only' } } : {}),
      lane: { tileId: lane.id, tabId: lane.id, repoPath, worktreePath, runtime: 'codex', laneId: lane.id, ...(readOnly ? { sessionKey: launched.surfaceId } : {}) },
    } as OrchestratorPacket], updatedAt: new Date().toISOString(),
  });
  return { repoPath, packetId, branch, lane, worktreePath, worktreeId, recordPath,
    archivePath, record, resultHead, sessionKey: launched.surfaceId };
}

function request(packetId: string, disposition?: string) {
  return new NextRequest('http://127.0.0.1/api/orchestrator/discard-packet', {
    method: 'POST', headers: { authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ packetId, clientMutationId: randomUUID(), ...(disposition ? { disposition } : {}) }),
  });
}

function readRecord(f: Awaited<ReturnType<typeof fixture>>) {
  return JSON.parse(readFileSync(f.recordPath, 'utf8')) as OwnedSessionRecord;
}

afterAll(() => { closeDb(); rmSync(root, { recursive: true, force: true }); });

describe('explicit adopted-elsewhere Close with an archived terminal owner', () => {
  it('retires through the actual handler without restoring or launching the archived owner', async () => {
    const f = await fixture('adopted-archived');
    const recordBefore = readFileSync(f.recordPath, 'utf8');
    const eventsBefore = getLaneEvents(f.lane.id, 200);
    const response = await closeRoute.POST(request(f.packetId, 'adopted_elsewhere'));
    const payload = await response.json();
    expect(response.status, JSON.stringify(payload)).toBe(200);
    expect(payload).toMatchObject({ ok: true, result: { closed: true, worktreeRemoved: true } });
    expect(existsSync(f.worktreePath)).toBe(false);
    expect(git(f.repoPath, ['rev-parse', f.branch])).toBe(f.resultHead);
    expect(readFileSync(f.recordPath, 'utf8')).toBe(recordBefore);
    expect(existsSync(join(ownedRoot, f.sessionKey.split(':')[1]!))).toBe(false);
    const eventsAfter = getLaneEvents(f.lane.id, 200);
    expect(eventsAfter.filter((event) => eventsBefore.some((old) => old.id === event.id))).toEqual(eventsBefore);
    expect(eventsAfter.filter((event) => event.verb === 'attach_session')).toHaveLength(1);
    expect(eventsAfter.filter((event) => event.verb === 'kill_escalated')).toHaveLength(0);
    expect(getLane(f.lane.id)?.status).toBe('archived');
    expect(readOrchestratorControlPlaneState().packets.find((packet) => packet.id === f.packetId))
      .toMatchObject({ status: 'archived', operatorStopped: true, queueState: 'held', releaseState: 'pending' });
    const receiptDeadline = Date.now() + 5_000;
    while (!listStoredPacketReceipts(f.packetId).length) {
      if (Date.now() > receiptDeadline) throw new Error('Close receipt did not settle.');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(listStoredPacketReceipts(f.packetId).at(-1)?.receipt).toMatchObject({
      packetId: f.packetId, laneId: f.lane.id,
      disposition: { kind: 'discarded', disposition: 'adopted_elsewhere' },
    });
    const replay = await closeRoute.POST(request(f.packetId, 'adopted_elsewhere'));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ result: { alreadyClosed: true } });
    const timing = eventsAfter.findLast(event => event.verb === 'close_timing')?.payload;
    expect(timing).toMatchObject({ totalMs: expect.any(Number), artifactHelperStarts: 1 });
    // Admission, the manager guard, pre-rename, paused purge and final removal
    // retain fresh evidence, including after the purge helper has exited.
    expect((timing?.scans as { openFiles: number } | undefined)?.openFiles).toBe(5);
  }, 120_000);

  it('keeps the recovered owner held after a retirement refusal and safely retries', async () => {
    const f = await fixture('retirement-retry');
    const archivedBefore = readFileSync(f.recordPath, 'utf8');
    // Inject a single retirement refusal, then retry the real manager path.
    const refused = vi.spyOn(worktreeCleanup, 'removeMergedWorktree')
      .mockResolvedValueOnce({ removed: false, reason: 'retirement-refused' });
    try {
      const first = await closeRoute.POST(request(f.packetId, 'adopted_elsewhere'));
      expect(first.status).toBe(409);
      expect(await first.json()).toMatchObject({ error: { code: 'close_failed' } });
      expect(getLane(f.lane.id)).toMatchObject({ status: 'paused', sessionKey: f.sessionKey });
      expect(existsSync(f.worktreePath)).toBe(true);
      expect(readFileSync(join(f.worktreePath, 'result.txt'), 'utf8')).toBe('retained result\n');
      expect(readFileSync(f.recordPath, 'utf8')).toBe(archivedBefore);
      expect(readOrchestratorControlPlaneState().packets.find((packet) => packet.id === f.packetId))
        .toMatchObject({ operatorStopped: true, queueState: 'held', blockedReason: 'worktree_cleanup_failed' });
    } finally {
      refused.mockRestore();
    }
    const second = await closeRoute.POST(request(f.packetId, 'adopted_elsewhere'));
    expect(second.status, JSON.stringify(await second.clone().json())).toBe(200);
    expect(existsSync(f.worktreePath)).toBe(false);
    expect(readFileSync(f.recordPath, 'utf8')).toBe(archivedBefore);
    expect(git(f.repoPath, ['rev-parse', f.branch])).toBe(f.resultHead);
    const deadline = Date.now() + 5_000;
    while (!listStoredPacketReceipts(f.packetId).length) {
      if (Date.now() > deadline) throw new Error('Retried Close receipt did not settle.');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(getLaneEvents(f.lane.id, 200).filter((event) => event.verb === 'attach_session')).toHaveLength(1);
    expect(getLaneEvents(f.lane.id, 200).filter((event) => event.verb === 'kill_escalated')).toHaveLength(0);
  }, 120_000);

  it.each(['unknown-exit', 'incomplete-ledger', 'wrong-packet', 'wrong-cwd', 'wrong-owner'])(
    'refuses %s without recovering a lane key or touching archived evidence', async (label) => {
      const f = await fixture(label);
      const record = readRecord(f);
      if (label === 'unknown-exit') delete record.recentRuns[0]!.childExit;
      if (label === 'incomplete-ledger') record.runIdentityLedger!.complete = false;
      if (label === 'wrong-packet') record.workspaceBinding!.packetId = 'pkt-other';
      if (label === 'wrong-cwd') record.cwd = f.repoPath;
      if (label === 'wrong-owner') record.laneId = 'lane-other';
      writeFileSync(f.recordPath, JSON.stringify(record));
      const before = readFileSync(f.recordPath, 'utf8');
      const response = await closeRoute.POST(request(f.packetId, 'adopted_elsewhere'));
      expect(response.status).toBe(409);
      expect(existsSync(f.worktreePath)).toBe(true);
      expect(readFileSync(f.recordPath, 'utf8')).toBe(before);
      expect(getLane(f.lane.id)).toMatchObject({ status: 'paused', sessionKey: null });
      expect(git(f.repoPath, ['rev-parse', f.branch])).toBe(f.resultHead);
    }, 120_000,
  );

  it.each([undefined, 'wontfix', 'superseded', 'spec_changed'])(
    'closes an idle archived owner for disposition %s without recovering its session', async (disposition) => {
      const f = await fixture(`ordinary-${disposition ?? 'default'}`);
      const response = await closeRoute.POST(request(f.packetId, disposition));
      expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
      expect(existsSync(f.worktreePath)).toBe(false);
      expect(getLane(f.lane.id)).toMatchObject({ status: 'archived', sessionKey: null });
      expect(git(f.repoPath, ['rev-parse', f.branch])).toBe(f.resultHead);
      expect(readOrchestratorControlPlaneState().packets.find((packet) => packet.id === f.packetId))
        .toMatchObject({ status: 'archived', operatorStopped: true, queueState: 'held' });
    }, 120_000,
  );

  it('refuses ambiguous workspace ownership', async () => {
    const f = await fixture('ambiguous-owner');
    createLane({ repoPath: f.repoPath, worktreePath: f.worktreePath, branch: f.branch,
      baseBranch: 'main', runtime: 'codex', packetId: 'pkt-other-owner', label: 'Other owner', ownership: 'managed' });
    const response = await closeRoute.POST(request(f.packetId, 'adopted_elsewhere'));
    expect(response.status).toBe(409);
    expect(existsSync(f.worktreePath)).toBe(true);
    expect(getLane(f.lane.id)?.sessionKey).toBeNull();
  }, 120_000);

  it('refuses an escaped marker-bearing descendant after the leader exited', async () => {
    const f = await fixture('live-descendant');
    const record = readRecord(f);
    const child = spawn(process.execPath, ['-e', 'console.log("ready"); setInterval(() => {}, 1000);'], {
      cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, O8_OWNED_RUN_MARKER: record.recentRuns[0]!.processMarker! },
    });
    try {
      await once(child.stdout!, 'data');
      const response = await closeRoute.POST(request(f.packetId, 'adopted_elsewhere'));
      expect(response.status).toBe(409);
      expect(existsSync(f.worktreePath)).toBe(true);
      expect(getLane(f.lane.id)?.sessionKey).toBeNull();
      expect(child.exitCode).toBeNull();
      expect(readRecord(f)).toEqual(record);
    } finally {
      const exited = once(child, 'exit');
      process.kill(-child.pid!, 'SIGKILL');
      await exited;
    }
  }, 120_000);
});


it('discards an exited owner despite an unrelated nameless routing socket', async () => {
  const f = await fixture('routing-socket');
  const before = readFileSync(f.recordPath, 'utf8');
  const lsof = execFileSync('which', ['lsof'], { encoding: 'utf8' }).trim();
  const bin = join(root, 'routing-bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'lsof'), `#!/bin/sh\n'${lsof}' "$@"\nprintf 'p999999\\ncroute\\nf8\\ntrte\\nn\\n'\n`);
  chmodSync(join(bin, 'lsof'), 0o700);
  const priorPath = process.env.PATH;
  process.env.PATH = `${bin}:${priorPath}`;
  try {
    const response = await closeRoute.POST(request(f.packetId, 'adopted_elsewhere'));
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    expect(existsSync(f.worktreePath)).toBe(false);
    expect(readFileSync(f.recordPath, 'utf8')).toBe(before);
    expect(git(f.repoPath, ['rev-parse', f.branch])).toBe(f.resultHead);
  } finally { process.env.PATH = priorPath; }
}, 120_000);


it('automatically retires a finished read-only review and retains its verdict and transcript', async () => {
  const f = await fixture('automatic-review', true);
  const { capturePacketCompletionContext } = await import('@/lib/orchestrator/context-relay');
  const { completeReadOnlyZeroDiffLane } = await import('@/lib/orchestrator/read-only-completion');
  const { waitForTerminalLaneWork } = await import('@/lib/lane/terminal-work');
  const context = await capturePacketCompletionContext(f.packetId, f.sessionKey);
  expect(context.selfReview?.decision, readFileSync(f.record.recentRuns[0]!.stdoutPath, 'utf8')).toBe('finding_ready');
  const stdoutPath = f.record.recentRuns[0]!.stdoutPath;
  const stdout = readFileSync(stdoutPath, 'utf8');
  cleanupMode.automatic = true;
  try {
    expect((await completeReadOnlyZeroDiffLane(getLane(f.lane.id)!, context)).completed).toBe(true);
    await waitForTerminalLaneWork();
    expect(getLane(f.lane.id)).toMatchObject({ status: 'completed', worktreePath: null });
    expect(existsSync(f.worktreePath)).toBe(false);
    expect(readFileSync(stdoutPath, 'utf8')).toBe(stdout);
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({ releaseState: 'released' });
    const { findRepoByLocalPath } = await import('@/lib/repos/registry');
    const { readCompletionHandoff } = await import('@/lib/workspace/completion-handoff-store');
    const repo = await findRepoByLocalPath(f.repoPath);
    expect(readCompletionHandoff(repo!.id, f.packetId)?.context.selfReview).toMatchObject({
      passed: true, decision: 'finding_ready', outcome: context.selfReview!.outcome,
    });
  } finally { cleanupMode.automatic = false; }
}, 120_000);
