import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDataDir } from '@/lib/data-dir-migration';
import type { OwnedRuntimeAdapter, OwnedSessionRecord } from './types';

const bridge = vi.hoisted(() => vi.fn());
const ready = vi.hoisted(() => vi.fn());
const sync = vi.hoisted(() => vi.fn());
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  sync.mockImplementation(actual.fsyncSync);
  return { ...actual, fsyncSync: sync };
});
vi.mock('@/lib/runtime/pty-bridge', () => ({ spawnBridgeTerminalSession: bridge }));
vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({ ensureDispatchBackendReady: ready }));
// This suite proves execution limits with real Node children, not the OS sandbox.
// Native sandbox/argv enforcement has its own read-only-worker-launch tests.
vi.mock('./sandbox', async (original) => ({
  ...await original<typeof import('./sandbox')>(),
  prepareWorkerSandbox: vi.fn(async (input: { binary: string; args: string[] }) => input),
}));

describe('durable single-attempt owned workers', () => {
  let root: string;
  let repo: string;
  let sessions: string;
  let counter: string;
  let prior: Record<string, string | undefined>;
  const keys = ['CORTEX_IDE_OWNED_CODEX_ROOT', 'O8_SINGLE_ATTEMPT_BIN', 'O8_CRASH_SURVIVABLE_WORKERS', 'O8_CODEX_BIN'];

  beforeEach(async () => {
    root = mkdtempSync(path.join(getDataDir(), 'single-attempt-'));
    repo = path.join(root, 'repo');
    sessions = path.join(root, 'sessions');
    counter = path.join(root, 'runs.txt');
    execFileSync('git', ['init', '-q', repo]);
    prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    process.env.CORTEX_IDE_OWNED_CODEX_ROOT = sessions;
    process.env.O8_SINGLE_ATTEMPT_BIN = process.execPath;
    process.env.O8_CRASH_SURVIVABLE_WORKERS = '0';
    // Codex effort admission reads model/list from the codex CLI, and the resolver caches one
    // binary per runtime id. This offline stand-in advertises the fixture models' effort and
    // otherwise runs the fixture worker with node, whichever resolution fills the cache first.
    const codex = path.join(root, 'codex');
    writeFileSync(codex, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
if (process.argv[2] === 'app-server') {
  require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line); if (!message.id) return;
    const data = ['gpt-6.1-sol', 'fallback-model', 'quota-model'].map((model, index) => ({ model, isDefault: index === 0,
      supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }));
    const result = message.method === 'model/list' ? { data } : message.method === 'config/read' ? { config: {} } : {};
    process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
  }).on('close', () => process.exit(0));
} else if (process.argv[2] === '--version') {
  process.stdout.write('codex-cli 1.0.0\\n');
} else {
  process.exit(spawnSync(process.execPath, process.argv.slice(2), { stdio: 'inherit' }).status ?? 1);
}
`, { mode: 0o700 });
    process.env.O8_CODEX_BIN = codex;
    (await import('@/lib/runtimes/shared/cli-resolver')).invalidateCliCache('codex');
    bridge.mockRejectedValue(new Error('ambiguous bridge response'));
    ready.mockReset().mockResolvedValue(undefined);
    sync.mockClear();
  });
  afterEach(async () => {
    for (const key of keys) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
    bridge.mockReset();
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    sync.mockImplementation(actual.fsyncSync);
    rmSync(root, { recursive: true, force: true });
  });

  function adapter(): OwnedRuntimeAdapter {
    return {
      runtimeId: 'codex', surfaceIdPrefix: 'codex-owned:',
      rootEnvVar: 'CORTEX_IDE_OWNED_CODEX_ROOT', rootDefault: sessions,
      binaryName: 'node', binaryEnvOverride: 'O8_SINGLE_ATTEMPT_BIN',
      humanLabel: 'Fixture worker', squadShortName: 'Fixture', retryDelayMs: 5,
      launchArgs: ({ model, effort }) => ['-e',
        `require('node:fs').appendFileSync(${JSON.stringify(counter)}, ${JSON.stringify(`${model}:${effort}\n`)}); process.stderr.write('model unavailable'); process.exit(1);`],
      resumeArgs: ({ model, effort }) => ['-e',
        `require('node:fs').appendFileSync(${JSON.stringify(counter)}, ${JSON.stringify(`${model}:${effort}\n`)}); process.exit(1);`],
      parseRunLog: () => ({ entries: [], outcome: 'failed', completedTurn: false, threadId: 'fixture-thread' }),
      modelCompatibilityFallback: vi.fn(() => ({ nextModel: 'fallback-model', notice: 'fallback' })),
      chooseRetryModel: vi.fn(() => ({ nextModel: 'quota-model', reason: 'quota' })),
    };
  }
  function request() {
    return { cwd: repo, prompt: 'inspect', model: 'gpt-6.1-sol', effort: 'high' as const,
      runtimeConfig: { workMode: 'read-only' }, executionPolicy: 'single-attempt' as const };
  }
  function sessionFile(): string {
    return path.join(sessions, readdirSync(sessions)[0]!, 'session.json');
  }
  function saved(): OwnedSessionRecord {
    return JSON.parse(readFileSync(sessionFile(), 'utf8')) as OwnedSessionRecord;
  }
  async function settled(): Promise<void> {
    const deadline = Date.now() + 5000;
    while (saved().activeRun) {
      if (Date.now() >= deadline) throw new Error('Fixture did not settle');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it('journals one real child and does not use an ambiguous bridge or change pins on failure', async () => {
    const { createOwnedSessionStore } = await import('./store');
    const runtime = adapter();
    const store = createOwnedSessionStore(runtime);
    const result = await store.launch(request());
    await settled();
    expect(bridge).not.toHaveBeenCalled();
    // Even a legacy/user-mutated retry flag cannot override the durable limit.
    writeFileSync(sessionFile(), JSON.stringify({ ...saved(), autoRetry: true }));
    await store.getRuntimeTail(result.surfaceId);
    await store.getFleetAdditions({ fresh: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(runtime.modelCompatibilityFallback).not.toHaveBeenCalled();
    expect(runtime.chooseRetryModel).not.toHaveBeenCalled();
    expect(readFileSync(counter, 'utf8')).toBe('gpt-6.1-sol:high\n');
    expect(saved()).toMatchObject({ model: 'gpt-6.1-sol', effort: 'high',
      executionPolicy: { version: 1, mode: 'single-attempt', runtime: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
      runIdentityLedger: { totalRuns: 1, complete: true } });
  }, 10_000);

  it('refuses explicit, automatic and archived resume after a cold store reload', async () => {
    const { createOwnedSessionStore } = await import('./store');
    const { withOwnedAutomaticRecovery } = await import('./automatic-recovery');
    const store = createOwnedSessionStore(adapter());
    const result = await store.launch(request());
    await settled();
    const cold = createOwnedSessionStore(adapter());
    await expect(cold.resume(result.surfaceId, 'try again')).rejects.toThrow(/single.attempt/i);
    const retry = vi.fn(async () => 'unexpected');
    await expect(withOwnedAutomaticRecovery(result.surfaceId, saved().recentRuns[0]!.id, retry)).rejects.toThrow(/single.attempt/i);
    expect(retry).not.toHaveBeenCalled();
    expect((await cold.archiveSession(result.surfaceId)).archived).toBe(true);
    expect(readdirSync(sessions)).toHaveLength(0);
    await expect(createOwnedSessionStore(adapter()).resume(result.surfaceId, 'cold retry')).rejects.toThrow(/single.attempt/i);
    expect(readdirSync(sessions)).toHaveLength(0);
    expect(readFileSync(counter, 'utf8')).toBe('gpt-6.1-sol:high\n');
  }, 10_000);

  it.each([
    { model: undefined }, { effort: undefined }, { effort: 'adaptive' },
    { runtimeConfig: {} }, { executionPolicy: 'unknown-policy' },
    { model: 'gpt-5.6-luna', effort: 'ultra' },
    { runtimeConfig: { workMode: 'read-only', modelSource: 'openrouter' } },
    { runtimeConfig: { workMode: 'read-only', executionCarrier: 'ori' } },
    { model: 'ollama:qwen2.5-coder:32b' }, { model: 'openrouter:anthropic/claude-opus-5' },
    { model: 'unknown-provider-model' }, { model: 'claude-opus-5' },
  ])('fails before creating session state for missing or widened pins: %j', async (override) => {
    const { createOwnedSessionStore } = await import('./store');
    const input = { ...request(), ...override } as Parameters<ReturnType<typeof createOwnedSessionStore>['launch']>[0];
    await expect(createOwnedSessionStore(adapter()).launch(input)).rejects.toThrow(/single.attempt/i);
    expect(existsSync(sessions)).toBe(false);
    expect(existsSync(counter)).toBe(false);
    expect(bridge).not.toHaveBeenCalled();
  });

  it.each(['model', 'effort', 'mode', 'policy', 'ledger'] as const)(
    'rereads durable %s changes after readiness and refuses before process creation', async (kind) => {
      const { createOwnedSessionStore } = await import('./store');
      let release!: () => void;
      ready.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
      const launched = createOwnedSessionStore(adapter()).launch(request());
      // Effort admission starts the catalogue stand-in before readiness.
      await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce(), { timeout: 5_000 });
      const changed = saved();
      if (kind === 'model') changed.model = 'fallback-model';
      if (kind === 'effort') changed.effort = 'low';
      if (kind === 'mode') changed.runtimeConfig = { workMode: 'edit' };
      if (kind === 'policy') delete changed.executionPolicy;
      if (kind === 'ledger') changed.runIdentityLedger = { version: 1, totalRuns: null, complete: false };
      writeFileSync(sessionFile(), JSON.stringify(changed));
      release();
      await expect(launched).rejects.toThrow(/single.attempt/i);
      expect(existsSync(counter)).toBe(false);
      expect(bridge).not.toHaveBeenCalled();
    },
  );

  it('retains the ordinary compatibility-recovery behavior as a control', async () => {
    const { createOwnedSessionStore } = await import('./store');
    const runtime = adapter();
    const store = createOwnedSessionStore(runtime);
    const result = await store.launch({ ...request(), executionPolicy: undefined });
    await settled();
    await vi.waitFor(async () => {
      await store.getRuntimeTail(result.surfaceId);
      expect(bridge).toHaveBeenCalledTimes(2);
    });
    await settled();
    expect(runtime.modelCompatibilityFallback).toHaveBeenCalled();
    expect(readFileSync(counter, 'utf8')).toBe('gpt-6.1-sol:high\nfallback-model:high\n');
    expect(saved().executionPolicy).toBeUndefined();
  }, 10_000);

  it('holds an uncertain published attempt after sync failure without spawning or replenishing it', async () => {
    const { createOwnedSessionStore } = await import('./store');
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    sync.mockImplementation((fd: number) => {
      if (existsSync(sessions) && readdirSync(sessions).length && existsSync(sessionFile())
        && saved().activeRun?.spawnState === 'prepared') throw new Error('fixture directory sync failed');
      actual.fsyncSync(fd);
    });
    await expect(createOwnedSessionStore(adapter()).launch(request())).rejects.toThrow('fixture directory sync failed');
    expect(saved()).toMatchObject({ activeRun: { spawnState: 'prepared' }, runIdentityLedger: { totalRuns: 1 } });
    expect(existsSync(counter)).toBe(false);
    const surface = saved().surfaceId;
    sync.mockImplementation(actual.fsyncSync);
    await expect(createOwnedSessionStore(adapter()).resume(surface, 'retry')).rejects.toThrow(/single.attempt/i);
    expect(saved().runIdentityLedger?.totalRuns).toBe(1);
  });

  it('refuses the real child quota exit and direct fallback handler with cross-house fallback enabled', async () => {
    const [{ createOwnedSessionStore }, { createLane, attachSession, getLane, getLaneEvents },
      { updateOperatorDefaults }, { handleWorkerQuotaExhaustion }] = await Promise.all([
      import('./store'), import('@/lib/lane/registry'), import('@/lib/operator/defaults'),
      import('@/lib/dispatch/worker-quota-fallback'),
    ]);
    await updateOperatorDefaults({ crossHouseWorkerFallback: true, subscriptionProfile: 'both' });
    try {
      const runtime = adapter();
      runtime.launchArgs = () => ['-e', `require('node:fs').appendFileSync(${JSON.stringify(counter)}, ${JSON.stringify('once\n')}); process.stderr.write('You have hit your usage limit.'); process.exit(1);`];
      const lane = createLane({ repoPath: repo, worktreePath: repo, runtime: 'codex', branch: 'fixture' });
      const result = await createOwnedSessionStore(runtime).launch({ ...request(), laneId: lane.id });
      attachSession(lane.id, result.surfaceId, 'system');
      await settled();
      await vi.waitFor(() => expect(getLaneEvents(lane.id).some((event) => event.verb === 'runtime_process_exit')).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await handleWorkerQuotaExhaustion({ laneId: lane.id, runtime: 'codex',
        surfaceId: result.surfaceId, model: 'gpt-6.1-sol', prompt: 'inspect', error: 'You have hit your usage limit.' }))
        .toEqual({ handled: false, action: 'ignored' });
      expect(getLane(lane.id)).toMatchObject({ runtime: 'codex', sessionKey: result.surfaceId });
      expect(getLaneEvents(lane.id).some((event) => event.verb === 'worker_fallback')).toBe(false);
      expect(readFileSync(counter, 'utf8')).toBe('once\n');
      expect(saved().runIdentityLedger?.totalRuns).toBe(1);
    } finally { await updateOperatorDefaults({ crossHouseWorkerFallback: false }); }
  }, 10_000);
});
