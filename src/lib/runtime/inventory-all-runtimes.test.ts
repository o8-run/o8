import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentRuntime,
  RuntimeId,
  RuntimeSession,
} from '@/lib/runtimes/types';
import type { IdeRuntimeSessionDescriptor } from '@/lib/runtime/ide-session-registry';

const registryFixture = vi.hoisted(() => ({
  runtimes: [] as AgentRuntime[],
}));

const ideRegistryFixture = vi.hoisted(() => ({
  sessions: [] as IdeRuntimeSessionDescriptor[],
  tabs: [] as IdeRuntimeSessionDescriptor[],
}));

const terminalFixture = vi.hoisted(() => ({
  bindings: new Map<string, string>(),
  registry: new Map<string, { sessionName: string; runtime: 'codex' | 'claude-code'; cwd?: string; source?: 'dashboard-cli-detected'; updatedAt: string }>(),
}));

const rolloutFixture = vi.hoisted(() => ({ path: null as string | null }));

vi.mock('@/lib/codex/sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/codex/sessions')>()),
  getCodexRolloutPath: async () => rolloutFixture.path,
}));

vi.mock('@/lib/runtimes', () => ({
  getAllRuntimes: () => registryFixture.runtimes,
}));

vi.mock('@/lib/runtime/ide-terminal-state', () => ({
  listCurrentIdeRepoPaths: () => [],
}));

vi.mock('@/lib/runtime/ide-session-registry', () => ({
  listIdeRuntimeSessions: () => ideRegistryFixture.sessions,
  listIdeRuntimeTabs: () => ideRegistryFixture.tabs,
}));

vi.mock('@/lib/runtime/terminal-session-registry', () => ({
  DASHBOARD_CLI_BINDING_TTL_MS: 30 * 60_000,
  getRuntimeTerminalSession: (key: string) => terminalFixture.registry.get(key) ?? null,
  registerRuntimeTerminalSession: (key: string, entry: { sessionName: string; runtime: 'codex' | 'claude-code'; cwd?: string; source?: 'dashboard-cli-detected' }) => {
    terminalFixture.registry.set(key, { ...entry, updatedAt: new Date().toISOString() });
  },
}));

vi.mock('@/lib/runtime/dashboard-cli-bindings', () => ({
  discoverDashboardCliBindings: async () => new Map(terminalFixture.bindings),
}));

vi.mock('@/lib/lane/registry', () => ({
  getAllEvents: () => [],
  getLaneEvents: () => [],
  listLanes: () => [],
  reconcileLanesWithSessions: () => [],
}));

// Cloud reconciliation has its own durable-job tests; this suite supplies no lanes.
// Keep its lazy import from pulling the job queue into the inventory build deadline.
vi.mock('@/lib/lane/cloud-reconciliation', () => ({
  reconcileCloudJobLanes: () => {},
}));

vi.mock('@/lib/lane/sweep-orphan-sessions', () => ({
  sweepOrphanedOwnedSessions: async () => {},
}));

// Default for this suite (read once at import): a loaded machine must not lose the 3.5s production deadline race.
process.env.O8_RUNTIME_INVENTORY_BUILD_TIMEOUT_MS ??= '1200000';

const {
  getRuntimeInventorySnapshot,
  invalidateRuntimeInventoryCache,
} = await import('./inventory');

const testRoot = mkdtempSync(join(tmpdir(), 'o8-runtime-inventory-all-'));

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

function runtime(id: RuntimeId): AgentRuntime {
  const cwd = join(testRoot, id);
  mkdirSync(cwd, { recursive: true });
  const lastActivityAt = id === 'gemini'
    ? '2026-07-24T12:00:02.000Z'
    : id === 'aider'
      ? '2026-07-24T12:00:01.000Z'
      : id === 'cloud'
        ? '2026-07-24T12:00:00.000Z'
        : '2026-07-23T12:00:00.000Z';
  const session: RuntimeSession = {
    sessionKey: `${id}-owned:inventory-parity`,
    runtimeId: id,
    displayName: id,
    cwd,
    branch: 'main',
    status: 'running',
    ownership: 'owned',
    identityId: `${id}-identity`,
    sessionCapabilities: {
      canSendInput: false,
      canInterrupt: false,
      canReviewDiffs: true,
    },
    lastActivityAt: new Date(lastActivityAt),
  };

  return {
    id,
    displayName: id,
    capabilities: {
      discover: true,
      readTranscript: true,
      launch: true,
      resume: false,
      interrupt: false,
      reviewDiffs: true,
      costTelemetry: false,
      streaming: false,
    },
    discoverSessions: async () => [session],
    readTranscript: async () => [],
    launch: async () => ({ ok: true, note: 'launched' }),
    resume: async () => ({ ok: false, note: 'not resumable' }),
    interrupt: async () => ({ ok: false, note: 'not interruptible' }),
    getChangedFiles: async () => [],
  };
}

describe('canonical runtime inventory discovery', () => {
  beforeEach(() => {
    registryFixture.runtimes = [];
    ideRegistryFixture.sessions = [];
    ideRegistryFixture.tabs = [];
    terminalFixture.bindings.clear();
    terminalFixture.registry.clear();
    rolloutFixture.path = null;
    invalidateRuntimeInventoryCache();
  });

  it('matches main policy by never discovering non-dispatchable registered adapters', async () => {
    const geminiRuntime = runtime('gemini');
    const aiderRuntime = runtime('aider');
    const cloudRuntime = runtime('cloud');
    const remoteCustomerRuntime = runtime('remote-customer');
    const cloudDiscovery = vi.spyOn(cloudRuntime, 'discoverSessions');
    const remoteCustomerDiscovery = vi.spyOn(remoteCustomerRuntime, 'discoverSessions');
    registryFixture.runtimes = [
      geminiRuntime,
      aiderRuntime,
      cloudRuntime,
      remoteCustomerRuntime,
    ];
    invalidateRuntimeInventoryCache();

    const snapshot = await getRuntimeInventorySnapshot({ fresh: true });

    expect(cloudDiscovery).not.toHaveBeenCalled();
    expect(remoteCustomerDiscovery).not.toHaveBeenCalled();
    expect(snapshot.agents.map((agent) => agent.runtime)).toEqual(['gemini', 'aider']);
    expect(snapshot.agents.map((agent) => agent.identityId)).toEqual([
      'gemini-identity',
      'aider-identity',
    ]);
    expect(snapshot.meta.note).toBe('Showing every discovered dispatchable runtime surface.');
  });

  it('projects an exact dashboard terminal binding and downgrades an exited CLI to unknown evidence', async () => {
    const codexRuntime = runtime('codex');
    const originalDiscovery = codexRuntime.discoverSessions;
    codexRuntime.discoverSessions = async () => (await originalDiscovery()).map((session) => ({
      ...session,
      sessionKey: 'codex:terminal-thread',
      ownership: 'discovered',
      pid: 4242,
    }));
    registryFixture.runtimes = [codexRuntime];
    terminalFixture.bindings.set('codex:terminal-thread', 'cortex-dash-real');

    const live = await getRuntimeInventorySnapshot({ fresh: true });
    expect(live.agents).toHaveLength(1);
    expect(live.agents[0]).toMatchObject({
      sessionKey: 'codex:terminal-thread',
      tmuxSession: 'cortex-dash-real',
      status: 'running',
      statusEvidence: { state: 'unknown', authority: 'raw-terminal' },
    });
    expect(terminalFixture.registry.get('codex:terminal-thread')?.source).toBe('dashboard-cli-detected');

    terminalFixture.bindings.clear();
    invalidateRuntimeInventoryCache();
    const exited = await getRuntimeInventorySnapshot({ fresh: true });
    expect(exited.agents).toHaveLength(1);
    expect(exited.agents[0]).toMatchObject({
      sessionKey: 'codex:terminal-thread',
      tmuxSession: undefined,
      status: 'idle',
      statusEvidence: {
        state: 'unknown',
        authority: 'raw-terminal',
        fallbackReason: expect.stringContaining('no longer verified'),
      },
    });
  });

  it('carries structured turn state from a matched rollout through fresh inventory, then drops it on exit', async () => {
    const codexRuntime = runtime('codex');
    const originalDiscovery = codexRuntime.discoverSessions;
    codexRuntime.discoverSessions = async () => (await originalDiscovery()).map((session) => ({
      ...session,
      sessionKey: 'codex:matched-rollout-thread',
      ownership: 'discovered',
      pid: 4242,
    }));
    registryFixture.runtimes = [codexRuntime];
    terminalFixture.bindings.set('codex:matched-rollout-thread', 'cortex-dash-real');
    rolloutFixture.path = join(testRoot, 'matched-rollout.jsonl');
    writeFileSync(rolloutFixture.path, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'event_msg',
      payload: { type: 'task_started' },
    })}\n`);

    const working = await getRuntimeInventorySnapshot({ fresh: true });
    expect(working.agents[0]).toMatchObject({
      status: 'running',
      statusEvidence: {
        state: 'working',
        authority: 'runtime-event',
        evidence: expect.arrayContaining([{ source: 'codex-rollout.lifecycle', value: 'task_started' }]),
      },
    });

    writeFileSync(rolloutFixture.path, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'event_msg',
      payload: { type: 'task_complete' },
    })}\n`, { flag: 'a' });
    invalidateRuntimeInventoryCache();
    const complete = await getRuntimeInventorySnapshot({ fresh: true });
    expect(complete.agents[0]).toMatchObject({
      status: 'completed',
      statusEvidence: { state: 'complete', authority: 'runtime-event' },
    });

    terminalFixture.bindings.clear();
    invalidateRuntimeInventoryCache();
    const exited = await getRuntimeInventorySnapshot({ fresh: true });
    expect(exited.agents[0]).toMatchObject({
      status: 'idle',
      statusEvidence: { state: 'unknown', authority: 'raw-terminal' },
    });
  });

  it('lets an explicit fresh read discover a CLI after an idle snapshot was cached', async () => {
    const codexRuntime = runtime('codex');
    const originalDiscovery = codexRuntime.discoverSessions;
    let cliVisible = false;
    codexRuntime.discoverSessions = async () => cliVisible
      ? (await originalDiscovery()).map((session) => ({
          ...session,
          sessionKey: 'codex:new-terminal-thread',
          ownership: 'discovered',
          pid: 4242,
        }))
      : [];
    registryFixture.runtimes = [codexRuntime];
    expect((await getRuntimeInventorySnapshot({ fresh: true })).agents).toHaveLength(0);

    cliVisible = true;
    terminalFixture.bindings.set('codex:new-terminal-thread', 'cortex-dash-new');
    const currentTime = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(currentTime + 3_000);
    try {
      const refreshed = await getRuntimeInventorySnapshot({ fresh: true });
      expect(refreshed.agents[0]).toMatchObject({
        sessionKey: 'codex:new-terminal-thread',
        tmuxSession: 'cortex-dash-new',
      });
    } finally {
      clock.mockRestore();
    }
  });

  it('serves a cold dashboard snapshot immediately and lets an explicit fresh read expedite discovery', async () => {
    const geminiRuntime = runtime('gemini');
    const originalDiscovery = geminiRuntime.discoverSessions;
    let releaseDiscovery!: () => void;
    const discoveryGate = new Promise<void>((resolve) => {
      releaseDiscovery = resolve;
    });
    const discovery = vi.spyOn(geminiRuntime, 'discoverSessions').mockImplementation(async (options) => {
      await discoveryGate;
      return originalDiscovery(options);
    });
    registryFixture.runtimes = [geminiRuntime];

    const warming = await getRuntimeInventorySnapshot();

    expect(warming).toMatchObject({
      meta: {
        mode: 'stale',
        gatewayFreshness: 'warming',
        observablePending: true,
        warmingRetryAfterMs: 5_000,
      },
      agents: [],
    });
    expect(discovery).not.toHaveBeenCalled();

    const freshPending = getRuntimeInventorySnapshot({ fresh: true });
    await vi.waitFor(() => {
      expect(discovery).toHaveBeenCalledWith({ fresh: true });
    });
    releaseDiscovery();

    const fresh = await freshPending;
    expect(fresh.meta.mode).toBe('live');
    expect(fresh.agents.map((agent) => agent.runtime)).toEqual(['gemini']);
  });

  it('bounds cold runtime discovery so installed CLIs cannot stampede the app', async () => {
    let activeDiscoveries = 0;
    let peakDiscoveries = 0;
    const runtimes = [runtime('gemini'), runtime('aider'), runtime('opencode'), runtime('cursor')];
    for (const candidate of runtimes) {
      const originalDiscovery = candidate.discoverSessions;
      candidate.discoverSessions = async (options) => {
        activeDiscoveries += 1;
        peakDiscoveries = Math.max(peakDiscoveries, activeDiscoveries);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeDiscoveries -= 1;
        return originalDiscovery(options);
      };
    }
    registryFixture.runtimes = runtimes;

    const snapshot = await getRuntimeInventorySnapshot({ fresh: true });

    expect(snapshot.agents).toHaveLength(4);
    expect(peakDiscoveries).toBe(2);
  });

  it('uses total unknown evidence for an invalid observation without dropping healthy sessions', async () => {
    const malformedRuntime = runtime('aider');
    const discoverSessions = malformedRuntime.discoverSessions;
    malformedRuntime.discoverSessions = async () => {
      const sessions = await discoverSessions();
      return sessions.map((session) => ({ ...session, lastActivityAt: new Date('not-a-time') }));
    };
    registryFixture.runtimes = [runtime('gemini'), malformedRuntime];
    invalidateRuntimeInventoryCache();

    const snapshot = await getRuntimeInventorySnapshot({ fresh: true });

    expect(snapshot.agents.map((agent) => agent.runtime)).toEqual(['gemini', 'aider']);
    expect(snapshot.agents.find((agent) => agent.runtime === 'aider')?.statusEvidence)
      .toMatchObject({
        runtime: 'aider',
        state: 'unknown',
        authority: 'raw-terminal',
        summary: 'No observation with a valid time was available.',
        evidence: [],
      });
  });

  it('contains a missing session identity and warns without dropping peers', async () => {
    const malformedRuntime = runtime('aider');
    const discoverSessions = malformedRuntime.discoverSessions;
    malformedRuntime.discoverSessions = async () => {
      const sessions = await discoverSessions();
      return sessions.map((session) => ({ ...session, sessionKey: '' }));
    };
    registryFixture.runtimes = [runtime('gemini'), malformedRuntime];
    invalidateRuntimeInventoryCache();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const snapshot = await getRuntimeInventorySnapshot({ fresh: true });

      expect(snapshot.agents).toHaveLength(2);
      expect(snapshot.agents.map((agent) => agent.runtime)).toEqual(['gemini', 'aider']);
      expect(snapshot.agents[1].statusEvidence).toMatchObject({
        sessionId: 'aider',
        runtime: 'aider',
        state: 'unknown',
        authority: 'raw-terminal',
        evidence: [],
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[terminal-status]'));
    } finally {
      warn.mockRestore();
    }
  });

  it('uses an owned IDE session status as runtime evidence', async () => {
    const descriptor: IdeRuntimeSessionDescriptor = {
      tabId: 'claude-reviewing-tab',
      runtimeId: 'claude-code',
      sessionKey: 'claude-code-owned:reviewing-session',
      liveSessionKey: 'claude-code-owned:reviewing-session',
      label: 'Reviewing worker',
      repoPath: testRoot,
      scope: 'tile-root',
      savedAt: '2026-08-29T12:00:00.000Z',
      supervisorStatus: 'reviewing',
      isCurrentSession: true,
    };
    ideRegistryFixture.sessions = [descriptor];
    ideRegistryFixture.tabs = [descriptor];
    invalidateRuntimeInventoryCache();

    const snapshot = await getRuntimeInventorySnapshot({ fresh: true });

    expect(snapshot.agents).toHaveLength(1);
    expect(snapshot.agents[0]).toMatchObject({
      sessionKey: descriptor.sessionKey,
      runtime: 'claude-code',
      status: 'reviewing',
      statusEvidence: {
        sessionId: descriptor.sessionKey,
        runtime: 'claude-code',
        state: 'review-ready',
        authority: 'runtime-event',
        summary: 'claude-code runtime reports this session as review-ready.',
      },
    });
  });
});
