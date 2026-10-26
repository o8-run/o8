import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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

vi.mock('@/lib/claude-code/codex-subscription-proxy', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/claude-code/codex-subscription-proxy')>(),
  ensureClaudeCodeWorkerConfigDir: vi.fn(async (sessionDir: string) => {
    const configDir = path.join(sessionDir, 'worker-config');
    mkdirSync(configDir, { recursive: true });
    return configDir;
  }),
}));

vi.mock('@/lib/runtimes/shared/auth-detect', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/runtimes/shared/auth-detect')>(),
  assertRuntimeDispatchable: vi.fn(async () => undefined),
}));

const tempRoot = realpathSync(mkdtempSync(path.join(os.homedir(), '.tmp-o8-worker-mcp-injection-')));
const dataDir = path.join(tempRoot, 'data');
const repoPath = path.join(tempRoot, 'repo');
const ownedRoot = path.join(tempRoot, 'owned');
const priorEnv: Record<string, string | undefined> = {};
const controlledEnvKeys = [
  'CORTEX_IDE_DATA_DIR',
  'O8_DATA_DIR',
  'CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT',
  'O8_CLAUDE_CODE_BIN',
  'O8_CRASH_SURVIVABLE_WORKERS',
  'O8_SKIP_PRELAUNCH_TYPECHECK',
  'O8_WORKER_SANDBOX',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const;

function packet(packetId: string, branch: string): OrchestratorPacket {
  return {
    id: packetId,
    referenceLabel: packetId.toUpperCase(),
    title: `Worker MCP test ${packetId}`,
    summary: 'Drive persisted worker MCP attachment through the owned-session launch path.',
    workspaceTargetPath: repoPath,
    branchTarget: branch,
    runtime: 'claude-code',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'queued',
    lane: null,
  };
}

function resultJson(result: { content: Array<{ type: 'text'; text: string } | { type: 'image' }> }) {
  const text = result.content.find((entry) => entry.type === 'text')?.text ?? '';
  return JSON.parse(text) as Record<string, unknown>;
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
    agentType: 'claude-code',
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
    runtime: 'claude-code',
    label: packetId,
    packetId,
  });
}

function spawnedArgs(callIndex: number): string[] {
  return (spawnMock.mock.calls[callIndex]?.[1] ?? []) as string[];
}

describe.sequential('worker MCP injection real path', () => {
  beforeAll(async () => {
    for (const key of controlledEnvKeys) priorEnv[key] = process.env[key];
    mkdirSync(dataDir, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', repoPath]);
    writeFileSync(path.join(repoPath, 'README.md'), 'worker MCP injection fixture\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repoPath });
    execFileSync('git', [
      '-c', 'user.email=test@o8.test',
      '-c', 'user.name=o8-test',
      'commit', '-qm', 'fixture',
    ], { cwd: repoPath });

    process.env.CORTEX_IDE_DATA_DIR = dataDir;
    process.env.O8_DATA_DIR = dataDir;
    process.env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT = ownedRoot;
    process.env.O8_CLAUDE_CODE_BIN = process.execPath;
    process.env.O8_CRASH_SURVIVABLE_WORKERS = '1';
    process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
    delete process.env.O8_WORKER_SANDBOX;
    process.env.ANTHROPIC_API_KEY = '';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'synthetic-mcp-fixture';

    spawnMock.mockImplementation(() => ({
      pid: 424_242,
      stdin: { end: vi.fn() },
      unref: vi.fn(),
      once: vi.fn(),
    }));
    vi.stubGlobal('fetch', vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      if (url.includes('/api/orchestrator/create-mission')) {
        const { NextRequest } = await import('next/server');
        const { POST } = await import('@/app/api/orchestrator/create-mission/route');
        return POST(new NextRequest(url, {
          method: init?.method ?? 'POST',
          headers: init?.headers,
          body: init?.body,
        }));
      }
      return Response.json({ ok: true });
    }));

    const { addRepo } = await import('@/lib/repos/registry');
    const { writeClaudeCodeWorkerProfile } = await import('@/lib/claude-code/worker-profile');
    await addRepo(repoPath);
    await writeClaudeCodeWorkerProfile({
      source: 'native',
      model: null,
      codexModel: null,
      repoSkillAllowlist: [],
    });
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

  it('writes only opted-in records into a per-run config and audits skipped sandbox commands', async () => {
    const { buildPacketPrompt } = await import('@/lib/orchestrator/packet-prompt');
    const {
      insertExternalMcpServer,
      removeExternalMcpServer,
      updateExternalMcpServer,
    } = await import('@/lib/mcp/external-servers');
    const { dispatch: dispatchLaneCommand } = await import('@/lib/lane/commands');
    const { getLaneEvents } = await import('@/lib/lane/registry');

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
        UNKNOWN: '{{futureToken}}',
      },
      enabled: true,
      workerInjection: true,
    });
    const firstPacket = packet('pkt-worker-mcp-attached', 'test/worker-mcp-attached');
    const firstLane = await createManagedLane(firstPacket.id, firstPacket.branchTarget);
    const firstPrompt = await buildPacketPrompt(
      firstPacket,
      [],
      'main',
      firstLane.worktreePath,
    );
    expect(firstPrompt).toContain(`MCP servers attached to this packet: packet-observer (${process.execPath}).`);

    const unsupportedPrompt = await buildPacketPrompt({
      ...packet('pkt-worker-mcp-unsupported', 'test/worker-mcp-unsupported'),
      runtime: 'gemini',
    }, [], 'main', firstLane.worktreePath);
    expect(unsupportedPrompt).not.toContain('MCP servers attached to this packet:');

    const firstCall = spawnMock.mock.calls.length;
    const firstLaunch = await dispatchLaneCommand({
      verb: 'launch_session',
      laneId: firstLane.id,
      prompt: firstPrompt,
      actor: 'orchestrator',
    });
    expect(firstLaunch.ok, firstLaunch.note).toBe(true);
    const firstArgs = spawnedArgs(firstCall);
    const configFlag = firstArgs.indexOf('--mcp-config');
    expect(configFlag).toBeGreaterThan(-1);
    const configPath = firstArgs[configFlag + 1]!;
    expect(configPath.startsWith(ownedRoot)).toBe(true);
    expect(configPath).not.toContain(repoPath);
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };
    const observer = config.mcpServers['packet-observer'];
    expect(observer).toEqual({
      command: process.execPath,
      args: ['-e', expect.any(String), expect.stringMatching(/mcp-broker-[a-f0-9-]+\.json$/)],
      env: {},
    });
    expect(path.dirname(observer.args[2])).toBe(path.dirname(configPath));
    expect(observer.args).not.toContain('fixture-server.mjs');
    expect(getLaneEvents(firstLane.id, 100)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        verb: 'mcp_injected',
        payload: { servers: ['packet-observer'], configPath, mode: 'launch' },
      }),
    ]));

    const staleConfigPath = path.join(path.dirname(configPath), 'o8-worker-mcp-stale.json');
    writeFileSync(staleConfigPath, '{}\n');
    const session = JSON.parse(readFileSync(
      path.join(path.dirname(configPath), 'session.json'),
      'utf8',
    )) as OwnedSessionRecord;
    const { claudeCodeOwnedAdapter } = await import('@/lib/claude-code/owned');
    const { prepareOwnedLaunchArgs } = await import(
      '@/lib/runtimes/shared/owned-session/launch-args'
    );
    const continued = await prepareOwnedLaunchArgs({
      adapter: claudeCodeOwnedAdapter,
      session: { ...session, threadId: 'f4561e47-70ac-4a72-9406-a340d3ea115e' },
      runId: 'replacement',
      prompt: 'Verify the attached tools again',
      mode: 'resume',
      sandboxEnabled: false,
      humanLabel: 'Owned Claude Code',
    });
    const replacement = continued.workerMcp;
    expect(continued.args[continued.args.indexOf('--mcp-config') + 1]).toBe(replacement.configPath);
    expect(JSON.parse(continued.stdinPayload!).message.content).toBe('Verify the attached tools again');
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(staleConfigPath)).toBe(false);
    expect(replacement.configPath).toBe(path.join(
      path.dirname(configPath),
      'o8-worker-mcp-replacement.json',
    ));
    expect(existsSync(replacement.configPath!)).toBe(true);

    updateExternalMcpServer(attached.id, { workerInjection: false });
    const detachedPacket = packet('pkt-worker-mcp-detached', 'test/worker-mcp-detached');
    const detachedLane = await createManagedLane(detachedPacket.id, detachedPacket.branchTarget);
    const detachedPrompt = await buildPacketPrompt(
      detachedPacket,
      [],
      'main',
      detachedLane.worktreePath,
    );
    expect(detachedPrompt).not.toContain('MCP servers attached to this packet:');
    const detachedCall = spawnMock.mock.calls.length;
    expect((await dispatchLaneCommand({
      verb: 'launch_session',
      laneId: detachedLane.id,
      prompt: detachedPrompt,
      actor: 'orchestrator',
    })).ok).toBe(true);
    expect(spawnedArgs(detachedCall)).not.toContain('--mcp-config');
    expect(getLaneEvents(detachedLane.id, 100).some((event) => (
      event.verb === 'mcp_injected' || event.verb === 'mcp_injection_skipped'
    ))).toBe(false);

    removeExternalMcpServer(attached.id);
    insertExternalMcpServer({
      name: 'missing-packet-observer',
      transport: 'stdio',
      command: 'o8-definitely-missing-worker-mcp-command',
      enabled: true,
      workerInjection: true,
    });
    process.env.O8_WORKER_SANDBOX = 'on';
    const skippedPacket = packet('pkt-worker-mcp-skipped', 'test/worker-mcp-skipped');
    const skippedLane = await createManagedLane(skippedPacket.id, skippedPacket.branchTarget);
    const skippedPrompt = await buildPacketPrompt(
      skippedPacket,
      [],
      'main',
      skippedLane.worktreePath,
    );
    expect(skippedPrompt).not.toContain('MCP servers attached to this packet:');
    const skippedCall = spawnMock.mock.calls.length;
    const skippedLaunch = await dispatchLaneCommand({
      verb: 'launch_session',
      laneId: skippedLane.id,
      prompt: skippedPrompt,
      actor: 'orchestrator',
    });
    // The opt-in OS sandbox is available only on macOS. Other hosts must
    // refuse this second launch before spawning a worker.
    if (process.platform !== 'darwin') {
      expect(skippedLaunch.ok).toBe(false);
      expect(skippedLaunch.note).toContain('Worker sandbox is macOS-only');
      expect(spawnMock.mock.calls.length).toBe(skippedCall);
      delete process.env.O8_WORKER_SANDBOX;
      return;
    }
    expect(skippedLaunch.ok, JSON.stringify(skippedLaunch)).toBe(true);
    expect(spawnMock.mock.calls.length).toBe(skippedCall + 1);
    expect(spawnedArgs(skippedCall)).not.toContain('--mcp-config');
    expect(getLaneEvents(skippedLane.id, 100)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        verb: 'mcp_injection_skipped',
        payload: expect.objectContaining({
          server: 'missing-packet-observer',
          command: 'o8-definitely-missing-worker-mcp-command',
          reason: expect.stringContaining('could not be resolved'),
        }),
      }),
    ]));
    delete process.env.O8_WORKER_SANDBOX;
  }, 120_000);

  it('ignores mission-supplied server fields at the real handler boundary', async () => {
    const { listExternalMcpServers, removeExternalMcpServer } = await import(
      '@/lib/mcp/external-servers'
    );
    for (const server of listExternalMcpServers()) removeExternalMcpServer(server.id);

    const { MISSION_TOOLS, handleCreateMission } = await import(
      '@/lib/mcp/operator-handlers/mission'
    );
    const createTool = MISSION_TOOLS.find((tool) => tool.name === 'create_mission');
    expect(createTool?.inputSchema.properties).not.toHaveProperty('mcpServers');
    const result = await handleCreateMission({
      repoPath,
      issues_inline: [{ title: 'Ignore untrusted worker tools', body: 'No tool attachment.' }],
      dispatch: false,
      mcpServers: {
        injected: { command: process.execPath, args: ['untrusted.mjs'] },
      },
    });
    expect(result.isError).not.toBe(true);
    expect(resultJson(result)).toHaveProperty('missionId');

    const { currentMissionState } = await import(
      '@/lib/orchestrator/operator-mission-service/shared'
    );
    const createdPacket = currentMissionState().packets[0]!;
    expect(createdPacket).not.toHaveProperty('mcpServers');
    expect(listExternalMcpServers()).toEqual([]);

    const { buildPacketPrompt } = await import('@/lib/orchestrator/packet-prompt');
    const promptText = await buildPacketPrompt(
      createdPacket,
      currentMissionState().packets,
      'main',
      createdPacket.workspaceTargetPath,
    );
    expect(promptText).not.toContain('MCP servers attached to this packet:');
  }, 120_000);
});
