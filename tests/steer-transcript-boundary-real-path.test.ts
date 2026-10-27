// @vitest-environment jsdom
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { act, createElement, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import type { OrchestratorBackend } from '@/lib/lane/orchestrator-backends/types';
import { useOrchestratorStream } from '@/components/desktop/thoughts/useOrchestratorStream';
import type { OrchestratorStreamResult } from '@/components/desktop/thoughts/use-orchestrator-stream/types';
import { serializeTranscriptForStorage } from '@/lib/transcripts/history-serde';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { ComposerArea } from '@/components/desktop/thoughts/chat-panel/ComposerArea';
import { useBufferedOrchestratorSend } from '@/components/desktop/thoughts/chat-panel/useBufferedOrchestratorSend';
import { useDefaultComposerSendBuffer } from '@/components/desktop/thoughts/chat-panel/useDefaultComposerSendBuffer';
import { ChatMessageList } from '@/components/desktop/thoughts/chat-panel/ChatMessageList';
import { useOrchestratorMobile } from '@/components/mobile/hooks/useOrchestratorMobile';
import type { MobileOrchestratorThread } from '@/lib/mobile/types';

const connection = vi.hoisted(() => ({ socket: null as WebSocket | null }));
vi.mock('@/components/desktop/thoughts/use-orchestrator-stream/shared', async original => ({
  ...await original<typeof import('@/components/desktop/thoughts/use-orchestrator-stream/shared')>(),
  openOrchestratorWebSocket: () => connection.socket,
}));
vi.mock('@/components/desktop/hooks/DesktopWebSocketContext', () => ({ useSharedDesktopWs: () => {} }));
vi.mock('@/components/desktop/thoughts/InputButtons', () => ({ InputButtons: () => null }));
vi.mock('@/components/desktop/thoughts/chat-panel/SlashCommandPicker', () => ({ SlashCommandPicker: () => null }));
vi.mock('@/components/desktop/thoughts/chat-panel/ComposerStatusBar', () => ({ ComposerStatusBar: () => null }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'o8-steer-boundary-')));
const repo = join(fixture, 'repo'); mkdirSync(repo);
vi.stubEnv('O8_DATA_DIR', fixture); vi.stubEnv('CORTEX_IDE_DATA_DIR', fixture);
vi.stubEnv('CORTEX_IDE_DB_PATH', join(fixture, 'queue.db'));
const store = await import('@/lib/llm/chat-history-store');
const { getSqlite, closeDb } = await import('@/lib/db');
const { ensureV71ComposerQueueSchema } = await import('@/lib/db/v71-composer-queue-migration');
ensureV71ComposerQueueSchema(getSqlite());
const registry = await import('@/lib/lane/orchestrator-backends/registry');
const { runBoundChatContinuation } = await import('@/lib/ws-server/bound-chat-continuation');
const { runQueuedComposerSteer } = await import('@/lib/ws-server/composer-queue-heartbeat');
const queue = await import('@/lib/orchestrator/composer-queue');
const { POST, GET } = await import('@/app/api/orchestrator/composer-queue/route');
const host = document.createElement('div'); document.body.append(host);
let root = createRoot(host);
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ font: '', measureText: (text: string) => ({ width: text.length * 6 }) } as unknown as CanvasRenderingContext2D);
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
const phoneWrites: Array<{ messages: Array<{ id: string; content: string; steerAnchor?: unknown }> }> = [];
vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
  if (url.startsWith('/api/v2/chat-history?')) return Response.json({ messages: store.readPersistedLlmChat(new URL(url, 'http://localhost').searchParams.get('tabId')!)?.history.messages ?? [] });
  if (url === '/api/v2/chat-history' && init?.method === 'POST') { phoneWrites.push(JSON.parse(init.body as string)); return Response.json({ ok: true }); }
  if (!String(url).startsWith('/api/orchestrator/composer-queue')) return Response.json({});
  const req = new NextRequest(new URL(url, 'http://localhost'), { method: init?.method, body: init?.body, headers: { host: 'localhost', 'Content-Type': 'application/json' } });
  return init?.method === 'POST' ? POST(req) : GET(req);
}));
let stream: OrchestratorStreamResult;
function Harness({ messages: restored, threadId, backend, busy }: { messages: MobileTranscriptEntry[]; threadId: string; backend: 'pi' | 'codex'; busy: boolean }) {
  const activeStream = useOrchestratorStream(repo, { threadId });
  useEffect(() => { stream = activeStream; }, [activeStream]);
  const messages = busy ? activeStream.messages : restored;
  const [input, setInput] = useState('');
  const latestInputRef = useRef(input);
  useEffect(() => { latestInputRef.current = input; }, [input]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { dispatch, capture } = useBufferedOrchestratorSend({ active: true, backend, model: backend, mode: 'multitask', solo: false,
    effort: 'low', permissionMode: 'full', collide: false, projectId: null, context: '', send: () => null });
  const result = useDefaultComposerSendBuffer({ active: true, backend, busy, threadId, repoPath: repo, attachedImages: [],
    latestInputRef, inputRef, setInput, addAttachedImage: () => {}, clearAttachments: () => {}, dispatch, captureQueuedSend: capture,
    interrupt: () => {}, undoSend: () => {}, shouldBypass: () => false, sendUnbuffered: () => {} });
  return createElement('div', null,
    createElement(ChatMessageList, { displayMessages: messages, displayWaiting: busy, threadId,
      activeTargetLabel: 'Lead', activeTargetColor: 'var(--t-accent)', thoughtsMutedGlass: 'transparent', thoughtsElevatedBorder: 'none', thoughtsElevatedShadow: 'none', emptyStateFallback: null,
      composerQueue: { items: busy ? result.durable.transcriptItems : [], canSteer: result.durable.canSteer, onSteer: () => {}, onCancel: result.sendBuffer.cancelQueued } }),
    createElement(ComposerArea, { input, inputLabel: 'Steer fixture', onInputChange: setInput,
      activeComposer: true, isOrchestratorMode: true, displayWaiting: busy, chatMessages: messages, activeTargetLabel: 'Lead', targetAgentExists: true,
      thoughtsBodyBackground: 'transparent', enhancing: false, preEnhanceInput: null, onEnhance: () => {}, onUndoEnhance: () => {},
      onSubmit: result.handleSend, onSteer: result.handleSteer, canSteerLive: result.durable.canSteer, queueSaving: result.saving, onSlashCommand: () => {}, modelLabel: backend,
      effort: 'low', onEffortChange: () => {}, adaptiveEnabled: false, displayMessagesCount: messages.length, hasAssistantActivity: true, attachedImages: [] }));
}
async function typeAndSubmit(text: string) {
  const textarea = host.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
}

afterEach(async () => { await act(async () => root.unmount()); root = createRoot(host); vi.restoreAllMocks(); vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ font: '', measureText: (text: string) => ({ width: text.length * 6 }) } as unknown as CanvasRenderingContext2D); });
afterAll(async () => { await act(async () => root.unmount()); host.remove(); closeDb(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(fixture, { recursive: true, force: true }); });

it.each([
  { backendId: 'pi', count: 2, identical: false }, { backendId: 'codex', count: 2, identical: false },
  { backendId: 'pi', count: 1, identical: false }, { backendId: 'pi', count: 2, identical: true },
] as const)('agrees on phone and desktop after $count $backendId steers (identical: $identical), completion and history reload', async ({ backendId, count, identical }) => {
  const threadId = `thoughts-steer-${backendId}-${count}-${identical}`;
  mkdirSync(join(fixture, 'chat-history'), { recursive: true });
  writeFileSync(join(fixture, 'chat-history', `${threadId}.json`), JSON.stringify({ repoPath: repo, backend: backendId, messages: [] }));
  let emit!: (event: OrchestratorEvent) => void;
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const native = vi.fn<NonNullable<OrchestratorBackend['liveSteer']>>(async (_repo, _text, options) => {
    options.beforeAdmit();
    // The provider can answer before its acknowledgement reaches the caller.
    emit({ type: 'text', text: 'After steer. ' });
    return { accepted: true };
  });
  const backend = { id: backendId, label: 'Fixture runtime', liveSteer: native,
    ensureSession: () => ({ sessionName: 'fixture-session' }), peekSession: () => null,
    sendTurn: async (_repo: string, _text: string, callback: (event: OrchestratorEvent) => void) => { emit = callback; callback({ type: 'text', text: 'Before steer. ' }); await gate; },
  } as unknown as OrchestratorBackend;
  vi.spyOn(registry, 'getOrchestratorBackend').mockReturnValue(backend);
  connection.socket = { readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn() } as unknown as WebSocket;
  await act(async () => root.render(createElement(Harness, { messages: [], threadId, backend: backendId, busy: true })));
  await act(async () => connection.socket!.onopen?.(new Event('open')));
  const run = runBoundChatContinuation({ repoPath: repo, origin: { threadId, turnId: 'assistant-original', backend: backendId,
    model: backendId, effort: 'low', permissionMode: 'full', mode: 'fleet', pickedMode: 'multitask' },
    message: 'Start the task', assistantMessageId: 'assistant-original', check: () => {} },
  { registerAbort: () => () => {}, publish: (_session, event, data) => connection.socket!.onmessage?.({ data: JSON.stringify({ channel: 'orchestrator', event, data }) } as MessageEvent) });
  await vi.waitFor(() => expect(emit).toBeTypeOf('function'));
  emit({ type: 'text', text: 'More before. ' });
  emit({ type: 'tool_use', name: 'boundary_probe', id: 'pending-probe', input: {} });
  const target = { repoPath: repo, threadId };
  const steer = async (text: string) => {
    await typeAndSubmit(text);
    const item = queue.listQueuedComposerSends(target).find(item => item.payload.text === text)!;
    expect(item.intent).toBe('steer-now');
    await runQueuedComposerSteer(queue.claimComposerSteer(item.id)!);
    await act(async () => window.dispatchEvent(new Event('o8:lifecycle-reconcile')));
    return item;
  };
  const render = async (reload = false) => {
    const history = store.readPersistedLlmChat(threadId)!.history;
    const messages = store.mapLlmHistoryToMobileTranscript(history.messages);
    await act(async () => root.render(createElement(Harness, { messages, threadId, backend: backendId, busy: !reload })));
    if (!reload) await vi.waitFor(() => expect(host.querySelector('textarea')?.getAttribute('placeholder')).toBe('Steer the agent…'));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)); });
    return [...host.querySelectorAll('[data-o8-message-id]')].map(node => node.textContent!);
  };
  try {
    await render();
    const first = await steer('First correction');
    expect(await render()).toEqual([expect.stringContaining('Start the task'), expect.stringContaining('Before steer.'), expect.stringContaining('First correction'), expect.stringContaining('After steer.')]);
    const second = count === 2 ? await steer(identical ? 'First correction' : 'Second correction') : null;
    const savedSteers = store.readPersistedLlmChat(threadId)!.history.messages.filter(entry => entry.id?.startsWith('composer-steer-'));
    expect(savedSteers.map(entry => entry.id)).toEqual([`composer-steer-${first.id}`, ...(second ? [`composer-steer-${second.id}`] : [])]);
    emit({ type: 'tool_result', name: 'boundary_probe', id: 'pending-probe', output: 'probe-output' });
    emit({ type: 'done', sessionId: 'fixture-session', cost: null }); finish(); await run;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)); });
    expect(stream.messages.find(message => message.id === 'assistant-original')?.toolCalls).toEqual([expect.objectContaining({ id: 'pending-probe', status: 'done' })]);
    // The normal desktop owner saves the aggregate stream, never its display slices.
    store.writePersistedLlmChat(threadId, { ...store.readPersistedLlmChat(threadId)!.history, messages: serializeTranscriptForStorage(stream.messages).map(message => ({ ...message, id: message.id!, role: message.role!, content: message.content!, timestamp: message.timestamp! })) });
    const live = await render(true);
    expect(live).toHaveLength(count === 2 ? 6 : 4);
    expect(live[2]).toContain('First correction');
    if (second) { expect(live[4]).toContain(identical ? 'First correction' : 'Second correction'); expect(live[5]).toContain('After steer.'); }
    expect(native).toHaveBeenCalledTimes(count);
    closeDb(); ensureV71ComposerQueueSchema(getSqlite());
    await act(async () => root.unmount()); root = createRoot(host);
    expect(await render(true)).toEqual(live);
    const canonicalText = store.readPersistedLlmChat(threadId)!.history.messages.find(entry => entry.id === 'assistant-original')!.content;
    const phoneHost = document.createElement('div'); document.body.append(phoneHost); const phoneRoot = createRoot(phoneHost);
    const oldSocket = globalThis.WebSocket;
    vi.stubGlobal('WebSocket', class { static OPEN = 1; readyState = 1; send() {} close() {} });
    let phone: ReturnType<typeof useOrchestratorMobile> | undefined;
    const thread: MobileOrchestratorThread = { id: threadId, title: 'Steer fixture', repoPath: repo, repoName: 'Fixture', repoBranch: 'main', githubOwner: null,
      githubRepo: null, runtime: backendId === 'pi' ? 'claude-code' : 'codex', status: 'ready', lastMessageAt: new Date().toISOString(), messageCount: 0, projectId: null, backend: backendId, agent: null };
    function Phone() { const result = useOrchestratorMobile({ activeThread: thread }); useEffect(() => { phone = result; }, [result]); return createElement('output', null, result.transcript.map(entry => entry.text).join('|')); }
    phoneWrites.length = 0;
    try {
      await act(async () => phoneRoot.render(createElement(Phone)));
      await vi.waitFor(() => expect(phone?.transcriptLoading).toBe(false));
      const expected = ['Start the task', 'Before steer. More before.', 'First correction', 'After steer.',
        ...(second ? [identical ? 'First correction' : 'Second correction', 'After steer.'] : [])];
      expect(phone!.transcript.filter(entry => entry.role === 'user' || entry.role === 'assistant').map(entry => entry.text.replace(/\s+/g, ' ').trim())).toEqual(expected);
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 850)); });
      const persisted = phoneWrites.at(-1)!.messages;
      expect(persisted.filter(entry => entry.id === 'assistant-original')).toEqual([expect.objectContaining({ content: canonicalText })]);
      expect(persisted.filter(entry => entry.id.startsWith('composer-steer-'))).toHaveLength(count);
      expect(persisted.filter(entry => entry.id.startsWith('composer-steer-')).every(entry => entry.steerAnchor)).toBe(true);
      expect(persisted.some(entry => entry.id.includes(':before:'))).toBe(false);
    } finally { await act(async () => phoneRoot.unmount()); phoneHost.remove(); vi.stubGlobal('WebSocket', oldSocket); }
  } finally { finish(); await run.catch(() => {}); }
});
