import { codexModelListFixtureScript } from './helpers/codex-model-list-fixture';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const testCacheRoot = join(process.cwd(), 'node_modules', '.cache');
mkdirSync(testCacheRoot, { recursive: true });
const dataDir = mkdtempSync(join(testCacheRoot, 'o8-worker-model-route-'));
const argsPath = join(dataDir, 'codex-args.jsonl');
const fakeCodexPath = join(dataDir, 'fake-codex');

process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_OWNED_CODEX_ROOT = join(dataDir, 'owned-codex');
process.env.O8_CODEX_BIN = fakeCodexPath;
process.env.O8_TEST_CODEX_ARGS_FILE = argsPath;
process.env.O8_CRASH_SURVIVABLE_WORKERS = '1';
process.env.O8_WORKER_SANDBOX = '0';
process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';

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

vi.mock('@/lib/worktree', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/worktree')>();
  return {
    ...actual,
    prepareLaunchWorktree: vi.fn(async (
      options: Parameters<typeof actual.prepareLaunchWorktree>[0],
    ) => ({
      cwd: options.repoRoot,
      worktree: {
        id: `packet-${options.packetId}`,
        path: options.repoRoot,
        branch: options.branchName!,
        baseBranch: options.baseBranch ?? 'main',
        agentType: options.agentType,
        status: 'ready' as const,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        dirtyFiles: [],
        claudeManaged: false,
      },
    })),
    linkSessionToWorktree: vi.fn(async () => undefined),
  };
});

vi.mock('@/lib/workspace/materialization-guard', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/workspace/materialization-guard')>(),
  inspectOwnedWorkspaceMaterialization: vi.fn(async () => ({
    status: 'available' as const,
    source: 'no-snapshot' as const,
  })),
}));

vi.mock('@/lib/runtimes/shared/auth-detect', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/runtimes/shared/auth-detect')>(),
  assertRuntimeDispatchable: vi.fn(async () => undefined),
}));

function makeRepo(): string {
  const repoPath = mkdtempSync(join(dataDir, 'repo-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
  git('init', '--initial-branch=main');
  writeFileSync(join(repoPath, 'README.md'), 'worker model routing test\n');
  git('add', 'README.md');
  git('-c', 'user.email=test@o8.test', '-c', 'user.name=o8-test', 'commit', '-m', 'init');
  return repoPath;
}

function readArgvCalls(): string[][] {
  if (!existsSync(argsPath)) return [];
  return readFileSync(argsPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

async function launchFailureDetails() {
  const { currentMissionState } = await import('@/lib/orchestrator/operator-mission-service/shared');
  return JSON.stringify(currentMissionState().packets.map(({ id, status, blockedReason }) => ({ id, status, blockedReason })));
}

async function waitForArgvCalls(count: number): Promise<string[][]> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    const calls = readArgvCalls();
    if (calls.length >= count) return calls;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${count} Codex launches: ${await launchFailureDetails()}`);
}

async function createAndDispatchWorker(repoPath: string, id: string, requestedModel?: string) {
  const { createMission, dispatchMission } = await import('@/lib/orchestrator/operator-mission-service');
  const created = await createMission({
    issues: [{ number: Number(id), title: `packet ${id}`, body: `packet ${id}`, url: '' }],
    repoPath,
    runtime: 'codex',
    requestedRuntime: 'codex',
    requestedModel,
    constraints: '',
  });
  const { currentMissionState } = await import('@/lib/orchestrator/operator-mission-service/shared');
  expect(currentMissionState().missionId).toBe(created.missionId);
  await dispatchMission({ missionId: created.missionId });
  if (!currentMissionState().packets[0]?.lane) {
    await dispatchMission({ missionId: created.missionId });
  }
  return currentMissionState();
}

beforeAll(() => {
  const fixture = `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('codex-cli 0.145.0\\n');
  process.exit(0);
}
${codexModelListFixtureScript()}
if (args[0] !== 'exec') process.exit(0);
appendFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args) + '\\n');
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex >= 0 && args[outputIndex + 1]) {
  writeFileSync(args[outputIndex + 1], 'Configured Brain answer.');
  process.exit(0);
}
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'worker-' + process.pid }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n');
}
`;
  writeFileSync(fakeCodexPath, fixture, 'utf8');
  chmodSync(fakeCodexPath, 0o755);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })));
});

afterAll(() => {
  vi.unstubAllGlobals();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('worker model routing real path', () => {
  it('persists an incompatible explicit model disposition on the created packet', async () => {
    const repoPath = makeRepo();
    const { createMission } = await import('@/lib/orchestrator/operator-mission-service');
    await createMission({
      issues: [{ number: 90_004, title: 'packet 90004', body: 'packet 90004', url: '' }],
      repoPath,
      runtime: 'codex',
      requestedRuntime: 'codex',
      requestedModel: 'claude-opus-5',
      constraints: '',
    });
    const { currentMissionState } = await import('@/lib/orchestrator/operator-mission-service/shared');
    expect(currentMissionState().packets[0]?.workerRouting).toMatchObject({
      requestedModel: 'claude-opus-5',
      selectedProvider: 'codex',
      selectedRuntime: 'codex',
      selectedModel: null,
      modelDisposition: 'rejected-incompatible',
    });
  });

  it('keeps worker defaults, packet pins, and Brain routing on their configured values', async () => {
    const { POST } = await import('@/app/api/panel/operator-defaults/route');
    const response = await POST(new Request('http://127.0.0.1/api/panel/operator-defaults', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscriptionProfile: 'both',
        parallelCap: 2,
        defaultDispatchRuntime: 'codex',
        defaultDispatchModel: 'gpt-5.6-sol',
        codexWorkerEffort: 'high',
        brainCodexModel: 'gpt-5.6-terra',
        brainCodexEffort: 'xhigh',
      }),
    }));
    expect(response.status).toBe(200);

    const defaultRepoPath = makeRepo();
    const pinnedRepoPath = makeRepo();
    const dispatchedDefault = await createAndDispatchWorker(defaultRepoPath, '90001');
    const dispatchedPinned = await createAndDispatchWorker(pinnedRepoPath, '90002', 'gpt-5.5');

    const workerCalls = (await waitForArgvCalls(2)).filter((args) => args.includes('--json'));
    expect(workerCalls).toHaveLength(2);
    const defaultCall = workerCalls.find((args) => args.some((arg) => arg.includes('packet 90001')));
    const pinnedCall = workerCalls.find((args) => args.some((arg) => arg.includes('packet 90002')));
    expect(defaultCall).toBeDefined();
    expect(defaultCall?.[defaultCall.indexOf('--model') + 1]).toBe('gpt-5.6-sol');
    expect(defaultCall).toContain('model_reasoning_effort=high');
    expect(pinnedCall).toBeDefined();
    expect(pinnedCall?.[pinnedCall.indexOf('--model') + 1]).toBe('gpt-5.5');
    expect(pinnedCall).toContain('model_reasoning_effort=high');

    expect(dispatchedDefault.packets[0]).toMatchObject({
      assignedModel: 'gpt-5.6-sol',
      workerRouting: {
        selectedModel: 'gpt-5.6-sol',
        selectedEffort: 'high',
      },
    });
    expect(dispatchedPinned.packets[0]).toMatchObject({
      assignedModel: 'gpt-5.5',
      workerRouting: {
        selectedModel: 'gpt-5.5',
        selectedEffort: 'high',
      },
    });

    const { listRoleRoutingReceipts } = await import('@/lib/operator/role-routing-ledger');
    expect(listRoleRoutingReceipts({ role: 'build', repoPath: defaultRepoPath })).toEqual([
      expect.objectContaining({
        role: 'build',
        contextType: 'packet',
        contextId: dispatchedDefault.packets[0]?.id,
        effective: expect.objectContaining({ runtime: 'codex', model: 'gpt-5.6-sol', effort: 'high' }),
        status: 'selected',
      }),
    ]);

    const { callCodex, resetCodexProviderCache } = await import('@/lib/cortex/qa/llm/codex-adapter');
    resetCodexProviderCache();
    await expect(callCodex('Which Brain route is active?')).resolves.toBe('Configured Brain answer.');
    const allCalls = await waitForArgvCalls(3);
    const brainCall = allCalls.find((args) => args.includes('--output-last-message'));
    expect(brainCall).toBeDefined();
    expect(brainCall?.[brainCall.indexOf('--model') + 1]).toBe('gpt-5.6-terra');
    expect(brainCall).toContain('model_reasoning_effort=xhigh');

    const codexOnlyResponse = await POST(new Request('http://127.0.0.1/api/panel/operator-defaults', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscriptionProfile: 'codex-only',
        parallelCap: 3,
        defaultDispatchModel: '',
      }),
    }));
    expect(codexOnlyResponse.status).toBe(200);
    const codexOnlyRepoPath = makeRepo();
    const dispatchedCodexOnly = await createAndDispatchWorker(codexOnlyRepoPath, '90003');
    const codexOnlyCall = (await waitForArgvCalls(4))
      .find((args) => args.some((arg) => arg.includes('packet 90003')));
    expect(codexOnlyCall?.[codexOnlyCall.indexOf('--model') + 1]).toBe('gpt-5.6-terra');
    expect(dispatchedCodexOnly.packets[0]).toMatchObject({
      assignedModel: 'gpt-5.6-terra',
      workerRouting: { selectedModel: 'gpt-5.6-terra', selectedEffort: 'high' },
    });
  }, 30_000);
  it('honors a persisted adaptive reset when the scheduler launches a packet with saved high effort', async () => {
    const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
    await updateOperatorDefaults({ subscriptionProfile: 'both', defaultDispatchRuntime: 'codex', defaultDispatchModel: 'gpt-5.6-sol', codexWorkerEffort: 'high', parallelCap: 4 });
    const { createMission, dispatchMission } = await import('@/lib/orchestrator/operator-mission-service');
    const { withLockedState } = await import('@/lib/orchestrator/control-plane');
    const repoPath = makeRepo();
    const created = await createMission({ issues: [{ number: 90005, title: 'adaptive packet', body: 'Inspect only', url: '' }], repoPath,
      runtime: 'codex', requestedRuntime: 'codex', requestedModel: 'gpt-5.6-sol', constraints: '' });
    // Delegate persists this reset; restart/scheduler must consume durable state.
    await withLockedState(state => { state.packets[0]!.workerRouting!.requestedEffort = 'adaptive'; state.packets[0]!.workerRouting!.selectedEffort = null; });
    await dispatchMission({ missionId: created.missionId });
    const calls = await waitForArgvCalls(5);
    expect(calls[4]?.some(arg => arg.startsWith('model_reasoning_effort='))).toBe(false);
    const { currentMissionState } = await import('@/lib/orchestrator/operator-mission-service/shared');
    expect(currentMissionState().packets[0]?.workerRouting).toMatchObject({ requestedEffort: 'adaptive', selectedEffort: null });
  });

});
