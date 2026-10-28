/** @vitest-environment jsdom */
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resetComposerQueueRecoveryMemoryForTests } from '@/components/desktop/thoughts/chat-panel/composer-queue-recovery';
import { act, createElement, useLayoutEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeComposerServiceTier } from '@/components/desktop/thoughts/composer-selector/service-tier-store';
import type { ComposerQueuePayload } from '@/lib/orchestrator/composer-queue-types';

const attachmentCopies = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@/components/desktop/thoughts/chat-panel/composer-queue-attachment-store', () => ({
  saveComposerAttachmentPayload: async (key: string, value: unknown) => { attachmentCopies.set(key, value); },
  readComposerAttachmentPayload: async (key: string) => attachmentCopies.get(key),
  removeComposerAttachmentPayload: async (key: string) => { attachmentCopies.delete(key); },
  listComposerAttachmentKeys: async () => [...attachmentCopies.keys()],
}));
vi.mock('@/components/desktop/hooks/DesktopWebSocketContext', () => ({ useSharedDesktopWs: () => {} }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
vi.mock('@/components/desktop/thoughts/InputButtons', () => ({ InputButtons: () => null, RepoTargetChip: () => null }));
vi.mock('@/components/desktop/thoughts/chat-panel/SlashCommandPicker', () => ({ SlashCommandPicker: () => null }));
vi.mock('@/components/desktop/thoughts/chat-panel/ComposerStatusBar', () => ({ ComposerStatusBar: () => null }));
vi.mock('@/components/desktop/composer-center-registry', () => ({ registerComposerCenter: () => () => undefined }));
vi.mock('@/lib/analytics/track', () => ({ track: vi.fn() }));

const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'o8-composer-retry-')));
const repo = join(fixture, 'repo'); mkdirSync(repo);
vi.stubEnv('O8_DATA_DIR', fixture); vi.stubEnv('CORTEX_IDE_DATA_DIR', fixture);
vi.stubEnv('CORTEX_IDE_DB_PATH', join(fixture, 'queue.db'));
mkdirSync(join(fixture, 'chat-history'));
const threadId = 'thoughts-retry-interface';
writeFileSync(join(fixture, 'chat-history', threadId + '.json'), JSON.stringify({ repoPath: repo, backend: 'codex', messages: [] }));
const { getSqlite, closeDb } = await import('@/lib/db');
const { ensureV71ComposerQueueSchema } = await import('@/lib/db/v71-composer-queue-migration');
const queue = await import('@/lib/orchestrator/composer-queue');
const { GET, POST } = await import('@/app/api/orchestrator/composer-queue/route');
const { ComposerArea } = await import('@/components/desktop/thoughts/chat-panel/ComposerArea');
const { ComposerSendBufferStatus } = await import('@/components/desktop/thoughts/chat-panel/ComposerSendBufferStatus');
const { useBufferedOrchestratorSend } = await import('@/components/desktop/thoughts/chat-panel/useBufferedOrchestratorSend');
const { useDefaultComposerSendBuffer } = await import('@/components/desktop/thoughts/chat-panel/useDefaultComposerSendBuffer');

const words = 'Preserve this follow-up exactly once';
const image = { name: ' proof.png ', dataUri: 'data:image/png;base64,YQ==', mimeType: 'image/png' };
const dispatch = vi.fn(() => null);
function Harness({ busy, model }: { busy: boolean; model: string }) {
  const [input, setInput] = useState(words);
  const [images, setImages] = useState([image]);
  const latestInputRef = useRef(input); const inputRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => { latestInputRef.current = input; }, [input]);
  const { dispatch: bufferedDispatch, capture } = useBufferedOrchestratorSend({ active: true, backend: 'codex', model,
    effort: 'low', permissionMode: 'plan', mode: 'solo', solo: false, collide: false, projectId: null,
    context: 'Original context', send: dispatch });
  const result = useDefaultComposerSendBuffer({ active: true, backend: 'codex', busy, threadId, repoPath: repo,
    attachedImages: images, latestInputRef, inputRef, setInput, addAttachedImage: entry => setImages(previous => [...previous, entry]),
    clearAttachments: () => setImages([]), dispatch: bufferedDispatch, captureQueuedSend: capture, interrupt: vi.fn(), undoSend: vi.fn(),
    shouldBypass: () => false, sendUnbuffered: vi.fn() });
  return createElement(ComposerArea, { input, inputLabel: 'Retry acceptance composer', activeComposer: true,
    onInputChange: setInput, isOrchestratorMode: true,
    displayWaiting: busy, chatMessages: [], activeTargetLabel: 'Codex', targetAgentExists: true,
    thoughtsBodyBackground: 'transparent', enhancing: false, preEnhanceInput: null, onEnhance: vi.fn(), onUndoEnhance: vi.fn(),
    onSubmit: result.handleSend, onSteer: result.handleSteer, queueSaving: result.saving, onSlashCommand: vi.fn(), modelLabel: model,
    effort: 'low', onEffortChange: vi.fn(), adaptiveEnabled: false, displayMessagesCount: 0, hasAssistantActivity: false, attachedImages: images,
    sendBufferStatus: createElement(ComposerSendBufferStatus, { attachmentError: result.attachmentError, queued: result.sendBuffer.queued,
      undoArmed: false, undoSequence: 0, onUndo: vi.fn(), onCancelQueued: result.sendBuffer.cancelQueued }),
  });
}

let host: HTMLDivElement; let root: Root;
let posts: Array<{ id: string; payload: ComposerQueuePayload }>; let dropResponse = true;
beforeEach(() => {
  resetComposerQueueRecoveryMemoryForTests(); attachmentCopies.clear();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  ensureV71ComposerQueueSchema(getSqlite()); getSqlite().exec('DELETE FROM composer_send_queue');
  localStorage.clear(); writeComposerServiceTier('codex', 'original-model', 'priority'); dispatch.mockClear(); posts = []; dropResponse = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const request = new NextRequest(new URL(url, 'http://localhost'), { ...init, signal: init?.signal ?? undefined, headers: { host: 'localhost', 'Content-Type': 'application/json' } });
    if (init?.method === 'POST') {
      posts.push(JSON.parse(init.body as string));
      const response = await POST(request);
      expect(response.status).toBe(200);
      if (dropResponse) { dropResponse = false; throw new Error('Response lost after real database commit.'); }
      return response;
    }
    return GET(request);
  }));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
afterAll(() => { closeDb(); vi.unstubAllEnvs(); rmSync(fixture, { recursive: true, force: true }); });
async function render(busy = true, model = 'original-model') {
  await act(async () => root.render(createElement(Harness, { busy, model })));
}
async function send() {
  await act(async () => host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
}

it('retries a lost API receipt after renderer and database restart without creating another delivered turn', async () => {
  await render(); await send();
  expect(host.querySelector('textarea')!.value).toBe(words);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Response lost');
  const original = structuredClone(posts[0]);
  expect(queue.listQueuedComposerSends({ repoPath: repo, threadId })).toHaveLength(1);
  expect(queue.claimNextComposerSend({ repoPath: repo, threadId })?.id).toBe(original.id);
  expect(queue.admitComposerSend(original.id)).toBe(true);
  expect(queue.settleComposerSend(original.id, { status: 'applied' })).toBe(true);
  closeDb();
  await act(async () => root.unmount()); root = createRoot(host);
  await render(false, 'later-selection');
  expect(host.querySelector('[role="list"]')).toBeNull();
  await send();
  expect(dispatch).not.toHaveBeenCalled();
  expect(posts).toHaveLength(2);
  expect(posts[1]).toEqual(original);
  expect(queue.readComposerSend(original.id)).toMatchObject({ status: 'applied', payload: original.payload, threadId, repoPath: repo });
  expect(getSqlite().prepare('SELECT COUNT(*) AS count FROM composer_send_queue').get()).toEqual({ count: 1 });
  expect(host.querySelector('textarea')!.value).toBe('');
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
