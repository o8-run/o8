import { codexModelListFixtureScript } from './helpers/codex-model-list-fixture';
/**
 * Spawn-prompt reasoning-effort pin (#2528) — real path.
 *
 * #2519 fixed the create-mission route but the sibling create-and-dispatch
 * entry point, `POST /api/orchestrator/spawn-prompt`, read runtime/model yet
 * dropped both `requestedEffort` and `thinkingEffort`. This proves an explicit
 * effort now survives the actual spawn-prompt handler:
 *   1. route → persisted mission/packet routing → auto-dispatch → captured codex
 *      argv keep the pinned effort, distinct from the operator default.
 *   2. the route rejects malformed, conflicting, unsupported-runtime, and
 *      adapter-coerced pins BEFORE any mission/preflight side effect.
 *   3. omitted effort keeps the runtime default; adaptive resets to it.
 *
 * Only the process/provider boundary (worktree prep, storage telemetry, runtime
 * auth preflight) is mocked, matching the proven mission-effort-pin-real-path
 * harness.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const testCacheRoot = join(process.cwd(), 'node_modules', '.cache');
mkdirSync(testCacheRoot, { recursive: true });
const dataDir = mkdtempSync(join(testCacheRoot, 'o8-spawn-effort-pin-'));
const argsPath = join(dataDir, 'codex-args.jsonl');
const fakeCodexPath = join(dataDir, 'fake-codex');

process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_OWNED_CODEX_ROOT = join(dataDir, 'owned-codex');
process.env.O8_CODEX_BIN = fakeCodexPath;
process.env.O8_CRASH_SURVIVABLE_WORKERS = '1';
process.env.O8_WORKER_SANDBOX = '0';
process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';

const preflight = vi.hoisted(() => ({ calls: 0 }));

// Capacity telemetry is outside effort routing. Keep its completion event real,
// but do not start unrelated adapter observations from this transport fixture.
vi.mock('@/lib/runtime/capacity-service', () => ({
  getRuntimeCapacityControlSnapshot: vi.fn(async () => ({
    schema: 'o8/runtime-capacity-control/v1',
    generatedAt: Date.now(),
    capacities: [],
    identities: [],
    runtimes: [],
  })),
}));

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
  assertRuntimeDispatchable: vi.fn(async () => {
    preflight.calls += 1;
  }),
}));

function makeRepo(): string {
  const repoPath = mkdtempSync(join(dataDir, 'repo-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
  git('init', '--initial-branch=main');
  writeFileSync(join(repoPath, 'README.md'), 'spawn effort pin test\n');
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

async function waitForLaunchContaining(beforeCount: number, needle: string): Promise<string[]> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    const match = readArgvCalls()
      .slice(beforeCount)
      .find((args) => args.some((arg) => arg.includes(needle)));
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for a Codex launch containing "${needle}".`);
}

function routeRequest(path: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { host: 'localhost' },
    body: JSON.stringify({ clientMutationId: `spawn-effort-${crypto.randomUUID()}`, ...body }),
  });
}

async function spawnViaRoute(body: Record<string, unknown>) {
  const route = await import('@/app/api/orchestrator/spawn-prompt/route');
  return route.POST(routeRequest('/api/orchestrator/spawn-prompt', body));
}

async function rejectSpawnPin(body: Record<string, unknown>) {
  const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
  const beforeMissionId = readOrchestratorControlPlaneState().missionId ?? null;
  const beforePreflight = preflight.calls;
  const response = await spawnViaRoute(body);
  const json = await response.json() as { ok: boolean; error?: { code?: string; message?: string } };
  expect(response.status).toBe(400);
  expect(json.ok).toBe(false);
  // "before any side effect": no mission moved, no runtime preflight ran.
  expect(readOrchestratorControlPlaneState().missionId ?? null).toBe(beforeMissionId);
  expect(preflight.calls).toBe(beforePreflight);
  return json.error ?? {};
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
appendFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args) + '\\n');
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex >= 0 && args[outputIndex + 1]) {
  writeFileSync(args[outputIndex + 1], 'Configured Brain answer.');
  process.exit(0);
}
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'worker-' + process.pid }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n');
}`;
  writeFileSync(fakeCodexPath, fixture, 'utf8');
  chmodSync(fakeCodexPath, 0o755);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })));
});

beforeEach(async () => {
  const { listActiveLanes, setLaneStatus } = await import('@/lib/lane/registry');
  for (const lane of listActiveLanes()) {
    if (lane.repoPath.startsWith(dataDir + sep)) {
      setLaneStatus(lane.id, 'completed', 'system', 'fixture_process_completed');
    }
  }
});

afterAll(async () => {
  const { listActiveLanes, getLaneEvents } = await import('@/lib/lane/registry');
  // Argv appears before launch registration completes. The start-capacity event
  // is persisted after supervisor registration, including its ws-token write.
  await vi.waitFor(() => {
    const lanes = listActiveLanes().filter((lane) => lane.repoPath.startsWith(dataDir + sep));
    for (const lane of lanes) {
      expect(['queued', 'launching']).not.toContain(lane.status);
      if (lane.sessionKey) {
        expect(getLaneEvents(lane.id, 10_000).some((event) => (
          event.verb === 'capacity_snapshot' && event.payload.phase === 'start'
        ))).toBe(true);
      }
    }
  }, { timeout: 15_000, interval: 10 });
  const { stopSupervisorLoop } = await import('@/lib/supervisor/agent-supervisor');
  stopSupervisorLoop();
  vi.unstubAllGlobals();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('spawn-prompt effort pin — supported + launch boundary', () => {
  it('persists the explicit pin and keeps it (not the operator default) at launch', async () => {
    const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
    await updateOperatorDefaults({ codexWorkerEffort: 'xhigh' });
    const repoPath = makeRepo();
    const before = readArgvCalls().length;
    const response = await spawnViaRoute({
      repoPath,
      requestedRuntime: 'codex',
      requestedModel: 'gpt-5.6-terra',
      requestedEffort: 'high',
      task: 'spawn high effort keep pin',
    });
    expect(response.status).toBe(201);
    const json = await response.json() as { result: { missionId: string; packets: Array<{ id: string }> } };

    const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    const persisted = readOrchestratorControlPlaneState().packets.find((p) => p.id === json.result.packets[0]?.id);
    expect(persisted?.workerRouting).toMatchObject({ requestedEffort: 'high', selectedEffort: 'high' });

    const launch = await waitForLaunchContaining(before, 'spawn high effort keep pin');
    expect(launch[launch.indexOf('--model') + 1]).toBe('gpt-5.6-terra');
    expect(launch).toContain('model_reasoning_effort=high');
    expect(launch).not.toContain('model_reasoning_effort=xhigh');
  }, 30_000);

  it('accepts thinkingEffort alone and keeps its pin at launch', async () => {
    const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
    await updateOperatorDefaults({ codexWorkerEffort: 'xhigh' });
    const repoPath = makeRepo();
    const before = readArgvCalls().length;
    const response = await spawnViaRoute({
      repoPath,
      requestedRuntime: 'codex',
      requestedModel: 'gpt-5.6-terra',
      thinkingEffort: 'high',
      task: 'spawn thinking effort keep pin',
    });
    expect(response.status).toBe(201);
    const json = await response.json() as { result: { packets: Array<{ id: string }> } };
    const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    const persisted = readOrchestratorControlPlaneState().packets.find((p) => p.id === json.result.packets[0]?.id);
    expect(persisted?.workerRouting).toMatchObject({ requestedEffort: 'high', selectedEffort: 'high' });

    const launch = await waitForLaunchContaining(before, 'spawn thinking effort keep pin');
    expect(launch).toContain('model_reasoning_effort=high');
    expect(launch).not.toContain('model_reasoning_effort=xhigh');
  }, 30_000);

  it('omitted effort keeps the runtime default (no reasoning flag, nulls persisted)', async () => {
    const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
    await updateOperatorDefaults({ codexWorkerEffort: 'adaptive' });
    const repoPath = makeRepo();
    const before = readArgvCalls().length;
    const response = await spawnViaRoute({
      repoPath,
      requestedRuntime: 'codex',
      requestedModel: 'gpt-5.6-terra',
      task: 'spawn omitted effort parity',
    });
    expect(response.status).toBe(201);
    const json = await response.json() as { result: { packets: Array<{ id: string }> } };
    const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    const persisted = readOrchestratorControlPlaneState().packets.find((p) => p.id === json.result.packets[0]?.id);
    expect(persisted?.workerRouting).toMatchObject({ requestedEffort: null, selectedEffort: null });

    const launch = await waitForLaunchContaining(before, 'spawn omitted effort parity');
    expect(launch.some((arg) => arg.startsWith('model_reasoning_effort='))).toBe(false);
  }, 30_000);

  it('treats adaptive as an explicit reset to the runtime default (preserves requested reset)', async () => {
    const repoPath = makeRepo();
    const response = await spawnViaRoute({
      repoPath,
      requestedRuntime: 'codex',
      requestedEffort: 'adaptive',
      task: 'spawn adaptive reset',
    });
    expect(response.status).toBe(201);
    const json = await response.json() as { result: { packets: Array<{ id: string }> } };
    const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    const persisted = readOrchestratorControlPlaneState().packets.find((p) => p.id === json.result.packets[0]?.id);
    expect(persisted?.workerRouting).toMatchObject({ requestedEffort: 'adaptive', selectedEffort: null });
  }, 30_000);
});

describe('spawn-prompt effort pin — public route rejections', () => {
  it('rejects a malformed effort string instead of silently nulling it', async () => {
    const repoPath = makeRepo();
    const error = await rejectSpawnPin({
      repoPath,
      requestedRuntime: 'codex',
      requestedEffort: 'turbo',
      task: 'bad effort',
    });
    expect(error.code).toBe('invalid_effort');
  }, 30_000);

  it('rejects conflicting requestedEffort/thinkingEffort aliases', async () => {
    const repoPath = makeRepo();
    const error = await rejectSpawnPin({
      repoPath,
      requestedRuntime: 'codex',
      requestedEffort: 'adaptive',
      thinkingEffort: 'high',
      task: 'conflicting effort',
    });
    expect(error.code).toBe('conflicting_effort');
  }, 30_000);

  it('rejects a malformed shadowed alias even when the other alias is valid', async () => {
    const repoPath = makeRepo();
    const error = await rejectSpawnPin({
      repoPath,
      requestedRuntime: 'codex',
      requestedEffort: 'high',
      thinkingEffort: 'turbo',
      task: 'shadowed effort',
    });
    expect(error.code).toBe('invalid_effort');
  }, 30_000);

  it('rejects an explicit effort on a runtime with no reasoning-effort surface', async () => {
    const repoPath = makeRepo();
    const error = await rejectSpawnPin({
      repoPath,
      requestedRuntime: 'gemini',
      requestedEffort: 'high',
      task: 'gemini effort',
    });
    expect(error.code).toBe('effort_unsupported_runtime');
    expect(error.message).toContain('cannot honor');
  }, 30_000);

  it('rejects a pin the codex adapter would coerce for an unverified model', async () => {
    const repoPath = makeRepo();
    const error = await rejectSpawnPin({
      repoPath,
      requestedRuntime: 'codex',
      requestedModel: 'gpt-5.5',
      requestedEffort: 'max',
      task: 'coerced max',
    });
    expect(error.code).toBe('effort_coerced');
    expect(error.message).toContain('xhigh');
  }, 30_000);

  it('rejects an explicit effort when the requested model is incompatible and would be swapped', async () => {
    const repoPath = makeRepo();
    const error = await rejectSpawnPin({
      repoPath,
      requestedRuntime: 'codex',
      requestedModel: 'claude-opus-5',
      requestedEffort: 'high',
      task: 'incompatible model effort',
    });
    expect(error.code).toBe('effort_model_incompatible');
  }, 30_000);
});
