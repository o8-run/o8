/**
 * Mission reasoning-effort pin (#2519) — real path.
 *
 * Proves an explicit `--effort` pin survives the ACTUAL entry points:
 *   1. `POST /api/orchestrator/create-mission` → persisted reload →
 *      `dispatchMission` (through scheduler reconstruction + enrichment) →
 *      captured codex argv, with the pin DIFFERENT from the operator default.
 *   2. the route rejects malformed, conflicting, unsupported-runtime,
 *      incompatible-model, adapter-coerced, and best-of-N-candidate-coerced pins
 *      BEFORE any mission/branch/preflight side effect.
 *   3. an explicit dispatch runtime override cannot silently drop a persisted
 *      pin; it is rejected before mission/packet routing is mutated.
 *
 * Only the process/provider boundary (worktree prep, storage telemetry, runtime
 * auth preflight, Gemini/Claude launch) and the supervisor-watch fetch are
 * mocked, matching the proven worker-model-routing-real-path harness.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const testCacheRoot = join(process.cwd(), 'node_modules', '.cache');
mkdirSync(testCacheRoot, { recursive: true });
const dataDir = mkdtempSync(join(testCacheRoot, 'o8-mission-effort-pin-'));
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
const providerLaunches = vi.hoisted(() => ({
  claude: [] as Array<{ model?: string; claudeCodeModel?: string; claudeCodeCarrier?: string; effort?: string }>,
  gemini: [] as Array<{ model?: string }>,
}));

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

vi.mock('@/lib/gemini/owned', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/gemini/owned')>();
  return {
    ...actual,
    launchOwnedGeminiSession: vi.fn(async (request: { model?: string }) => {
      providerLaunches.gemini.push({ model: request.model });
      return {
        ok: true,
        runtime: 'gemini' as const,
        surfaceId: 'gemini-owned:mission-effort-pin-test',
        note: 'fake Gemini launch',
      };
    }),
  };
});

vi.mock('@/lib/claude-code/owned', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/claude-code/owned')>();
  return {
    ...actual,
    launchOwnedClaudeCodeSession: vi.fn(async (request: {
      model?: string;
      claudeCodeModel?: string;
      claudeCodeCarrier?: string;
      effort?: string;
    }) => {
      providerLaunches.claude.push(request);
      return {
        ok: true,
        runtime: 'claude-code' as const,
        surfaceId: `claude-code-owned:mission-effort-pin-${providerLaunches.claude.length}`,
        note: 'fake Claude launch',
      };
    }),
  };
});

function makeRepo(): string {
  const repoPath = mkdtempSync(join(dataDir, 'repo-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
  git('init', '--initial-branch=main');
  writeFileSync(join(repoPath, 'README.md'), 'mission effort pin test\n');
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

async function waitForLaunchContaining(beforeCount: number, needle: string): Promise<string[]> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    const match = readArgvCalls()
      .slice(beforeCount)
      .find((args) => args.some((arg) => arg.includes(needle)));
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for a Codex launch containing "${needle}": ${await launchFailureDetails()}`);
}

async function waitForLaunchesContaining(
  beforeCount: number,
  needle: string,
  count: number,
): Promise<string[][]> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20_000) {
    const matches = readArgvCalls()
      .slice(beforeCount)
      .filter((args) => args.some((arg) => arg.includes(needle)));
    if (matches.length >= count) return matches;
    const { runHeadlessSprintTick } = await import('@/lib/orchestrator/headless-loop');
    await runHeadlessSprintTick();
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${count} Codex launches containing "${needle}": ${await launchFailureDetails()}`);
}

async function waitForClaudeLaunches(beforeCount: number, count: number) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20_000) {
    const launches = providerLaunches.claude.slice(beforeCount);
    if (launches.length >= count) return launches;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${count} fake Claude launches.`);
}

function routeRequest(path: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { host: 'localhost' },
    body: JSON.stringify({ clientMutationId: `effort-pin-${crypto.randomUUID()}`, ...body }),
  });
}

async function createMissionViaRoute(body: Record<string, unknown>) {
  const route = await import('@/app/api/orchestrator/create-mission/route');
  const response = await route.POST(routeRequest('/api/orchestrator/create-mission', body));
  return response;
}

async function createMissionViaMcp(body: Record<string, unknown>) {
  const route = await import('@/app/api/orchestrator/create-mission/route');
  vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return route.POST(routeRequest('/api/orchestrator/create-mission', requestBody));
  }));
  const { handleCreateMission } = await import('@/lib/mcp/operator-handlers/mission');
  return handleCreateMission(body);
}

function stubExternalFetch() {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })));
}

function missionResultFromMcp(result: { content: Array<{ type: string; text?: string }> }): { missionId: string; packetId: string } {
  const text = result.content.find((entry) => entry.type === 'text')?.text ?? '{}';
  const payload = JSON.parse(text) as { missionId?: string; packets?: Array<{ id?: string }> };
  return { missionId: payload.missionId ?? '', packetId: payload.packets?.[0]?.id ?? '' };
}

const qualitySearchTaskContract = {
  version: 1 as const,
  requirements: [{
    id: 'R1',
    source: 'write the verification artifact',
    expectedBehavior: 'The verification artifact exists.',
    productionPath: 'verification.txt',
    verification: 'inspect the committed artifact',
  }],
  smallestRoute: [{
    path: 'verification.txt',
    requirements: ['R1'],
    reason: 'The requested artifact is the complete change.',
  }],
  exclusions: [],
};

async function rejectEffortPin(body: Record<string, unknown>) {
  const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
  const beforeMissionId = readOrchestratorControlPlaneState().missionId ?? null;
  const beforePreflight = preflight.calls;
  const response = await createMissionViaRoute(body);
  const json = await response.json() as { ok: boolean; error?: { code?: string; message?: string } };
  expect(response.status).toBe(400);
  expect(json.ok).toBe(false);
  // "before mission side effects": no mission moved, no runtime preflight ran.
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
appendFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args) + '\\n');
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex >= 0 && args[outputIndex + 1]) {
  writeFileSync(args[outputIndex + 1], 'Configured Brain answer.');
  process.exit(0);
}
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'worker-' + process.pid }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n');
`;
  writeFileSync(fakeCodexPath, fixture, 'utf8');
  chmodSync(fakeCodexPath, 0o755);
  stubExternalFetch();
});

beforeEach(async () => {
  // Fake processes have finished; retire only this fixture's prior lanes so
  // later cases exercise the real admission cap without leaked active slots.
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

describe('mission effort pin — launch boundary', () => {
  it('MCP create_mission keeps an explicit medium pin through persistence and the Codex launch', async () => {
    const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
    await updateOperatorDefaults({ codexWorkerEffort: 'xhigh' });
    const repoPath = makeRepo();
    try {
      const result = await createMissionViaMcp({
        repoPath,
        issues_inline: [{ title: 'MCP medium effort survives', body: 'touch effort pin' }],
        runtime: 'codex',
        model: 'gpt-5.6-terra',
        requestedEffort: 'medium',
        dispatch: false,
      });
      expect(result.isError).not.toBe(true);
      const { missionId, packetId } = missionResultFromMcp(result);
      expect(missionId).toBeTruthy();

      const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
      const packet = readOrchestratorControlPlaneState().packets.find((candidate) => candidate.id === packetId);
      expect(packet?.workerRouting).toMatchObject({ requestedEffort: 'medium', selectedEffort: 'medium' });

      // The MCP transport is complete. Restore the normal external-call fixture
      // before the real scheduler starts its unrelated telemetry work.
      stubExternalFetch();
      const { dispatchMission } = await import('@/lib/orchestrator/operator-mission-service');
      const before = readArgvCalls().length;
      await dispatchMission({ missionId });
      const launch = await waitForLaunchContaining(before, 'MCP medium effort survives');
      expect(launch).toContain('model_reasoning_effort=medium');
      expect(launch).not.toContain('model_reasoning_effort=xhigh');
    } finally {
      stubExternalFetch();
    }
  }, 30_000);

  it('MCP create_mission keeps omitted effort at the runtime default and rejects malformed pins', async () => {
    const repoPath = makeRepo();
    try {
      const omitted = await createMissionViaMcp({
        repoPath,
        issues_inline: [{ title: 'MCP omitted effort parity', body: 'touch effort pin' }],
        runtime: 'codex',
        model: 'gpt-5.6-terra',
        dispatch: false,
      });
      expect(omitted.isError).not.toBe(true);
      const { packetId } = missionResultFromMcp(omitted);
      const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
      expect(readOrchestratorControlPlaneState().packets.find((packet) => packet.id === packetId)?.workerRouting)
        .toMatchObject({ requestedEffort: null, selectedEffort: null });

      const beforeMissionId = readOrchestratorControlPlaneState().missionId;
      const malformed = await createMissionViaMcp({
        repoPath,
        issues_inline: [{ title: 'MCP malformed effort', body: 'must not persist' }],
        runtime: 'codex',
        requestedEffort: 'turbo',
        dispatch: false,
      });
      expect(malformed.isError).toBe(true);
      expect(malformed.content.find((entry) => entry.type === 'text')?.text).toContain('effort must be one of');
      expect(readOrchestratorControlPlaneState().missionId).toBe(beforeMissionId);
    } finally {
      stubExternalFetch();
    }
  }, 30_000);

  it.each(['high', 'max', 'ultra'] as const)('route creation → persisted reload → dispatch → argv keeps Terra %s exact', async (requestedEffort) => {
    const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
    await updateOperatorDefaults({ codexWorkerEffort: 'xhigh' });
    const repoPath = makeRepo();
    const response = await createMissionViaRoute({
      repoPath,
      runtime: 'codex',
      requestedRuntime: 'codex',
      requestedModel: 'gpt-5.6-terra',
      requestedEffort,
      issues: [{ number: 900_101, title: `effort pin ${requestedEffort} terra`, body: 'touch src/lib/orchestrator/effort-pin.ts', url: '' }],
    });
    expect(response.status).toBe(201);
    const json = await response.json() as { result: { missionId: string; packets: Array<{ id: string }> } };

    // persisted reload (not the create return) proves the pin survived normalize.
    const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    const persisted = readOrchestratorControlPlaneState().packets.find((p) => p.id === json.result.packets[0]?.id);
    expect(persisted?.workerRouting).toMatchObject({ requestedEffort, selectedEffort: requestedEffort });

    const { dispatchMission } = await import('@/lib/orchestrator/operator-mission-service');
    const before = readArgvCalls().length;
    await dispatchMission({ missionId: json.result.missionId });
    const launch = await waitForLaunchContaining(before, `effort pin ${requestedEffort} terra`);
    expect(launch[launch.indexOf('--model') + 1]).toBe('gpt-5.6-terra');
    // If the scheduler/enrichment dropped the pin, the operator default xhigh would win.
    expect(launch).toContain(`model_reasoning_effort=${requestedEffort}`);
    expect(launch).not.toContain('model_reasoning_effort=xhigh');
  }, 30_000);

  it('omitted effort keeps the runtime default (no reasoning flag, nulls persisted)', async () => {
    const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
    await updateOperatorDefaults({ codexWorkerEffort: 'adaptive' });
    const repoPath = makeRepo();
    const response = await createMissionViaRoute({
      repoPath,
      runtime: 'codex',
      requestedRuntime: 'codex',
      requestedModel: 'gpt-5.6-terra',
      issues: [{ number: 900_102, title: 'effort parity packet', body: 'touch src/lib/orchestrator/effort-pin.ts', url: '' }],
    });
    expect(response.status).toBe(201);
    const json = await response.json() as { result: { missionId: string; packets: Array<{ id: string }> } };
    const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    const persisted = readOrchestratorControlPlaneState().packets.find((p) => p.id === json.result.packets[0]?.id);
    expect(persisted?.workerRouting).toMatchObject({ requestedEffort: null, selectedEffort: null });

    const { dispatchMission } = await import('@/lib/orchestrator/operator-mission-service');
    const before = readArgvCalls().length;
    await dispatchMission({ missionId: json.result.missionId });
    const launch = await waitForLaunchContaining(before, 'effort parity packet');
    expect(launch.some((arg) => arg.startsWith('model_reasoning_effort='))).toBe(false);
  }, 30_000);
});

describe('mission effort pin — public route', () => {
  it('accepts a supported high+Terra pin and persists it on the packet', async () => {
    const repoPath = makeRepo();
    const response = await createMissionViaRoute({
      repoPath,
      runtime: 'codex',
      requestedRuntime: 'codex',
      requestedModel: 'gpt-5.6-terra',
      requestedEffort: 'high',
      issues: [{ number: 900_103, title: 'route effort high', body: 'body', url: '' }],
    });
    expect(response.status).toBe(201);
    const json = await response.json() as { result: { packets: Array<{ id: string }> } };
    const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    const packet = readOrchestratorControlPlaneState().packets.find((p) => p.id === json.result.packets[0]?.id);
    expect(packet?.workerRouting).toMatchObject({ requestedEffort: 'high', selectedEffort: 'high' });
  }, 30_000);

  it('treats adaptive as an explicit reset to the runtime default (preserves requested reset)', async () => {
    const repoPath = makeRepo();
    const response = await createMissionViaRoute({
      repoPath,
      runtime: 'codex',
      requestedRuntime: 'codex',
      requestedEffort: 'adaptive',
      issues: [{ number: 900_104, title: 'route effort adaptive', body: 'body', url: '' }],
    });
    expect(response.status).toBe(201);
    const json = await response.json() as { result: { packets: Array<{ id: string }> } };
    const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    const packet = readOrchestratorControlPlaneState().packets.find((p) => p.id === json.result.packets[0]?.id);
    expect(packet?.workerRouting).toMatchObject({ requestedEffort: 'adaptive', selectedEffort: null });
  }, 30_000);

  it('rejects a malformed effort string instead of silently nulling it', async () => {
    const repoPath = makeRepo();
    const error = await rejectEffortPin({
      repoPath,
      runtime: 'codex',
      requestedEffort: 'turbo',
      issues: [{ number: 900_105, title: 'bad effort', body: 'body', url: '' }],
    });
    expect(error.code).toBe('invalid_effort');
    expect(error.message).toContain('high');
  }, 30_000);

  it('rejects conflicting requestedEffort/thinkingEffort aliases (adaptive vs concrete)', async () => {
    const repoPath = makeRepo();
    const error = await rejectEffortPin({
      repoPath,
      runtime: 'codex',
      requestedEffort: 'adaptive',
      thinkingEffort: 'high',
      issues: [{ number: 900_106, title: 'conflicting effort', body: 'body', url: '' }],
    });
    expect(error.code).toBe('conflicting_effort');
  }, 30_000);

  it('rejects a malformed shadowed alias even when the other alias is valid', async () => {
    const repoPath = makeRepo();
    const error = await rejectEffortPin({
      repoPath,
      runtime: 'codex',
      requestedEffort: 'high',
      thinkingEffort: 'turbo',
      issues: [{ number: 900_107, title: 'shadowed effort', body: 'body', url: '' }],
    });
    expect(error.code).toBe('invalid_effort');
  }, 30_000);

  it('rejects an explicit effort on a runtime with no reasoning-effort surface', async () => {
    const repoPath = makeRepo();
    const error = await rejectEffortPin({
      repoPath,
      runtime: 'gemini',
      requestedRuntime: 'gemini',
      requestedEffort: 'high',
      issues: [{ number: 900_108, title: 'gemini effort', body: 'body', url: '' }],
    });
    expect(error.code).toBe('effort_unsupported_runtime');
    expect(error.message).toContain('cannot honor');
  }, 30_000);

  it('rejects an explicit effort when the requested model is incompatible and would be swapped', async () => {
    const repoPath = makeRepo();
    const error = await rejectEffortPin({
      repoPath,
      runtime: 'codex',
      requestedRuntime: 'codex',
      requestedModel: 'claude-opus-5',
      requestedEffort: 'high',
      issues: [{ number: 900_109, title: 'incompatible model effort', body: 'body', url: '' }],
    });
    expect(error.code).toBe('effort_model_incompatible');
    expect(error.message).toContain('claude-opus-5');
  }, 30_000);

  it('rejects a pin the codex adapter would coerce for an unverified model', async () => {
    const repoPath = makeRepo();
    const error = await rejectEffortPin({
      repoPath,
      runtime: 'codex',
      requestedRuntime: 'codex',
      requestedModel: 'gpt-5.5',
      requestedEffort: 'max',
      issues: [{ number: 900_110, title: 'coerced max', body: 'body', url: '' }],
    });
    expect(error.code).toBe('effort_coerced');
    expect(error.message).toContain('xhigh');
  }, 30_000);

  it('rejects a pin the claude adapter would coerce (ultra maps to max)', async () => {
    const repoPath = makeRepo();
    const error = await rejectEffortPin({
      repoPath,
      runtime: 'claude-code',
      requestedRuntime: 'claude-code',
      requestedModel: 'claude-opus-5',
      requestedEffort: 'ultra',
      issues: [{ number: 900_111, title: 'coerced ultra', body: 'body', url: '' }],
    });
    expect(error.code).toBe('effort_coerced');
    expect(error.message).toContain('max');
  }, 30_000);

  it('rejects a best-of-N comparison candidate whose adapter would coerce the seed pin', async () => {
    const repoPath = makeRepo();
    const error = await rejectEffortPin({
      repoPath,
      runtime: 'codex',
      requestedRuntime: 'codex',
      requestedModel: 'gpt-5.6-sol',
      requestedEffort: 'max',
      comparisonModels: ['gpt-5.5'],
      issues: [{ number: 900_112, title: 'comparison coercion', body: 'body', url: '' }],
    });
    expect(error.code).toBe('effort_coerced');
    expect(error.message).toContain('gpt-5.5');
  }, 30_000);

  it('rejects a foreign-runtime comparison candidate with a supported effort (not only max)', async () => {
    const repoPath = makeRepo();
    const error = await rejectEffortPin({
      repoPath,
      runtime: 'codex',
      requestedRuntime: 'codex',
      requestedEffort: 'high',
      comparisonModels: ['claude-opus-5'],
      issues: [{ number: 900_115, title: 'foreign comparison', body: 'body', url: '' }],
    });
    expect(error.code).toBe('effort_model_incompatible');
  }, 30_000);

  it('rejects an explicit effort when a per-issue runtime cannot honor it, before preflight', async () => {
    const repoPath = makeRepo();
    const error = await rejectEffortPin({
      repoPath,
      runtime: 'codex',
      requestedRuntime: 'codex',
      requestedEffort: 'high',
      issues: [{
        number: 900_116,
        title: 'per-issue gemini',
        body: 'body',
        url: '',
        runtime: 'gemini',
      }],
    });
    expect(error.code).toBe('effort_unsupported_runtime');
  }, 30_000);

  it('launches each best-of-N candidate on its own model at the pinned effort', async () => {
    const repoPath = makeRepo();
    const response = await createMissionViaRoute({
      repoPath,
      runtime: 'codex',
      requestedRuntime: 'codex',
      requestedEffort: 'high',
      comparisonModels: ['gpt-5.6-sol', 'gpt-5.6-terra'],
      dispatchOnCreate: true,
      issues: [{ number: 900_114, title: 'cmp pin two models', body: 'touch src/lib/orchestrator/effort-pin.ts', url: '' }],
    });
    expect(response.status).toBe(201);
    await response.json();

    const before = readArgvCalls().length;
    // The headless entry point persists fan-out before provider launch, which is
    // the production ordering the runtime work-mode guard requires.
    const { runHeadlessSprintTick } = await import('@/lib/orchestrator/headless-loop');
    await runHeadlessSprintTick();
    const launches = await waitForLaunchesContaining(before, 'cmp pin two models', 2);
    const models = launches.map((args) => args[args.indexOf('--model') + 1]).sort();
    expect(models).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra']);
    for (const args of launches) {
      expect(args).toContain('model_reasoning_effort=high');
    }
  }, 30_000);

  it('persists inline quality-search candidates before explicit dispatch reaches the launch guard', async () => {
    const repoPath = makeRepo();
    const response = await createMissionViaRoute({
      repoPath,
      runtime: 'codex',
      requestedRuntime: 'codex',
      requestedModel: 'gpt-5.6-terra',
      requestedEffort: 'medium',
      dispatchOnCreate: false,
      qualitySearch: { taskContract: qualitySearchTaskContract },
      issues: [{
        number: 900_118,
        title: 'inline quality search durable launch',
        body: 'Create verification.txt.',
        url: '',
      }],
    });
    expect(response.status).toBe(201);
    const created = await response.json() as {
      result: { missionId: string };
    };

    const before = readArgvCalls().length;
    const dispatchRoute = await import('@/app/api/orchestrator/dispatch/route');
    const dispatchResponse = await dispatchRoute.POST(routeRequest('/api/orchestrator/dispatch', {
      missionId: created.result.missionId,
      wait: true,
    }));
    expect(dispatchResponse.status).toBe(200);
    const dispatched = await dispatchResponse.json() as { result: { dispatched: number } };
    const launch = await waitForLaunchContaining(before, 'inline quality search durable launch');
    const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    const { resolvePacketWorkMode } = await import('@/lib/orchestrator/packet-launch-context');
    const persisted = readOrchestratorControlPlaneState();
    const candidates = persisted.packets.filter((packet) => packet.comparisonGroupId);

    expect(dispatched.result.dispatched).toBeGreaterThan(0);
    expect(launch).toContain('gpt-5.6-terra');
    expect(candidates).toHaveLength(2);
    expect(candidates.every((packet) => resolvePacketWorkMode(packet.id).found)).toBe(true);
    expect(candidates.every((packet) => !packet.blockedReason?.includes('not found in durable state'))).toBe(true);
  }, 30_000);

  it('launches a saved inline quality-search mission once when explicit dispatch overlaps the scheduler', async () => {
    const repoPath = makeRepo();
    const qualityResponse = await createMissionViaRoute({
      repoPath,
      runtime: 'codex',
      requestedRuntime: 'codex',
      requestedModel: 'gpt-5.6-terra',
      requestedEffort: 'medium',
      dispatchOnCreate: false,
      qualitySearch: { taskContract: qualitySearchTaskContract },
      issues: [{
        number: 900_119,
        title: 'saved inline quality search concurrent launch',
        body: 'Create verification.txt.',
        url: '',
      }],
    });
    expect(qualityResponse.status).toBe(201);
    const qualityMission = await qualityResponse.json() as { result: { missionId: string } };

    // Move the quality-search mission into the durable registry so explicit
    // dispatch and the headless registry scheduler contend on the real locks.
    const replacementResponse = await createMissionViaRoute({
      repoPath,
      runtime: 'codex',
      requestedRuntime: 'codex',
      dispatchOnCreate: false,
      issues: [{
        number: 900_120,
        title: 'current held control mission',
        body: 'Remain held.',
        url: '',
      }],
    });
    expect(replacementResponse.status).toBe(201);

    const before = readArgvCalls().length;
    const dispatchRoute = await import('@/app/api/orchestrator/dispatch/route');
    const { runHeadlessSprintTick } = await import('@/lib/orchestrator/headless-loop');
    const [dispatchResponse] = await Promise.all([
      dispatchRoute.POST(routeRequest('/api/orchestrator/dispatch', {
        missionId: qualityMission.result.missionId,
        wait: true,
      })),
      runHeadlessSprintTick(),
    ]);
    expect(dispatchResponse.status).toBe(200);
    const dispatchResult = await dispatchResponse.json() as { result: { dispatched: number } };
    const launches = await waitForLaunchesContaining(before, 'saved inline quality search concurrent launch', 2);
    const { readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
    const { listLanes } = await import('@/lib/lane/registry');
    const saved = readMissionRegistryEntry(qualityMission.result.missionId, { includeArchived: true });
    const candidateIds = saved?.mission.packets.map((packet) => packet.id) ?? [];
    const candidateLanes = listLanes().filter((lane) => lane.packetId && candidateIds.includes(lane.packetId));

    expect(dispatchResult.result.dispatched).toBeGreaterThanOrEqual(1);
    expect(launches).toHaveLength(2);
    expect(candidateIds).toHaveLength(2);
    expect(candidateLanes).toHaveLength(2);
    expect(new Set(candidateLanes.map((lane) => lane.packetId)).size).toBe(2);
  }, 30_000);

  it('replaces a Claude seed carrier model for each comparison candidate at launch', async () => {
    const repoPath = makeRepo();
    const response = await createMissionViaRoute({
      repoPath,
      runtime: 'claude-code',
      requestedRuntime: 'claude-code',
      requestedModel: 'claude-sonnet-5',
      requestedEffort: 'high',
      claudeCodeModel: 'claude-sonnet-5',
      claudeCodeCarrier: 'native',
      comparisonModels: ['claude-sonnet-5', 'claude-opus-5'],
      dispatchOnCreate: true,
      issues: [{ number: 900_117, title: 'Claude carrier comparison', body: 'touch src/lib/orchestrator/comparison-fanout.ts', url: '' }],
    });
    expect(response.status).toBe(201);
    await response.json();

    const before = providerLaunches.claude.length;
    // Exercise route -> persisted seed -> persisted fan-out -> runtime launch.
    const { runHeadlessSprintTick } = await import('@/lib/orchestrator/headless-loop');
    await runHeadlessSprintTick();
    const launches = await waitForClaudeLaunches(before, 2);

    expect(launches.map((launch) => launch.model).sort()).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    expect(launches.map((launch) => launch.claudeCodeModel).sort()).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    expect(launches.every((launch) => launch.claudeCodeModel === launch.model)).toBe(true);
    expect(launches.every((launch) => launch.claudeCodeCarrier === 'native')).toBe(true);
    expect(launches.every((launch) => launch.effort === 'high')).toBe(true);
  }, 30_000);
});

describe('mission effort pin — explicit dispatch runtime override', () => {
  it('rejects an override on a held packet and leaves all persisted state untouched', async () => {
    const repoPath = makeRepo();
    const createResponse = await createMissionViaRoute({
      repoPath,
      runtime: 'codex',
      requestedRuntime: 'codex',
      requestedModel: 'gpt-5.6-terra',
      requestedEffort: 'high',
      // held: no explicit dispatch yet, so the rejection must not mutate it.
      dispatchOnCreate: false,
      issues: [{ number: 900_113, title: 'override held effort pin', body: 'body', url: '' }],
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as { result: { missionId: string; packets: Array<{ id: string }> } };
    const packetId = created.result.packets[0]?.id as string;

    const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    const before = readOrchestratorControlPlaneState();
    const beforePacket = before.packets.find((p) => p.id === packetId);
    expect(beforePacket).toMatchObject({
      runtime: 'codex',
      queueState: 'held',
      dispatchRuntimePin: 'codex',
    });

    const dispatchRoute = await import('@/app/api/orchestrator/dispatch/route');
    const response = await dispatchRoute.POST(routeRequest('/api/orchestrator/dispatch', {
      missionId: created.result.missionId,
      runtime: 'gemini',
      wait: true,
    }));
    expect(response.status).toBe(400);
    const json = await response.json() as { ok: boolean; error?: { code?: string; message?: string } };
    expect(json.ok).toBe(false);
    expect(json.error?.code).toBe('effort_unsupported_runtime');
    expect(json.error?.message).toContain('Cannot override mission runtime');

    // Snapshot of every mutation-prone field is byte-identical to before.
    const after = readOrchestratorControlPlaneState();
    expect(after.runtime).toBe(before.runtime);
    const afterPacket = after.packets.find((p) => p.id === packetId);
    expect(afterPacket).toMatchObject({
      runtime: beforePacket?.runtime,
      status: beforePacket?.status,
      queueState: beforePacket?.queueState,
      blockedReason: beforePacket?.blockedReason,
      dispatchRuntimePin: beforePacket?.dispatchRuntimePin,
      assignedModel: beforePacket?.assignedModel,
      workerRouting: {
        requestedEffort: 'high',
        selectedEffort: 'high',
        requestedRuntime: 'codex',
        selectedRuntime: 'codex',
        selectedModel: 'gpt-5.6-terra',
      },
    });
  }, 30_000);
});
