import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import type { OrchestratorBackend, OrchestratorTurnOptions } from '@/lib/lane/orchestrator-backends/types';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import sharp from 'sharp';
import { submitVisualInstruction, VISUAL_REQUEST_MARKER, VisualInstructionDeliveryError } from '@/lib/composer/visual-instruction-send';
import type { VisualInstructionDraft } from '@/lib/composer/visual-draft-store';
import type { ComposerQueuePayload } from '@/lib/orchestrator/composer-queue-types';
import { sampleObservation } from '@/lib/composer/visual-inspection.test-fixture';
import { commitVisualInstruction } from '@/lib/composer/visual-instruction-commit';
import { saveVisualDraft, readVisualDraft } from '@/lib/composer/visual-draft-store';
import { confirmVisualQuestion, currentVisualQuestion } from '@/lib/composer/visual-clarification';

const mocks = vi.hoisted(() => ({ beforeProject: null as (() => Promise<void>) | null,
  send: vi.fn(async (_repo: string, _message: string, emit: (event: OrchestratorEvent) => void, options: OrchestratorTurnOptions) => {
    emit({ type: 'turn_receipt', leadModel: options.model!, effort: options.thinkingEffort! });
    emit({ type: 'text', text: 'Queued answer.' });
    emit({ type: 'done', sessionId: 'queue-provider-session', cost: null });
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
vi.mock('@/lib/cortex/qa/llm/inference-route', () => ({ resolveOpenRouterRoute: async () => ({ url: 'https://model.example.test/resolve', headers: {}, via: 'direct' }) }));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-visual-exec-')));
const repo = join(root, 'repo'); mkdirSync(repo); mkdirSync(join(root, 'chat-history'));
vi.stubEnv('O8_DATA_DIR', root); vi.stubEnv('CORTEX_IDE_DATA_DIR', root); vi.stubEnv('CORTEX_IDE_DB_PATH', join(root, 'queue.db'));
const threadId = 'thoughts-queued-execution'; const target = { repoPath: repo, threadId };
const historyPath = join(root, 'chat-history', `${threadId}.json`);
const { getSqlite, closeDb } = await import('@/lib/db');
const queue = await import('@/lib/orchestrator/composer-queue');
const { POST, GET } = await import('@/app/api/orchestrator/composer-queue/route');
const { POST: resolveRipple } = await import('@/app/api/mobile/ripple/resolve/route');
const { createChatContinuationHeartbeat } = await import('@/lib/ws-server/composer-queue-heartbeat');
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
beforeEach(() => {
  getSqlite().exec('DELETE FROM composer_send_queue'); mocks.send.mockClear(); mocks.beforeProject = null; busy = false;
  writeFileSync(historyPath, JSON.stringify({ repoPath: repo, backend: 'codex', messages: [] }));
});
afterAll(() => { closeDb(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

async function visualDraft(): Promise<VisualInstructionDraft> {
  // Real raster bytes, a conspicuous red mark over a light background.
  const png = await sharp({ create: { width: 80, height: 60, channels: 4, background: 'white' } })
    .composite([{ input: Buffer.from('<svg width="80" height="60"><path d="M10 30 L70 30" stroke="red" stroke-width="6"/></svg>') }]).png().toBuffer();
  return { principal: 'account-a', status: 'draft', template: { ...base, wireMessage: `Captured project context\n${VISUAL_REQUEST_MARKER}` },
    request: { version: 1, id: 'visual-real-1', createdAt: '2026-10-19T12:00:00.000Z', target, utterance: 'Keep $& and $` literally. Change the red line.',
      frames: Array.from({ length: 4 }, (_, index) => ({ id: `frame-${index}`, atMs: index * 1_000, width: 80, height: 60,
        transcript: `Frame ${index + 1} original words.`, image: { name: `marked-${index}.png`, dataUri: `data:image/png;base64,${png.toString('base64')}` },
        strokes: [{ points: [{ x: 0.125, y: 0.5, tMs: 0 }, { x: 0.875, y: 0.5, tMs: 150 }] }], pins: [] })),
      clarification: { path: 'intent.target', question: 'Which line?', value: 'red line' } } };
}
const routeTransport: typeof fetch = async (_url, init) => POST(new NextRequest('http://localhost/api/orchestrator/composer-queue', {
  ...init, signal: init?.signal ?? undefined, headers: { host: 'localhost', 'Content-Type': 'application/json' },
}));
it('persists four marked frames from the real visual submit entry and delivers once to the captured chat after reconnect', async () => {
  const draft = await visualDraft();
  draft.request.frames[0].sequence = { durationMs: 2_000, timing: 'audio', sourceDirectory: join(root, 'private-capture'),
    moments: [{ n: 1, atMs: 800, kind: 'mark', rect: [0, 0, 1, 1], transcript: 'Measured words for this moment.' }] };
  const item = await submitVisualInstruction(draft, routeTransport);
  expect(item).toMatchObject({ id: 'visual-visual-real-1', threadId, status: 'queued' });
  closeDb();
  const persisted = queue.readComposerSend(item.id)?.payload;
  expect(persisted).toMatchObject({ text: draft.request.utterance,
    images: draft.request.frames.map(frame => frame.image), routing: base.routing });
  expect(persisted?.wireMessage).toContain('Measured words for this moment.');
  expect(JSON.parse(persisted!.wireMessage.match(/```json\n([\s\S]+?)\n```/)![1]).frames[0].sequence).toEqual(draft.request.frames[0].sequence);
  busy = true; const heartbeat = createChatContinuationHeartbeat(hooks); heartbeat();
  await new Promise(resolve => setTimeout(resolve, 30)); expect(mocks.send).not.toHaveBeenCalled();
  busy = false; heartbeat();
  await vi.waitFor(() => expect(queue.readComposerSend(item.id)?.status).toBe('applied'));
  const [_repo, wire, _emit, options] = mocks.send.mock.calls[0];
  expect(_repo).toBe(repo); expect(wire).toContain(draft.request.utterance);
  expect(wire).toContain('Frame 4 original words.'); expect(wire).toContain('intent.target');
  expect(JSON.parse(wire.match(/```json\n([\s\S]+?)\n```/)![1]).frames[0].sequence).toEqual(draft.request.frames[0].sequence);
  expect(options).toMatchObject({ threadId, permissionMode: 'plan', model: 'selected-model', attachments: draft.request.frames.map(frame => frame.image) });
  const delivered = options.attachments![0];
  const pixels = await sharp(Buffer.from(delivered.dataUri.split(',')[1], 'base64')).raw().toBuffer({ resolveWithObject: true });
  const middle = (30 * pixels.info.width + 40) * pixels.info.channels;
  expect(pixels.data[middle]).toBe(255); expect(pixels.data[middle + 1]).toBe(0); expect(pixels.data[middle + 2]).toBe(0);
  expect(readPersistedLlmChat(threadId)?.history.messages.find(row => row.role === 'user')).toMatchObject({ content: draft.request.utterance });
  closeDb(); createChatContinuationHeartbeat(hooks)(); await new Promise(resolve => setTimeout(resolve, 30));
  expect(mocks.send).toHaveBeenCalledTimes(1);
});
it('reconciles a lost response with its original ID without duplicating the accepted turn', async () => {
  const draft = await visualDraft();
  await expect(submitVisualInstruction(draft, async (url, init) => { await routeTransport(url, init); throw new Error('Connection lost after acceptance'); })).rejects.toThrow('Connection lost');
  closeDb(); const accepted = await submitVisualInstruction(draft, routeTransport);
  expect(queue.listQueuedComposerSends(target)).toHaveLength(1);
  createChatContinuationHeartbeat(hooks)();
  await vi.waitFor(() => expect(queue.readComposerSend(accepted.id)?.status).toBe('applied'));
  await submitVisualInstruction(draft, routeTransport); createChatContinuationHeartbeat(hooks)();
  await new Promise(resolve => setTimeout(resolve, 30)); expect(mocks.send).toHaveBeenCalledTimes(1);
});
it('retains editable evidence for a known rejection and refuses mismatched saved chat identity', async () => {
  const draft = await visualDraft(); draft.request.target = { ...target, repoPath: join(root, 'wrong-repo') };
  await expect(submitVisualInstruction(draft, routeTransport)).rejects.toMatchObject({ name: 'VisualInstructionDeliveryError', uncertain: false });
  expect(queue.listQueuedComposerSends(target)).toHaveLength(0);
  const original = await visualDraft(); original.request.utterance = 'x'.repeat(16_001);
  const send = vi.fn(routeTransport);
  await expect(submitVisualInstruction(original, send)).rejects.toBeInstanceOf(VisualInstructionDeliveryError);
  expect(send).not.toHaveBeenCalled(); expect(original.request.frames).toHaveLength(4);
});


it('reads only the exact captured chat receipt before and after persisted admission', async () => {
  const draft = await visualDraft(); const item = await submitVisualInstruction(draft, routeTransport);
  const receiptRequest = (thread = threadId, origin = 'http://localhost') => new NextRequest(`${origin}/api/orchestrator/composer-queue?repoPath=${encodeURIComponent(repo)}&threadId=${thread}&id=${item.id}`, { headers: { host: new URL(origin).host } });
  expect((await (await GET(receiptRequest())).json()).userMessageId).toBeNull();
  const heartbeat = createChatContinuationHeartbeat(hooks); heartbeat();
  await vi.waitFor(() => expect(queue.readComposerSend(item.id)?.status).toBe('applied'));
  closeDb();
  const restored = await (await GET(receiptRequest())).json();
  expect(restored.item.id).toBe(item.id);
  expect(restored.userMessageId).toBe(`review-user-assistant-queued-${item.id}`);
  expect((await GET(receiptRequest('thoughts-other'))).status).toBe(404);
  expect((await GET(receiptRequest(threadId, 'https://untrusted.example'))).status).toBe(401);
});

it('reads the persisted lead turn identity rather than guessing the ordinary chat user ID', async () => {
  const draft = await visualDraft(); const item = await submitVisualInstruction(draft, routeTransport);
  const db = getSqlite();
  db.prepare(`INSERT INTO orchestrator_leads (id,start_key,request_digest,thread_id,repo_path,backend,model,effort,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run('fixture-lead','fixture-lead-start','fixture-digest',threadId,repo,'codex','selected-model','low','running',1,1);
  db.prepare(`INSERT INTO orchestrator_lead_turns (id,lead_id,idempotency_key,ordinal,kind,message,status,created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run('actual-admitted-turn','fixture-lead',`composer-queue:${item.id}`,1,'user','Raw original instruction','running',2);
  expect(queue.claimNextComposerSend(target)?.id).toBe(item.id); expect(queue.admitComposerSend(item.id)).toBe(true);
  closeDb();
  const response = await GET(new NextRequest(`http://localhost/api/orchestrator/composer-queue?repoPath=${encodeURIComponent(repo)}&threadId=${threadId}&id=${item.id}`, { headers: { host: 'localhost' } }));
  expect((await response.json()).userMessageId).toBe('lead-user-actual-admitted-turn');
  getSqlite().prepare('DELETE FROM orchestrator_leads WHERE id = ?').run('fixture-lead');
});

it('retains the confirmed meaning through draft persistence, a lost queue reply, and actual chat dispatch', async () => {
  // Exercise the production draft store with an asynchronous IndexedDB boundary.
  vi.stubGlobal('indexedDB', { open: () => {
    const opening = { result: { transaction: () => {
      const transaction = { oncomplete: null as (() => void) | null, objectStore: () => ({ put: () => queueMicrotask(() => transaction.oncomplete?.()) }) };
      return transaction;
    } }, onsuccess: null as (() => void) | null };
    queueMicrotask(() => opening.onsuccess?.()); return opening;
  } });
  const choice = { kind: 'choice', question: 'What should be bigger?', aodlPath: 'intent.size', options: [
    { label: 'Button size', value: 'button-size' }, { label: 'Text size', value: 'text-size' },
  ] };
  const provider = vi.fn(async () => Response.json({ choices: [{ message: { content: JSON.stringify(choice) } }] }));
  vi.stubGlobal('fetch', provider);
  try {
    const draft = await visualDraft(); draft.request.id = 'meaning-real'; draft.request.utterance = 'Make it bigger.'; draft.request.clarification = undefined;
    const observation = sampleObservation();
    const png = await sharp({ create: { width: 320, height: 280, channels: 4, background: 'white' } }).png().toBuffer();
    observation.image.dataUri = `data:image/png;base64,${png.toString('base64')}`;
    draft.request.frames = [{ ...draft.request.frames[0], image: observation.image, width: 320, height: 280, observation,
      candidates: [{ id: 'save-button', name: 'Save', role: 'button', rect: [0.1, 0.2, 0.1, 0.1] }] }];
    await saveVisualDraft(draft);
    const transport: typeof fetch = (url, init) => url === '/api/mobile/ripple/resolve'
      ? resolveRipple(new NextRequest('http://localhost/api/mobile/ripple/resolve', { ...init, signal: init?.signal ?? undefined })) : routeTransport(url, init);
    expect(await commitVisualInstruction(draft, () => true, transport)).toBeNull();
    expect(queue.listQueuedComposerSends(target)).toHaveLength(0);
    const pending = readVisualDraft(draft.principal, target)!;
    expect(currentVisualQuestion(pending)?.question).toBe(choice.question);
    expect(await confirmVisualQuestion(pending, 'text-size')).toBe(true);
    expect(queue.listQueuedComposerSends(target)).toHaveLength(0);
    const accepted = readVisualDraft(draft.principal, target)!;
    await expect(commitVisualInstruction(accepted, () => true, async (url, init) => {
      await transport(url, init); throw new Error('Lost acceptance reply');
    })).rejects.toThrow('Lost acceptance reply');
    closeDb();
    const uncertain = readVisualDraft(draft.principal, target)!;
    expect(uncertain.status).toBe('unknown');
    const item = await commitVisualInstruction(uncertain, () => true, transport);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(queue.readComposerSend(item!.id)?.payload.wireMessage).toContain('intent.size = "text-size"');
    createChatContinuationHeartbeat(hooks)();
    await vi.waitFor(() => expect(queue.readComposerSend(item!.id)?.status).toBe('applied'));
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0][1]).toContain('intent.size = "text-size"');
    expect(mocks.send.mock.calls[0][3].permissionMode).toBe('plan');
    expect(readPersistedLlmChat(threadId)?.history.messages.find(row => row.role === 'user')?.content).toBe('Make it bigger.');
  } finally { vi.unstubAllGlobals(); }
});
