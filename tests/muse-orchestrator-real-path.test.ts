import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMuseBackend } from '@/lib/lane/orchestrator-backends/muse';
import type { MuseHost } from '@/lib/muse/host';
import { museHostEnvironment } from '@/lib/muse/host';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';

let root: string;
let repo: string;
let backends: ReturnType<typeof createMuseBackend>[];

function fakeHost(cwd: string, mode = 'promptUnmatched', complete = true) {
  let notify: (frame: { jsonrpc: '2.0'; method: string; params: Record<string, unknown> }) => void = () => {};
  let protocolError = () => {};
  const command = vi.fn(async (method: string, params: Record<string, unknown>, options?: { commandId?: string }): Promise<Record<string, unknown>> => {
    if (method === 'session/start' || method === 'session/resume') return { session: { sessionId: 'native-session', workspaceRoot: cwd, providerId: 'meta', modelId: 'muse-wonder' } };
    if (method === 'session/setApprovalMode') return { effectiveMode: { mode } };
    if (method === 'turn/start') {
      const turnId = options?.commandId;
      if (complete) queueMicrotask(() => notify({ jsonrpc: '2.0', method: 'turn/completed', params: { sessionId: 'native-session', turnId, terminal: 'completed' } }));
      return { turnId, disposition: 'started' };
    }
    return {};
  });
  const close = vi.fn(async () => {});
  const host: MuseHost = { initializeResult: { museHome: join(root, 'data', 'muse'), schema: { version: 1 }, grantedCapabilities: ['sessionMcp'] } as unknown as MuseHost['initializeResult'],
    close, connection: { command, request: vi.fn(async () => ({})), mintCommandId: randomUUID,
      onNotification(handler) { notify = handler; }, onServerRequest() {}, onProtocolError(handler) { protocolError = () => handler(new Error('fixture protocol error') as never); }, closed: new Promise(() => {}) } };
  return { host, command, close, emit: (method: string, params: Record<string, unknown>) => notify({ jsonrpc: '2.0', method, params: { sessionId: 'native-session', ...params } }), protocolError: () => protocolError() };
}

beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'o8-muse-entry-'))); repo = join(root, 'workspace'); await mkdir(repo); backends = []; vi.stubEnv('XDG_CONFIG_HOME', join(root, 'config')); vi.stubEnv('XDG_DATA_HOME', join(root, 'data')); });
afterEach(async () => { await Promise.all(backends.map(value => value.closeAll())); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

describe('Muse orchestrator persisted entry point', () => {
  it.each([undefined, 'adaptive'] as const)('records runtime-default provenance without reasoning input on a %s cold resume', async thinkingEffort => {
    const first = fakeHost(repo);
    const make = (host: MuseHost) => {
      const backend = createMuseBackend({ stateRoot: () => join(root, 'state'), openHost: async () => host });
      backends.push(backend); return backend;
    };
    await make(first.host).sendTurn(repo, 'first', () => {}, { threadId: 'default-effort' });
    await backends[0].closeAll();
    const second = fakeHost(repo);
    const events: OrchestratorEvent[] = [];
    await make(second.host).sendTurn(repo, 'second', event => events.push(event), { threadId: 'default-effort', thinkingEffort });
    expect(second.command).toHaveBeenCalledWith('session/resume', expect.objectContaining({ sessionId: 'native-session' }));
    const request = second.command.mock.calls.find(([method]) => method === 'turn/start')![1];
    expect(request).not.toHaveProperty('reasoningEffort');
    expect(events).toContainEqual(expect.objectContaining({ type: 'turn_receipt', effort: 'adaptive', effortSource: 'runtime-default' }));
  });

  it('resumes the recorded session and pins its configuration after a cold restart', async () => {
    const first = fakeHost(repo);
    const make = (host: MuseHost) => { const backend = createMuseBackend({ stateRoot: () => join(root, 'state'), openHost: vi.fn(async () => host) }); backends.push(backend); return backend; };
    const events: OrchestratorEvent[] = [];
    await make(first.host).sendTurn(repo, 'first', value => events.push(value), { model: 'muse-wonder', threadId: 'thread' });
    expect(events.at(-1)?.type).toBe('done');
    const file = (await readdir(join(root, 'state')))[0];
    const stored = JSON.parse(await readFile(join(root, 'state', file), 'utf8'));
    expect(stored).toMatchObject({ sessionId: 'native-session', model: 'muse-wonder', repoPath: repo, dataRoot: join(root, 'data') });
    await backends[0].closeAll();
    vi.stubEnv('XDG_CONFIG_HOME', 'invalid-current-root'); vi.stubEnv('XDG_DATA_HOME', 'invalid-current-root');
    const second = fakeHost(repo);
    await make(second.host).sendTurn(repo, 'second', () => {}, { threadId: 'thread' });
    expect(second.command).toHaveBeenCalledWith('session/resume', expect.objectContaining({ sessionId: 'native-session' }));
    expect(second.command).toHaveBeenCalledWith('session/setApprovalMode', expect.objectContaining({ mode: 'promptUnmatched' }));
  });

  it('rejects unapplied approval policy before any turn submission', async () => {
    const fake = fakeHost(repo, 'allowAll');
    const backend = createMuseBackend({ stateRoot: () => join(root, 'state'), openHost: async () => fake.host }); backends.push(backend);
    const events: OrchestratorEvent[] = [];
    await backend.sendTurn(repo, 'task', value => events.push(value));
    expect(events.at(-1)?.type).toBe('error');
    expect(fake.command.mock.calls.some(([method]) => method === 'turn/start')).toBe(false);
    expect(fake.close).toHaveBeenCalled();
  });

  it('recreates the native host when the tool profile narrows', async () => {
    const first = fakeHost(repo); const second = fakeHost(repo);
    const openHost = vi.fn().mockResolvedValueOnce(first.host).mockResolvedValueOnce(second.host);
    const backend = createMuseBackend({ stateRoot: () => join(root, 'state'), openHost }); backends.push(backend);
    await backend.sendTurn(repo, 'first', () => {}, { toolProfile: 'full' });
    await backend.sendTurn(repo, 'second', () => {}, { toolProfile: 'propose' });
    expect(first.close).toHaveBeenCalled();
    expect(openHost).toHaveBeenCalledTimes(2);
    expect(openHost.mock.calls[1][0].readOnly).toBe(true);
  });

  it('keeps ambient keys, updater, and fail-open overrides out of the host environment', () => {
    const env = museHostEnvironment({ META_API_KEY: 'secret', OPENROUTER_API_KEY: 'secret', NODE_OPTIONS: '--import bad',
      MUSE_PERMISSION_PROFILE_FAIL_OPEN: '1', MUSE_AUTH_PATH: '/unexpected/account', PATH: '/bin', MUSE_NO_AUTO_UPDATE: '0', NODE_ENV: 'test' });
    expect(env).toEqual({ PATH: '/bin', MUSE_NO_AUTO_UPDATE: '1', NODE_ENV: 'test' });
  });

  it('asks once per stage, ignores a stale decision and retires a resolved approval', async () => {
    const fake = fakeHost(repo, 'promptUnmatched', false);
    const pending: Array<{ resolve: (value: string) => void; signal?: AbortSignal }> = [];
    const approve = vi.fn((_params, context) => new Promise<string>(resolve => pending.push({ resolve, signal: context.signal })));
    const backend = createMuseBackend({ stateRoot: () => join(root, 'state'), openHost: async () => fake.host, approve }); backends.push(backend);
    const turn = backend.sendTurn(repo, 'task', () => {});
    await vi.waitFor(() => expect(fake.command.mock.calls.some(([method]) => method === 'turn/start')).toBe(true));
    const turnId = fake.command.mock.calls.find(([method]) => method === 'turn/start')?.[2]?.commandId;
    const request = { approvalId: 'approval-a', turnId, currentRequirementId: { approvalId: 'approval-a', sourceIndex: 0 }, subject: { kind: 'shell', command: 'echo test' } };
    fake.emit('approval/requested', request); fake.emit('approval/requested', request);
    expect(approve).toHaveBeenCalledTimes(1);
    fake.emit('approval/updated', { approvalId: 'approval-a', currentRequirementId: { approvalId: 'approval-a', sourceIndex: 1 }, subject: { kind: 'network', host: 'example.test' } });
    expect(approve).toHaveBeenCalledTimes(2); expect(pending[0].signal?.aborted).toBe(true);
    pending[0].resolve('old-choice'); pending[1].resolve('new-choice');
    await vi.waitFor(() => expect(fake.command).toHaveBeenCalledWith('approval/decide', expect.objectContaining({ choiceId: 'new-choice', requirementId: { approvalId: 'approval-a', sourceIndex: 1 } })));
    expect(fake.command.mock.calls.filter(([method]) => method === 'approval/decide')).toHaveLength(1);
    fake.emit('approval/resolved', { approvalId: 'approval-a' });
    fake.emit('approval/updated', { approvalId: 'approval-a', currentRequirementId: { sourceIndex: 2 } });
    expect(approve).toHaveBeenCalledTimes(2);
    fake.emit('turn/completed', { turnId, terminal: 'completed' }); await turn;
  });

  it('holds the conversation when protocol teardown cannot prove exit', async () => {
    const fake = fakeHost(repo, 'promptUnmatched', false);
    fake.close.mockRejectedValue(new Error('fixture process still exists'));
    const openHost = vi.fn(async () => fake.host);
    const backend = createMuseBackend({ stateRoot: () => join(root, 'state'), openHost }); backends.push(backend);
    const events: OrchestratorEvent[] = [];
    const turn = backend.sendTurn(repo, 'task', value => events.push(value));
    await vi.waitFor(() => expect(fake.command.mock.calls.some(([method]) => method === 'turn/start')).toBe(true));
    fake.protocolError(); await turn;
    await backend.sendTurn(repo, 'retry', value => events.push(value));
    expect(openHost).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ type: 'error', error: expect.stringContaining('already working') });
  });

  it('waits for a terminal decision acknowledgement before considering a trailing stage update', async () => {
    const fake = fakeHost(repo, 'promptUnmatched', false);
    const original = fake.command.getMockImplementation()!;
    let acknowledge: (value: Record<string, unknown>) => void = () => {};
    fake.command.mockImplementation((method, params, options) => method === 'approval/decide'
      ? new Promise(resolve => { acknowledge = resolve; }) : original(method, params, options));
    const approve = vi.fn(async () => 'once');
    const backend = createMuseBackend({ stateRoot: () => join(root, 'state'), openHost: async () => fake.host, approve }); backends.push(backend);
    const turn = backend.sendTurn(repo, 'task', () => {});
    await vi.waitFor(() => expect(fake.command.mock.calls.some(([method]) => method === 'turn/start')).toBe(true));
    const turnId = fake.command.mock.calls.find(([method]) => method === 'turn/start')?.[2]?.commandId;
    fake.emit('approval/requested', { approvalId: 'terminal-a', turnId, currentRequirementId: { sourceIndex: 0 } });
    await vi.waitFor(() => expect(fake.command.mock.calls.some(([method]) => method === 'approval/decide')).toBe(true));
    fake.emit('approval/updated', { approvalId: 'terminal-a', currentRequirementId: { sourceIndex: 1 }, change: { kind: 'stageResolved' } });
    expect(approve).toHaveBeenCalledTimes(1);
    acknowledge({ terminal: true }); await new Promise(resolve => setTimeout(resolve, 0));
    fake.emit('approval/updated', { approvalId: 'terminal-a', currentRequirementId: { sourceIndex: 2 }, change: { kind: 'stageResolved' } });
    expect(approve).toHaveBeenCalledTimes(1);
    fake.emit('turn/completed', { turnId, terminal: 'completed' }); await turn;
    expect(fake.close).not.toHaveBeenCalled();
  });

  it('routes declared file-access requests through the real approval store and denies protected or child requests', async () => {
    const { listApprovals } = await import('@/lib/approvals/store');
    const { resolveApproval } = await import('@/lib/approvals/resolution');
    const fake = fakeHost(repo, 'promptUnmatched', false);
    const backend = createMuseBackend({ stateRoot: () => join(root, 'state'), openHost: async () => fake.host }); backends.push(backend);
    const turn = backend.sendTurn(repo, 'task', () => {});
    await vi.waitFor(() => expect(fake.command.mock.calls.some(([method]) => method === 'turn/start')).toBe(true));
    const turnId = fake.command.mock.calls.find(([method]) => method === 'turn/start')?.[2]?.commandId;
    const request = { approvalId: 'file-a', turnId, currentRequirementId: { sourceIndex: 0 }, subject: { kind: 'fileAccess', path: '/fixture/document' },
      availableChoices: [{ choiceId: 'allow-once', decision: 'approved', scope: 'once' }, { choiceId: 'deny', decision: 'denied', scope: 'once' }] };
    fake.emit('approval/requested', request);
    const approval = listApprovals({ status: 'pending' }).find(value => value.runtime === 'muse');
    expect(approval).toBeDefined(); resolveApproval(approval!.id, 'approve', 'test');
    await vi.waitFor(() => expect(fake.command).toHaveBeenCalledWith('approval/decide', expect.objectContaining({ choiceId: 'allow-once' })));
    fake.emit('approval/requested', { ...request, approvalId: 'protected', protectedWrite: true });
    fake.emit('approval/requested', { ...request, approvalId: 'child', subagentOrigin: { sessionId: 'child' } });
    await vi.waitFor(() => expect(fake.command.mock.calls.filter(([method, params]) => method === 'approval/decide' && params.choiceId === 'deny')).toHaveLength(2));
    expect(listApprovals({ status: 'pending' }).filter(value => value.runtime === 'muse')).toHaveLength(0);
    fake.emit('turn/completed', { turnId, terminal: 'completed' }); await turn;
  });
});
