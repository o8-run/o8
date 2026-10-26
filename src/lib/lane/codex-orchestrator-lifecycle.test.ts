import { readFileSync, writeSync } from 'node:fs';
import { mutateProviderKey } from '@/lib/providers/key-store';
import { saveRuntimeBillingMode } from '@/lib/providers/runtime-billing';
import { listOrchestratorTurnsForThread } from './orchestrator-crash-survival';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
const resolveCliMock = vi.hoisted(() => vi.fn(async () => ({ path: process.execPath, version: '0.140.0' })));
const prepareSingleMock = vi.hoisted(() => vi.fn());
const codexComposerImagePathsMock = vi.hoisted(() => vi.fn(() => ['/tmp/o8-test-image.png']));
const backendSessions = vi.hoisted(() => new Map<string, string>());
const speedCatalogue = vi.hoisted(() => vi.fn(async () => ({ models: { 'gpt-5.5': [{ id: 'default' }, { id: 'priority' }] } })));
vi.mock('@/lib/codex/service-tier-catalogue', () => ({ getCodexSpeedCatalogue: speedCatalogue }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

vi.mock('@/lib/runtimes/shared/cli-resolver', () => ({
  CliNotFoundError: class CliNotFoundError extends Error {},
  resolveCli: resolveCliMock,
}));

vi.mock('./single-orchestrator-policy', () => ({
  prepareSingleOrchestratorLaunch: prepareSingleMock,
}));
vi.mock('@/lib/mobile/orchestrator-image-media', () => ({
  codexComposerImagePaths: codexComposerImagePathsMock,
}));

vi.mock('@/lib/mcp/tool-spine/build', () => ({ buildToolRegistry: () => ({}) }));
vi.mock('@/lib/mcp/tool-spine/emit-codex', () => ({
  serializeCodexMcpServers: () => '',
  toCodexServersMap: () => ({}),
}));

vi.mock('@/lib/mobile/orchestrator-thread-history', () => ({
  readOrchestratorBackendSessionId: (threadId: string | null, backend: string) => (
    threadId ? backendSessions.get(`${threadId}:${backend}`) ?? null : null
  ),
  writeOrchestratorBackendSessionId: (threadId: string | null, backend: string, sessionId: string | null) => {
    if (!threadId) return;
    const key = `${threadId}:${backend}`;
    if (sessionId) backendSessions.set(key, sessionId);
    else backendSessions.delete(key);
  },
}));

import {
  CODEX_FIRST_EVENT_TIMEOUT_MS,
  ensureCodexOrchestratorSession,
  sendToCodexOrchestrator,
} from './codex-orchestrator-session';
import { writeOrchestratorBackendSessionId } from '@/lib/mobile/orchestrator-thread-history';
import type { OrchestratorEvent } from './orchestrator-stream-events';
import { writePersistedLlmChat } from '@/lib/llm/chat-history-store';

function persistRecoveryHistory(threadId: string, current: string) {
  writePersistedLlmChat(threadId, { repoPath: process.cwd(), messages: [
    { id: 'earlier-user', role: 'user', content: 'Retain the earlier requirement.', timestamp: 1 },
    { id: 'earlier-assistant', role: 'assistant', content: 'Requirement retained.', timestamp: 2 },
    { id: 'current-user', role: 'user', content: current, timestamp: 3 },
  ] });
}

class FakeCodexProc extends EventEmitter {
  stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = process.pid;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  unref = vi.fn();
  kill = vi.fn((signal: NodeJS.Signals = 'SIGTERM') => {
    this.killed = true;
    this.signalCode = signal;
    return true;
  });
}

function useFakeProc(): FakeCodexProc {
  const proc = new FakeCodexProc();
  spawnMock.mockReturnValue(proc as unknown as ChildProcess);
  return proc;
}

async function waitForSpawn(): Promise<void> {
  await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
}

describe('Codex orchestrator process lifecycle', () => {
  it.each(['Error', 'TypeError', 'SyntaxError', 'RangeError', 'ReferenceError', 'AggregateError', 'Error [ERR_MODULE_NOT_FOUND]'])('surfaces the first %s line after a packaged bridge code frame', async (name) => {
    const session = ensureCodexOrchestratorSession(process.cwd(), `bridge-error-${name}-${Date.now()}`);
    const proc = useFakeProc();
    const events: OrchestratorEvent[] = [];
    const turn = sendToCodexOrchestrator(session, 'startup failure', event => events.push(event));
    await waitForSpawn();
    const error = `${name}: Could not locate the bindings file. Tried:`;
    proc.stderr.emit('data', Buffer.from('file:///bundle/Contents/Resources/server/codex-app-bridge-impl.mjs:2\n'
      + 'const bundledSource = 1;'.repeat(100) + '\n  ^\n\n' + error + '\nError: secondary failure\n    at main (bridge.mjs:2:1)\n'));
    proc.exitCode = 1;
    proc.emit('close', 1);
    await turn;
    expect(events).toContainEqual({ type: 'error', error });
    expect(events.at(-1)?.type).toBe('done');
  });

  it.each([false, true])('passes an explicit tier to the actual CLI launch (resume=%s)', async (resume) => {
    const session = ensureCodexOrchestratorSession(process.cwd(), `speed-${resume}-${Date.now()}`);
    if (resume) session.threadId = 'saved-speed-thread';
    const proc = useFakeProc(); const events: OrchestratorEvent[] = [];
    const turn = sendToCodexOrchestrator(session, 'speed fixture', (event) => events.push(event), { model: 'gpt-5.5', serviceTier: 'priority' });
    await waitForSpawn();
    expect(spawnMock.mock.calls[0][1]).toContain('service_tier="priority"');
    expect(speedCatalogue).toHaveBeenCalledWith(spawnMock.mock.calls[0][2].env.CODEX_HOME);
    proc.exitCode = 0; proc.emit('close', 0); await turn;
    expect(events.at(-1)?.type).toBe('done');
  });
  it('rejects an unadvertised tier without spawning or stranding the session busy', async () => {
    const session = ensureCodexOrchestratorSession(process.cwd(), `speed-rejected-${Date.now()}`);
    const events: OrchestratorEvent[] = [];
    await sendToCodexOrchestrator(session, 'speed fixture', (event) => events.push(event), { model: 'gpt-5.5', serviceTier: 'ultrafast' });
    expect(spawnMock).not.toHaveBeenCalled(); expect(session.status).toBe('ready'); expect(events.at(-2)).toMatchObject({ type: 'error', error: expect.stringContaining('not available') }); expect(events.at(-1)?.type).toBe('done');
  });
  beforeEach(() => {
    process.env.O8_CRASH_SURVIVABLE_ORCHESTRATOR = '0';
    backendSessions.clear();
    spawnMock.mockReset();
    speedCatalogue.mockClear();
    resolveCliMock.mockReset();
    resolveCliMock.mockResolvedValue({ path: process.execPath, version: '0.140.0' });
    prepareSingleMock.mockReset();
    codexComposerImagePathsMock.mockClear();
    prepareSingleMock.mockImplementation(async (input: {
      binary: string;
      args: string[];
      env: NodeJS.ProcessEnv;
    }) => ({
      binary: process.execPath,
      args: ['/tmp/o8-single-bin/.single-supervisor.mjs', '/tmp/o8-single-bin/.codex-main',
        '/tmp/o8-single-root', '/usr/bin/sandbox-exec', '-f', '/tmp/o8-single.sb',
        '/tmp/o8-single-bin/.codex-main', ...input.args],
      env: input.env,
      profileText: '(version 1)',
      profilePath: '/tmp/o8-single.sb',
      overlayPath: '/tmp/o8-single-codex-home',
      rulesPath: '/tmp/o8-single.rules',
      guardPath: '/tmp/o8-single-bin/codex',
      launchBinaryPath: '/tmp/o8-single-bin/.codex-main',
      supervisorPath: '/tmp/o8-single-bin/.single-supervisor.mjs',
      cleanup: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.O8_CRASH_SURVIVABLE_ORCHESTRATOR;
  });

  it('starts a fresh codex exec when the thread only has a Claude backend session id', async () => {
    const threadId = `thoughts-codex-hygiene-${Date.now()}`;
    writeOrchestratorBackendSessionId(threadId, 'claude', 'foreign-claude-session');
    const session = ensureCodexOrchestratorSession(process.cwd(), threadId);
    const proc = useFakeProc();
    const events: OrchestratorEvent[] = [];

    const turn = sendToCodexOrchestrator(session, 'hi', (event) => events.push(event));
    await waitForSpawn();

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args.slice(0, 2)).toEqual(['exec', '--json']);
    expect(args).not.toContain('resume');
    expect(args).not.toContain('foreign-claude-session');

    proc.stdout.emit('data', Buffer.from('{"type":"thread.started","thread_id":"codex-thread"}\n'));
    proc.exitCode = 0;
    proc.emit('close', 0);
    await turn;
    expect(events.at(-1)).toMatchObject({ type: 'done', sessionId: 'codex-thread' });
  });

  it('publishes Codex CLI usage on the terminal lifecycle event', async () => {
    const session = ensureCodexOrchestratorSession(process.cwd(), `thoughts-usage-${Date.now()}`);
    const proc = useFakeProc();
    const events: OrchestratorEvent[] = [];

    const turn = sendToCodexOrchestrator(session, 'report usage', (event) => events.push(event));
    await waitForSpawn();

    proc.stdout.emit('data', Buffer.from([
      JSON.stringify({ type: 'thread.started', thread_id: 'usage-thread' }),
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 40_651, cached_input_tokens: 40_448, output_tokens: 11 },
      }),
      '',
    ].join('\n')));
    proc.exitCode = 0;
    proc.emit('close', 0);
    await turn;

    expect(events.at(-1)).toMatchObject({
      type: 'done',
      terminalOutcome: 'completed', sessionId: 'usage-thread',
      usage: {
        inputTokens: 203,
        outputTokens: 11,
        cacheReadTokens: 40_448,
        cacheWriteTokens: 0,
      },
    });
  });

  it('keeps subscription-only Solo detached with durable output and no saved API key', async () => {
    saveRuntimeBillingMode('codex', 'subscription');
    mutateProviderKey('OPENAI_API_KEY', { key: 'fixture-solo-api' });
    process.env.O8_CRASH_SURVIVABLE_ORCHESTRATOR = '1';
    const prepare = prepareSingleMock.getMockImplementation()!;
    prepareSingleMock.mockImplementation(async input => ({ ...await prepare(input), sealInParent: true, sealOnOutput: vi.fn() }));
    const proc = new FakeCodexProc();
    const line = '{"type":"item.completed","item":{"type":"agent_message","text":"Fixture durable output"}}\n';
    spawnMock.mockImplementation((_command, _args, options) => {
      if (typeof options.stdio[1] === 'number') writeSync(options.stdio[1], line);
      else queueMicrotask(() => proc.stdout.emit('data', Buffer.from(line)));
      return proc;
    });
    const threadId = `thoughts-solo-durable-${Date.now()}`;
    const session = ensureCodexOrchestratorSession(process.cwd(), threadId);
    const turn = sendToCodexOrchestrator(session, 'Fixture', () => {}, { orchestrationMode: 'single', model: 'gpt-5.5' });
    try {
      await waitForSpawn();
      const options = spawnMock.mock.calls[0][2];
      expect(options.detached).toBe(true);
      expect(options.env.OPENAI_API_KEY || null).toBeNull();
      expect(options.stdio.slice(1).every((fd: unknown) => typeof fd === 'number')).toBe(true);
      const records = listOrchestratorTurnsForThread(threadId);
      expect(records).toHaveLength(1);
      expect(readFileSync(records[0].stdoutPath, 'utf8')).toContain('Fixture durable output');
      expect(proc.unref).toHaveBeenCalledOnce();
    } finally {
      proc.exitCode = 0; proc.emit('close', 0); await turn;
      mutateProviderKey('OPENAI_API_KEY', { key: null });
      saveRuntimeBillingMode('codex', 'subscription');
    }
  });

  it('wraps a Single turn before spawn and disables config plus native fan-out', async () => {
    const session = ensureCodexOrchestratorSession(process.cwd(), `thoughts-single-${Date.now()}`);
    const proc = useFakeProc();

    const turn = sendToCodexOrchestrator(session, 'work alone', () => {}, {
      orchestrationMode: 'single',
    });
    await waitForSpawn();

    expect(prepareSingleMock).toHaveBeenCalledOnce();
    const preparedInput = prepareSingleMock.mock.calls[0][0] as { args: string[] };
    expect(preparedInput.args).toEqual(expect.arrayContaining([
      '--ignore-user-config',
      'sandbox_mode="danger-full-access"',
      'approval_policy="never"',
      'mcp_servers={}',
      'features.multi_agent=false',
      'features.enable_fanout=false',
    ]));
    expect(preparedInput.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(spawnMock.mock.calls[0][0]).toBe(process.execPath);
    expect(spawnMock.mock.calls[0][2]).toMatchObject({ detached: true });

    proc.stdout.emit('data', Buffer.from('{"type":"thread.started","thread_id":"single-thread"}\n'));
    proc.exitCode = 0;
    proc.emit('close', 0);
    await turn;
    const prepared = await prepareSingleMock.mock.results[0].value;
    expect(prepared.cleanup).toHaveBeenCalledOnce();
  });

  it('passes composer images to a Codex Solo turn as image files', async () => {
    const session = ensureCodexOrchestratorSession(process.cwd(), `thoughts-single-image-${Date.now()}`);
    const proc = useFakeProc();
    const attachment = { dataUri: 'data:image/png;base64,aW1hZ2U=', name: 'photo.png' };
    const turn = sendToCodexOrchestrator(session, 'inspect this', () => {}, {
      orchestrationMode: 'single',
      attachments: [attachment],
    });
    await waitForSpawn();
    expect(codexComposerImagePathsMock).toHaveBeenCalledWith([attachment], expect.any(String));
    const preparedArgs = prepareSingleMock.mock.calls[0][0].args as string[];
    expect(preparedArgs).toEqual(expect.arrayContaining(['--image', '/tmp/o8-test-image.png']));
    expect(preparedArgs.indexOf('--image')).toBeLessThan(preparedArgs.indexOf('--'));
    proc.stdout.emit('data', Buffer.from('{"type":"thread.started","thread_id":"single-image-thread"}\n'));
    proc.exitCode = 0;
    proc.emit('close', 0);
    await turn;
  });

  it('uses resume-compatible sandbox config instead of the bypass flag for later Single turns', async () => {
    const threadId = `thoughts-single-resume-${Date.now()}`;
    writeOrchestratorBackendSessionId(threadId, 'codex', '00000000-0000-0000-0000-000000000001');
    const session = ensureCodexOrchestratorSession(process.cwd(), threadId);
    const proc = useFakeProc();

    const turn = sendToCodexOrchestrator(session, 'continue alone', () => {}, {
      orchestrationMode: 'single',
    });
    await waitForSpawn();

    const preparedInput = prepareSingleMock.mock.calls[0][0] as { args: string[] };
    expect(preparedInput.args.slice(0, 4)).toEqual([
      'exec', 'resume', '00000000-0000-0000-0000-000000000001', '--json',
    ]);
    expect(preparedInput.args).toEqual(expect.arrayContaining([
      'sandbox_mode="danger-full-access"',
      'approval_policy="never"',
    ]));
    expect(preparedInput.args).not.toContain('--sandbox');
    expect(preparedInput.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');

    proc.exitCode = 0;
    proc.emit('close', 0);
    await turn;
  });

  it('retries a missing persisted Codex rollout once as a fresh thread', async () => {
    const historyThreadId = `thoughts-stale-resume-${Date.now()}`;
    persistRecoveryHistory(historyThreadId, 'recover me');
    writeOrchestratorBackendSessionId(historyThreadId, 'codex', 'stale-codex-thread');
    const session = ensureCodexOrchestratorSession(process.cwd(), historyThreadId);
    const staleProc = new FakeCodexProc();
    const freshProc = new FakeCodexProc();
    spawnMock
      .mockReturnValueOnce(staleProc as unknown as ChildProcess)
      .mockReturnValueOnce(freshProc as unknown as ChildProcess);
    const events: OrchestratorEvent[] = [];

    const turn = sendToCodexOrchestrator(session, 'recover me', (event) => events.push(event), { rawMessage: 'recover me' });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    expect(spawnMock.mock.calls[0][1]).toEqual(expect.arrayContaining([
      'exec', 'resume', 'stale-codex-thread', '--json',
    ]));
    staleProc.stderr.emit('data', Buffer.from(
      'Error: thread/resume failed: failed to resolve rollout path `/missing.jsonl`: file does not exist',
    ));
    staleProc.exitCode = 1;
    staleProc.emit('close', 1);

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
    expect(spawnMock.mock.calls[1][1]).toEqual(expect.arrayContaining(['exec', '--json']));
    expect(spawnMock.mock.calls[1][1]).not.toContain('resume');
    expect(backendSessions.get(`${historyThreadId}:codex`)).toBe('stale-codex-thread');

    freshProc.stdout.emit('data', Buffer.from('{"type":"thread.started","thread_id":"fresh-codex-thread"}\n{"type":"turn.started"}\n'));
    freshProc.exitCode = 0;
    freshProc.emit('close', 0);
    await turn;

    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'done', sessionId: 'fresh-codex-thread' });
    expect(session.threadId).toBe('fresh-codex-thread');
    expect(session.status).toBe('ready');
  });

  it('retries a no-rollout resume response after long startup warnings as a fresh thread', async () => {
    const historyThreadId = `thoughts-no-rollout-resume-${Date.now()}`;
    persistRecoveryHistory(historyThreadId, 'recover the production error');
    writeOrchestratorBackendSessionId(historyThreadId, 'codex', '019ffcb1-3d86-7ba3-af64-0ca2a66660e9');
    const session = ensureCodexOrchestratorSession(process.cwd(), historyThreadId);
    const staleProc = new FakeCodexProc();
    const freshProc = new FakeCodexProc();
    spawnMock
      .mockReturnValueOnce(staleProc as unknown as ChildProcess)
      .mockReturnValueOnce(freshProc as unknown as ChildProcess);
    const events: OrchestratorEvent[] = [];

    const turn = sendToCodexOrchestrator(session, 'recover the production error', (event) => events.push(event), { rawMessage: 'recover the production error' });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    staleProc.stderr.emit('data', Buffer.from(
      'WARN catalog request timed out\n'.repeat(30)
      + 'Error thread/resume: thread/resume failed: no rollout found for thread id 019ffcb1-3d86-7ba3-af64-0ca2a66660e9 (code -32600)',
    ));
    staleProc.exitCode = 1;
    staleProc.emit('close', 1);

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
    expect(spawnMock.mock.calls[1][1]).not.toContain('resume');
    freshProc.stdout.emit('data', Buffer.from('{"type":"thread.started","thread_id":"replacement-thread"}\n{"type":"turn.started"}\n'));
    freshProc.exitCode = 0;
    freshProc.emit('close', 0);
    await turn;

    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(session.threadId).toBe('replacement-thread');
  });

  it('fails a Single turn closed when the process boundary cannot be prepared', async () => {
    prepareSingleMock.mockRejectedValueOnce(new Error('sandbox missing'));
    const session = ensureCodexOrchestratorSession(process.cwd(), `thoughts-single-fail-${Date.now()}`);
    const events: OrchestratorEvent[] = [];

    await sendToCodexOrchestrator(session, 'work alone', (event) => events.push(event), {
      orchestrationMode: 'single',
    });

    expect(spawnMock).not.toHaveBeenCalled();
    expect(events).toContainEqual({ type: 'error', error: 'Single mode unavailable: sandbox missing' });
    expect(events.at(-1)?.type).toBe('done');
  });

  it('aborts a silent child after 45 seconds with error + done and settles immediately', async () => {
    vi.useFakeTimers();
    const session = ensureCodexOrchestratorSession(process.cwd(), `thoughts-watchdog-${Date.now()}`);
    const proc = useFakeProc();
    const events: OrchestratorEvent[] = [];

    const turn = sendToCodexOrchestrator(session, 'hi', (event) => events.push(event));
    await waitForSpawn();
    await vi.advanceTimersByTimeAsync(CODEX_FIRST_EVENT_TIMEOUT_MS);
    await turn;

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(events).toContainEqual({
      type: 'error',
      error: 'Codex produced no output for 45s — the turn was aborted; re-send to retry',
    });
    expect(events.at(-1)).toMatchObject({ type: 'done', terminalOutcome: 'unconfirmed' });
    expect(session.proc).toBeNull();
    expect(session.status).toBe('dead');
  });

  it('terminates the whole Single process group and escalates when TERM stalls', async () => {
    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    const session = ensureCodexOrchestratorSession(process.cwd(), `thoughts-single-kill-${Date.now()}`);
    const proc = useFakeProc();

    try {
      const turn = sendToCodexOrchestrator(session, 'work alone', () => {}, {
        orchestrationMode: 'single',
      });
      await waitForSpawn();
      await vi.advanceTimersByTimeAsync(CODEX_FIRST_EVENT_TIMEOUT_MS);
      await turn;
      expect(killSpy).toHaveBeenCalledWith(-proc.pid, 'SIGTERM');
      proc.signalCode = 'SIGTERM';
      await vi.advanceTimersByTimeAsync(2_000);
      expect(killSpy).toHaveBeenCalledWith(-proc.pid, 'SIGKILL');
      proc.signalCode = 'SIGKILL';
      proc.emit('close', null);
    } finally {
      killSpy.mockRestore();
    }
  });

  it('clears the first-event watchdog on a parseable Codex protocol event', async () => {
    vi.useFakeTimers();
    const session = ensureCodexOrchestratorSession(process.cwd(), `thoughts-first-event-${Date.now()}`);
    const proc = useFakeProc();

    const turn = sendToCodexOrchestrator(session, 'hi', () => {});
    await waitForSpawn();
    proc.stdout.emit('data', Buffer.from('{"type":"thread.started","thread_id":"codex-live"}\n'));
    await vi.advanceTimersByTimeAsync(CODEX_FIRST_EVENT_TIMEOUT_MS);

    expect(proc.kill).not.toHaveBeenCalled();
    proc.exitCode = 0;
    proc.emit('close', 0);
    await turn;
  });

  it('settles and kills the child when Stop arrives during the silent window', async () => {
    const session = ensureCodexOrchestratorSession(process.cwd(), `thoughts-abort-${Date.now()}`);
    const proc = useFakeProc();
    const controller = new AbortController();
    const events: OrchestratorEvent[] = [];

    const turn = sendToCodexOrchestrator(session, 'hi', (event) => events.push(event), { signal: controller.signal });
    await waitForSpawn();
    controller.abort();
    await turn;

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(events.at(-1)).toMatchObject({ type: 'done', terminalOutcome: 'unconfirmed' });
    expect(session.proc).toBeNull();
  });

  it('settles without spawning when Stop arrives during CLI resolution', async () => {
    let releaseResolver: (value: { path: string; version: string }) => void = () => {
      throw new Error('resolver was not armed');
    };
    resolveCliMock.mockImplementationOnce(() => new Promise((resolve) => { releaseResolver = resolve; }));
    const session = ensureCodexOrchestratorSession(process.cwd(), `thoughts-resolve-abort-${Date.now()}`);
    const controller = new AbortController();
    const events: OrchestratorEvent[] = [];

    const turn = sendToCodexOrchestrator(session, 'hi', (event) => events.push(event), { signal: controller.signal });
    await vi.waitFor(() => expect(resolveCliMock).toHaveBeenCalledTimes(1));
    controller.abort();
    releaseResolver({ path: process.execPath, version: '0.140.0' });
    await turn;

    expect(spawnMock).not.toHaveBeenCalled();
    expect(events.at(-1)?.type).toBe('done');
    expect(session.status).toBe('ready');
  });
});
