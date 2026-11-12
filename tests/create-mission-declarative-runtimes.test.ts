import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import { listDeclarativeRuntimes } from '@/lib/orchestrator/runtime-capabilities';
import type { OwnedRunRecord } from '@/lib/runtimes/shared/owned-session';

const authMock = vi.hoisted(() => {
  class MockDispatchPreflightError extends Error {
    public readonly code = 'dispatch_cli_auth_unavailable';

    constructor(public readonly status: {
      house: string;
      runtime: OrchestratorRuntime;
      installed: boolean;
      authenticated: boolean;
      unavailableReason: 'not_installed' | 'needs_auth';
      detail: string;
      fix: string;
      checkedAt: number;
    }) {
      super(status.detail);
      this.name = 'DispatchPreflightError';
    }
  }
  return {
    unauthRuntime: null as OrchestratorRuntime | null,
    DispatchPreflightError: MockDispatchPreflightError,
  };
});

vi.mock('@/lib/runtimes/shared/auth-detect', () => ({
  DispatchPreflightError: authMock.DispatchPreflightError,
  assertRuntimeDispatchable: vi.fn(async (runtime: OrchestratorRuntime) => {
    if (runtime !== authMock.unauthRuntime) return;
    const needsAuth = runtime === 'opencode';
    throw new authMock.DispatchPreflightError({
      house: runtime,
      runtime,
      installed: needsAuth,
      authenticated: false,
      unavailableReason: needsAuth ? 'needs_auth' : 'not_installed',
      detail: needsAuth
        ? 'OpenCode 2 needs auth.json at /test-home/.local/share/opencode/auth.json.'
        : `${runtime} CLI is not installed.`,
      fix: needsAuth
        ? 'Run `opencode2 auth login` to create auth.json.'
        : `Install ${runtime} and configure credentials.`,
      checkedAt: Date.now(),
    });
  }),
}));

vi.mock('@/lib/realtime/publisher', () => ({
  publishRealtimeMutation: vi.fn(async () => {}),
}));

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-create-mission-runtimes-'));
const repoPath = path.join(dataDir, 'repo');
const fixtureDir = path.join(process.cwd(), 'tests', 'fixtures');
execFileSync('git', ['init', '-q', repoPath]);
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const createMissionRoute = await import('@/app/api/orchestrator/create-mission/route');
const { getSqlite } = await import('@/lib/db');
const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { MISSION_TOOLS } = await import('@/lib/mcp/operator-handlers/mission');
await import('@/lib/runtimes/declarative-workers');
const { getDeclarativeOwnedRuntime } = await import('@/lib/runtimes/shared/owned-session');
const { getCostParser } = await import('@/lib/runtimes/shared/cost-parser-registry');

const NEW_RUNTIMES = listDeclarativeRuntimes();

function request(runtime: OrchestratorRuntime, issueNumber: number): NextRequest {
  return new NextRequest('http://localhost:3001/api/orchestrator/create-mission', {
    method: 'POST',
    headers: { host: 'localhost:3001', 'x-o8-worker-packet-id': 'untrusted-packet' },
    body: JSON.stringify({
      clientMutationId: `create-runtime-${issueNumber}`,
      repoPath,
      requestedRuntime: runtime,
      issues: [{
        number: issueNumber,
        title: `${runtime} dispatch real-path seam`,
        body: `Prove ${runtime} survives the create_mission path.`,
        url: '',
      }],
    }),
  });
}

afterEach(() => {
  authMock.unauthRuntime = null;
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('create_mission runtime reachability', () => {
  it('replays one body-bound mission creation without creating a second mission', async () => {
    const first = await createMissionRoute.POST(request('codex', 91_598_101));
    const firstPayload = await first.json() as { result: { missionId: string } };
    getSqlite().prepare(`
      UPDATE idempotency_keys
         SET result_json = NULL, pid = ?, reservation_id = ?
       WHERE verb = 'create_mission' AND packet_id = ?
    `).run(2_147_483_647, 'dead-create-owner', repoPath);
    const replay = await createMissionRoute.POST(request('codex', 91_598_101));
    const replayPayload = await replay.json() as { result: { missionId: string; replayed?: boolean } };

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replayPayload.result.missionId).toBe(firstPayload.result.missionId);
    expect(replayPayload.result.replayed).toBe(true);
  });

  it.each([
    ['claude-code', 91_598_001],
    ['gemini', 91_598_002],
    ['opencode', 91_598_003],
    ['cursor', 91_598_004],
    ['grok', 91_598_005],
    ['pi', 91_598_006],
    ['openhands', 91_598_011],
    ['goose', 91_598_012],
    ['qwen', 91_598_013],
    ['kimi', 91_598_014],
    ['aider', 91_598_015],
    ['qoder', 91_598_016],
    ['3code', 91_598_017],
    ['copilot-cli', 91_598_018],
    ['crush', 91_598_019],
  ] as const)('%s remains selected through the real route and persisted mission', async (runtime, issueNumber) => {
    const response = await createMissionRoute.POST(request(runtime, issueNumber));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ ok: true });

    const packet = readOrchestratorControlPlaneState().packets.find((entry) => entry.title.includes(runtime));
    expect(packet?.dispatcher).toEqual({ surface: 'operator', id: 'desktop' });
    expect(packet?.runtime).toBe(runtime);
    expect(packet?.workerRouting?.requestedRuntime).toBe(runtime);
    expect(packet?.workerRouting?.selectedRuntime).toBe(runtime);
    expect(packet?.workerRouting?.selectedProvider).toBe(runtime === 'claude-code' ? 'claude' : runtime);
    expect(packet?.workerRouting?.enforcement).toBe('dispatchable_runtimes');
  });

  it('publishes declarative runtimes in the create_mission runtime enum', () => {
    const createMission = MISSION_TOOLS.find((tool) => tool.name === 'create_mission');
    const properties = createMission?.inputSchema.properties as Record<string, { enum?: string[] }> | undefined;
    expect(properties?.runtime?.enum).toEqual(expect.arrayContaining(['opencode', 'pi', ...NEW_RUNTIMES]));
  });

  it('persists transient outside-launch provenance on the packet', async () => {
    const response = await createMissionRoute.POST(new NextRequest('http://localhost:3001/api/orchestrator/create-mission', {
      method: 'POST',
      headers: { host: 'localhost:3001', 'x-o8-worker-packet-id': 'untrusted-packet' },
      body: JSON.stringify({
        clientMutationId: 'create-runtime-outside-launch',
        repoPath,
        requestedRuntime: 'codex',
        issues: [{
          number: 91_598_008,
          title: 'outside launch context seam',
          body: 'Keep this repo temporary and reveal the worker in its own pane.',
          url: '',
        }],
        launchContext: {
          source: 'cli',
          presentation: 'split',
          repoContext: 'transient',
          caller: 'outside terminal',
        },
      }),
    }));
    expect(response.status).toBe(201);
    const packet = readOrchestratorControlPlaneState().packets.find((entry) => entry.title === 'outside launch context seam');
    expect(packet?.launchContext).toEqual({
      source: 'cli',
      presentation: 'split',
      repoContext: 'transient',
      caller: 'outside terminal',
    });
  });

  it('returns a clean missing-credential response when OpenCode auth.json is absent', async () => {
    authMock.unauthRuntime = 'opencode';
    const beforeMissionId = readOrchestratorControlPlaneState().missionId;

    const response = await createMissionRoute.POST(request('opencode', 91_598_007));
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload).toMatchObject({
      ok: false,
      error: { code: 'dispatch_cli_auth_unavailable' },
    });
    expect(payload.error.message).toContain('OpenCode 2 needs auth.json');
    expect(payload.error.message).toContain('opencode2 auth login');
    expect(readOrchestratorControlPlaneState().missionId).toBe(beforeMissionId);
  });

  it.each(NEW_RUNTIMES)('returns a structured unavailable response when %s is absent', async (runtime) => {
    authMock.unauthRuntime = runtime;
    const beforeMissionId = readOrchestratorControlPlaneState().missionId;

    const response = await createMissionRoute.POST(request(runtime, 91_598_020 + NEW_RUNTIMES.indexOf(runtime)));
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload).toMatchObject({
      ok: false,
      error: { code: 'dispatch_cli_auth_unavailable' },
    });
    expect(payload.error.message).toContain(`${runtime} CLI is not installed`);
    expect(payload.error.message).toContain(`Install ${runtime}`);
    expect(readOrchestratorControlPlaneState().missionId).toBe(beforeMissionId);
  });

  it('renders valid launch specs from every declarative config entry', () => {
    const launchSpecs = Object.fromEntries(NEW_RUNTIMES.map((runtime) => [
      runtime,
      getDeclarativeOwnedRuntime(runtime)?.adapter.launchArgs({
        cwd: repoPath,
        sessionDir: path.join(repoPath, '.owned-session'),
        prompt: 'fix the bug',
      }),
    ]));

    expect(launchSpecs).toEqual({
      openhands: ['--headless', '--json', '-t', 'fix the bug'],
      goose: ['run', '-t', 'fix the bug', '--max-turns', '100'],
      qwen: ['-p', 'fix the bug', '--yolo', '--output-format', 'stream-json'],
      qoder: ['-p', 'fix the bug', '-m', 'Qwen3.8-Max-Preview', '--dangerously-skip-permissions', '--output-format', 'stream-json'],
      kimi: ['-p', 'fix the bug'],
      aider: ['--message', 'fix the bug', '--yes-always', '--auto-test'],
      '3code': [
        '--session',
        path.join(repoPath, '.owned-session', 'session.3log'),
        'fix the bug',
      ],
      'copilot-cli': [
        '-p',
        'fix the bug',
        '--allow-all',
        '--no-ask-user',
        '--output-format',
        'json',
        '--no-color',
        '--no-auto-update',
        '--no-remote-export',
      ],
      crush: ['run', '--quiet', 'fix the bug'],
      antigravity: [
        '--print',
        `Workspace directory: ${repoPath}\n\nfix the bug`,
        '--add-dir',
        repoPath,
        '--output-format',
        'stream-json',
        '--sandbox',
        '--print-timeout',
        '15m',
        '--model',
        'gemini-3.8-flash-low',
      ],
    });
  });

  it('normalizes structured and text output through declared parser profiles', async () => {
    const run: OwnedRunRecord = {
      id: 'declarative-run-1',
      mode: 'launch',
      prompt: 'fix the bug',
      startedAt: '2026-07-19T00:00:00.000Z',
      finishedAt: '2026-07-19T00:00:01.000Z',
      pid: 123,
      stdoutPath: '/tmp/declarative.stdout.log',
      stderrPath: '/tmp/declarative.stderr.log',
      outcome: 'running',
    };
    const openHands = getDeclarativeOwnedRuntime('openhands')?.adapter.parseRunLog([
      JSON.stringify({ type: 'assistant_message', content: 'done' }),
      JSON.stringify({ type: 'completed', message: 'complete' }),
    ].join('\n'), run);
    const qwen = getDeclarativeOwnedRuntime('qwen')?.adapter.parseRunLog([
      JSON.stringify({ type: 'message', content: 'done' }),
      JSON.stringify({ type: 'result', usage: { outputTokens: 2 } }),
    ].join('\n'), run);

    expect(openHands).toMatchObject({ completedTurn: true, outcome: 'finished' });
    expect(qwen).toMatchObject({ completedTurn: true, outcome: 'finished' });
    expect(openHands?.entries).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'done' })]));
    expect(qwen?.entries).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'done' })]));

    // SOURCE-DERIVED, NOT LOCALLY CAPTURED: the hermetic test host has no
    // Copilot account. This fixture follows the public Copilot v1 JSONL event
    // stream, with identifiers and the model name normalized.
    const copilotOutput = readFileSync(
      path.join(fixtureDir, 'copilot-cli-v1.source-derived.jsonl'),
      'utf8',
    );
    const copilot = getDeclarativeOwnedRuntime('copilot-cli')?.adapter.parseRunLog(copilotOutput, run);
    expect(copilot).toMatchObject({
      threadId: '0cb916db-26aa-40f2-86b5-1ba81b225fd2',
      completedTurn: true,
      outcome: 'finished',
    });
    expect(copilot?.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'message', text: 'VERDICT: APPROVED' }),
    ]));
    const copilotCost = await getCostParser('copilot-cli')?.parseLines?.(
      copilotOutput.split(/\r?\n/),
    );
    expect(copilotCost).toMatchObject({
      inputTokens: 22_344,
      outputTokens: 12,
      cacheReadTokens: 0,
      totalCostUsd: 0,
    });

    const gooseCost = await getCostParser('goose')?.parseLines?.(['plain text output']);
    expect(gooseCost).toMatchObject({ inputTokens: 0, outputTokens: 5, totalCostUsd: 0 });

    // SOURCE-DERIVED, NOT LOCALLY CAPTURED: exact final stdout from the
    // v0.92.0 non-interactive run-stream regression fixture.
    const crushOutput = readFileSync(
      path.join(fixtureDir, 'crush-v0.92.0.source-derived.txt'),
      'utf8',
    );
    const crushCost = await getCostParser('crush')?.parseLines?.(crushOutput.split(/\r?\n/));
    expect(crushCost).toMatchObject({ inputTokens: 0, outputTokens: 5, totalCostUsd: 0 });
  });
});
