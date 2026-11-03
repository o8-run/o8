import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComposerQueuePayload } from '@/lib/orchestrator/composer-queue-types';

vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'o8-composer-queue-')));
const repo = join(fixture, 'repo'); mkdirSync(repo);
vi.stubEnv('O8_DATA_DIR', fixture); vi.stubEnv('CORTEX_IDE_DATA_DIR', fixture);
vi.stubEnv('CORTEX_IDE_DB_PATH', join(fixture, 'queue.db'));
mkdirSync(join(fixture, 'chat-history'), { recursive: true });
for (const thread of ['thoughts-first', 'thoughts-second']) writeFileSync(join(fixture, 'chat-history', `${thread}.json`), JSON.stringify({ repoPath: repo, backend: 'codex', messages: [{ id: 'assistant', role: 'assistant', content: 'Working', timestamp: 1 }] }));
const { getSqlite, closeDb } = await import('@/lib/db');
const { ensureV71ComposerQueueSchema } = await import('@/lib/db/v71-composer-queue-migration');
ensureV71ComposerQueueSchema(getSqlite());
const queue = await import('@/lib/orchestrator/composer-queue');
const { GET, POST, PATCH, DELETE } = await import('@/app/api/orchestrator/composer-queue/route');
const target = { repoPath: repo, threadId: 'thoughts-first' };
const payload: ComposerQueuePayload = { text: 'First message', wireMessage: 'Original mode directive\n\nFirst message',
  images: [{ name: 'proof.png', dataUri: 'data:image/png;base64,YQ==' }], routing: {
    backend: 'codex', model: 'model-at-enqueue', effort: 'low', serviceTier: 'priority', permissionMode: 'plan', mode: 'single', pickedMode: 'solo', collide: false, projectId: 'project-at-enqueue',
  } };
function request(method: string, body?: unknown, host = 'localhost') {
  return new NextRequest(`http://${host}/api/orchestrator/composer-queue`, { method, headers: { host, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function enqueue(id: string, update: Partial<ComposerQueuePayload> = {}) {
  const response = await POST(request('POST', { ...target, id, intent: 'send-next', payload: { ...payload, ...update } }));
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
  return (await response.json()).item;
}
beforeEach(() => {
  getSqlite().exec('DELETE FROM composer_send_queue');
  writeFileSync(join(fixture, 'chat-history', `${target.threadId}.json`), JSON.stringify({ repoPath: repo, backend: 'pi', messages: [{ id: 'assistant', role: 'assistant', content: 'Working', timestamp: 1 }] }));
});
afterAll(() => { closeDb(); vi.unstubAllEnvs(); rmSync(fixture, { recursive: true, force: true }); });

describe('durable composer queue API and persisted state', () => {
  it('converts one queued message into a steer without changing its identity or saved routing', async () => {
    const first = await enqueue('queue-promote');
    const response = await PATCH(request('PATCH', { ...target, id: first.id }));
    expect(response.status).toBe(200);
    const item = (await response.json()).item;
    expect(item).toMatchObject({ id: first.id, sequence: first.sequence, intent: 'steer-now', payload: first.payload });
    closeDb(); ensureV71ComposerQueueSchema(getSqlite());
    expect(queue.readComposerSend(first.id)?.intent).toBe('steer-now');
    expect(queue.listQueuedComposerSends(target)).toHaveLength(1);
  });
  it('keeps a promoted intent out of the normal claim when promotion races a heartbeat scan', async () => {
    const item = await enqueue('queue-claim-race');
    expect(queue.listQueuedComposerSends(target)[0].intent).toBe('send-next');
    expect((await PATCH(request('PATCH', { ...target, id: item.id }))).status).toBe(200);
    expect(queue.claimNextComposerSend(target)).toBeNull();
    expect(queue.claimComposerSteer(item.id)).toMatchObject({ intent: 'steer-now', admittedAt: null });
  });

  it.each([true, false, 'unknown'] as const)('requires a native acknowledgement before reporting a steer delivered: %s', async outcome => {
    const { getOrchestratorBackend } = await import('@/lib/lane/orchestrator-backends/registry');
    const backend = getOrchestratorBackend('pi');
    const native = vi.spyOn(backend, 'liveSteer').mockImplementation(async (_repo, _message, options) => {
      options.beforeAdmit();
      if (outcome === 'unknown') throw new Error('Acknowledgement timed out.');
      return { accepted: outcome };
    });
    const routing = { ...payload.routing, backend: 'pi' as const, model: 'pi', projectId: undefined };
    const response = await POST(request('POST', { ...target, id: 'queue-native-steer', intent: 'steer-now', payload: { ...payload, images: [], routing } }));
    expect(response.status).toBe(200);
    const { createComposerQueueHeartbeat } = await import('@/lib/ws-server/composer-queue-heartbeat');
    const heartbeat = createComposerQueueHeartbeat({ isBusy: () => true, readTranscript: async () => [], publish: () => {}, registerAbort: () => () => {} });
    try {
      heartbeat();
      await vi.waitFor(() => expect(queue.readComposerSend('queue-native-steer')?.status).toBe(outcome === true ? 'applied' : outcome === false ? 'queued' : 'held'));
      const item = queue.readComposerSend('queue-native-steer')!;
      expect(native).toHaveBeenCalledOnce();
      expect(item.payload.routing).toEqual(routing);
      expect(item.admittedAt === null).toBe(outcome === false);
      if (outcome === true) {
        const history = (await import('@/lib/llm/chat-history-store')).readPersistedLlmChat(target.threadId)!;
        expect(history.history.messages).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'composer-steer-queue-native-steer', role: 'user', content: payload.text })]));
      } else expect(item.reason).toContain(outcome === false ? 'Steer declined' : 'Steer unconfirmed');
      heartbeat(); await Promise.resolve(); expect(native).toHaveBeenCalledOnce();
    } finally { native.mockRestore(); }
  });

  it.each([false, true])('fences live preparation when permissions narrow or Stop arrives: %s', async stop => {
    const backend = (await import('@/lib/lane/orchestrator-backends/registry')).getOrchestratorBackend('pi');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const native = vi.spyOn(backend, 'liveSteer').mockImplementation(async (_repo, _message, options) => {
      await gate; options.beforeAdmit(); return { accepted: true };
    });
    try {
      const id = stop ? 'queue-stop-steer' : 'queue-narrow-steer';
      const routing = { ...payload.routing, backend: 'pi' as const, model: 'pi', permissionMode: 'full' as const, projectId: undefined };
      await POST(request('POST', { ...target, id, intent: 'steer-now', payload: { ...payload, images: [], routing } }));
      const { runQueuedComposerSteer } = await import('@/lib/ws-server/composer-queue-heartbeat');
      const running = runQueuedComposerSteer(queue.claimComposerSteer(id)!);
      if (stop) queue.holdComposerSends(target);
      else writeFileSync(join(fixture, 'chat-history', `${target.threadId}.json`), JSON.stringify({ repoPath: repo, backend: 'pi', messages: [{ id: 'narrowed', role: 'assistant', content: 'Plan only', timestamp: Date.now() + 1, receipt: { permissionMode: 'plan' } }] }));
      release(); await expect(running).rejects.toThrow(stop ? 'cancelled or held' : 'more restrictive');
      expect(queue.readComposerSend(id)?.admittedAt).toBeNull();
    } finally { native.mockRestore(); }
  });

  it('preserves an explicitly queued outside grant across database reopen and refuses a later downgrade', async () => {
    const routing = { ...payload.routing, backend: 'pi' as const, model: 'pi', permissionMode: 'outside-workspace' as const,
      projectId: undefined };
    const item = await enqueue('queue-outside', { images: [], routing });
    closeDb(); ensureV71ComposerQueueSchema(getSqlite());
    expect(queue.readComposerSend(item.id)?.payload.routing.permissionMode).toBe('outside-workspace');
    writeFileSync(join(fixture, 'chat-history', `${target.threadId}.json`), JSON.stringify({ repoPath: repo, backend: 'pi',
      messages: [{ id: 'later-turn', role: 'assistant', content: 'Workspace only.', timestamp: item.createdAt + 1,
        backend: 'pi', receipt: { leadModel: 'pi', effort: 'low', mode: 'solo', permissionMode: 'full' } }] }));
    const claimed = queue.claimNextComposerSend(target)!;
    const { runQueuedComposerSend } = await import('@/lib/ws-server/composer-queue-heartbeat');
    const publish = vi.fn();
    await expect(runQueuedComposerSend(claimed, { publish, registerAbort: () => () => {} }))
      .rejects.toThrow('permissions became more restrictive');
    expect(publish).not.toHaveBeenCalled();
    expect(queue.readComposerSend(item.id)?.admittedAt).toBeNull();
    writeFileSync(join(fixture, 'chat-history', `${target.threadId}.json`), JSON.stringify({ repoPath: repo, backend: 'codex',
      messages: [{ id: 'assistant', role: 'assistant', content: 'Working', timestamp: 1 }] }));
  });

  it.each(['codex', 'collide'])('refuses an outside grant queued for %s before persistence', async backend => {
    const response = await POST(request('POST', { ...target, id: `queue-outside-${backend}`, intent: 'send-next',
      payload: { ...payload, images: [], routing: { ...payload.routing, backend, permissionMode: 'outside-workspace' } } }));
    expect(response.status).toBe(400);
    expect(queue.listQueuedComposerSends(target)).toEqual([]);
  });

  it('preserves FIFO, exact destination, images and routing after reopening the database', async () => {
    const first = await enqueue('queue-first');
    const second = await enqueue('queue-second', { text: 'Second message' });
    await POST(request('POST', { ...target, threadId: 'thoughts-second', id: 'queue-other', intent: 'send-next', payload }));
    closeDb(); ensureV71ComposerQueueSchema(getSqlite());
    const response = await GET(new NextRequest(`http://localhost/api/orchestrator/composer-queue?repoPath=${encodeURIComponent(repo)}&threadId=thoughts-first`, { headers: { host: 'localhost' } }));
    expect(response.status).toBe(200);
    const items = (await response.json()).items;
    expect(items.map((item: { id: string }) => item.id)).toEqual([first.id, second.id]);
    expect(items[0]).toMatchObject({ ...target, payload, status: 'queued', admittedAt: null });
    expect(queue.listComposerQueueTargets()).toEqual([target, { ...target, threadId: 'thoughts-second' }]);
    expect(queue.claimNextComposerSend(target)?.id).toBe(first.id);
    expect(queue.claimNextComposerSend(target)).toBeNull();
    expect(queue.settleComposerSend(first.id, { status: 'applied' })).toBe(false);
    expect(queue.admitComposerSend(first.id)).toBe(true);
    expect(queue.settleComposerSend(first.id, { status: 'applied' })).toBe(true);
    expect(queue.claimNextComposerSend(target)?.id).toBe(second.id);
  });

  it('rejects mismatched targets and retains unsupported steering as the same queued message', async () => {
    const denied = await POST(request('POST', { ...target, id: 'queue-forbidden', intent: 'send-next', payload }, 'remote.invalid'));
    expect(denied.status).toBe(401);
    const otherRepo = join(fixture, 'other-repo'); mkdirSync(otherRepo, { recursive: true });
    expect((await POST(request('POST', { ...target, repoPath: otherRepo, id: 'queue-wrong-repo', intent: 'send-next', payload }))).status).toBe(400);
    const steerPayload = { ...payload, images: [], routing: { ...payload.routing, backend: 'pi' as const, model: 'pi', projectId: undefined } };
    const backend = (await import('@/lib/lane/orchestrator-backends/registry')).getOrchestratorBackend('pi');
    const steer = await POST(request('POST', { ...target, id: 'queue-steer', intent: 'steer-now', payload: steerPayload }));
    expect(steer.status).toBe(200);
    const original = backend.liveSteer; Object.defineProperty(backend, 'liveSteer', { value: undefined, configurable: true });
    try {
      const { runQueuedComposerSteer } = await import('@/lib/ws-server/composer-queue-heartbeat');
      await runQueuedComposerSteer(queue.claimComposerSteer('queue-steer')!);
      expect(queue.readComposerSend('queue-steer')).toMatchObject({ intent: 'send-next', status: 'queued', admittedAt: null, payload: JSON.parse(JSON.stringify(steerPayload)) });
      expect(queue.claimNextComposerSend(target)?.id).toBe('queue-steer');
    } finally { Object.defineProperty(backend, 'liveSteer', { value: original, configurable: true }); }
  });

  it('keeps an explicit runtime handoff on the saved routing and refuses an unknown mode', async () => {
    const routing = { ...payload.routing, handoffMode: 'handoff' as const };
    const accepted = await POST(request('POST', { ...target, id: 'queue-handoff', intent: 'send-next', payload: { ...payload, routing } }));
    expect(accepted.status).toBe(200);
    expect(queue.readComposerSend('queue-handoff')?.payload.routing.handoffMode).toBe('handoff');
    expect((await POST(request('POST', { ...target, id: 'queue-bad-handoff', intent: 'send-next', payload: { ...payload, routing: { ...routing, handoffMode: 'silent' } } }))).status).toBe(400);
  });

  it('deduplicates exact retries and refuses changing an accepted payload or its attachments', async () => {
    const first = await enqueue('queue-idempotent');
    expect((await enqueue('queue-idempotent')).sequence).toBe(first.sequence);
    expect(queue.listQueuedComposerSends(target)).toHaveLength(1);
    expect((await POST(request('POST', { ...target, id: first.id, intent: 'send-next', payload: { ...payload, text: 'Changed' } }))).status).toBe(400);
    expect((await POST(request('POST', { ...target, id: 'queue-bad-image', intent: 'send-next', payload: { ...payload, images: [{ name: 'bad', dataUri: 'invalid' }] } }))).status).toBe(400);
    expect((await POST(request('POST', { ...target, id: 'queue-bad-tier', intent: 'send-next', payload: { ...payload, routing: { ...payload.routing, serviceTier: 'unrecognized-tier' } } }))).status).toBe(400);
    expect(queue.readComposerSend(first.id)?.payload).toEqual(payload);
    expect(queue.listQueuedComposerSends(target)).toHaveLength(1);
  });

  it('cancels queued and prepared items, fences provider admission, and refuses a false cancellation after admission', async () => {
    const first = await enqueue('queue-cancel');
    await enqueue('queue-preparing');
    expect((await DELETE(request('DELETE', { ...target, id: first.id }))).status).toBe(200);
    expect(queue.claimNextComposerSend(target)?.id).toBe('queue-preparing');
    expect((await DELETE(request('DELETE', { ...target, id: 'queue-preparing' }))).status).toBe(200);
    expect(() => queue.assertComposerSendClaim('queue-preparing')).toThrow('cancelled or held');
    expect(queue.admitComposerSend('queue-preparing')).toBe(false);
    const admitted = await enqueue('queue-admitted'); queue.claimNextComposerSend(target);
    expect(queue.admitComposerSend(admitted.id)).toBe(true);
    expect((await DELETE(request('DELETE', { ...target, id: admitted.id }))).status).toBe(409);
    expect(queue.readComposerSend(admitted.id)?.status).toBe('dispatching');
  });

  it('holds interrupted execution on recovery and prevents a stopped claim from starting a provider turn', async () => {
    await enqueue('queue-interrupted'); await enqueue('queue-behind');
    queue.claimNextComposerSend(target); queue.admitComposerSend('queue-interrupted');
    queue.recoverComposerSends();
    expect(queue.readComposerSend('queue-interrupted')).toMatchObject({ status: 'held', reason: expect.stringContaining('interrupted') });
    expect(queue.claimNextComposerSend(target)).toBeNull();
    await DELETE(request('DELETE', { ...target, id: 'queue-interrupted' }));
    expect(queue.claimNextComposerSend(target)?.id).toBe('queue-behind');
    queue.holdComposerSends(target);
    expect(() => queue.assertComposerSendClaim('queue-behind')).toThrow();
    expect(queue.admitComposerSend('queue-behind')).toBe(false);
    expect(queue.settleComposerSend('queue-behind', { status: 'applied' })).toBe(false);
  });

  it('settles the turn Stop ended, so a message sent after Stop runs (#5193)', async () => {
    await enqueue('queue-running'); queue.claimNextComposerSend(target);
    expect(queue.admitComposerSend('queue-running')).toBe(true);
    await enqueue('queue-waiting');
    queue.holdComposerSends(target);
    expect(queue.readComposerSend('queue-running')).toMatchObject({ status: 'applied' });
    expect(queue.readComposerSend('queue-waiting')).toMatchObject({ status: 'held', reason: 'Chat stopped.' });
    await DELETE(request('DELETE', { ...target, id: 'queue-waiting' }));
    await enqueue('queue-after-stop');
    expect(queue.claimNextComposerSend(target)?.id).toBe('queue-after-stop');
  });
});
