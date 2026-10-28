/** @vitest-environment jsdom */
/* eslint-disable react-hooks/refs -- test harness owns its draft and imperative controller */
import { resetComposerQueueRecoveryMemoryForTests } from '@/components/desktop/thoughts/chat-panel/composer-queue-recovery';
import { act, createElement, createRef, forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeComposerServiceTier } from '../composer-selector/service-tier-store';
import type { ComposerMode } from '../composer-mode';
import type { ComposerQueuePayload, QueuedComposerSendRecord } from '@/lib/orchestrator/composer-queue-types';
import { useDefaultComposerSendBuffer } from './useDefaultComposerSendBuffer';
import { useBufferedOrchestratorSend } from './useBufferedOrchestratorSend';
import { managedVoiceFollowup } from './managed-voice-followup';
import { ComposerArea } from './ComposerArea';
import { ChatMessageList } from './ChatMessageList';
import { ComposerSendBufferStatus } from './ComposerSendBufferStatus';

const { ws } = vi.hoisted(() => ({ ws: { options: null as null | { onRealtimeEvent: (event: unknown) => void } } }));
const attachmentCopies = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@/components/desktop/thoughts/chat-panel/composer-queue-attachment-store', () => ({
  saveComposerAttachmentPayload: async (key: string, value: unknown) => { attachmentCopies.set(key, value); },
  readComposerAttachmentPayload: async (key: string) => attachmentCopies.get(key),
  removeComposerAttachmentPayload: async (key: string) => { attachmentCopies.delete(key); },
  listComposerAttachmentKeys: async () => [...attachmentCopies.keys()],
}));
vi.mock('@/components/desktop/hooks/DesktopWebSocketContext', () => ({ useSharedDesktopWs: (_: unknown, options: typeof ws.options) => { ws.options = options; } }));
vi.mock('../InputButtons', () => ({ InputButtons: ({ inlineLeadingExtras, sendDisabled }: { inlineLeadingExtras: React.ReactNode; sendDisabled: boolean }) => createElement('footer', null, inlineLeadingExtras, createElement('button', { disabled: sendDisabled, 'aria-label': 'Send message' }, 'Send')), RepoTargetChip: () => null }));
vi.mock('./SlashCommandPicker', () => ({ SlashCommandPicker: () => null }));
vi.mock('./ComposerStatusBar', () => ({ ComposerStatusBar: () => null }));
vi.mock('../../composer-center-registry', () => ({ registerComposerCenter: () => () => undefined }));
vi.mock('@/lib/pretext', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/pretext')>(), usePretextHeight: () => 24 }));
vi.mock('@/lib/analytics/track', () => ({ track: vi.fn() }));

const send = vi.fn(() => null);
const image = { name: 'proof.png', dataUri: 'data:image/png;base64,YQ==', mimeType: 'image/png' };
type Controller = { setDraft: (text: string) => void; enqueueVoice: () => Promise<string>; cancelVoice: () => Promise<string> };
const control = createRef<Controller>();
const Harness = forwardRef<Controller, { threadId: string; model?: string; mode?: ComposerMode; busy?: boolean; backend?: 'codex' | 'pi'; imagesEnabled?: boolean }>(function Harness({ threadId, model = 'original-model', mode = 'solo', busy = true, backend = 'codex', imagesEnabled = true }, ref) {
  const [input, setInput] = useState('Queue this message');
  const [images, setImages] = useState(imagesEnabled ? [image] : []);
  const latestInputRef = useRef(input); const inputRef = useRef<HTMLTextAreaElement>(null);
  const { dispatch, capture } = useBufferedOrchestratorSend({ active: true, backend, model, mode, solo: false,
    effort: 'low', permissionMode: 'plan', collide: false, projectId: 'original-project', context: 'Original context', send });
  const result = useDefaultComposerSendBuffer({ active: true, backend, busy, threadId, repoPath: '/repo', attachedImages: images,
    latestInputRef, inputRef, setInput, addAttachedImage: entry => setImages(previous => [...previous, entry]), clearAttachments: () => setImages([]),
    dispatch, captureQueuedSend: capture, interrupt: vi.fn(), undoSend: vi.fn(), shouldBypass: () => false, sendUnbuffered: vi.fn() });
  const voice = managedVoiceFollowup(result.durable, text => capture(text, []));
  useImperativeHandle(ref, () => ({ setDraft: text => { latestInputRef.current = text; setInput(text); },
    enqueueVoice: () => voice.enqueue('voice-test', 'Do the follow-up', 'original-task'), cancelVoice: voice.cancel }));
  return createElement('div', null, createElement(ChatMessageList, { displayMessages: [], displayWaiting: busy, activeTargetLabel: 'Agent', activeTargetColor: 'var(--t-accent)',
    thoughtsMutedGlass: 'transparent', thoughtsElevatedBorder: 'var(--t-divider)', thoughtsElevatedShadow: 'none', emptyStateFallback: null,
    composerQueue: { items: result.durable.transcriptItems, canSteer: result.durable.canSteer, onSteer: id => { void result.durable.steer(id); },
      onCancel: result.sendBuffer.cancelQueued, removing: result.durable.removing, promoting: result.durable.promoting } }), createElement(ComposerArea, { input, inputLabel: 'Queue test composer', onInputChange: text => { latestInputRef.current = text; setInput(text); },
    activeComposer: true, isOrchestratorMode: true, displayWaiting: busy, chatMessages: [], activeTargetLabel: 'Codex', targetAgentExists: true,
    thoughtsBodyBackground: 'transparent', enhancing: false, preEnhanceInput: null, onEnhance: vi.fn(), onUndoEnhance: vi.fn(),
    onSubmit: result.handleSend, onSteer: result.handleSteer, canSteerLive: result.durable.canSteer, queueSaving: result.saving, onSlashCommand: vi.fn(), modelLabel: model,
    effort: 'low', onEffortChange: vi.fn(), adaptiveEnabled: false, displayMessagesCount: 0, hasAssistantActivity: false, attachedImages: images,
    sendBufferStatus: createElement(ComposerSendBufferStatus, { attachmentError: result.attachmentError, queued: [],
      undoArmed: false, undoSequence: 0, onUndo: vi.fn(), onCancelQueued: result.sendBuffer.cancelQueued }),
  }));
});
let host: HTMLDivElement; let root: Root; let rows: QueuedComposerSendRecord[]; let posts: Array<{ id: string; threadId: string; payload: ComposerQueuePayload; intent: string }>;
let canSteer = false; let patchCount = 0;
let steerOutcome: 'applied' | 'refused' | 'unconfirmed' = 'applied';
let delayPatch: (() => Promise<void>) | null = null;
function applySteer(item: QueuedComposerSendRecord) {
  if (steerOutcome === 'applied') Object.assign(item, { status: 'applied', admittedAt: 1 });
  else if (steerOutcome === 'refused') Object.assign(item, { intent: 'send-next', status: 'queued', reason: 'Steer declined; queued for the next turn.' });
  else Object.assign(item, { status: 'held', admittedAt: 1, reason: 'Steer unconfirmed; queued for inspection.' });
}
let failAfterPersist = false;
let delayPost: (() => Promise<void>) | null = null;
beforeEach(() => {
  resetComposerQueueRecoveryMemoryForTests(); attachmentCopies.clear();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  rows = []; posts = []; canSteer = false; patchCount = 0; steerOutcome = 'applied'; delayPatch = null; failAfterPersist = false; delayPost = null; send.mockClear(); localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const response = (data: unknown) => ({ ok: true, json: async () => data });
    if (!url.startsWith('/api/orchestrator/composer-queue')) return response({});
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body as string); posts.push(body); await delayPost?.();
      let item = rows.find(row => row.id === body.id);
      if (!item) { item = { ...body, sequence: rows.length + 1, status: 'queued', reason: null, createdAt: 1, updatedAt: 1, admittedAt: null }; rows.push(item!); }
      if (body.intent === 'steer-now') applySteer(item!);
      if (failAfterPersist) { failAfterPersist = false; throw new Error('Response lost. Retry the same draft.'); }
      return response({ item });
    }
    if (init?.method === 'PATCH') {
      patchCount++; await delayPatch?.(); const body = JSON.parse(init.body as string); const item = rows.find(row => row.id === body.id)!;
      item.intent = 'steer-now'; applySteer(item); return response({ item });
    }
    if (init?.method === 'DELETE') { const body = JSON.parse(init.body as string); rows = rows.filter(row => row.id !== body.id); return response({ ok: true }); }
    const thread = new URL(url, 'http://localhost').searchParams.get('threadId');
    return response({ canSteer, items: rows.filter(row => row.threadId === thread && row.status !== 'cancelled' && (row.status !== 'applied' || row.intent === 'steer-now')).map(row => structuredClone(row)) });
  }));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function render(threadId = 'thoughts-one', model = 'original-model', mode: ComposerMode = 'solo', busy = true, backend: 'codex' | 'pi' = 'codex', imagesEnabled = true) {
  await act(async () => root.render(createElement(Harness, { ref: control, threadId, model, mode, busy, backend, imagesEnabled })));
}
async function enter(metaKey = false) {
  await act(async () => host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey, bubbles: true, cancelable: true })));
}

describe('durable Send next through the normal composer', () => {
  it('keeps a fresh idle send on the direct send path without inventing a pending retry', async () => {
    await render('thoughts-one', 'original-model', 'solo', false, 'codex', false);
    await enter();
    expect(posts).toEqual([]);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('refuses a fresh image on an unsupported backend without inventing a pending retry', async () => {
    await render('thoughts-one', 'original-model', 'solo', false, 'pi');
    await enter();
    expect(posts).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(host.querySelector('textarea')!.value).toBe('Queue this message');
    expect(host.textContent).toContain('proof.png');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('cannot receive images');
  });
  it('surfaces an unavailable recovery read without posting or losing its draft', async () => {
    await render();
    const read = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError'); });
    try {
      await enter();
      expect(posts).toEqual([]);
      expect(send).not.toHaveBeenCalled();
      expect(host.querySelector('textarea')!.value).toBe('Queue this message');
      expect(host.textContent).toContain('proof.png');
      expect(host.querySelector('[role="alert"]')?.textContent).toContain('Browser storage is unavailable');
    } finally { read.mockRestore(); }
  });
  it('keeps the original destination, attachment and routing across navigation/reload and removes a cancelled item durably', async () => {
    writeComposerServiceTier('codex', 'original-model', 'priority');
    await render(); await enter();
    writeComposerServiceTier('codex', 'original-model', 'default');
    expect(send).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ repoPath: '/repo', threadId: 'thoughts-one', payload: { text: 'Queue this message', images: [{ name: image.name, dataUri: image.dataUri }],
      routing: { backend: 'codex', model: 'original-model', effort: 'low', serviceTier: 'priority', permissionMode: 'plan', mode: 'single', pickedMode: 'solo', projectId: 'original-project' } } });
    expect(rows[0].payload.wireMessage).toContain('Original context');
    await render('thoughts-two', 'new-model', 'fast');
    expect(host.querySelector('[role="list"]')).toBeNull();
    await act(async () => control.current!.setDraft('Another chat'));
    await enter();
    expect(rows.map(row => row.threadId)).toEqual(['thoughts-one', 'thoughts-two']);
    expect(rows[0].payload.routing.model).toBe('original-model');
    expect(rows[0].payload.routing.serviceTier).toBe('priority');
    await act(async () => root.unmount()); root = createRoot(host);
    await render('thoughts-one', 'changed-model', 'fast');
    expect(host.querySelector('[role="list"]')?.textContent).toContain('Queue this message');
    expect(host.querySelector('[role="list"]')?.textContent).not.toContain('Another chat');
    await act(async () => root.unmount()); root = createRoot(host);
    await render('thoughts-one');
    expect(host.querySelector('[role="list"] img')).not.toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('[title="Cancel queued message"]')!.click());
    expect(rows.map(row => row.threadId)).toEqual(['thoughts-two']);
    await act(async () => root.unmount()); root = createRoot(host); await render('thoughts-one');
    expect(host.querySelector('[role="list"]')).toBeNull();
  });

  it('keeps a new idle submission behind previously queued intent after returning to the chat', async () => {
    await render(); await enter();
    await act(async () => control.current!.setDraft('Follow the queued message'));
    await render('thoughts-one', 'new-model', 'fast', false);
    await enter();
    expect(send).not.toHaveBeenCalled();
    expect(rows.map(row => row.payload.text)).toEqual(['Queue this message', 'Follow the queued message']);
    expect(rows.map(row => row.payload.routing.model)).toEqual(['original-model', 'new-model']);
  });

  it('uses Queue without a mode toggle or unavailable sentence when native steering is unavailable', async () => {
    await render();
    expect(host.querySelector('[aria-label^="Message mode:"]')).toBeNull();
    expect(host.textContent).not.toContain('Live steering is unavailable');
    await enter(true);
    expect(posts).toHaveLength(0); expect(host.querySelector('textarea')!.value).toBe('Queue this message');
    await enter(); expect(rows).toHaveLength(1); expect(rows[0].status).toBe('queued');
    expect(host.querySelector('textarea')!.value).toBe('');
    expect(host.textContent).not.toContain('Steer now');
  });

  it('defaults to acknowledged live steering on Enter and shows one normal message with its Steer arrow tag', async () => {
    canSteer = true; await render('thoughts-one', 'pi', 'solo', true, 'pi', false); await enter();
    expect(posts[0].intent).toBe('steer-now');
    expect(host.querySelector('textarea')!.value).toBe('');
    expect(host.querySelector('[role="list"]')?.textContent).toContain('Queue this message');
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Steer →');
    expect(host.querySelectorAll('[data-composer-message]')).toHaveLength(1);
  });

  it('renders Queue in the transcript and converts that exact message with immediate busy feedback', async () => {
    canSteer = true; await render('thoughts-one', 'pi', 'solo', true, 'pi', false);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Message mode: Steer"]')!.click());
    await enter(); expect(posts[0].intent).toBe('send-next');
    const saved = structuredClone(rows[0]);
    const action = [...host.querySelectorAll('button')].find(button => button.textContent === 'Steer now')!;
    expect(action).toBeDefined();
    let release!: () => void; delayPatch = () => new Promise(resolve => { release = resolve; });
    await act(async () => { action.click(); action.click(); });
    expect(patchCount).toBe(1); expect(action.disabled).toBe(true); expect(action.textContent).toBe('Steering…');
    await act(async () => release());
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ id: saved.id, payload: saved.payload, status: 'applied' });
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Steer →');
    expect(host.textContent).not.toContain('Steer now');
  });

  it.each(['refused', 'unconfirmed'] as const)('keeps a %s steer in the transcript with a queued explanation', async outcome => {
    canSteer = true; steerOutcome = outcome; await render('thoughts-one', 'pi', 'solo', true, 'pi', false); await enter();
    expect(rows).toHaveLength(1); expect(rows[0].status).toBe(outcome === 'refused' ? 'queued' : 'held');
    expect(host.querySelector('[role="status"]')?.textContent).toContain(outcome === 'refused' ? 'Queued · Steer declined' : 'Queued · Steer unconfirmed');
    expect(host.querySelector('textarea')!.value).toBe('');
    expect(host.textContent).not.toContain('Steer →');
  });

  it('reuses the same mutation identity after an uncertain response instead of duplicating the message', async () => {
    await render(); failAfterPersist = true; await enter();
    expect(host.querySelector('textarea')!.value).toBe('Queue this message');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Response lost');
    await enter();
    expect(posts).toHaveLength(2);
    expect(posts[0].id).toBe(posts[1].id);
    expect(rows).toHaveLength(1);
    expect(host.querySelector('textarea')!.value).toBe('');
  });

  it('reconciles the same uncertain send after a full composer reload, even after it has left the visible queue', async () => {
    await render(); failAfterPersist = true; await enter();
    const original = structuredClone(posts[0]);
    rows[0] = { ...rows[0], status: 'applied', admittedAt: 10 };
    await act(async () => root.unmount()); root = createRoot(host);
    await render('thoughts-one', 'changed-model', 'fast', false);
    await enter();
    expect(send).not.toHaveBeenCalled();
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual(original);
    expect(rows).toHaveLength(1);
    expect(host.querySelector('textarea')!.value).toBe('');
  });

  it('retains uncertain identities independently across chats and routing changes', async () => {
    await render(); failAfterPersist = true; await enter();
    await render('thoughts-two');
    await act(async () => control.current!.setDraft('Another queued message'));
    await enter();
    await act(async () => root.unmount()); root = createRoot(host);
    await render('thoughts-one', 'changed-model', 'fast');
    await act(async () => control.current!.setDraft('Queue this message'));
    await enter();
    expect(posts[2].id).toBe(posts[0].id);
    expect(posts[2].payload).toEqual(posts[0].payload);
    expect(rows).toHaveLength(2);
  });

  it('bounds a stalled save, retains the draft and retries only on request with its original identity', async () => {
    await render(); vi.useFakeTimers();
    const normal = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push(JSON.parse(init.body as string));
        return new Promise<Response>(() => {});
      }
      return normal(url, init);
    }));
    await enter();
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.disabled).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(15_001));
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.disabled).toBe(false);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('not confirmed');
    expect(host.querySelector('textarea')!.value).toBe('Queue this message');
    expect(posts).toHaveLength(1);
    vi.stubGlobal('fetch', normal);
    await enter();
    expect(posts[1].id).toBe(posts[0].id);
    expect(rows).toHaveLength(1);
  });

  it('bounds a stalled cancellation and allows an explicit retry without hiding the saved message', async () => {
    await render(); await enter(); vi.useFakeTimers();
    const normal = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => init?.method === 'DELETE'
      ? new Promise<Response>(() => {}) : normal(url, init)));
    await act(async () => host.querySelector<HTMLButtonElement>('[title="Cancel queued message"]')!.click());
    await act(async () => vi.advanceTimersByTimeAsync(15_001));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('not confirmed');
    expect(host.querySelector<HTMLButtonElement>('[title="Cancel queued message"]')!.disabled).toBe(false);
    expect(rows).toHaveLength(1);
    vi.stubGlobal('fetch', normal);
    await act(async () => host.querySelector<HTMLButtonElement>('[title="Cancel queued message"]')!.click());
    expect(rows).toHaveLength(0);
  });

  it('retains recovery when a success arrives after its original composer unmounts', async () => {
    await render();
    const normal = globalThis.fetch; let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const response = await normal(url, init);
      if (init?.method === 'POST') await gate;
      return response;
    }));
    await enter(); expect(rows).toHaveLength(1);
    const original = structuredClone(posts[0]);
    rows[0] = { ...rows[0], status: 'applied', admittedAt: 1 };
    await act(async () => root.unmount()); root = createRoot(host);
    await render('thoughts-one', 'later-model', 'solo', false);
    await act(async () => release());
    expect(host.querySelector('textarea')!.value).toBe('Queue this message');
    vi.stubGlobal('fetch', normal); await enter();
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual(original);
    expect(rows).toHaveLength(1);
    expect(host.querySelector('textarea')!.value).toBe('');
  });

  it('reconciles a pending image send using its saved backend after switching to a backend without image support', async () => {
    await render(); failAfterPersist = true; await enter();
    const original = structuredClone(posts[0]);
    await act(async () => root.unmount()); root = createRoot(host);
    await render('thoughts-one', '', 'solo', false, 'pi');
    await enter();
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual(original);
    expect(rows).toHaveLength(1);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('queues when recovery cannot be saved, preserving text and attachment', async () => {
    await render();
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Quota exceeded'); });
    try {
      await enter();
      expect(posts).toHaveLength(1);
      expect(host.querySelector('textarea')!.value).toBe('Queue this message');
      expect(host.textContent).toContain('proof.png');
      expect(host.querySelector('[role="alert"]')?.textContent).toContain('Message queued.');
    } finally { write.mockRestore(); }
  });

  it.each([
    [new DOMException('Full', 'QuotaExceededError'), 'Browser storage is full'],
    [new DOMException('Blocked', 'SecurityError'), 'Browser storage is unavailable'],
    [new Error('Unknown write failure'), 'The draft could not be saved'],
  ])('reports actual storage failures after a matching queue receipt: %s', async (failure, advice) => {
    await render();
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw failure; });
    try {
      await enter();
      expect(posts).toHaveLength(1);
      expect(rows).toHaveLength(1);
      expect(host.querySelector('textarea')!.value).toBe('Queue this message');
      expect(host.textContent).toContain('proof.png');
      const error = host.querySelector('[role="alert"]')?.textContent;
      expect(error).toContain('Message queued.');
      expect(error).toContain(advice);
      expect(error).not.toContain('Send next recovery');
      if (!(failure instanceof DOMException && failure.name === 'QuotaExceededError')) expect(error).not.toContain('Free browser storage');
    } finally { write.mockRestore(); }
  });

  it('allows a deliberate identical message after the previous submission was confirmed', async () => {
    await render(); await enter();
    await act(async () => root.unmount()); root = createRoot(host);
    await render(); await enter();
    expect(posts).toHaveLength(2);
    expect(posts[1].id).not.toBe(posts[0].id);
    expect(rows).toHaveLength(2);
  });

  it('shows preparation and held outcomes without claiming steering was applied, and only disables removal after admission', async () => {
    await render(); await enter();
    rows[0] = { ...rows[0], status: 'dispatching', admittedAt: 10 };
    await act(async () => ws.options!.onRealtimeEvent({ channel: 'mutation', data: { mutation: { action: 'composer-queue', surfaceId: 'thoughts-one' } } }));
    expect(host.querySelector('[role="list"]')?.textContent).toContain('Sending');
    expect(host.querySelector<HTMLButtonElement>('[title="Cancel queued message"]')!.disabled).toBe(true);
    const reason = 'This lead cannot apply the independent thinking effort "high": its transport has no verified mapping.';
    rows[0] = { ...rows[0], status: 'held', reason };
    await act(async () => window.dispatchEvent(new Event('o8:lifecycle-reconcile')));
    expect(host.querySelector('[role="status"]')?.getAttribute('title')).toContain(reason);
    expect(host.querySelector('[role="list"]')?.textContent).toContain(reason);
    expect(host.querySelector<HTMLButtonElement>('[title="Cancel queued message"]')!.disabled).toBe(false);
    expect(host.textContent).not.toMatch(/Steering applied|Steer applied/);
  });
});

it.each([false, true])('withdraws an in-flight voice save durably even when its response is lost: %s', async lostResponse => {
  await render();
  let release!: () => void;
  delayPost = () => new Promise<void>(resolve => { release = resolve; });
  failAfterPersist = lostResponse;
  let saving!: Promise<string>; let canceling!: Promise<string>;
  await act(async () => { saving = control.current!.enqueueVoice(); void saving.catch(() => {}); });
  expect(posts).toHaveLength(1);
  await act(async () => { canceling = control.current!.cancelVoice(); });
  // Navigation cannot send withdrawal to whichever chat becomes selected next.
  await render('thoughts-two');
  let outcome = '';
  await act(async () => { release(); await saving.catch(() => {}); outcome = await canceling; });
  expect(outcome).toContain('removed the saved voice follow-up');
  expect(outcome).toContain('does not stop or undo work already submitted');
  expect(rows).toEqual([]);
  await render('thoughts-one');
  expect(host.querySelector('[role="list"]')).toBeNull();
});

it('reuses a voice delegation id after an uncertain save without claiming a changed-routing receipt succeeded', async () => {
  await render(); failAfterPersist = true;
  await act(async () => { await expect(control.current!.enqueueVoice()).rejects.toThrow('Response lost'); });
  await render('thoughts-one', 'changed-model');
  await act(async () => { await expect(control.current!.enqueueVoice()).rejects.toThrow('receipt did not match'); });
  expect(rows).toHaveLength(1); expect(posts.map(post => post.id)).toEqual(['voice-test', 'voice-test']);
  expect(rows[0].payload.routing.model).toBe('original-model'); expect(send).not.toHaveBeenCalled();
  await render(); await act(async () => control.current!.enqueueVoice());
  expect(rows).toHaveLength(1);
});
