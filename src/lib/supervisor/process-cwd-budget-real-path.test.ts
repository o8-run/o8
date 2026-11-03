import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntime, RuntimeSession } from '@/lib/runtimes/types';
import type { ProcessCwdExecFile } from '@/lib/runtime/process-cwd-snapshot';

const registryFixture = vi.hoisted(() => ({
  runtimes: [] as AgentRuntime[],
}));

vi.mock('@/lib/db', () => ({
  getSqlite: () => ({
    prepare: () => ({
      all: () => [],
      get: () => null,
      run: () => ({}),
    }),
  }),
}));

vi.mock('@/lib/approvals/store', () => ({
  listApprovals: () => [],
}));

vi.mock('@/lib/runtimes', () => ({
  getAllRuntimes: () => registryFixture.runtimes,
}));

vi.mock('@/lib/runtime/ide-terminal-state', () => ({
  listCurrentIdeRepoPaths: () => [],
}));

vi.mock('@/lib/runtime/ide-session-registry', () => ({
  listIdeRuntimeSessions: () => [],
  listIdeRuntimeTabs: () => [],
}));

vi.mock('@/lib/runtime/terminal-session-registry', () => ({
  DASHBOARD_CLI_BINDING_TTL_MS: 30 * 60_000,
  getRuntimeTerminalSession: () => null,
  listRecentDashboardCliSessions: () => [],
}));

vi.mock('@/lib/lane/registry', () => ({
  getAllEvents: () => [],
  getLaneEvents: () => [],
  listLanes: () => [],
  reconcileLanesWithSessions: () => [],
}));

vi.mock('@/lib/lane/sweep-orphan-sessions', () => ({
  sweepOrphanedOwnedSessions: async () => {},
}));

const {
  getRuntimeInventorySnapshot,
  invalidateRuntimeInventoryCache,
} = await import('@/lib/runtime/inventory');
const { queryLiveCodexProcesses } = await import('@/lib/codex/live-process-discovery');
const {
  readProcessCwdProbeDiagnostics,
  readProcessCwdSnapshot,
  resetProcessCwdProbeForTesting,
} = await import('@/lib/runtime/process-cwd-snapshot');
const {
  getWatchedAgents,
  registerWatchedAgent,
  startSupervisorLoop,
  stopSupervisorLoop,
  unregisterWatchedAgent,
} = await import('./agent-supervisor');

const testRoot = mkdtempSync(join(tmpdir(), 'o8-process-cwd-budget-'));
const candidatePids = [41_001, 41_002, 41_003, 41_004];

function candidateCwd(pid: number): string {
  return join(testRoot, `candidate-${pid}`);
}

function fakeExecFile(): ProcessCwdExecFile {
  return vi.fn(async (file, args) => {
    if (file === 'lsof') {
      return {
        stdout: candidatePids
          .map((pid) => `p${pid}\nccodex\nn${candidateCwd(pid)}`)
          .join('\n'),
      };
    }
    if (file === 'ps' && args[0] === '-o') {
      return {
        stdout: candidatePids
          .map((pid) => `${pid} 1 ttys001 00:01 /usr/local/bin/codex exec`)
          .join('\n'),
      };
    }
    if (file === 'ps' && args[0] === 'eww') {
      return { stdout: 'TERM_SESSION_ID=test-session' };
    }
    return { stdout: '' };
  });
}

function runtime(execFile: ProcessCwdExecFile): AgentRuntime {
  return {
    id: 'codex',
    displayName: 'Codex',
    capabilities: {
      discover: true,
      readTranscript: true,
      launch: true,
      resume: true,
      interrupt: true,
      reviewDiffs: true,
      costTelemetry: false,
      streaming: true,
    },
    discoverSessions: async () => {
      const processes = await queryLiveCodexProcesses(candidatePids, { execFile });
      return [...processes.values()].map((process): RuntimeSession => ({
        sessionKey: `codex-owned:${process.pid}`,
        runtimeId: 'codex',
        displayName: `candidate ${process.pid}`,
        cwd: process.cwd ?? 'unknown',
        status: 'running',
        ownership: 'owned',
        sessionCapabilities: {
          canSendInput: true,
          canInterrupt: true,
          canReviewDiffs: true,
        },
        lastActivityAt: new Date(),
      }));
    },
    readTranscript: async () => [],
    launch: async () => ({ ok: true, note: 'launched' }),
    resume: async () => ({ ok: true, note: 'resumed' }),
    interrupt: async () => ({ ok: true, note: 'interrupted' }),
    getChangedFiles: async () => [],
  };
}

function supervisorCallbacks() {
  return {
    async fetchFleetStatus() {
      const snapshot = await getRuntimeInventorySnapshot({ fresh: true });
      return snapshot.agents.map((agent) => ({
        sessionKey: agent.sessionKey,
        status: agent.status,
      }));
    },
    async fetchTranscript() { return []; },
    async steerAgent() {},
    async interruptAgent() {},
    async relaunchAgent() { return { status: 'held' as const, reason: 'test hold' }; },
    broadcastAgentUpdate() {},
    queueOrchestratorEscalation() {},
  };
}

describe('supervisor process cwd probe budget', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-22T12:00:00.000Z'));
    for (const pid of candidatePids) mkdirSync(candidateCwd(pid), { recursive: true });
    for (const watched of getWatchedAgents()) unregisterWatchedAgent(watched.surfaceId);
    stopSupervisorLoop();
    resetProcessCwdProbeForTesting();
    invalidateRuntimeInventoryCache();
  });

  afterEach(() => {
    stopSupervisorLoop();
    for (const watched of getWatchedAgents()) unregisterWatchedAgent(watched.surfaceId);
    vi.useRealTimers();
  });

  afterAll(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('runs one lsof for one inventory poll regardless of candidate count', async () => {
    const execFile = fakeExecFile();
    registryFixture.runtimes = [runtime(execFile)];
    startSupervisorLoop(supervisorCallbacks());
    for (const pid of candidatePids) {
      registerWatchedAgent(`codex-owned:${pid}`, testRoot, `candidate ${pid}`, 'test');
    }

    await vi.advanceTimersByTimeAsync(0);

    expect(execFile).toHaveBeenCalledTimes(1 + candidatePids.length + 1);
    expect(execFile).toHaveBeenCalledWith(
      'lsof',
      ['-nP', '-d', 'cwd', '-F', 'pcLftn'],
      expect.any(Object),
    );
    expect(readProcessCwdProbeDiagnostics()).toMatchObject({
      lsofInvocations: 1,
      lastRowCount: candidatePids.length,
    });
  });

  it('does not invoke inventory or lsof when the supervisor owns no sessions', async () => {
    const execFile = fakeExecFile();
    registryFixture.runtimes = [runtime(execFile)];
    const callbacks = supervisorCallbacks();
    const fetchFleetStatus = vi.spyOn(callbacks, 'fetchFleetStatus');
    startSupervisorLoop(callbacks);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(fetchFleetStatus).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
    expect(readProcessCwdProbeDiagnostics().lsofInvocations).toBe(0);
  });

  it('coalesces fresh inventory requests for 2 seconds after an empty discovery', async () => {
    const execFile = fakeExecFile();
    const emptyRuntime = runtime(execFile);
    emptyRuntime.discoverSessions = vi.fn(async () => []);
    registryFixture.runtimes = [emptyRuntime];

    await getRuntimeInventorySnapshot({ fresh: true });
    await vi.advanceTimersByTimeAsync(1_000);
    await getRuntimeInventorySnapshot({ fresh: true });

    expect(emptyRuntime.discoverSessions).toHaveBeenCalledTimes(1);
    expect(execFile).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_001);
    await getRuntimeInventorySnapshot({ fresh: true });
    expect(emptyRuntime.discoverSessions).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent process consumers into one visible budget charge', async () => {
    const execFile = fakeExecFile();
    await Promise.all([
      readProcessCwdSnapshot({ execFile }),
      readProcessCwdSnapshot({ execFile }),
      readProcessCwdSnapshot({ execFile }),
    ]);

    expect(readProcessCwdProbeDiagnostics()).toMatchObject({
      lsofInvocations: 1,
      singleFlightJoins: 2,
    });
  });
});
