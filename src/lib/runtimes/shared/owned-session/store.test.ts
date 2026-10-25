import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DispatchBackendWaitResult } from '@/lib/runtimes/shared/dispatch-readiness';
import type { OwnedRuntimeAdapter, OwnedSessionRecord, ParsedRunLog } from './types';

const spawnMock = vi.hoisted(() => vi.fn());
const spawnBridgeMock = vi.hoisted(() => vi.fn());
const ensureDispatchBackendReadyMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

vi.mock('@/lib/runtimes/shared/dispatch-readiness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtimes/shared/dispatch-readiness')>();
  return {
    ...actual,
    ensureDispatchBackendReady: ensureDispatchBackendReadyMock,
  };
});

vi.mock('@/lib/runtime/pty-bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtime/pty-bridge')>();
  return { ...actual, spawnBridgeTerminalSession: spawnBridgeMock };
});

describe('createOwnedSessionStore launch readiness gate', () => {
  let tempRoot: string;
  let repoPath: string;
  let priorRoot: string | undefined;
  let priorBin: string | undefined;
  let priorCrashSurvival: string | undefined;
  let priorNodeEnv: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(process.cwd(), '.tmp-owned-store-'));
    repoPath = path.join(tempRoot, 'repo');
    execFileSync('git', ['init', '-q', repoPath]);
    priorRoot = process.env.O8_TEST_OWNED_ROOT;
    priorBin = process.env.O8_TEST_BIN;
    priorCrashSurvival = process.env.O8_CRASH_SURVIVABLE_WORKERS;
    priorNodeEnv = process.env.NODE_ENV;
    process.env.O8_TEST_OWNED_ROOT = path.join(tempRoot, 'sessions');
    process.env.O8_TEST_BIN = process.execPath;
    spawnMock.mockReturnValue({ pid: 42, unref: vi.fn(), once: vi.fn() });
    spawnBridgeMock.mockRejectedValue(new Error('bridge unavailable'));
    ensureDispatchBackendReadyMock.mockReset();
  });

  afterEach(() => {
    spawnMock.mockReset();
    spawnBridgeMock.mockReset();
    if (priorRoot === undefined) delete process.env.O8_TEST_OWNED_ROOT;
    else process.env.O8_TEST_OWNED_ROOT = priorRoot;
    if (priorBin === undefined) delete process.env.O8_TEST_BIN;
    else process.env.O8_TEST_BIN = priorBin;
    if (priorCrashSurvival === undefined) delete process.env.O8_CRASH_SURVIVABLE_WORKERS;
    else process.env.O8_CRASH_SURVIVABLE_WORKERS = priorCrashSurvival;
    setNodeEnv(priorNodeEnv);
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('does not spawn the worker until the readiness wait completes warm', { timeout: 20_000 }, async () => {
    const { createOwnedSessionStore } = await import('./store');
    let releaseReady: ((result: DispatchBackendWaitResult) => void) | undefined;
    ensureDispatchBackendReadyMock.mockReturnValue(new Promise((resolve) => {
      releaseReady = resolve;
    }));

    const store = createOwnedSessionStore(testAdapter());
    const launched = store.launch({ cwd: repoPath, prompt: 'do work' });

    await waitUntil(() => ensureDispatchBackendReadyMock.mock.calls.length === 1);
    expect(spawnMock).not.toHaveBeenCalled();

    releaseReady?.({
      ready: true,
      reason: 'http_200',
      waitedMs: 4_000,
      attempts: 3,
      lastCheck: {
        ready: true,
        reason: 'http_200',
        apiBase: 'http://o8.test',
        status: 200,
        portSource: 'file',
        apiPortFilePresent: true,
      },
    });

    await expect(launched).resolves.toMatchObject({ ok: true, runtime: 'test-runtime' });
    expect(ensureDispatchBackendReadyMock).toHaveBeenCalledWith('test-runtime', 'launch');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({
      cwd: repoPath,
      env: { PWD: repoPath },
    });
  });

  it('sets detached owned workers to development under a production parent', async () => {
    const { createOwnedSessionStore } = await import('./store');
    setNodeEnv('production');
    ensureDispatchBackendReadyMock.mockResolvedValue(readyResult());

    const store = createOwnedSessionStore(testAdapter());
    await expect(store.launch({ cwd: repoPath, prompt: 'launch detached worker' })).resolves.toMatchObject({ ok: true });

    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({ env: { NODE_ENV: 'development' } });
  });

  it('shows the assigned task and pinned model for an owned worker after launch', async () => {
    const { createOwnedSessionStore } = await import('./store');
    ensureDispatchBackendReadyMock.mockResolvedValue(readyResult());

    const store = createOwnedSessionStore(testAdapter());
    await expect(store.launch({
      cwd: repoPath,
      prompt: 'edit proof/a.txt',
      taskName: 'Proof A',
      model: 'gpt-5.6-terra',
    })).resolves.toMatchObject({ ok: true });

    const saved = readSingleSession(process.env.O8_TEST_OWNED_ROOT!);
    expect(saved).toMatchObject({ title: 'Proof A', model: 'gpt-5.6-terra' });
    const fleet = await store.getFleetAdditions({ fresh: true });
    expect(fleet.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionKey: saved.surfaceId,
        name: 'Proof A',
        model: 'gpt-5.6-terra',
      }),
    ]));
  });

  it('returns a failed launch with an install hint when the worker CLI is missing', async () => {
    const { invalidateCliCache } = await import('@/lib/runtimes/shared/cli-resolver');
    const { createOwnedSessionStore } = await import('./store');
    delete process.env.O8_TEST_BIN;
    invalidateCliCache('test-runtime');
    ensureDispatchBackendReadyMock.mockResolvedValue({
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
    });

    const store = createOwnedSessionStore(testAdapter('o8-definitely-missing-worker-cli'));
    const result = await store.launch({ cwd: repoPath, prompt: 'do work' });

    expect(result.ok).toBe(false);
    expect(result.note).toContain('[runtime] Owned Test is not installed');
    expect(result.note).toContain('o8-definitely-missing-worker-cli');
    expect(result.note).not.toContain('ENOENT');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('persists the prepared marker before detached process creation', async () => {
    const { createOwnedSessionStore } = await import('./store');
    ensureDispatchBackendReadyMock.mockResolvedValue(readyResult());
    spawnMock.mockImplementationOnce((_command, _args, options: { env?: NodeJS.ProcessEnv }) => {
      const prepared = readSingleSession(process.env.O8_TEST_OWNED_ROOT!);
      expect(prepared.activeRun).toMatchObject({
        spawnState: 'prepared',
        pid: 0,
        processMarker: expect.any(String),
      });
      expect(prepared.runIdentityLedger).toEqual({ version: 1, totalRuns: 1, complete: true });
      expect(options.env?.O8_OWNED_RUN_MARKER).toBe(prepared.activeRun?.processMarker);
      return { pid: 42, unref: vi.fn(), once: vi.fn() };
    });

    const store = createOwnedSessionStore(testAdapter());
    await expect(store.launch({ cwd: repoPath, prompt: 'journal detached' })).resolves.toMatchObject({ ok: true });
    expect(readSingleSession(process.env.O8_TEST_OWNED_ROOT!).activeRun).toMatchObject({
      spawnState: 'started',
      pid: 42,
    });
  });

  it('passes the persisted prepared marker and development environment into bridge process creation', async () => {
    const { createOwnedSessionStore } = await import('./store');
    process.env.O8_CRASH_SURVIVABLE_WORKERS = '0';
    setNodeEnv('production');
    ensureDispatchBackendReadyMock.mockResolvedValue(readyResult());
    spawnBridgeMock.mockImplementationOnce((options: { env?: Record<string, string>; sessionName: string }) => {
      const prepared = readSingleSession(process.env.O8_TEST_OWNED_ROOT!);
      expect(prepared.activeRun).toMatchObject({ spawnState: 'prepared', processMarker: expect.any(String) });
      expect(options.env?.O8_OWNED_RUN_MARKER).toBe(prepared.activeRun?.processMarker);
      expect(options.env?.NODE_ENV).toBe('development');
      return { ok: true, sessionName: options.sessionName, pid: 43 };
    });

    const store = createOwnedSessionStore(testAdapter());
    await expect(store.launch({ cwd: repoPath, prompt: 'journal bridge' })).resolves.toMatchObject({ ok: true });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(readSingleSession(process.env.O8_TEST_OWNED_ROOT!).activeRun).toMatchObject({
      spawnState: 'started',
      pid: 43,
      tmuxSession: expect.any(String),
    });
  });

  it('binds a packet worker credential to the spawned run identity', async () => {
    const { resolvePacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
    const { createOwnedSessionStore } = await import('./store');
    ensureDispatchBackendReadyMock.mockResolvedValue(readyResult());
    let workerToken = '';
    let processMarker = '';
    spawnMock.mockImplementationOnce((_command, _args, options: { env?: NodeJS.ProcessEnv }) => {
      workerToken = options.env?.O8_WORKER_TOKEN ?? '';
      processMarker = options.env?.O8_OWNED_RUN_MARKER ?? '';
      return { pid: 42, unref: vi.fn(), once: vi.fn() };
    });

    const store = createOwnedSessionStore(testAdapter(), {
      workspaceSpawnGuard: async () => ({ status: 'available', source: 'no-snapshot' }),
    });
    await expect(store.launch({
      cwd: repoPath,
      prompt: 'bind packet identity',
      packetId: 'packet-process-binding',
    })).resolves.toMatchObject({ ok: true });

    expect(workerToken).toMatch(/^o8pw_/);
    expect(processMarker).not.toBe('');
    expect(resolvePacketWorkerToken(workerToken)).toMatchObject({
      packetId: 'packet-process-binding',
      leaseProcessMarker: processMarker,
      leaseProcessPid: 42,
    });
  });

  it('reconciles a confirmed pre-spawn failure without incrementing the ledger twice', async () => {
    const { createOwnedSessionStore } = await import('./store');
    ensureDispatchBackendReadyMock.mockResolvedValue(readyResult());
    spawnMock.mockImplementationOnce(() => {
      expect(readSingleSession(process.env.O8_TEST_OWNED_ROOT!).activeRun?.spawnState).toBe('prepared');
      throw new Error('spawn refused before process creation');
    });

    const store = createOwnedSessionStore(testAdapter());
    await expect(store.launch({ cwd: repoPath, prompt: 'fail before spawn' }))
      .rejects.toThrow('spawn refused before process creation');
    const reconciled = readSingleSession(process.env.O8_TEST_OWNED_ROOT!);
    expect(reconciled.activeRun).toBeUndefined();
    expect(reconciled.recentRuns).toHaveLength(1);
    expect(reconciled.recentRuns[0]).toMatchObject({
      spawnState: 'reconciled_clear',
      outcome: 'failed',
      pid: 0,
    });
    expect(reconciled.runIdentityLedger).toEqual({ version: 1, totalRuns: 1, complete: true });
    await expect(store.getWorkspaceBinding!(reconciled.surfaceId)).resolves.toMatchObject({
      activeRun: null,
      retainedRuns: [],
      retainedRunsComplete: true,
      retainedRunTotal: 1,
    });
  });

  it('CAS-rebinds the same logical workspace and preserves session identity', async () => {
    const { createOwnedSessionStore } = await import('./store');
    ensureDispatchBackendReadyMock.mockResolvedValue({
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
    });
    const store = createOwnedSessionStore(testAdapter());
    const launched = await store.launch({ cwd: repoPath, prompt: 'do work', packetId: 'packet-rebind' });
    const sessionRoot = process.env.O8_TEST_OWNED_ROOT!;
    const sessionDir = readdirSync(sessionRoot, { withFileTypes: true }).find((entry) => entry.isDirectory())!;
    const metadataPath = path.join(sessionRoot, sessionDir.name, 'session.json');
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as Record<string, unknown>;
    const seedRun = (metadata.recentRuns as Array<Record<string, unknown>>)[0]!;
    delete metadata.activeRun;
    delete metadata.runIdentityLedger;
    writeFileSync(metadataPath, JSON.stringify(metadata));
    await expect(store.getWorkspaceBinding!(launched.surfaceId)).resolves.toMatchObject({
      retainedRunsComplete: false,
      retainedRunTotal: null,
    });
    metadata.recentRuns = [
      {
        ...seedRun,
        id: 'newer-finished-run',
        outcome: 'finished',
        pid: 5252,
        processGroupId: 5252,
        processMarker: 'newer-marker',
      },
      {
        ...seedRun,
        id: 'older-finished-run',
        outcome: 'finished',
        pid: 4241,
        processGroupId: 4241,
        processMarker: 'older-marker',
      },
    ];
    metadata.runIdentityLedger = { version: 1, totalRuns: 2, complete: true };
    writeFileSync(metadataPath, JSON.stringify(metadata));

    const before = await store.getWorkspaceBinding!(launched.surfaceId);
    expect(before).toMatchObject({
      surfaceId: launched.surfaceId,
      binding: {
        logicalWorkspaceId: 'packet:packet-rebind',
        cwd: repoPath,
        version: 1,
      },
      activeRun: null,
      retainedRuns: [
        { id: 'newer-finished-run', pid: 5252, processGroupId: 5252, processMarker: 'newer-marker' },
        { id: 'older-finished-run', pid: 4241, processGroupId: 4241, processMarker: 'older-marker' },
      ],
      retainedRunsComplete: true,
      retainedRunTotal: 2,
    });
    expect(before?.retainedRuns).toHaveLength(2);
    const rebound = await store.rebindWorkspace!(launched.surfaceId, {
      logicalWorkspaceId: 'packet:packet-rebind',
      repositoryUuid: 'repo-rebind',
      packetId: 'packet-rebind',
      expectedCwd: repoPath,
      nextCwd: repoPath,
      expectedVersion: 1,
    });
    expect(rebound).toMatchObject({
      status: 'rebound',
      receipt: {
        surfaceId: launched.surfaceId,
        binding: {
          repositoryUuid: 'repo-rebind',
          cwd: repoPath,
          version: 2,
        },
      },
    });
    await expect(store.rebindWorkspace!(launched.surfaceId, {
      logicalWorkspaceId: 'packet:packet-rebind',
      repositoryUuid: 'repo-rebind',
      packetId: 'packet-rebind',
      expectedCwd: repoPath,
      nextCwd: repoPath,
      expectedVersion: 1,
    })).resolves.toMatchObject({ status: 'idempotent' });
  });
  it.each(['resume', 'forget during preparation'] as const)('fences forgotten worker memory at %s through the owned store', async kind => {
    const { createOwnedSessionStore } = await import('./store');
    const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
    const { advanceMemoryRevision, readMemoryRevision } = await import('@/lib/cortex/memory-revision');
    const { getSqlite } = await import('@/lib/db');
    const db = getSqlite();
    const prior = readMemoryRevision();
    const packetId = 'packet-forget-owned-store';
    writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), packets: [{
      id: packetId, branchTarget: 'fixture-forget', workspaceTargetPath: repoPath, referenceLabel: packetId,
      title: 'Current retained worker task', summary: 'Inspect the fixture.', runtime: 'codex',
      status: 'running', queueState: 'held', releaseState: 'pending', dependencyPacketIds: [], dependencyLabels: [],
    }] });
    ensureDispatchBackendReadyMock.mockResolvedValue(readyResult());
    const store = createOwnedSessionStore(testAdapter(), {
      workspaceSpawnGuard: async () => ({ status: 'available', source: 'no-snapshot' }),
    });
    try {
      const launched = await store.launch({ cwd: repoPath, prompt: 'forgotten assembled context canary', packetId });
      const session = readSingleSession(process.env.O8_TEST_OWNED_ROOT!);
      session.threadId = 'old-provider-thread';
      session.recentRuns[0] = { ...session.recentRuns[0], outcome: 'finished', pid: 0, finishedAt: new Date().toISOString() };
      session.activeRun = undefined;
      writeFileSync(path.join(session.sessionDir, 'session.json'), JSON.stringify(session));
      spawnMock.mockClear();
      if (kind === 'forget during preparation') {
        ensureDispatchBackendReadyMock.mockImplementationOnce(async () => {
          db.transaction(() => advanceMemoryRevision(db))();
          return readyResult();
        });
        await expect(store.resume(launched.surfaceId, 'fresh operator instruction')).rejects.toThrow(/memory changed/i);
        expect(spawnMock).not.toHaveBeenCalled();
      } else {
        db.transaction(() => advanceMemoryRevision(db))();
        const expectedRevision = readMemoryRevision();
        spawnMock.mockImplementationOnce(() => {
          const prepared = readSingleSession(process.env.O8_TEST_OWNED_ROOT!);
          expect(prepared.threadId).toBeUndefined();
          expect(prepared.promptMemoryRevision).toBe(expectedRevision);
          expect(prepared.initialPrompt).toContain('Current retained worker task');
          expect(prepared.activeRun?.mode).toBe('launch');
          expect(prepared.activeRun?.prompt).toContain('fresh operator instruction');
          expect(prepared.activeRun?.prompt).not.toContain('forgotten assembled context canary');
          return { pid: 42, unref: vi.fn(), once: vi.fn() };
        });
        await expect(store.resume(launched.surfaceId, 'fresh operator instruction')).resolves.toMatchObject({ ok: true });
        expect(spawnMock).toHaveBeenCalledTimes(1);
      }
    } finally {
      if (prior === '0') db.exec('DROP TABLE IF EXISTS memory_forget_revision');
      else db.prepare('UPDATE memory_forget_revision SET revision = ? WHERE singleton = 1').run(prior);
    }
  });

});

function testAdapter(binaryName = 'node'): OwnedRuntimeAdapter {
  return {
    runtimeId: 'test-runtime',
    surfaceIdPrefix: 'test-owned:',
    rootEnvVar: 'O8_TEST_OWNED_ROOT',
    rootDefault: path.join(os.tmpdir(), 'o8-test-owned-store'),
    binaryName,
    binaryEnvOverride: 'O8_TEST_BIN',
    humanLabel: 'Owned Test',
    squadShortName: 'Test',
    launchArgs: ({ prompt }) => ['-e', `console.log(${JSON.stringify(prompt)})`],
    resumeArgs: ({ prompt }) => ['-e', `console.log(${JSON.stringify(prompt)})`],
    parseRunLog: (): ParsedRunLog => ({
      entries: [],
      outcome: 'running',
      completedTurn: false,
    }),
  };
}

function readSingleSession(root: string): OwnedSessionRecord {
  const sessionDir = readdirSync(root, { withFileTypes: true }).find((entry) => entry.isDirectory());
  if (!sessionDir) throw new Error(`missing owned session under ${root}`);
  return JSON.parse(readFileSync(path.join(root, sessionDir.name, 'session.json'), 'utf8')) as OwnedSessionRecord;
}

function readyResult(): DispatchBackendWaitResult {
  return {
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
  };
}

function setNodeEnv(value: string | undefined): void {
  const environment = process.env as Record<string, string | undefined>;
  if (value === undefined) delete environment.NODE_ENV;
  else environment.NODE_ENV = value;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 4000; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for predicate');
}
