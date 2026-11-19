import { installComposerOwnerFixture } from './fixtures/composer-queue-owner';
import { fixtureComposerClaim, fixtureComposerToken, recoverComposerOwner } from './fixtures/composer-queue-attempt';
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
    expect((await queue.readComposerSend(first.id))?.intent).toBe('steer-now');
    expect((await queue.listQueuedComposerSends(target))).toHaveLength(1);
  });
  it('keeps a promoted intent out of the normal claim when promotion races a heartbeat scan', async () => {
    const item = await enqueue('queue-claim-race');
    expect((await queue.listQueuedComposerSends(target))[0].intent).toBe('send-next');
    expect((await PATCH(request('PATCH', { ...target, id: item.id }))).status).toBe(200);
    expect((await fixtureComposerClaim(queue.claimNextComposerSend(target)))).toBeNull();
    expect((await fixtureComposerClaim(queue.claimComposerSteer(item.id)))).toMatchObject({ intent: 'steer-now', admittedAt: null });
  });

  it.each([true, false, 'unknown'] as const)('requires a native acknowledgement before reporting a steer delivered: %s', async outcome => {
    const { getOrchestratorBackend } = await import('@/lib/lane/orchestrator-backends/registry');
    const backend = getOrchestratorBackend('pi');
    const native = vi.spyOn(backend, 'liveSteer').mockImplementation(async (_repo, _message, options) => {
      await options.beforeAdmit();
      if (outcome === 'unknown') throw new Error('Acknowledgement timed out.');
      return { accepted: outcome };
    });
    const routing = { ...payload.routing, backend: 'pi' as const, model: 'pi', projectId: undefined };
    const response = await POST(request('POST', { ...target, id: 'queue-native-steer', intent: 'steer-now', payload: { ...payload, images: [], routing } }));
    expect(response.status).toBe(200);
    const { createComposerQueueHeartbeat } = await import('./fixtures/composer-queue-executor');
    const heartbeat = createComposerQueueHeartbeat({ isBusy: () => true, readTranscript: async () => [], publish: () => {}, registerAbort: () => () => {} });
    try {
      heartbeat();
      await vi.waitFor(async () => expect((await queue.readComposerSend('queue-native-steer'))?.status).toBe(outcome === true ? 'applied' : outcome === false ? 'queued' : 'held'));
      const item = (await queue.readComposerSend('queue-native-steer'))!;
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
      await gate; await options.beforeAdmit(); return { accepted: true };
    });
    try {
      const id = stop ? 'queue-stop-steer' : 'queue-narrow-steer';
      const routing = { ...payload.routing, backend: 'pi' as const, model: 'pi', permissionMode: 'full' as const, projectId: undefined };
      await POST(request('POST', { ...target, id, intent: 'steer-now', payload: { ...payload, images: [], routing } }));
      const { runQueuedComposerSteer } = await import('./fixtures/composer-queue-executor');
      const running = runQueuedComposerSteer((await fixtureComposerClaim(queue.claimComposerSteer(id)))!);
      if (stop) (await queue.holdComposerSends(target));
      else writeFileSync(join(fixture, 'chat-history', `${target.threadId}.json`), JSON.stringify({ repoPath: repo, backend: 'pi', messages: [{ id: 'narrowed', role: 'assistant', content: 'Plan only', timestamp: Date.now() + 1, receipt: { permissionMode: 'plan' } }] }));
      release(); await expect(running).rejects.toThrow(stop ? 'cancelled or held' : 'more restrictive');
      expect((await queue.readComposerSend(id))?.admittedAt).toBeNull();
    } finally { native.mockRestore(); }
  });

  it('preserves an explicitly queued outside grant across database reopen and refuses a later downgrade', async () => {
    const routing = { ...payload.routing, backend: 'pi' as const, model: 'pi', permissionMode: 'outside-workspace' as const,
      projectId: undefined };
    const item = await enqueue('queue-outside', { images: [], routing });
    closeDb(); ensureV71ComposerQueueSchema(getSqlite());
    expect((await queue.readComposerSend(item.id))?.payload.routing.permissionMode).toBe('outside-workspace');
    writeFileSync(join(fixture, 'chat-history', `${target.threadId}.json`), JSON.stringify({ repoPath: repo, backend: 'pi',
      messages: [{ id: 'later-turn', role: 'assistant', content: 'Workspace only.', timestamp: item.createdAt + 1,
        backend: 'pi', receipt: { leadModel: 'pi', effort: 'low', mode: 'solo', permissionMode: 'full' } }] }));
    const claimed = (await fixtureComposerClaim(queue.claimNextComposerSend(target)))!;
    const { runQueuedComposerSend } = await import('./fixtures/composer-queue-executor');
    const publish = vi.fn();
    await expect(runQueuedComposerSend(claimed, { publish, registerAbort: () => () => {} }))
      .rejects.toThrow('permissions became more restrictive');
    expect(publish).not.toHaveBeenCalled();
    expect((await queue.readComposerSend(item.id))?.admittedAt).toBeNull();
    writeFileSync(join(fixture, 'chat-history', `${target.threadId}.json`), JSON.stringify({ repoPath: repo, backend: 'codex',
      messages: [{ id: 'assistant', role: 'assistant', content: 'Working', timestamp: 1 }] }));
  });

  it.each(['codex', 'collide'])('refuses an outside grant queued for %s before persistence', async backend => {
    const response = await POST(request('POST', { ...target, id: `queue-outside-${backend}`, intent: 'send-next',
      payload: { ...payload, images: [], routing: { ...payload.routing, backend, permissionMode: 'outside-workspace' } } }));
    expect(response.status).toBe(400);
    expect((await queue.listQueuedComposerSends(target))).toEqual([]);
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
    expect((await queue.listComposerQueueTargets())).toEqual([target, { ...target, threadId: 'thoughts-second' }]);
    expect((await fixtureComposerClaim(queue.claimNextComposerSend(target)))?.id).toBe(first.id);
    expect((await fixtureComposerClaim(queue.claimNextComposerSend(target)))).toBeNull();
    expect((await queue.settleComposerSend(first.id, { status: 'applied' }, fixtureComposerToken(first.id)))).toBe(false);
    expect((await queue.admitComposerSend(first.id, fixtureComposerToken(first.id)))).toBe(true);
    expect((await queue.settleComposerSend(first.id, { status: 'applied' }, fixtureComposerToken(first.id)))).toBe(true);
    expect((await fixtureComposerClaim(queue.claimNextComposerSend(target)))?.id).toBe(second.id);
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
      const { runQueuedComposerSteer } = await import('./fixtures/composer-queue-executor');
      await runQueuedComposerSteer((await fixtureComposerClaim(queue.claimComposerSteer('queue-steer')))!);
      expect((await queue.readComposerSend('queue-steer'))).toMatchObject({ intent: 'send-next', status: 'queued', admittedAt: null, payload: JSON.parse(JSON.stringify(steerPayload)) });
      expect((await fixtureComposerClaim(queue.claimNextComposerSend(target)))?.id).toBe('queue-steer');
    } finally { Object.defineProperty(backend, 'liveSteer', { value: original, configurable: true }); }
  });

  it('keeps an explicit runtime handoff on the saved routing and refuses an unknown mode', async () => {
    const routing = { ...payload.routing, handoffMode: 'handoff' as const };
    const accepted = await POST(request('POST', { ...target, id: 'queue-handoff', intent: 'send-next', payload: { ...payload, routing } }));
    expect(accepted.status).toBe(200);
    expect((await queue.readComposerSend('queue-handoff'))?.payload.routing.handoffMode).toBe('handoff');
    expect((await POST(request('POST', { ...target, id: 'queue-bad-handoff', intent: 'send-next', payload: { ...payload, routing: { ...routing, handoffMode: 'silent' } } }))).status).toBe(400);
  });

  it('deduplicates exact retries and refuses changing an accepted payload or its attachments', async () => {
    const first = await enqueue('queue-idempotent');
    expect((await enqueue('queue-idempotent')).sequence).toBe(first.sequence);
    expect((await queue.listQueuedComposerSends(target))).toHaveLength(1);
    expect((await POST(request('POST', { ...target, id: first.id, intent: 'send-next', payload: { ...payload, text: 'Changed' } }))).status).toBe(400);
    expect((await POST(request('POST', { ...target, id: 'queue-bad-image', intent: 'send-next', payload: { ...payload, images: [{ name: 'bad', dataUri: 'invalid' }] } }))).status).toBe(400);
    expect((await POST(request('POST', { ...target, id: 'queue-bad-tier', intent: 'send-next', payload: { ...payload, routing: { ...payload.routing, serviceTier: 'unrecognized-tier' } } }))).status).toBe(400);
    expect((await queue.readComposerSend(first.id))?.payload).toEqual(payload);
    expect((await queue.listQueuedComposerSends(target))).toHaveLength(1);
  });

  it('cancels queued and prepared items, fences provider admission, and refuses a false cancellation after admission', async () => {
    const first = await enqueue('queue-cancel');
    await enqueue('queue-preparing');
    expect((await DELETE(request('DELETE', { ...target, id: first.id }))).status).toBe(200);
    expect((await fixtureComposerClaim(queue.claimNextComposerSend(target)))?.id).toBe('queue-preparing');
    expect((await DELETE(request('DELETE', { ...target, id: 'queue-preparing' }))).status).toBe(200);
    await expect(async () => (await queue.assertComposerSendClaim('queue-preparing', fixtureComposerToken('queue-preparing')))).rejects.toThrow('cancelled or held');
    expect((await queue.admitComposerSend('queue-preparing', fixtureComposerToken('queue-preparing')))).toBe(false);
    const admitted = await enqueue('queue-admitted'); (await fixtureComposerClaim(queue.claimNextComposerSend(target)));
    expect((await queue.admitComposerSend(admitted.id, fixtureComposerToken(admitted.id)))).toBe(true);
    expect((await DELETE(request('DELETE', { ...target, id: admitted.id }))).status).toBe(409);
    expect((await queue.readComposerSend(admitted.id))?.status).toBe('dispatching');
  });

  it('holds interrupted execution on recovery and prevents a stopped claim from starting a provider turn', async () => {
    await enqueue('queue-interrupted'); await enqueue('queue-behind');
    (await fixtureComposerClaim(queue.claimNextComposerSend(target))); (await queue.admitComposerSend('queue-interrupted', fixtureComposerToken('queue-interrupted')));
    (await recoverComposerOwner());
    expect((await queue.readComposerSend('queue-interrupted'))).toMatchObject({ status: 'held', reason: expect.stringContaining('interrupted') });
    expect((await fixtureComposerClaim(queue.claimNextComposerSend(target)))).toBeNull();
    await DELETE(request('DELETE', { ...target, id: 'queue-interrupted' }));
    expect((await fixtureComposerClaim(queue.claimNextComposerSend(target)))?.id).toBe('queue-behind');
    (await queue.holdComposerSends(target));
    await expect(async () => (await queue.assertComposerSendClaim('queue-behind', fixtureComposerToken('queue-behind')))).rejects.toThrow();
    expect((await queue.admitComposerSend('queue-behind', fixtureComposerToken('queue-behind')))).toBe(false);
    expect((await queue.settleComposerSend('queue-behind', { status: 'applied' }, fixtureComposerToken('queue-behind')))).toBe(false);
  });

  it('runs a message sent after a failed turn was held, and keeps the held one for Retry or Remove', async () => {
    await enqueue('queue-failed'); await enqueue('queue-waiting-at-hold');
    (await fixtureComposerClaim(queue.claimNextComposerSend(target))); (await queue.admitComposerSend('queue-failed', fixtureComposerToken('queue-failed')));
    (await queue.settleComposerSend('queue-failed', { status: 'held', reason: 'Codex produced no output for 45s.' }, fixtureComposerToken('queue-failed')));
    expect((await fixtureComposerClaim(queue.claimNextComposerSend(target)))).toBeNull();
    await DELETE(request('DELETE', { ...target, id: 'queue-waiting-at-hold' }));
    await new Promise(resolve => setTimeout(resolve, 2));
    await enqueue('queue-after-hold');
    expect((await fixtureComposerClaim(queue.claimNextComposerSend(target)))?.id).toBe('queue-after-hold');
    expect((await queue.readComposerSend('queue-failed'))).toMatchObject({ status: 'held', reason: expect.stringContaining('no output') });
  });

  it('settles the turn Stop ended, so a message sent after Stop runs (#5193)', async () => {
    await enqueue('queue-running'); (await fixtureComposerClaim(queue.claimNextComposerSend(target)));
    expect((await queue.admitComposerSend('queue-running', fixtureComposerToken('queue-running')))).toBe(true);
    await enqueue('queue-waiting');
    (await queue.holdComposerSends(target));
    expect((await queue.readComposerSend('queue-running'))).toMatchObject({ status: 'applied' });
    expect((await queue.readComposerSend('queue-waiting'))).toMatchObject({ status: 'held', reason: 'Chat stopped.' });
    await DELETE(request('DELETE', { ...target, id: 'queue-waiting' }));
    await enqueue('queue-after-stop');
    expect((await fixtureComposerClaim(queue.claimNextComposerSend(target)))?.id).toBe('queue-after-stop');
  });
});

installComposerOwnerFixture();
