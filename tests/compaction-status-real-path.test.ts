// @vitest-environment jsdom
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import type { RealtimeMutationPublishRequest } from '@/lib/realtime/types';

vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => null }));
vi.mock('@/lib/repos/repo-path-registry', () => ({ resolveRepoPathFromRegistry: async (repoRoot: string) => ({ ok: true, repoRoot }) }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => true) }));
vi.mock('@/lib/panel/ws-port-client', () => ({ getBrowserWsPort: () => 47125 }));
vi.mock('@/lib/entitlement/context', () => ({ useEntitlement: () => ({ plan: 'free' }) }));
const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-compaction-status-')));
const repoPath = join(directory, 'repo'); mkdirSync(repoPath);
vi.stubEnv('O8_DATA_DIR', directory); vi.stubEnv('CORTEX_IDE_DATA_DIR', directory);
vi.stubEnv('CORTEX_IDE_DB_PATH', join(directory, 'queue.db'));
const { persistCanonicalChatHistoryRecord, readPersistedLlmChat } = await import('@/lib/llm/chat-history-store');
const historyRoute = await import('@/app/api/v2/chat-history/route');
const compactRoute = await import('@/app/api/orchestrator/compact/route');
const queueRoute = await import('@/app/api/orchestrator/composer-queue/route');
const queue = await import('@/lib/orchestrator/composer-queue');
const { getSqlite, closeDb } = await import('@/lib/db');
const { ensureV71ComposerQueueSchema } = await import('@/lib/db/v71-composer-queue-migration');
const { withLiveCompaction } = await import('@/lib/orchestrator/live-compaction');
const { publishRealtimeMutation } = await import('@/lib/realtime/publisher');
const { DesktopWebSocketProvider } = await import('@/components/desktop/hooks/DesktopWebSocketContext');
const { ProfiledChatMessageList } = await import('@/components/desktop/thoughts/chat-panel/ProfiledChatMessageList');
const { ComposerArea } = await import('@/components/desktop/thoughts/chat-panel/ComposerArea');
ensureV71ComposerQueueSchema(getSqlite());

class Socket {
  static OPEN = 1; static CONNECTING = 0; static current: Socket;
  readyState = 1; onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  send() {} close() {}
  constructor() { Socket.current = this; }
}
const threadId = 'thoughts-compaction-status';
const scope = { repoPath, threadId };
let root: Root; let host: HTMLDivElement; let seq = 0;
let entries: MobileTranscriptEntry[]; let waiting = true;
let dropTerminal = false; let statusUnavailable = false;
let captured: RealtimeMutationPublishRequest['mutation'][];
function receive(mutation: RealtimeMutationPublishRequest['mutation']) {
  Socket.current.onmessage?.({ data: JSON.stringify({ channel: 'realtime', event: 'batch', data: {
    delivery: 'live', stream: 'global', events: [{ protocol: 1, seq: ++seq, stream: 'global', channel: 'mutation',
      event: mutation.status === 'completed' || mutation.status === 'failed' ? 'mutation.settled' : 'mutation.record',
      ts: new Date().toISOString(), data: { mutation } }],
  } }) } as MessageEvent);
}
async function render() {
  await act(async () => root.render(createElement(DesktopWebSocketProvider, null,
    createElement('section', null,
      createElement(ProfiledChatMessageList, { displayMessages: entries, displayWaiting: waiting, isOrchestratorMode: true,
        threadId, repoPath, active: true, activeTargetLabel: 'Lead', activeTargetColor: 'var(--t-accent)',
        thoughtsMutedGlass: 'var(--t-hover)', thoughtsElevatedBorder: 'none', thoughtsElevatedShadow: 'none', emptyStateFallback: null,
        composerQueue: { items: queue.listComposerTranscriptSends(scope), canSteer: false, onSteer() {}, onCancel() {} } }),
      createElement(ComposerArea, { input: '', onInputChange() {}, isOrchestratorMode: true, displayWaiting: waiting,
        chatMessages: entries, sessionRulesThreadId: threadId, repoPath, showBrain: false, activeTargetLabel: 'Lead',
        targetAgentExists: true, thoughtsBodyBackground: 'transparent', enhancing: false, preEnhanceInput: null,
        onEnhance() {}, onUndoEnhance() {}, onSubmit() {}, onSlashCommand() {}, modelLabel: 'Default', effort: 'high',
        onEffortChange() {}, adaptiveEnabled: false, repoLabel: 'Sample', displayMessagesCount: entries.length, hasAssistantActivity: true })))));
}
async function loadHistory() {
  const response = await historyRoute.GET(new NextRequest(`http://localhost/api/v2/chat-history?tabId=${threadId}`));
  const data = await response.json();
  entries = data.messages.map((message: { content: string; [key: string]: unknown }) => ({ ...message, text: message.content }));
}
async function status() {
  const get = Reflect.get(compactRoute, 'GET');
  return typeof get === 'function' ? get(new NextRequest(`http://localhost/api/orchestrator/compact?repoPath=${encodeURIComponent(repoPath)}&threadId=${threadId}`))
    : Response.json({}, { status: 405 });
}
async function start() {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const running = new Promise<void>(resolve => { entered = resolve; });
  let job!: Promise<void>;
  await act(async () => {
    job = withLiveCompaction(scope, async () => { entered(); await gate; });
    await running;
  });
  return { release, job };
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ font: '', measureText: (text: string) => ({ width: text.length * 6 }) } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    if (String(input).startsWith('/api/orchestrator/compact?')) {
      if (statusUnavailable) throw new Error('Status unavailable');
      return status();
    }
    return Response.json({});
  }));
  getSqlite().exec('DELETE FROM composer_send_queue');
  rmSync(join(directory, 'compaction-status'), { recursive: true, force: true });
  entries = [{ id: 'question', role: 'user', text: 'Inspect the sample.', timestamp: Date.now() - 2000 },
    { id: 'answer', role: 'assistant', text: 'The inspection is running.', timestamp: Date.now() - 1000 }];
  persistCanonicalChatHistoryRecord(threadId, { repoPath, backend: 'codex', messages: entries.map(entry => ({ ...entry, content: entry.text })) });
  waiting = true; dropTerminal = false; statusUnavailable = false; captured = [];
  vi.mocked(publishRealtimeMutation).mockImplementation(async request => {
    captured.push(request.mutation);
    if (!(dropTerminal && ['completed', 'failed'].includes(request.mutation.status))) receive(request.mutation);
    return true;
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await render(); await act(async () => Socket.current.onopen?.());
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });
afterAll(() => { closeDb(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

it('reconciles a missing terminal event from the persisted receipt and history without duplicating a follow-up', async () => {
  const operation = await start();
  try {
    const payload = { text: 'Keep this follow-up.', wireMessage: 'Keep this follow-up.', images: [], routing: {
      backend: 'codex', model: 'default', effort: 'high', permissionMode: 'plan', mode: 'single', pickedMode: 'solo', collide: false } };
    const response = await queueRoute.POST(new NextRequest('http://localhost/api/orchestrator/composer-queue', { method: 'POST',
      headers: { host: 'localhost', 'Content-Type': 'application/json' }, body: JSON.stringify({ ...scope, id: 'follow-up', intent: 'send-next', payload }) }));
    expect(response.status).toBe(200);
    await render(); expect(host.textContent?.match(/Keep this follow-up\./g)).toHaveLength(1);
    dropTerminal = true;
    await act(async () => { operation.release(); await operation.job; });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1200)); });
    expect(host.textContent).not.toContain('Compaction in progress');
    expect(host.querySelector('[data-compaction-phase="complete"]')).not.toBeNull();
    const claimed = queue.claimNextComposerSend(scope)!; expect(claimed.id).toBe('follow-up');
    expect(queue.admitComposerSend(claimed.id)).toBe(true);
    const record = readPersistedLlmChat(threadId)!.history;
    persistCanonicalChatHistoryRecord(threadId, { ...record, messages: [...record.messages,
      { id: 'composer-queued-follow-up', role: 'user', content: payload.text, timestamp: Date.now() }] });
    queue.settleComposerSend(claimed.id, { status: 'applied' });
    await loadHistory(); await render();
    expect(host.textContent?.match(/Keep this follow-up\./g)).toHaveLength(1);
    expect(queue.claimNextComposerSend(scope)).toBeNull();
    await act(async () => receive(captured.find(mutation => mutation.status === 'pending')!));
    expect(host.querySelector('[data-compaction-phase="compacting"]')).toBeNull();
  } finally { await act(async () => { operation.release(); await operation.job; }); }
});

it('keeps compaction independent when the assistant turn completes before compaction', async () => {
  const operation = await start();
  try {
    waiting = false;
    const record = readPersistedLlmChat(threadId)!.history;
    persistCanonicalChatHistoryRecord(threadId, { ...record, messages: [...record.messages,
      { id: 'turn-complete', role: 'assistant', content: 'The turn finished.', timestamp: Date.now() }] });
    await loadHistory(); await render();
    await vi.waitFor(() => expect(host.querySelector('[data-compaction-phase="compacting"]')).not.toBeNull());
    expect(host.textContent).not.toContain('Messages sent now will be queued');
  } finally { await act(async () => { operation.release(); await operation.job; }); }
});

it('stops claiming active compaction when its status cannot be verified', async () => {
  const operation = await start();
  try {
    await vi.waitFor(() => expect(host.querySelector('[data-compaction-phase="compacting"]')).not.toBeNull());
    statusUnavailable = true;
    const later = Date.now() + 46_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1200)); });
    expect(host.textContent).not.toContain('Compaction in progress');
    expect(host.querySelector('[data-compaction-phase="uncertain"]')).not.toBeNull();
    expect(host.textContent).toContain('Check status');
    await act(async () => receive(captured.find(mutation => mutation.status === 'pending')!));
    expect(host.querySelector('[data-compaction-phase="uncertain"]')).not.toBeNull();
  } finally { vi.useRealTimers(); await act(async () => { operation.release(); await operation.job; }); }
});

it('records requested, started and terminal times separately with one operation and exact conversation identity', async () => {
  const operation = await start();
  await act(async () => { operation.release(); await operation.job; });
  expect(captured.map(mutation => mutation.status)).toEqual(['queued', 'pending', 'completed']);
  expect(new Set(captured.map(mutation => mutation.mutationId)).size).toBe(1);
  expect(captured.every(mutation => mutation.repoPath === repoPath && mutation.surfaceId === threadId)).toBe(true);
  const response = await status(); expect(response.status).toBe(200);
  const snapshot = (await response.json()).operation;
  expect(snapshot.phase).toBe('complete');
  expect(snapshot.requestedAt).toBeLessThanOrEqual(snapshot.startedAt);
  expect(snapshot.startedAt).toBeLessThanOrEqual(snapshot.settledAt);
});

it.each(['failed', 'cancelled'] as const)('settles %s work and rejects its delayed start after a component reload', async phase => {
  await act(async () => {
    await expect(withLiveCompaction(scope, async () => {
      const error = new Error('Fixture compaction stopped');
      if (phase === 'cancelled') error.name = 'AbortError';
      throw error;
    })).rejects.toThrow('Fixture compaction stopped');
  });
  await act(async () => root.unmount()); root = createRoot(host);
  await render(); await act(async () => Socket.current.onopen?.());
  await vi.waitFor(() => expect(host.querySelector(`[data-compaction-phase="${phase}"]`)).not.toBeNull());
  await act(async () => receive(captured.find(mutation => mutation.status === 'pending')!));
  expect(host.querySelector('[data-compaction-phase="compacting"]')).toBeNull();
});

it('restores an active operation from the server on reload and keeps percentages absent until measured work arrives', async () => {
  const operation = await start();
  try {
    await act(async () => root.unmount()); root = createRoot(host);
    await render(); await act(async () => Socket.current.onopen?.());
    await vi.waitFor(() => expect(host.querySelector('[data-compaction-phase="compacting"]')).not.toBeNull());
    expect(host.querySelector('[role="progressbar"]')?.hasAttribute('aria-valuenow')).toBe(false);
    const pending = captured.find(mutation => mutation.status === 'pending')!;
    await act(async () => receive({ ...pending, compaction: { ...pending.compaction!, updatedAt: Date.now(), progress: { completed: 3, total: 8 } } }));
    expect(host.querySelector('progress')?.value).toBe(3);
    expect(host.querySelector('progress')?.max).toBe(8);
  } finally { await act(async () => { operation.release(); await operation.job; }); }
});

it('never revives a completed operation from a late live start before reload readback is available', async () => {
  const operation = await start();
  await act(async () => { operation.release(); await operation.job; });
  const oldStart = captured.find(mutation => mutation.status === 'pending')!;
  await act(async () => root.unmount()); root = createRoot(host);
  statusUnavailable = true;
  await render(); await act(async () => Socket.current.onopen?.());
  await act(async () => receive(oldStart));
  expect(host.textContent).not.toContain('Compaction in progress');
  expect(host.querySelector('[data-compaction-phase="compacting"]')).toBeNull();
  expect(host.querySelector('[data-compaction-phase="uncertain"]')).not.toBeNull();
});
