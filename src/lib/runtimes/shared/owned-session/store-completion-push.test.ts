/**
 * #1523 — push-based completion: agent_completed as the norm, salvage the
 * exception.
 *
 * Field data showed 3 of 5 Codex packets ending via silent_exit_work_present /
 * zombie_reap_salvaged with COMPLETE, green work — because completion was
 * pull-only: `recordDetachedChildExit` knew the run finished clean but only
 * mutated the store, leaving the lane transition to a poll racing the
 * session_lost grace, the orphan sweep, and the 45s/90s salvage timers.
 *
 * Test 1 drives the real store: a launched child emits a clean close and the
 * store must POST /supervisor/completed to the ws-server. Test 2 drives the
 * real supervisor: the ingest entry point fires the same onAgentCompletion
 * chain the poller uses, idempotently.
 */
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OwnedRuntimeAdapter, OwnedSessionRecord, ParsedRunLog } from './types';

const spawnMock = vi.hoisted(() => vi.fn());
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

const DEAD_PID = 9_999_999;

function pushAdapter(): OwnedRuntimeAdapter {
  return {
    runtimeId: 'test-runtime',
    surfaceIdPrefix: 'test-owned:',
    rootEnvVar: 'O8_TEST_OWNED_ROOT',
    rootDefault: path.join(os.tmpdir(), 'o8-test-owned-push'),
    binaryName: 'node',
    binaryEnvOverride: 'O8_TEST_BIN',
    humanLabel: 'Owned Test',
    squadShortName: 'Test',
    launchArgs: ({ prompt }) => ['-e', `console.log(${JSON.stringify(prompt)})`],
    resumeArgs: ({ prompt }) => ['-e', `console.log(${JSON.stringify(prompt)})`],
    parseRunLog: (): ParsedRunLog => ({
      entries: [],
      outcome: 'finished',
      completedTurn: true,
    }),
  };
}

async function waitUntil(check: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('#1523 — clean child exit pushes completion to the supervisor', () => {
  let tempRoot: string;
  let repoPath: string;
  let priorEnv: Record<string, string | undefined>;
  let server: http.Server | null = null;

  beforeEach(() => {
    // Scratch lives under a dedicated hidden dir in the home tree — a
    // validateWorkspace-allowed root — never the repo (process.cwd()): a
    // hard-killed/detached runner can skip afterEach, and a leaked dir in the
    // working tree pollutes the Files panel and can retain owned-session data
    // (#1588, #5097). A home subdir (not os.homedir() root) contains any such
    // leak in one place, and avoids priming the memoized getDataDir() cache
    // before these tests override O8_DATA_DIR.
    const scratchBase = path.join(os.homedir(), '.o8-owned-session-test-scratch');
    mkdirSync(scratchBase, { recursive: true });
    tempRoot = mkdtempSync(path.join(scratchBase, 'push-'));
    repoPath = path.join(tempRoot, 'repo');
    execFileSync('git', ['init', '-q', repoPath]);
    priorEnv = {
      O8_TEST_OWNED_ROOT: process.env.O8_TEST_OWNED_ROOT,
      O8_TEST_BIN: process.env.O8_TEST_BIN,
      O8_WS_PORT: process.env.O8_WS_PORT,
      O8_DATA_DIR: process.env.O8_DATA_DIR,
      CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR,
    };
    process.env.O8_TEST_OWNED_ROOT = path.join(tempRoot, 'sessions');
    process.env.O8_TEST_BIN = process.execPath;
    process.env.O8_DATA_DIR = path.join(tempRoot, 'data');
    process.env.CORTEX_IDE_DATA_DIR = path.join(tempRoot, 'data');
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
  });

  afterEach(async () => {
    spawnMock.mockReset();
    ensureDispatchBackendReadyMock.mockReset();
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('POSTs /supervisor/completed when the detached child closes clean', { timeout: 20_000 }, async () => {
    const received: Array<{ url: string; body: string }> = [];
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        received.push({ url: req.url ?? '', body: Buffer.concat(chunks).toString('utf-8') });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true,"ingested":true}');
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;
    process.env.O8_WS_PORT = String(port);

    const child = Object.assign(new EventEmitter(), { pid: DEAD_PID, unref: vi.fn() });
    spawnMock.mockReturnValue(child);

    const { createOwnedSessionStore } = await import('./store');
    const store = createOwnedSessionStore(pushAdapter());
    const launched = await store.launch({ cwd: repoPath, prompt: 'do the work' });
    expect(launched.ok).toBe(true);

    child.emit('close', 0, null);

    await waitUntil(() => received.length > 0);
    expect(received[0].url).toBe('/supervisor/completed');
    expect(JSON.parse(received[0].body)).toMatchObject({ surfaceId: launched.surfaceId });
  });

  it('#1502 — telemetry sources survive archiving (headless worker transcripts)', { timeout: 20_000 }, async () => {
    const child = Object.assign(new EventEmitter(), { pid: DEAD_PID, unref: vi.fn() });
    spawnMock.mockReturnValue(child);

    const { createOwnedSessionStore } = await import('./store');
    const store = createOwnedSessionStore(pushAdapter());
    const launched = await store.launch({ cwd: repoPath, prompt: 'headless work' });
    expect(launched.ok).toBe(true);
    const surfaceId = launched.surfaceId!;

    // The #1502 shape: the worker finishes and the session is archived before
    // anything reads the packet transcript.
    await store.getRuntimeTail(surfaceId);
    const archived = await store.archiveSession(surfaceId);
    expect(archived.archived).toBe(true);

    const sources = await store.getTelemetrySources(surfaceId);
    expect(sources).not.toBeNull();
    expect(sources?.stdoutPaths.length).toBeGreaterThan(0);
  });

  async function launchCompletionFixture() {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true,"ingested":true}');
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    process.env.O8_WS_PORT = String((server.address() as { port: number }).port);

    const child = Object.assign(new EventEmitter(), { pid: DEAD_PID, unref: vi.fn() });
    spawnMock.mockReturnValue(child);
    const { createOwnedSessionStore } = await import('./store');
    const { readOwnedRecoveryState } = await import('./automatic-recovery');
    const launched = await createOwnedSessionStore(pushAdapter()).launch({ cwd: repoPath, prompt: 'complete the fixture work' });
    expect(launched.ok).toBe(true);
    expect(launched.surfaceId).toBeTruthy();
    const surfaceId = launched.surfaceId!;
    const running = await readOwnedRecoveryState(surfaceId);
    expect(running).toMatchObject({ owned: true, outcome: 'running' });
    expect(running).toHaveProperty('runId', expect.any(String));
    const runId = running.owned ? running.runId! : '';

    return {
      surfaceId,
      runId,
      async finish() {
        child.emit('close', 0, null);
        await vi.waitFor(async () => {
          expect(await readOwnedRecoveryState(surfaceId)).toMatchObject({ owned: true, runId, outcome: 'finished' });
        }, { timeout: 8_000 });
        const session = JSON.parse(await readFile(path.join(
          process.env.O8_TEST_OWNED_ROOT!, surfaceId.slice('test-owned:'.length), 'session.json',
        ), 'utf8')) as OwnedSessionRecord;
        expect(session.activeRun).toBeUndefined();
        expect(session.recentRuns.find((run) => run.id === runId)).toMatchObject({
          outcome: 'finished',
          childExit: { code: 0, signal: null, classification: 'clean-exit' },
        });
      },
    };
  }

  it('drives the supervisor completion chain once, idempotently', async () => {
    const {
      ingestAgentCompletionSignal,
      registerWatchedAgent,
      startSupervisorLoop,
      stopSupervisorLoop,
      unregisterWatchedAgent,
    } = await import('@/lib/supervisor/agent-supervisor');

    const fixture = await launchCompletionFixture();
    const onAgentCompletion = vi.fn(async () => undefined);
    startSupervisorLoop({
      fetchFleetStatus: vi.fn(async () => []),
      fetchTranscript: vi.fn(async () => []),
      steerAgent: vi.fn(async () => undefined),
      interruptAgent: vi.fn(async () => undefined),
      relaunchAgent: vi.fn(async () => ({ status: 'held' as const, reason: 'test hold' })),
      broadcastAgentUpdate: vi.fn(),
      queueOrchestratorEscalation: vi.fn(),
      onAgentCompletion,
    });

    try {
      registerWatchedAgent(fixture.surfaceId, repoPath, 'push test', 'prompt');

      expect(await ingestAgentCompletionSignal(fixture.surfaceId, fixture.runId)).toBe(true);
      expect(onAgentCompletion).not.toHaveBeenCalled();
      await fixture.finish();
      expect(await ingestAgentCompletionSignal(fixture.surfaceId, `${fixture.runId}-stale`)).toBe(true);
      expect(onAgentCompletion).not.toHaveBeenCalled();
      expect(await ingestAgentCompletionSignal(fixture.surfaceId, fixture.runId)).toBe(true);
      expect(onAgentCompletion).toHaveBeenCalledWith(fixture.surfaceId, 'completed');

      // Second push (or the poller arriving later) must not re-fire.
      await ingestAgentCompletionSignal(fixture.surfaceId, fixture.runId);
      expect(onAgentCompletion).toHaveBeenCalledTimes(1);

      // Unknown surface → false so the caller can re-register from the lane.
      expect(await ingestAgentCompletionSignal('test-owned:ghost')).toBe(false);
    } finally {
      unregisterWatchedAgent(fixture.surfaceId);
      stopSupervisorLoop();
    }
  });

  it('broadcasts a successful completion decision with its specific detail', async () => {
    const {
      ingestAgentCompletionSignal,
      registerWatchedAgent,
      startSupervisorLoop,
      stopSupervisorLoop,
      unregisterWatchedAgent,
    } = await import('@/lib/supervisor/agent-supervisor');
    const fixture = await launchCompletionFixture();
    const broadcastAgentUpdate = vi.fn();
    startSupervisorLoop({
      fetchFleetStatus: vi.fn(async () => []),
      fetchTranscript: vi.fn(async () => []),
      steerAgent: vi.fn(async () => undefined),
      interruptAgent: vi.fn(async () => undefined),
      relaunchAgent: vi.fn(async () => ({ status: 'held' as const, reason: 'test hold' })),
      broadcastAgentUpdate,
      queueOrchestratorEscalation: vi.fn(),
      onAgentCompletion: vi.fn(async () => ({
        detail: 'Read-only inspection completed with evidence.',
      })),
    });

    try {
      registerWatchedAgent(fixture.surfaceId, repoPath, 'read-only test', 'prompt');
      await fixture.finish();
      broadcastAgentUpdate.mockClear();
      expect(await ingestAgentCompletionSignal(fixture.surfaceId, `${fixture.runId}-stale`)).toBe(true);
      expect(broadcastAgentUpdate).not.toHaveBeenCalled();
      expect(await ingestAgentCompletionSignal(fixture.surfaceId, fixture.runId)).toBe(true);
      expect(broadcastAgentUpdate).toHaveBeenCalledWith(expect.objectContaining({
        surfaceId: fixture.surfaceId,
        status: 'completed',
        detail: 'Read-only inspection completed with evidence.',
      }));
    } finally {
      unregisterWatchedAgent(fixture.surfaceId);
      stopSupervisorLoop();
    }
  });
});
