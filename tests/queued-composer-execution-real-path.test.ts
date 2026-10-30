import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import type { OrchestratorBackend, OrchestratorTurnOptions } from '@/lib/lane/orchestrator-backends/types';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import type { ComposerQueuePayload } from '@/lib/orchestrator/composer-queue-types';
import { voiceFollowupReceipt, voiceFollowupRemovalReceipt } from '@/components/desktop/thoughts/chat-panel/managed-voice-followup';

const mocks = vi.hoisted(() => ({ beforeProject: null as (() => Promise<void>) | null,
  send: vi.fn(async (_repo: string, _message: string, emit: (event: OrchestratorEvent) => void, options: OrchestratorTurnOptions) => {
    emit({ type: 'turn_receipt', leadModel: options.model!, effort: options.thinkingEffort! });
    emit({ type: 'text', text: 'Queued answer.' });
    emit({ type: 'done', sessionId: 'queue-provider-session', cost: null, terminalOutcome: 'completed' });
  }) }));
vi.mock('@/lib/lane/orchestrator-backends/registry', () => ({ getOrchestratorBackend: (id: OrchestratorBackend['id']) => ({
  id, label: id, ensureSession: () => ({ sessionName: 'queued-session', status: 'ready' }),
  peekSession: () => ({ sessionName: 'queued-session', status: 'ready' }), sendTurn: mocks.send,
}) }));
vi.mock('@/lib/ws-server/orchestrator-project-context', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/ws-server/orchestrator-project-context')>();
  return { ...actual, prepareOrchestratorProjectTurn: async (input: Parameters<typeof actual.prepareOrchestratorProjectTurn>[0]) => {
    await mocks.beforeProject?.(); return actual.prepareOrchestratorProjectTurn(input);
  } };
});
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => true) }));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-queue-exec-')));
const repo = join(root, 'repo'); mkdirSync(repo); mkdirSync(join(root, 'chat-history'));
vi.stubEnv('O8_DATA_DIR', root); vi.stubEnv('CORTEX_IDE_DATA_DIR', root); vi.stubEnv('CORTEX_IDE_DB_PATH', join(root, 'queue.db'));
const threadId = 'thoughts-queued-execution'; const target = { repoPath: repo, threadId };
const historyPath = join(root, 'chat-history', `${threadId}.json`);
const { getSqlite, closeDb } = await import('@/lib/db');
const queue = await import('@/lib/orchestrator/composer-queue');
const { POST, DELETE } = await import('@/app/api/orchestrator/composer-queue/route');
const { createChatContinuationHeartbeat } = await import('@/lib/ws-server/composer-queue-heartbeat');
const { withImmediateComposerSend, orchestratorContinuationAbortKey } = await import('@/lib/ws-server/composer-send-admission');
const { readPersistedLlmChat } = await import('@/lib/llm/chat-history-store');
const active = new Map<string, AbortController>(); let busy = false;
const hooks = { readTranscript: async () => [], isBusy: () => busy || active.size > 0,
  registerAbort: (_repo: string, origin: { threadId: string }, controller: AbortController) => {
    if (active.has(origin.threadId)) throw new Error('Already working');
    active.set(origin.threadId, controller); return () => { active.delete(origin.threadId); };
  }, publish: vi.fn() };
const base: ComposerQueuePayload = { text: 'Visible operator words', wireMessage: 'Private context\n\nVisible operator words',
  images: [{ name: 'proof.png', dataUri: 'data:image/png;base64,YQ==' }], routing: {
    backend: 'codex', model: 'selected-model', effort: 'low', serviceTier: 'priority', permissionMode: 'plan',
    mode: 'single', pickedMode: 'solo', collide: false,
  } };
async function enqueue(id: string, payload = base) {
  const response = await POST(new NextRequest('http://localhost/api/orchestrator/composer-queue', {
    method: 'POST', headers: { host: 'localhost' }, body: JSON.stringify({ ...target, id, intent: 'send-next', payload }),
  }));
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
}
beforeEach(() => {
  getSqlite().exec('DELETE FROM composer_send_queue'); mocks.send.mockClear(); mocks.beforeProject = null; busy = false;
  writeFileSync(historyPath, JSON.stringify({ repoPath: repo, backend: 'codex', messages: [] }));
});
afterAll(() => { closeDb(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
it('drains API-saved messages FIFO without a mounted composer, retains exact routing/images and never replays', async () => {
  await enqueue('queue-first'); await enqueue('queue-second', { ...base, text: 'Second words', wireMessage: 'Second payload' });
  closeDb(); const heartbeat = createChatContinuationHeartbeat(hooks); busy = true; heartbeat();
  await new Promise(resolve => setTimeout(resolve, 30)); expect(mocks.send).not.toHaveBeenCalled();
  busy = false; heartbeat();
  await vi.waitFor(() => expect(queue.readComposerSend('queue-first')?.status).toBe('applied'));
  expect(queue.readComposerSend('queue-second')?.status).toBe('queued');
  expect(mocks.send.mock.calls[0][3]).toMatchObject({ threadId, model: 'selected-model', thinkingEffort: 'low',
    permissionMode: 'plan', orchestrationMode: 'single', serviceTier: 'priority', attachments: base.images });
  const history = readPersistedLlmChat(threadId)!.history;
  expect(history.messages.find(row => row.role === 'user')?.content).toBe(base.text);
  expect(history.messages.find(row => row.role === 'user')?.media).toHaveLength(1);
  expect(hooks.publish).toHaveBeenCalledWith(threadId, 'queued-session', 'turn-start', expect.objectContaining({
    userMessageId: 'review-user-assistant-queued-queue-first', assistantMessageId: 'assistant-queued-queue-first', message: base.text,
  }));
  expect(mocks.send.mock.calls[0][1]).toContain('Private context');
  heartbeat(); await vi.waitFor(() => expect(queue.readComposerSend('queue-second')?.status).toBe('applied'));
  closeDb(); createChatContinuationHeartbeat(hooks)(); await new Promise(resolve => setTimeout(resolve, 30));
  expect(mocks.send).toHaveBeenCalledTimes(2);
});
it('Stop during asynchronous preparation holds the message before a provider sees it', async () => {
  let release!: () => void; let entered = false;
  mocks.beforeProject = async () => { entered = true; await new Promise<void>(resolve => { release = resolve; }); };
  await enqueue('queue-stopped'); const heartbeat = createChatContinuationHeartbeat(hooks); heartbeat();
  await vi.waitFor(() => expect(entered).toBe(true));
  queue.holdComposerSends(target); release();
  await vi.waitFor(() => expect(active.size).toBe(0));
  expect(queue.readComposerSend('queue-stopped')).toMatchObject({ status: 'held', admittedAt: null });
  expect(mocks.send).not.toHaveBeenCalled(); expect(readPersistedLlmChat(threadId)?.history.messages).toEqual([]);
});
it('does not let a stale window overtake the queue or a heartbeat overtake an accepted preparing send', async () => {
  await enqueue('queue-existing'); const direct = vi.fn(async () => {});
  await expect(withImmediateComposerSend(target, direct)).rejects.toThrow('saved messages'); expect(direct).not.toHaveBeenCalled();
  queue.cancelComposerSend(target, 'queue-existing');
  let release!: () => void;
  const sending = withImmediateComposerSend(target, () => new Promise<void>(resolve => { release = resolve; }));
  await enqueue('queue-after-direct'); const heartbeat = createChatContinuationHeartbeat(hooks); heartbeat();
  await new Promise(resolve => setTimeout(resolve, 30)); expect(mocks.send).not.toHaveBeenCalled();
  release(); await sending; heartbeat(); await vi.waitFor(() => expect(queue.readComposerSend('queue-after-direct')?.status).toBe('applied'));
});
it('uses captured Collide routing', async () => {
  await enqueue('queue-collide', { ...base, routing: { ...base.routing, collide: true, mode: 'fleet', pickedMode: 'moa' } });
  const heartbeat = createChatContinuationHeartbeat(hooks); heartbeat();
  await vi.waitFor(() => expect(queue.readComposerSend('queue-collide')?.status).toBe('applied'));
  expect(mocks.send.mock.calls[0][3]).toMatchObject({ collideBaseBackend: 'codex', orchestrationMode: 'fleet' });
  expect(readPersistedLlmChat(threadId)!.history.messages.at(-1)).toMatchObject({ backend: 'collide', receipt: { mode: 'moa' } });
});
it('canonicalizes equivalent repository paths for FIFO, Stop and cancellation', async () => {
  const alias = join(root, 'repo-alias'); symlinkSync(repo, alias);
  const response = await POST(new NextRequest('http://localhost/api/orchestrator/composer-queue', {
    method: 'POST', headers: { host: 'localhost' }, body: JSON.stringify({ ...target, repoPath: alias,
      id: 'queue-aliased', intent: 'send-next', payload: base }),
  }));
  expect(response.status).toBe(200);
  expect(queue.readComposerSend('queue-aliased')?.repoPath).toBe(repo);
  expect(queue.listQueuedComposerSends({ ...target, repoPath: `${repo}/` })).toHaveLength(1);
  await expect(withImmediateComposerSend(target, async () => {})).rejects.toThrow('saved messages');
  queue.holdComposerSends({ ...target, repoPath: alias });
  expect(queue.readComposerSend('queue-aliased')?.status).toBe('held');
  expect(queue.cancelComposerSend(target, 'queue-aliased')).toBe(true);
});

it('holds an unavailable checkout without blocking a healthy chat or preventing cancellation', async () => {
  const missing = join(root, 'temporary-repo'); mkdirSync(missing);
  const offline = { repoPath: missing, threadId: 'thoughts-offline' };
  writeFileSync(join(root, 'chat-history', 'thoughts-offline.json'), JSON.stringify({ repoPath: missing, messages: [] }));
  queue.enqueueComposerSend({ ...offline, id: 'queue-offline', intent: 'send-next', payload: base });
  rmSync(missing, { recursive: true });
  await enqueue('queue-healthy'); const heartbeat = createChatContinuationHeartbeat(hooks); heartbeat();
  await vi.waitFor(() => expect(queue.readComposerSend('queue-healthy')?.status).toBe('applied'));
  expect(queue.readComposerSend('queue-offline')?.status).toBe('held');
  expect(queue.cancelComposerSend(offline, 'queue-offline')).toBe(true);
});
it('holds an asynchronous provider error without throwing out of its process event callback', async () => {
  mocks.send.mockImplementationOnce(async (_repo, _message, emit) => new Promise<void>(resolve => {
    setImmediate(() => {
      emit({ type: 'error', error: 'Provider process exited.' });
      emit({ type: 'done', sessionId: null, cost: null }); resolve();
    });
  }));
  await enqueue('queue-provider-error'); createChatContinuationHeartbeat(hooks)();
  await vi.waitFor(() => expect(queue.readComposerSend('queue-provider-error')?.status).toBe('held'));
  expect(queue.readComposerSend('queue-provider-error')?.reason).toContain('Provider process exited');
  expect(active.size).toBe(0);
});
it('routes Stop from a symlink-backed chat to the admitted queued provider controller', async () => {
  const alias = join(root, 'stop-alias'); symlinkSync(repo, alias);
  writeFileSync(historyPath, JSON.stringify({ repoPath: alias, backend: 'codex', messages: [] }));
  const controllers = new Map<string, AbortController>();
  mocks.send.mockImplementationOnce(async (_repo, _message, emit, options) => new Promise<void>(resolve => {
    options.signal!.addEventListener('abort', () => { emit({ type: 'done', sessionId: null, cost: null }); resolve(); }, { once: true });
  }));
  await enqueue('queue-alias-stop');
  createChatContinuationHeartbeat({ ...hooks, registerAbort: (path, origin, controller) => {
    const key = orchestratorContinuationAbortKey(path, origin.backend, '', origin.threadId);
    controllers.set(key, controller); return () => { controllers.delete(key); };
  } })();
  await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
  expect(mocks.send.mock.calls[0][0]).toBe(alias);
  const controller = controllers.get(orchestratorContinuationAbortKey(alias, 'codex', '', threadId));
  expect(controller).toBeDefined();
  queue.holdComposerSends({ ...target, repoPath: alias }); controller!.abort();
  await vi.waitFor(() => expect(controllers.size).toBe(0));
  expect(queue.readComposerSend('queue-alias-stop')?.status).toBe('held');
});

const boundFollowup = (): ComposerQueuePayload => ({ ...base, afterTaskId: 'orch-user-original',
  routing: { ...base.routing, pinBackend: true } });
function originalTask(outcome?: 'completed' | 'failed' | 'unconfirmed', userId = 'orch-user-original', model = base.routing.model) {
  writeFileSync(historyPath, JSON.stringify({ repoPath: repo, backend: 'codex', model, messages: [
    { id: userId, role: 'user', content: 'Original request', timestamp: 1 },
    { id: 'original-assistant', role: 'assistant', content: 'Partial or final answer', timestamp: 2, backend: 'codex', model,
      receipt: { leadModel: model, effort: 'low', mode: 'solo', permissionMode: 'plan',
        ...(outcome ? { terminal: { userMessageId: userId, outcome } } : {}) } },
  ] }));
}
it('persists the exact-task voice precondition through the route and reload, then drains once with a correlated receipt', async () => {
  originalTask('completed'); await enqueue('voice-original', boundFollowup()); closeDb();
  expect(queue.readComposerSend('voice-original')?.payload).toMatchObject({ afterTaskId: 'orch-user-original', routing: { pinBackend: true } });
  createChatContinuationHeartbeat(hooks)();
  await vi.waitFor(() => expect(queue.readComposerSend('voice-original')?.status).toBe('applied'));
  const receipt = readPersistedLlmChat(threadId)!.history.messages.at(-1)?.receipt;
  expect(receipt?.terminal).toEqual({ userMessageId: 'review-user-assistant-queued-voice-original', outcome: 'completed', completedAt: expect.any(Number) });
  closeDb(); createChatContinuationHeartbeat(hooks)();
  expect(mocks.send).toHaveBeenCalledTimes(1);
});
it.each([undefined, 'unconfirmed'] as const)('holds a voice follow-up with %s completion even when the UI reports idle', async outcome => {
  originalTask(outcome); await enqueue('voice-unknown', boundFollowup()); createChatContinuationHeartbeat(hooks)();
  await vi.waitFor(() => expect(queue.readComposerSend('voice-unknown')?.status).toBe('held'));
  expect(mocks.send).not.toHaveBeenCalled();
  originalTask('completed'); createChatContinuationHeartbeat(hooks)();
  expect(mocks.send).not.toHaveBeenCalled(); // Held intent requires explicit recovery, not a late automatic replay.
});
it('does not borrow a newer task result or silently follow a changed model', async () => {
  originalTask('completed', 'orch-user-newer'); await enqueue('voice-stale-task', boundFollowup()); createChatContinuationHeartbeat(hooks)();
  await vi.waitFor(() => expect(queue.readComposerSend('voice-stale-task')?.status).toBe('held'));
  queue.cancelComposerSend(target, 'voice-stale-task');
  originalTask('completed', 'orch-user-original', 'another-model'); await enqueue('voice-stale-model', boundFollowup()); createChatContinuationHeartbeat(hooks)();
  await vi.waitFor(() => expect(queue.readComposerSend('voice-stale-model')?.status).toBe('held'));
  expect(mocks.send).not.toHaveBeenCalled();
});
it('rechecks the original task after asynchronous preparation, before provider admission', async () => {
  originalTask('completed'); mocks.beforeProject = async () => { originalTask('completed', 'orch-user-replacement'); };
  await enqueue('voice-replaced', boundFollowup()); createChatContinuationHeartbeat(hooks)();
  await vi.waitFor(() => expect(queue.readComposerSend('voice-replaced')?.status).toBe('held'));
  expect(queue.readComposerSend('voice-replaced')?.admittedAt).toBeNull();
  expect(mocks.send).not.toHaveBeenCalled();
});
it('rejects an unfenced task binding and refuses implicit managed-model normalization', async () => {
  const response = await POST(new NextRequest('http://localhost/api/orchestrator/composer-queue', {
    method: 'POST', headers: { host: 'localhost' }, body: JSON.stringify({ ...target, id: 'voice-unpinned', intent: 'send-next',
      payload: { ...base, afterTaskId: 'orch-user-original' } }),
  }));
  expect(response.status).toBe(400); expect(queue.readComposerSend('voice-unpinned')).toBeNull();
  originalTask('completed'); await enqueue('voice-normalized', { ...boundFollowup(), images: [], routing: { ...base.routing, backend: 'o8', pinBackend: true } });
  createChatContinuationHeartbeat(hooks)();
  await vi.waitFor(() => expect(queue.readComposerSend('voice-normalized')?.status).toBe('held'));
  expect(mocks.send).not.toHaveBeenCalled();
});

it.each(['canonical', 'optimistic', 'replaced'])('binds a persisted lead follow-up to the exact task through admission: %s', async form => {
  execFileSync('git', ['init', '-q', repo]);
  const leadRoute = await import('@/app/api/orchestrator/lead/route');
  const leads = await import('@/lib/orchestrator/lead-lifecycle');
  const report = async (body: Record<string, unknown>) => leadRoute.POST(new NextRequest('http://localhost/api/orchestrator/lead', {
    method: 'POST', headers: { host: 'localhost' }, body: JSON.stringify(body),
  }));
  mocks.send.mockImplementation(async (_repo, _message, emit, options) => {
    const lead = leads.findLeadThreadBinding(options.threadId!)!;
    const status = leads.getLeadStatus(lead.id);
    const result = await report({ action: 'report', leadId: lead.id, turnId: status.latestTurn!.id,
      repoPath: repo, threadId: lead.thread_id, kind: 'completed', summary: 'Fixture completed', evidence: ['Deterministic fixture receipt'] });
    expect(result.status).toBe(200);
    emit({ type: 'text', text: 'Finished fixture' });
    emit({ type: 'done', sessionId: 'lead-fixture', cost: null, terminalOutcome: 'completed' });
  });
  const started = await report({ action: 'start', repoPath: repo, backend: 'codex', model: 'gpt-6.1-sol', effort: 'high',
    idempotencyKey: `voice-lead-${form}`, brief: { objective: 'Exercise the shared lead queue', scope: ['Fixture only'],
      doneTests: ['Persist a terminal receipt'], nonGoals: ['External calls'], budgets: ['No provider calls'], escalationCriteria: ['Unexpected routing'] } });
  expect(started.status, await started.clone().text()).toBe(202);
  const initial = await started.json(); const leadId = initial.lead.id; const leadThread = initial.lead.threadId;
  await vi.waitFor(() => expect(leads.getLeadStatus(leadId).latestTurn?.status).toBe('completed'));
  const sent = await leads.sendLeadThreadMessage({ threadId: leadThread, repoPath: repo, message: 'First chat task',
    backend: 'codex', model: 'gpt-6.1-sol', effort: 'high', idempotencyKey: 'ws:voice-parent' });
  await vi.waitFor(() => expect(leads.getLeadStatus(leadId).latestTurn?.status).toBe('completed'));
  const afterTaskId = form === 'canonical' ? `lead-user-${sent!.admittedTurnId}` : 'orch-user-voice-parent';
  const response = await POST(new NextRequest('http://localhost/api/orchestrator/composer-queue', {
    method: 'POST', headers: { host: 'localhost' }, body: JSON.stringify({ repoPath: repo, threadId: leadThread,
      id: `voice-lead-queue-${form}`, intent: 'send-next', payload: { ...base, images: [], afterTaskId,
        routing: { ...base.routing, model: 'gpt-6.1-sol', effort: 'high', pinBackend: true } } }),
  }));
  expect(response.status, await response.clone().text()).toBe(200);
  if (form === 'replaced') {
    await leads.sendLeadThreadMessage({ threadId: leadThread, repoPath: repo, message: 'Newer task',
      backend: 'codex', model: 'gpt-6.1-sol', effort: 'high', idempotencyKey: 'ws:newer-parent' });
    await vi.waitFor(() => expect(leads.getLeadStatus(leadId).latestTurn?.status).toBe('completed'));
  }
  const before = mocks.send.mock.calls.length;
  closeDb(); createChatContinuationHeartbeat(hooks)();
  await vi.waitFor(() => expect(queue.readComposerSend(`voice-lead-queue-${form}`)?.status).toBe(form === 'replaced' ? 'held' : 'applied'));
  if (form === 'replaced') expect(mocks.send).toHaveBeenCalledTimes(before);
  else {
    await vi.waitFor(() => expect(leads.getLeadStatus(leadId).latestTurn?.status).toBe('completed'));
    expect(mocks.send).toHaveBeenCalledTimes(before + 1);
    const terminal = readPersistedLlmChat(leadThread)!.history.messages.at(-1)?.receipt?.terminal;
    expect(terminal).toMatchObject({ outcome: 'completed' });
  }
});

it.each(['held', 'applied'] as const)('keeps voice status truthful when an uncertain save retries after backend admission: %s', async status => {
  const id = 'voice-receipt-retry'; const payload: ComposerQueuePayload = { ...base, afterTaskId: 'original-task', routing: { ...base.routing, pinBackend: true } };
  await enqueue(id, payload);
  expect(queue.claimNextComposerSend(target)?.id).toBe(id);
  expect(queue.admitComposerSend(id)).toBe(true);
  expect(queue.settleComposerSend(id, { status, reason: status === 'held' ? 'Uncertain delivery' : undefined })).toBe(true);
  const response = await POST(new NextRequest('http://localhost/api/orchestrator/composer-queue', {
    method: 'POST', headers: { host: 'localhost' }, body: JSON.stringify({ ...target, id, intent: 'send-next', payload }),
  }));
  const receipt = (await response.json()).item;
  expect(receipt).toMatchObject({ id, status, admittedAt: expect.any(Number) });
  const spoken = voiceFollowupReceipt(receipt);
  expect(spoken).toContain('did not submit');
  expect(spoken).not.toMatch(/has not been submitted|canceled before submission/);
  if (status === 'held') {
    expect(spoken).toContain('may already have reached');
    const removed = await DELETE(new NextRequest('http://localhost/api/orchestrator/composer-queue', {
      method: 'DELETE', headers: { host: 'localhost' }, body: JSON.stringify({ ...target, id }),
    }));
    expect(removed.status).toBe(200);
    expect(queue.readComposerSend(id)).toMatchObject({ status: 'cancelled', admittedAt: expect.any(Number) });
    expect(voiceFollowupRemovalReceipt()).toContain('does not stop or undo work already submitted');
  } else expect(spoken).toContain('already accepted');
  expect(mocks.send).not.toHaveBeenCalled();
});
