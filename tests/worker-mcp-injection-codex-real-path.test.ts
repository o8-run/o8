import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';

const spawnMock = vi.hoisted(() => vi.fn());
const ensureDispatchBackendReadyMock = vi.hoisted(() => vi.fn(async () => ({
  ready: true,
  reason: 'http_200',
  waitedMs: 0,
  attempts: 1,
})));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (
      command: string,
      args: string[] = [],
      options: import('node:child_process').SpawnOptions = {},
    ) => options.env?.O8_OWNED_RUN_MARKER
      ? spawnMock(command, args, options)
      : actual.spawn(command, args, options),
  };
});

vi.mock('@/lib/runtimes/shared/dispatch-readiness', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/runtimes/shared/dispatch-readiness')>(),
  ensureDispatchBackendReady: ensureDispatchBackendReadyMock,
}));

vi.mock('@/lib/runtimes/shared/auth-detect', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/runtimes/shared/auth-detect')>(),
  assertRuntimeDispatchable: vi.fn(async () => undefined),
}));

const tempRoot = realpathSync(mkdtempSync(path.join(os.homedir(), '.tmp-o8-codex-worker-mcp-')));
const dataDir = path.join(tempRoot, 'data');
const repoPath = path.join(tempRoot, 'repo');
const ownedRoot = path.join(tempRoot, 'owned');
const codexHome = path.join(tempRoot, 'codex-home');
const priorEnv: Record<string, string | undefined> = {};
const controlledEnvKeys = [
  'CODEX_HOME',
  'CORTEX_IDE_DATA_DIR',
  'O8_DATA_DIR',
  'CORTEX_IDE_OWNED_CODEX_ROOT',
  'O8_CODEX_BIN',
  'O8_CRASH_SURVIVABLE_WORKERS',
  'O8_SKIP_PRELAUNCH_TYPECHECK',
  'O8_WORKER_SANDBOX',
] as const;

function packet(packetId: string, branch: string): OrchestratorPacket {
  return {
    id: packetId,
    referenceLabel: packetId.toUpperCase(),
    title: `Codex worker MCP test ${packetId}`,
    summary: 'Drive persisted worker MCP attachment through Codex launch and resume.',
    workspaceTargetPath: repoPath,
    branchTarget: branch,
    runtime: 'codex',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'queued',
    lane: null,
  };
}

async function createManagedLane(packetId: string, branch: string) {
  const {
    readOrchestratorControlPlaneState,
    writeOrchestratorControlPlaneState,
  } = await import('@/lib/orchestrator/control-plane');
  const currentState = readOrchestratorControlPlaneState();
  if (!currentState.packets.some((candidate) => candidate.id === packetId)) {
    writeOrchestratorControlPlaneState({
      ...currentState,
      packets: [...currentState.packets, packet(packetId, branch)],
    });
  }
  const { captureWorktreeMaterializationIdentity } = await import(
    '@/lib/worktree/materialization-identity'
  );
  const { withWorktreeMetaTransaction } = await import('@/lib/worktree/metadata-store');
  const { managedPacketWorktreeId } = await import('@/lib/worktree/root-layout');
  const { createLane } = await import('@/lib/lane/registry');
  const worktreeId = managedPacketWorktreeId(packetId);
  if (!worktreeId) throw new Error(`Unable to resolve a worktree id for ${packetId}`);
  const worktreeBase = path.join(repoPath, '.cortex-worktrees');
  const worktreePath = path.join(worktreeBase, worktreeId);
  mkdirSync(worktreeBase, { recursive: true });
  execFileSync('git', ['worktree', 'add', worktreePath, '-b', branch], { cwd: repoPath });
  const materializationIdentity = await captureWorktreeMaterializationIdentity(worktreePath);
  const materializationParentIdentity = await captureWorktreeMaterializationIdentity(worktreeBase);
  await withWorktreeMetaTransaction(repoPath, (transaction) => transaction.save(worktreeId, {
    id: worktreeId,
    agentType: 'codex',
    baseBranch: 'main',
    createdAt: Date.now(),
    claudeManaged: false,
    taskName: packetId,
    branchName: branch,
    status: 'ready',
    isolationKind: 'git-worktree',
    materializationIdentity,
    materializationParentIdentity,
  }));
  return createLane({
    repoPath,
    worktreePath,
    branch,
    runtime: 'codex',
    label: packetId,
    packetId,
  });
}

function spawnedArgs(callIndex: number): string[] {
  return (spawnMock.mock.calls[callIndex]?.[1] ?? []) as string[];
}

function configOverrides(args: string[]): string[] {
  return args.flatMap((arg, index) => (
    arg === '-c' && args[index + 1] ? [args[index + 1]!] : []
  ));
}

function sessionDirForSurface(surfaceId: string): string {
  return path.join(ownedRoot, surfaceId.replace(/^codex-owned:/, ''));
}

function finishLaunchForResume(surfaceId: string, threadId: string): void {
  const sessionPath = path.join(sessionDirForSurface(surfaceId), 'session.json');
  const session = JSON.parse(readFileSync(sessionPath, 'utf8')) as OwnedSessionRecord;
  const finishedAt = new Date().toISOString();
  session.threadId = threadId;
  session.activeRun = undefined;
  session.autoRetry = false;
  session.recentRuns = session.recentRuns.map((run) => ({
    ...run,
    pid: 987_654_321,
    outcome: 'finished',
    finishedAt,
  }));
  writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`);
}

describe.sequential('Codex worker MCP injection real path', () => {
  beforeAll(async () => {
    for (const key of controlledEnvKeys) priorEnv[key] = process.env[key];
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', repoPath]);
    writeFileSync(path.join(repoPath, 'README.md'), 'Codex worker MCP injection fixture\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repoPath });
    execFileSync('git', [
      '-c', 'user.email=test@o8.test',
      '-c', 'user.name=o8-test',
      'commit', '-qm', 'fixture',
    ], { cwd: repoPath });

    process.env.CODEX_HOME = codexHome;
    process.env.CORTEX_IDE_DATA_DIR = dataDir;
    process.env.O8_DATA_DIR = dataDir;
    process.env.CORTEX_IDE_OWNED_CODEX_ROOT = ownedRoot;
    process.env.O8_CODEX_BIN = process.execPath;
    process.env.O8_CRASH_SURVIVABLE_WORKERS = '1';
    process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
    delete process.env.O8_WORKER_SANDBOX;

    spawnMock.mockImplementation(() => ({
      pid: 424_242,
      stdin: { end: vi.fn() },
      unref: vi.fn(),
      once: vi.fn(),
    }));
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true })));

    const { addRepo } = await import('@/lib/repos/registry');
    await addRepo(repoPath);
  });

  afterAll(async () => {
    const { closeDb } = await import('@/lib/db');
    closeDb();
    vi.unstubAllGlobals();
    for (const key of controlledEnvKeys) {
      const prior = priorEnv[key];
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('keeps the prompt support set equal to the owned adapters advertising injection', async () => {
    const { claudeCodeOwnedAdapter } = await import('@/lib/claude-code/owned');
    const { codexOwnedAdapter } = await import('@/lib/codex/owned');
    const { WORKER_MCP_INJECTION_SUPPORTED_RUNTIMES } = await import(
      '@/lib/mcp/worker-injection'
    );
    const adapters = [claudeCodeOwnedAdapter, codexOwnedAdapter];

    expect([...WORKER_MCP_INJECTION_SUPPORTED_RUNTIMES].sort()).toEqual(
      adapters
        .filter((adapter) => Boolean(adapter.workerMcpInjection))
        .map((adapter) => adapter.runtimeId)
        .sort(),
    );
    expect(claudeCodeOwnedAdapter.workerMcpInjection).toBe('config-file');
    expect(codexOwnedAdapter.workerMcpInjection).toBe('config-override');
    expect(codexOwnedAdapter.binaryEnvOverride).toBe('O8_CODEX_BIN');
  });

  it('injects overrides on launch and lane resume, then audits an invalid name', async () => {
    const { buildPacketPrompt } = await import('@/lib/orchestrator/packet-prompt');
    const {
      insertExternalMcpServer,
      listExternalMcpServers,
      removeExternalMcpServer,
    } = await import('@/lib/mcp/external-servers');
    const { dispatch: dispatchLaneCommand } = await import('@/lib/lane/commands');
    const { getLane, getLaneEvents } = await import('@/lib/lane/registry');

    for (const server of listExternalMcpServers()) removeExternalMcpServer(server.id);
    const attached = insertExternalMcpServer({
      name: 'packet-observer',
      transport: 'stdio',
      command: process.execPath,
      args: ['fixture-server.mjs'],
      env: {
        PACKET_ID: '{{packetId}}',
        WORKTREE: '{{worktreePath}}',
        BRANCH: '{{branch}}',
        LANE_ID: '{{laneId}}',
      },
      enabled: true,
      workerInjection: true,
    });
    const launchPacket = packet('pkt-codex-worker-mcp', 'test/codex-worker-mcp');
    const launchLane = await createManagedLane(launchPacket.id, launchPacket.branchTarget);
    const launchPrompt = await buildPacketPrompt(
      launchPacket,
      [],
      'main',
      launchLane.worktreePath,
    );
    expect(launchPrompt).toContain(
      `MCP servers attached to this packet: packet-observer (${process.execPath}).`,
    );

    const launchCall = spawnMock.mock.calls.length;
    const launchResult = await dispatchLaneCommand({
      verb: 'launch_session',
      laneId: launchLane.id,
      prompt: launchPrompt,
      actor: 'orchestrator',
    });
    expect(launchResult.ok, launchResult.note || 'launch refused').toBe(true);
    const launchArgs = spawnedArgs(launchCall);
    function brokerReference(args: string[]): string {
      const overrides = configOverrides(args).filter(value => value.startsWith('mcp_servers.packet-observer.'));
      expect(overrides).toHaveLength(3);
      expect(overrides).toContain(`mcp_servers.packet-observer.command=${JSON.stringify(process.execPath)}`);
      expect(overrides).toContain('mcp_servers.packet-observer.env={}');
      const prefix = 'mcp_servers.packet-observer.args=';
      const proxy = JSON.parse(overrides.find(value => value.startsWith(prefix))!.slice(prefix.length)) as string[];
      expect(proxy).toEqual(['-e', expect.any(String), expect.stringMatching(/mcp-broker-[a-f0-9-]+\.json$/)]);
      expect(overrides.join('')).not.toContain('fixture-server.mjs');
      return proxy[2];
    }
    const launchReference = brokerReference(launchArgs);
    expect(launchArgs).not.toContain('--mcp-config');
    const surfaceId = getLane(launchLane.id)?.sessionKey;
    expect(surfaceId).toMatch(/^codex-owned:/);
    const sessionDir = sessionDirForSurface(surfaceId!);
    expect(path.dirname(launchReference)).toBe(sessionDir);
    expect(readdirSync(sessionDir).some((name) => /^o8-worker-mcp-.*\.json$/.test(name))).toBe(false);
    expect(getLaneEvents(launchLane.id, 100)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        verb: 'mcp_injected',
        payload: { servers: ['packet-observer'], mode: 'launch' },
      }),
    ]));

    const threadId = 'thread-codex-worker-mcp-resume';
    finishLaunchForResume(surfaceId!, threadId);
    const resumeCall = spawnMock.mock.calls.length;
    const resumeResult = await dispatchLaneCommand({
      verb: 'send_turn',
      laneId: launchLane.id,
      message: 'continue with the attached observer',
      actor: 'orchestrator',
    });
    expect(resumeResult.ok).toBe(true);
    const resumeArgs = spawnedArgs(resumeCall);
    expect(resumeArgs).toEqual(expect.arrayContaining(['exec', 'resume', threadId]));
    const resumeReference = brokerReference(resumeArgs);
    expect(path.dirname(resumeReference)).toBe(sessionDir);
    expect(resumeReference).not.toBe(launchReference);
    expect(resumeArgs).not.toContain('--mcp-config');
    expect(getLaneEvents(launchLane.id, 100)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        verb: 'mcp_injected',
        payload: { servers: ['packet-observer'], mode: 'resume' },
      }),
    ]));

    removeExternalMcpServer(attached.id);
    insertExternalMcpServer({
      name: 'bad name',
      transport: 'stdio',
      command: process.execPath,
      enabled: true,
      workerInjection: true,
    });
    const invalidPacket = packet('pkt-codex-worker-mcp-invalid', 'test/codex-worker-mcp-invalid');
    const invalidLane = await createManagedLane(invalidPacket.id, invalidPacket.branchTarget);
    const invalidPrompt = await buildPacketPrompt(
      invalidPacket,
      [],
      'main',
      invalidLane.worktreePath,
    );
    expect(invalidPrompt).not.toContain('bad name');
    expect(invalidPrompt).not.toContain('MCP servers attached to this packet:');
    const invalidCall = spawnMock.mock.calls.length;
    expect((await dispatchLaneCommand({
      verb: 'launch_session',
      laneId: invalidLane.id,
      prompt: invalidPrompt,
      actor: 'orchestrator',
    })).ok).toBe(true);
    expect(spawnedArgs(invalidCall).join('\n')).not.toContain('bad name');
    expect(getLaneEvents(invalidLane.id, 100)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        verb: 'mcp_injection_skipped',
        payload: expect.objectContaining({
          server: 'bad name',
          command: process.execPath,
          reason: 'name is not a valid config key',
        }),
      }),
    ]));
  }, 120_000);
});
