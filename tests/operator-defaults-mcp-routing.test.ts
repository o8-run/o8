import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { MODEL_IDS } from '@/lib/models';

const spawnMock = vi.hoisted(() => vi.fn());
const nativePreflightMock = vi.hoisted(() => vi.fn(async () => undefined));
const carrierPreflightMock = vi.hoisted(() => vi.fn(async () => ({
  runtime: 'codex' as const,
  runtimeBinaryName: 'codex',
  runtimeCli: { path: '/test/codex', source: 'path' as const, detectedAt: 1 },
  executionCarrier: 'ori' as const,
  carrierBinaryName: 'ori',
  carrierCli: { path: '/test/ori', source: 'path' as const, detectedAt: 1 },
  authSource: 'execution-carrier' as const,
  authenticated: true as const,
})));
const ensureDispatchBackendReadyMock = vi.hoisted(() => vi.fn(async () => ({
  ready: true,
  reason: 'http_200',
  waitedMs: 0,
  attempts: 1,
})));
const ensureCodexSubscriptionProxyReadyMock = vi.hoisted(() => vi.fn(async () => ({
  baseUrl: 'http://127.0.0.1:8317',
  clientToken: 'global-carrier-token',
  models: ['global-model-x'],
})));
const ensureCodexSubscriptionClaudeConfigDirMock = vi.hoisted(() => vi.fn(async (sessionDir: string) =>
  path.join(sessionDir, 'claude-code-codex-config')));

// Authentication is outside this routing fixture. Stub the current config
// preparation entry point so it never reads the operator's credential store.
const ensureClaudeCodeWorkerConfigDirMock = vi.hoisted(() => vi.fn(async (sessionDir: string) =>
  path.join(sessionDir, 'claude-code-worker-config')));

vi.mock('@/lib/worktree/storage-telemetry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: vi.fn(async () => ({
    accountingStatus: 'observed' as const,
    probePath: '/',
    availableBytes: 90_000_000_000,
    freeBytes: 90_000_000_000,
    totalBytes: 100_000_000_000,
    error: null,
  })),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (
      command: string,
      args: string[] = [],
      options: import('node:child_process').SpawnOptions = {},
    ) => options.detached
      ? spawnMock(command, args, options)
      : actual.spawn(command, args, options),
  };
});

vi.mock('@/lib/runtimes/shared/dispatch-readiness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtimes/shared/dispatch-readiness')>();
  return {
    ...actual,
    ensureDispatchBackendReady: ensureDispatchBackendReadyMock,
  };
});

vi.mock('@/lib/claude-code/codex-subscription-proxy', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/claude-code/codex-subscription-proxy')>(),
  ensureCodexSubscriptionProxyReady: ensureCodexSubscriptionProxyReadyMock,
  ensureCodexSubscriptionClaudeConfigDir: ensureCodexSubscriptionClaudeConfigDirMock,
  ensureClaudeCodeWorkerConfigDir: ensureClaudeCodeWorkerConfigDirMock,
  prepareClaudeCodeWorkerConfig: vi.fn(async (sessionDir: string, source: string) => ({
    configDir: source === 'codex-subscription'
      ? await ensureCodexSubscriptionClaudeConfigDirMock(sessionDir)
      : await ensureClaudeCodeWorkerConfigDirMock(sessionDir),
    credentialEnv: {},
  })),
}));

vi.mock('@/lib/runtimes/shared/auth-detect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtimes/shared/auth-detect')>();
  const readyStatus = (house: 'codex' | 'claude' | 'opencode' | 'cursor' | 'grok', runtime: string) => ({
    house,
    runtime,
    installed: true,
    authenticated: true,
    detail: `${runtime} ready`,
    fix: '',
    checkedAt: Date.now(),
  });
  return {
    ...actual,
    getRuntimeAuthSnapshot: vi.fn(async () => ({
      statuses: {
        codex: readyStatus('codex', 'codex'),
        claude: readyStatus('claude', 'claude-code'),
        opencode: readyStatus('opencode', 'opencode'),
        cursor: readyStatus('cursor', 'cursor'),
        grok: readyStatus('grok', 'grok'),
      },
      suggestedSubscriptionProfile: { profile: null, detail: null },
    })),
    assertRuntimeDispatchable: nativePreflightMock,
  };
});

vi.mock('@/lib/runtimes/shared/execution-carrier-preflight', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/runtimes/shared/execution-carrier-preflight')>(),
  assertExecutionCarrierDispatchable: carrierPreflightMock,
}));

vi.mock('@/lib/usage-log', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/usage-log')>();
  return {
    ...actual,
    monitorUsageDispatch: vi.fn(),
  };
});

let testRoot: string | null = null;
const priorEnv: Record<string, string | undefined> = {};
const controlledEnvKeys = [
  'CORTEX_IDE_DATA_DIR',
  'O8_DATA_DIR',
  'CORTEX_IDE_OWNED_CODEX_ROOT',
  'CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT',
  'O8_CODEX_BIN',
  'O8_CLAUDE_CODE_BIN',
  'O8_CRASH_SURVIVABLE_WORKERS',
  'O8_SKIP_PRELAUNCH_TYPECHECK',
  'O8_DISPATCH_MODEL',
  'O8_SUBSCRIPTION_PROFILE',
  'O8_DEFAULT_DISPATCH_RUNTIME',
  'O8_CODEX_WORKER_EFFORT',
  'O8_CLAUDE_WORKER_EFFORT',
  'O8_PACKAGED_APP',
  'OPENROUTER_API_KEY',
] as const;

function resultJson(result: { content: Array<{ type: 'text'; text: string } | { type: 'image' }> }) {
  const text = result.content.find((entry) => entry.type === 'text')?.text ?? '';
  return JSON.parse(text) as Record<string, unknown>;
}

function createTempRepo() {
  if (!testRoot) throw new Error('Test data directory was not initialized');
  const repoPath = mkdtempSync(path.join(testRoot, 'repo-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
  git('init', '--initial-branch=main');
  writeFileSync(path.join(repoPath, 'README.md'), 'operator defaults routing test\n');
  git('add', 'README.md');
  git('-c', 'user.email=test@o8.test', '-c', 'user.name=o8-test', 'commit', '-m', 'init');
  return repoPath;
}

async function createRegisteredTempRepo() {
  const repoPath = createTempRepo();
  const { addRepo } = await import('@/lib/repos/registry');
  await addRepo(repoPath);
  return repoPath;
}

async function createMissionThroughRoute(input: {
  repoPath: string;
  issueNumber: number;
  requestedRuntime: 'codex' | 'claude-code';
  requestedModel?: string;
  carrier?: 'native' | 'openrouter' | 'codex-subscription';
}) {
  const { NextRequest } = await import('next/server');
  const { POST } = await import('@/app/api/orchestrator/create-mission/route');
  const response = await POST(new NextRequest('http://127.0.0.1:47120/api/orchestrator/create-mission', {
    method: 'POST',
    headers: { host: 'localhost:47120', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientMutationId: `create-route-${input.issueNumber}`,
      repoPath: input.repoPath,
      requestedRuntime: input.requestedRuntime,
      ...(input.requestedModel ? { requestedModel: input.requestedModel } : {}),
      ...(input.carrier ? { carrier: input.carrier } : {}),
      issues: [{
        number: input.issueNumber,
        title: `Route worker model ${input.issueNumber}`,
        body: '',
        url: '',
      }],
    }),
  }));
  const created = await response.json() as {
    ok: boolean;
    result: { missionId: string; packets: Array<{ id: string }> };
  };
  expect(response.status).toBe(201);
  expect(created.ok).toBe(true);
  return created.result;
}

function spawnedArgv(callIndex = 0): string[] {
  const [command, args] = spawnMock.mock.calls[callIndex]!;
  const directArgs = command === process.execPath && args[0] === '-e'
    ? args.slice(4)
    : args;
  return process.platform === 'win32' ? directArgs : directArgs.slice(3);
}

function stubOperatorDefaultsApi() {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    if (url.includes('/api/panel/operator-defaults')) {
      const route = await import('@/app/api/panel/operator-defaults/route');
      if ((init?.method ?? 'GET') === 'POST') {
        return route.POST(new Request(url, {
          method: 'POST',
          headers: init?.headers,
          body: init?.body,
        }));
      }
      return route.GET(new Request('http://127.0.0.1/api/panel/operator-defaults'));
    }
    if (url.includes('/supervisor/watch') || url.includes('/internal/realtime')) {
      return Response.json({ ok: true });
    }
    throw new Error(`Unhandled test fetch: ${url}`);
  }));
}

beforeAll(() => {
  for (const key of controlledEnvKeys) priorEnv[key] = process.env[key];
});

beforeEach(() => {
  testRoot = realpathSync(mkdtempSync(path.join(process.env.CORTEX_IDE_DATA_DIR!, 'operator-mcp-routing-')));
  process.env.CORTEX_IDE_DATA_DIR = testRoot;
  process.env.O8_DATA_DIR = testRoot;
  process.env.CORTEX_IDE_OWNED_CODEX_ROOT = path.join(testRoot, 'owned-codex');
  process.env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT = path.join(testRoot, 'owned-claude');
  process.env.O8_CODEX_BIN = process.execPath;
  process.env.O8_CLAUDE_CODE_BIN = process.execPath;
  process.env.O8_CRASH_SURVIVABLE_WORKERS = '1';
  process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
  writeFileSync(path.join(testRoot, 'claude-code-worker.json'), JSON.stringify({
    version: 2,
    source: 'native',
    model: null,
    codexModel: null,
  }));
  delete process.env.O8_DISPATCH_MODEL;
  delete process.env.O8_SUBSCRIPTION_PROFILE;
  delete process.env.O8_DEFAULT_DISPATCH_RUNTIME;
  delete process.env.O8_CODEX_WORKER_EFFORT;
  delete process.env.O8_CLAUDE_WORKER_EFFORT;
  delete process.env.O8_PACKAGED_APP;
  delete process.env.OPENROUTER_API_KEY;
  vi.resetModules();
  // Declarative runtimes register a root under the data dir, which changes per test.
  delete (globalThis as { __o8DeclarativeOwnedRuntimeRegistry?: unknown }).__o8DeclarativeOwnedRuntimeRegistry;

  spawnMock.mockReset();
  nativePreflightMock.mockClear();
  carrierPreflightMock.mockClear();
  spawnMock.mockImplementation(() => Object.assign(new EventEmitter(), {
    pid: 987_654,
    stdin: { end: vi.fn() },
    unref: vi.fn(),
  }));
  ensureDispatchBackendReadyMock.mockClear();
  ensureCodexSubscriptionProxyReadyMock.mockClear();
  ensureCodexSubscriptionClaudeConfigDirMock.mockClear();
  stubOperatorDefaultsApi();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const key of controlledEnvKeys) {
    const prior = priorEnv[key];
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
  if (testRoot) rmSync(testRoot, { recursive: true, force: true });
  testRoot = null;
  vi.resetModules();
});

describe('MCP operator defaults and dispatch routing', () => {
  it('advertises per-packet model and carrier on the create_mission schema', async () => {
    const { MISSION_TOOLS } = await import('@/lib/mcp/operator-handlers/mission');
    const tool = MISSION_TOOLS.find((candidate) => candidate.name === 'create_mission');
    expect(tool?.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        model: { type: 'string' },
        carrier: {
          type: 'string',
          enum: ['native', 'openrouter', 'codex-subscription'],
        },
      },
    });
  }, 15_000);

  it('sets worker effort and merge approval posture through the registered MCP schema and real handler', async () => {
    const { STATUS_TOOLS, handleOperatorDefaults } = await import('@/lib/mcp/operator-handlers/status');
    const tool = STATUS_TOOLS.find((candidate) => candidate.name === 'o8_operator_defaults');
    const properties = tool?.inputSchema.properties as Record<string, unknown> | undefined;

    expect(properties).toMatchObject({
      subscriptionProfile: expect.any(Object),
      codexWorkerEffort: expect.any(Object),
      claudeWorkerEffort: expect.any(Object),
      brainCodexModel: expect.any(Object),
      brainCodexEffort: expect.any(Object),
      broadcastCommentary: expect.any(Object),
      broadcastCommentaryIntervalMinutes: expect.any(Object),
      broadcastCommentaryMinNewEvents: expect.any(Object),
      broadcastCommentaryMaxPerHour: expect.any(Object),
      presentationQuietMode: expect.any(Object),
      notificationsReviewReady: expect.objectContaining({ enum: ['off', 'on'] }),
      brainUseClaudeCli: expect.any(Object),
      defaultDispatchModel: expect.any(Object),
      workerExecutionCarrier: expect.objectContaining({ enum: ['ori', ''] }),
      meteredPacketCostCapUsd: expect.any(Object),
      meteredPacketInputTokenCap: expect.any(Object),
      uiLoopMaxIterations: expect.any(Object),
      uiLoopMaxMinutes: expect.any(Object),
      uiLoopMaxDiffBytes: expect.any(Object),
      uiLoopMaxDiffFiles: expect.any(Object),
      uiLoopPreviewTimeoutMs: expect.any(Object),
      workersUseBrain: expect.any(Object),
      workspaceManifestPolicy: expect.objectContaining({
        enum: ['disabled', 'one-approval', 'auto'],
      }),
      crossHouseWorkerFallback: expect.any(Object),
      requireApproval: expect.objectContaining({
        enum: ['high-risk', 'surface', 'always', 'never'],
      }),
    });

    const result = await handleOperatorDefaults({
      subscriptionProfile: 'codex-only',
      brainCodexModel: 'gpt-5.6-terra',
      brainCodexEffort: 'xhigh',
      codexWorkerEffort: 'xhigh',
      requireApproval: 'always',
      meteredPacketCostCapUsd: 0.75,
      meteredPacketInputTokenCap: 400_000,
      uiLoopMaxIterations: 6,
      uiLoopMaxMinutes: 24,
      uiLoopMaxDiffBytes: 48_000,
      uiLoopMaxDiffFiles: 9,
      uiLoopPreviewTimeoutMs: 18_000,
      broadcastCommentary: 'interval',
      broadcastCommentaryIntervalMinutes: 6,
      broadcastCommentaryMinNewEvents: 4,
      broadcastCommentaryMaxPerHour: 10,
      presentationQuietMode: true,
      notificationsReviewReady: 'off',
    });
    expect(result.isError).not.toBe(true);
    expect(resultJson(result).values).toMatchObject({
      subscriptionProfile: 'codex-only',
      brainCodexModel: 'gpt-5.6-terra',
      brainCodexEffort: 'xhigh',
      codexWorkerEffort: 'xhigh',
      requireApproval: 'always',
      meteredPacketCostCapUsd: 0.75,
      meteredPacketInputTokenCap: 400_000,
      uiLoopMaxIterations: 6,
      uiLoopMaxMinutes: 24,
      uiLoopMaxDiffBytes: 48_000,
      uiLoopMaxDiffFiles: 9,
      uiLoopPreviewTimeoutMs: 18_000,
      broadcastCommentary: 'interval',
      broadcastCommentaryIntervalMinutes: 6,
      broadcastCommentaryMinNewEvents: 4,
      broadcastCommentaryMaxPerHour: 10,
      presentationQuietMode: true,
      notificationsReviewReady: 'off',
    });

    const { getOperatorDefaults } = await import('@/lib/operator/defaults');
    expect((await getOperatorDefaults()).values).toMatchObject({
      subscriptionProfile: 'codex-only',
      brainCodexModel: 'gpt-5.6-terra',
      brainCodexEffort: 'xhigh',
      codexWorkerEffort: 'xhigh',
      requireApproval: 'always',
      meteredPacketCostCapUsd: 0.75,
      meteredPacketInputTokenCap: 400_000,
      uiLoopMaxIterations: 6,
      uiLoopMaxMinutes: 24,
      uiLoopMaxDiffBytes: 48_000,
      uiLoopMaxDiffFiles: 9,
      uiLoopPreviewTimeoutMs: 18_000,
      broadcastCommentary: 'interval',
      broadcastCommentaryIntervalMinutes: 6,
      broadcastCommentaryMinNewEvents: 4,
      broadcastCommentaryMaxPerHour: 10,
      presentationQuietMode: true,
      notificationsReviewReady: 'off',
    });
  }, 15_000);

  it('rejects unknown MCP keys as a structured error without applying a partial update', async () => {
    const { getOperatorDefaults } = await import('@/lib/operator/defaults');
    const before = (await getOperatorDefaults()).values.codexWorkerEffort;
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockClear();

    const { handleOperatorDefaults } = await import('@/lib/mcp/operator-handlers/status');
    const result = await handleOperatorDefaults({
      codexWorkerEffort: 'low',
      codexWorkerEfort: 'xhigh',
    });
    const payload = resultJson(result);

    expect(result.isError).toBe(true);
    expect(payload).toMatchObject({
      ok: false,
      error: {
        code: 'unknown_operator_default_keys',
        unknownKeys: ['codexWorkerEfort'],
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await getOperatorDefaults()).values.codexWorkerEffort).toBe(before);
  });

  it.skipIf(process.platform === 'win32')('uses execution-carrier auth instead of native auth at the create-mission route', async () => {
    const { handleOperatorDefaults } = await import('@/lib/mcp/operator-handlers/status');
    await handleOperatorDefaults({ defaultDispatchRuntime: 'codex', workerExecutionCarrier: 'ori' });

    await expect(createMissionThroughRoute({
      repoPath: await createRegisteredTempRepo(),
      issueNumber: 2037,
      requestedRuntime: 'codex',
    })).resolves.toMatchObject({ missionId: expect.any(String) });
    expect(carrierPreflightMock).toHaveBeenCalledWith('codex', 'ori');
    expect(nativePreflightMock).not.toHaveBeenCalled();
  });

  it('carries defaultDispatchModel through mission creation into the Codex spawn argv', async () => {
    const { handleOperatorDefaults } = await import('@/lib/mcp/operator-handlers/status');
    const defaultsResult = await handleOperatorDefaults({
      defaultDispatchRuntime: 'codex',
      defaultDispatchModel: 'gpt-5.6-sol',
    });
    expect(defaultsResult.isError).not.toBe(true);

    const repoPath = await createRegisteredTempRepo();
    const { NextRequest } = await import('next/server');
    const { POST } = await import('@/app/api/orchestrator/create-mission/route');
    const response = await POST(new NextRequest('http://127.0.0.1:47120/api/orchestrator/create-mission', {
      method: 'POST',
      headers: { host: 'localhost:47120', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientMutationId: 'create-route-default-model',
        repoPath,
        requestedRuntime: 'codex',
        issues: [{ number: 1, title: 'Honor the configured worker model', body: '', url: '' }],
      }),
    }));
    const created = await response.json() as { ok: boolean; result: { missionId: string } };
    expect(created.ok).toBe(true);

    const { dispatchMission } = await import('@/lib/orchestrator/operator-mission-service/mission');
    const dispatched = await dispatchMission({ missionId: created.result.missionId });
    expect(dispatched.dispatched).toBe(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const argv = spawnedArgv();
    const modelIndex = argv.indexOf('--model');
    expect(modelIndex).toBeGreaterThan(-1);
    expect(argv[modelIndex + 1]).toBe('gpt-5.6-sol');
    expect(argv).not.toContain('gpt-5.6-terra');
  }, 30_000);

  it('rejects a cross-house default through the MCP settings path', async () => {
    const { handleOperatorDefaults } = await import('@/lib/mcp/operator-handlers/status');
    const defaultsResult = await handleOperatorDefaults({
      defaultDispatchRuntime: 'claude-code',
      defaultDispatchModel: MODEL_IDS.codexDefault,
    });
    const message = defaultsResult.content.find((entry) => entry.type === 'text')?.text ?? '';

    expect(defaultsResult.isError).toBe(true);
    expect(message).toContain('not compatible with Claude Code');
    expect(message).toContain('Settings > Models > Runtime routing');
    expect(spawnMock).not.toHaveBeenCalled();
  }, 30_000);

  it('preserves a compatible packet model across reset after the operator default changes', async () => {
    const { handleOperatorDefaults } = await import('@/lib/mcp/operator-handlers/status');
    const configuredClaudeModel = 'claude-opus-5';
    const defaultsResult = await handleOperatorDefaults({
      defaultDispatchRuntime: 'claude-code',
      defaultDispatchModel: configuredClaudeModel,
    });
    expect(defaultsResult.isError).not.toBe(true);

    const created = await createMissionThroughRoute({
      repoPath: await createRegisteredTempRepo(),
      issueNumber: 3,
      requestedRuntime: 'claude-code',
    });
    const { dispatchMission } = await import('@/lib/orchestrator/operator-mission-service/mission');
    expect((await dispatchMission({ missionId: created.missionId })).dispatched).toBe(1);
    expect(spawnedArgv()).toContain(configuredClaudeModel);

    const cleared = await handleOperatorDefaults({ defaultDispatchModel: '' });
    expect(cleared.isError).not.toBe(true);
    // The worker exits first: reset retires a workspace only once its run ledger proves quiescence.
    const worker = spawnMock.mock.results[0]!.value as EventEmitter;
    worker.emit('exit', 0, null);
    worker.emit('close', 0, null);
    const { findLaneByPacket } = await import('@/lib/lane/registry');
    const { getOwnedSessionLifecycle } = await import('@/lib/runtimes/shared/owned-session-lifecycle');
    const sessionKey = findLaneByPacket(created.packets[0]!.id)!.sessionKey!;
    await vi.waitFor(async () => {
      expect((await getOwnedSessionLifecycle(sessionKey)!.getWorkspaceBinding!(sessionKey))?.activeRun).toBeNull();
    }, { timeout: 10_000 });
    const { resetPacket } = await import('@/lib/orchestrator/operator-mission-service/reset');
    await resetPacket({
      packetId: created.packets[0]!.id,
      reason: 'model-routing regression',
      clearWorktree: true,
    });
    expect((await dispatchMission({ missionId: created.missionId })).dispatched).toBe(1);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    const redispatchArgv = spawnedArgv(1);
    expect(redispatchArgv).toContain(configuredClaudeModel);
  }, 45_000);

  it('carries a per-packet Claude model hint through the mission chain into spawn argv', async () => {
    const { handleOperatorDefaults } = await import('@/lib/mcp/operator-handlers/status');
    const defaultsResult = await handleOperatorDefaults({
      defaultDispatchRuntime: 'claude-code',
      defaultDispatchModel: '',
    });
    expect(defaultsResult.isError).not.toBe(true);

    const requestedModel = 'claude-opus-5';
    const created = await createMissionThroughRoute({
      repoPath: await createRegisteredTempRepo(),
      issueNumber: 4,
      requestedRuntime: 'claude-code',
      requestedModel,
    });
    const { dispatchMission } = await import('@/lib/orchestrator/operator-mission-service/mission');
    expect((await dispatchMission({ missionId: created.missionId })).dispatched).toBe(1);

    const argv = spawnedArgv();
    expect(argv).toContain('--model');
    expect(argv).toContain(requestedModel);
    expect(argv).not.toContain(MODEL_IDS.claudeWorkerDefault);
  }, 30_000);

  it('keeps the global harness carrier while a mission packet pins a different carrier and model', async () => {
    process.env.OPENROUTER_API_KEY = 'packet-carrier-token';
    const profile = await import('@/lib/claude-code/worker-profile');
    await profile.writeClaudeCodeWorkerProfile({
      source: 'codex-subscription',
      model: 'global-openrouter-model',
      codexModel: 'global-model-x',
    });

    const created = await createMissionThroughRoute({
      repoPath: await createRegisteredTempRepo(),
      issueNumber: 5,
      requestedRuntime: 'claude-code',
      requestedModel: 'gateway/model-y',
      carrier: 'openrouter',
    });
    const { currentMissionState } = await import('@/lib/orchestrator/operator-mission-service/shared');
    expect(currentMissionState().packets[0]).toMatchObject({
      id: created.packets[0]!.id,
      claudeCodeModel: 'gateway/model-y',
      claudeCodeCarrier: 'openrouter',
    });

    const { dispatchMission } = await import('@/lib/orchestrator/operator-mission-service/mission');
    expect((await dispatchMission({ missionId: created.missionId })).dispatched).toBe(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, , spawnOptions] = spawnMock.mock.calls[0]!;
    expect(spawnedArgv()).toContain('gateway/model-y');
    expect(spawnOptions.env).toMatchObject({
      ANTHROPIC_BASE_URL: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\//),
      ANTHROPIC_AUTH_TOKEN: 'packet-carrier-token',
      ANTHROPIC_MODEL: 'gateway/model-y',
    });

    const { resolveClaudeHarnessCarrier } = await import('@/lib/lane/claude-harness-carrier');
    const harness = await resolveClaudeHarnessCarrier({
      requestedModel: 'orchestrator-request',
      sessionDir: path.join(testRoot!, 'orchestrator-session'),
    });
    expect(harness).toMatchObject({
      source: 'codex-subscription',
      model: 'global-model-x',
      spawnEnv: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317',
        ANTHROPIC_MODEL: 'global-model-x',
      },
    });
    expect(profile.readClaudeCodeWorkerProfileSync()).toEqual({
      source: 'codex-subscription',
      model: 'global-openrouter-model',
      codexModel: 'global-model-x',
      repoSkillAllowlist: [],
    });
  }, 30_000);
});
