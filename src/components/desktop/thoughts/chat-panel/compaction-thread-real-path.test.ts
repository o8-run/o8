// @vitest-environment jsdom

import { EventEmitter } from 'node:events';
import { NextRequest } from 'next/server';
import type { RealtimeEventEnvelope } from '@/lib/realtime/types';
import { act, createElement, Fragment, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync, rmSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProfiledChatMessageList as ChatMessageList } from './ProfiledChatMessageList';
import { compactionThread } from './fixtures/compaction-thread';
import { resolveVisibleChatMessages } from './resolve-display-messages';
import { useOrchestratorStream } from '../useOrchestratorStream';
import type { OrchestratorStreamResult } from '../use-orchestrator-stream/types';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { deserializeStoredTranscript, serializeTranscriptForStorage } from '@/lib/transcripts/history-serde';
import { clearQueuedOrchestratorSessionPrelude } from '@/lib/orchestrator/store';
import { CompactionStatus } from './CompactionStatus';

const fixture = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return { root: mkdtempSync(join(tmpdir(), 'o8-compaction-render-')), socket: null as WebSocket | null, contextTokens: 0,
    compactGate: null as Promise<void> | null, compactStarted: () => {}, realCompact: false, failCompact: false, compactResponse: null as Promise<Response> | null,
    liveEvent: null as ((event: RealtimeEventEnvelope) => void) | null };
});
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => fixture.root }));
vi.mock('@/lib/search/conversations', () => ({ syncChatHistorySearchRecord: vi.fn(), deleteChatHistorySearchRecord: vi.fn() }));
vi.mock('../use-orchestrator-stream/shared', async (original) => ({
  ...await original<typeof import('../use-orchestrator-stream/shared')>(),
  openOrchestratorWebSocket: () => fixture.socket,
  ORCHESTRATOR_COMPACTION_STATUS_MIN_MS: 0,
}));
vi.mock('@/components/desktop/hooks/DesktopWebSocketContext', () => ({
  useSharedDesktopWs: (_key: unknown, callbacks: { onRealtimeEvent: typeof fixture.liveEvent }) => { fixture.liveEvent = callbacks.onRealtimeEvent; },
}));
vi.mock('@/lib/db/usage', () => ({ logUsage: vi.fn() }));
vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => null }));
vi.mock('@/lib/repos/repo-path-registry', () => ({ resolveRepoPathFromRegistry: async (repoRoot: string) => ({ ok: true, repoRoot }) }));
vi.mock('@/lib/operator/defaults', () => ({ resolveInAppOrchestratorEnabledSync: () => true }));
vi.mock('@/lib/orchestrator/compaction-scorer', () => ({ scoreCompactionSegment: async () => null }));
vi.mock('@/lib/runtimes/shared/cli-resolver', () => ({ resolveCli: async () => ({ path: 'synthetic-codex' }) }));
vi.mock('@/lib/providers/child-process', async original => ({ ...await original<typeof import('@/lib/providers/child-process')>(), spawn: () => {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
  fixture.compactStarted();
  void fixture.compactGate?.then(() => {
    child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Decisions made\n- Preserve the route check.' } }) + '\n'));
    child.emit('close', fixture.failCompact ? 1 : 0);
  });
  return child;
} }));
const { POST: compactRoute, GET: compactionStatusRoute } = await import('@/app/api/orchestrator/compact/route');
const { getCanonicalChatHistoryPath, persistCanonicalChatHistoryRecord } = await import('@/lib/llm/chat-history-store');
const threadId = 'thoughts-compaction-render';
let host: HTMLDivElement;
let root: Root;
let stream: OrchestratorStreamResult;

function Harness({ restored = [] }: { restored?: MobileTranscriptEntry[] }) {
  const result = useOrchestratorStream('/repo/sample', { threadId });
  useEffect(() => { stream = result; }, [result]);
  return createElement(Fragment, null, createElement(ChatMessageList, {
    displayMessages: resolveVisibleChatMessages({ historyEntries: [], chatMessages: restored, streamMessages: restored.length ? [] : result.messages,
      isOrchestratorMode: true, isChatMode: false }),
    repoPath: '/repo/sample', threadId, displayWaiting: result.status === 'busy', isOrchestratorMode: true, activeTargetLabel: 'Lead', activeTargetColor: 'var(--t-accent)',
    thoughtsMutedGlass: 'var(--t-hover)', thoughtsElevatedBorder: 'var(--t-divider-subtle)', thoughtsElevatedShadow: 'none', emptyStateFallback: null,
  }), createElement(CompactionStatus, { repoPath: '/repo/sample', threadId, messages: result.messages, turnBusy: result.status === 'busy' }));
}
function receive(event: string, data: Record<string, unknown>) {
  fixture.socket!.onmessage?.({ data: JSON.stringify({ channel: 'orchestrator', event, data: { threadId, backend: 'codex', ...data } }) } as MessageEvent);
}
const messageIds = () => [...host.querySelectorAll('[data-o8-message-id]')].map(node => node.getAttribute('data-o8-message-id'));
function persist(entries: MobileTranscriptEntry[]) {
  persistCanonicalChatHistoryRecord(threadId, { repoPath: '/repo/sample', messages: serializeTranscriptForStorage(entries) });
  return deserializeStoredTranscript(JSON.parse(readFileSync(getCanonicalChatHistoryPath(threadId), 'utf8')).messages);
}
beforeEach(async () => {
  fixture.contextTokens = 0;
  fixture.compactGate = null;
  fixture.realCompact = false;
  fixture.failCompact = false;
  fixture.compactStarted = () => {};
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ font: '', measureText: (text: string) => ({ width: text.length * 6 }) } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith('/api/orchestrator/compact?')) return compactionStatusRoute(new NextRequest(`http://localhost${String(input)}`));
    if (String(input).endsWith('/internal/realtime')) {
      const { mutation } = JSON.parse(init?.body as string);
      fixture.liveEvent?.({ protocol: 1, seq: 1, stream: 'global', channel: 'mutation', event: mutation.status === 'pending' ? 'mutation.record' : 'mutation.settled',
        ts: new Date().toISOString(), delivery: 'live', data: { mutation } });
      return new Response('{}');
    }
    if (String(input) === '/api/orchestrator/compact' && fixture.realCompact) {
      fixture.compactResponse = compactRoute(new NextRequest('http://localhost/api/orchestrator/compact', { method: 'POST', headers: init?.headers, body: init?.body }));
      return fixture.compactResponse;
    }
    if (String(input) === '/api/orchestrator/compact') { fixture.compactStarted(); await fixture.compactGate; }
    return new Response(JSON.stringify(String(input) === '/api/orchestrator/compact'
      ? { ok: true, applied: true, tokensAfter: 20, resumePrelude: 'Synthetic session context', transcript: [compactionThread[2], compactionThread[0]] }
      : String(input).startsWith('/api/runtime/telemetry') ? { telemetry: { contextTokens: fixture.contextTokens } } : {}), { status: 200 });
  }));
  fixture.socket = { readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn() } as unknown as WebSocket;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(createElement(Harness)));
  await act(async () => fixture.socket!.onopen?.(new Event('open')));
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); clearQueuedOrchestratorSessionPrelude('/repo/sample', threadId); localStorage.clear();
  if (vi.isFakeTimers()) { vi.clearAllTimers(); vi.useRealTimers(); }
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});
afterAll(() => rmSync(fixture.root, { recursive: true, force: true }));

describe('compaction through persisted history, live stream and real transcript components', () => {
  it.each([
    ['completed boundary', compactionThread[2]],
    ['operator prose', { id: 'operator-compact', role: 'user', text: 'Keep the compact layout.' }],
    ['assistant prose', { id: 'assistant-compact', role: 'assistant', text: 'The compaction check finished; now running the tests.' }],
    ['tool result', { id: 'tool-compact', role: 'tool', text: 'compact-status test passed' }],
    ['old failure', { id: 'old-compact-error', role: 'system', text: 'Compaction failed before send. Re-send this message.' }],
    ['old local status', { id: 'orch-compacting-123', role: 'system', text: 'Compacting to keep turn fast…' }],
  ] as const)('does not infer an active compaction from persisted %s during a busy turn', async (_name, last) => {
    const restored = persist([...compactionThread.slice(0, 2), { ...last, timestamp: compactionThread[2].timestamp! + 1 }]);
    act(() => stream.replaceTranscript(restored));
    await act(async () => receive('status', { status: 'busy' }));
    expect(stream.status).toBe('busy');
    expect(messageIds().at(-1)).toBe(last.id);
    expect(host.textContent).not.toContain('Compaction in progress');
    expect(host.textContent).not.toContain('Messages sent now will be queued and delivered after compaction completes.');
    expect(host.textContent).not.toContain('Planning next moves');
    expect(host.textContent).toContain(last.role === 'user' ? 'Waiting for response' : 'Working · phase unknown');
  });
  it.each([false, true])('keeps compact status while the pre-send summarizer is held, then settles it (failure: %s)', async (failed) => {
    fixture.realCompact = true;
    fixture.failCompact = failed;
    act(() => stream.replaceTranscript(persist(compactionThread.slice(0, 2).map((entry, index) => ({ ...entry, timestamp: Date.now() - 60_000 + index * 1_000 })))));
    fixture.contextTokens = 850_001;
    await act(async () => { receive('status', { status: 'ready' }); await stream.fetchTelemetrySnapshot(); });
    let release = () => {};
    fixture.compactGate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { fixture.compactStarted = resolve; });
    let handle: ReturnType<OrchestratorStreamResult['send']> = null;
    try {
      act(() => { handle = stream.send('Continue the original check.', { backend: 'codex' }); });
      await act(async () => { await started; });
      expect(host.textContent).toContain('Compacting to keep turn fast…');
      await vi.waitFor(() => expect(host.querySelector('[data-compaction-phase="compacting"]')).not.toBeNull());
      expect(host.textContent).not.toContain('Messages sent now will be queued');
      await act(async () => { release(); await fixture.compactResponse; await new Promise(resolve => setTimeout(resolve, 0)); });
      expect((await fixture.compactResponse)?.status).toBe(failed ? 500 : 200);
      expect(host.textContent).not.toContain('Compacting to keep turn fast…');
      expect(host.textContent).not.toContain('Compaction in progress');
      expect(host.textContent).not.toContain('Messages sent now will be queued');
      expect(host.querySelector('[data-compaction-phase="compacting"]')).toBeNull();
      expect(host.querySelector(`[data-compaction-phase="${failed ? 'failed' : 'complete'}"]`)).not.toBeNull();
      if (failed) {
        expect(stream.messages.at(-1)?.text).toContain('Compaction failed before send');
        expect((fixture.socket!.send as ReturnType<typeof vi.fn>).mock.calls.map(([raw]) => JSON.parse(raw as string))
          .filter(message => message.type === 'orchestrator-send')).toHaveLength(0);
        await act(async () => receive('status', { status: 'busy' }));
        expect(host.textContent).not.toContain('Compaction in progress');
        return;
      }
      expect(messageIds().slice(0, 2)).toEqual(compactionThread.slice(0, 2).map(entry => entry.id));
      expect(stream.messages.filter(entry => entry.type === 'compaction')).toHaveLength(1);
      const sends = (fixture.socket!.send as ReturnType<typeof vi.fn>).mock.calls.map(([raw]) => JSON.parse(raw as string))
        .filter(message => message.type === 'orchestrator-send');
      expect(sends).toHaveLength(1);
      expect(sends[0].displayMessage).toBe('Continue the original check.');
      expect(stream.messages.filter(entry => entry.text === 'Continue the original check.')).toHaveLength(1);
    } finally {
      release();
      await fixture.compactResponse;
      await new Promise(resolve => setTimeout(resolve, 0));
      if (handle) act(() => stream.undoSend(handle!));
    }
  });
  it('adds one boundary through the real automatic-compaction effect', async () => {
    vi.useFakeTimers();
    act(() => stream.replaceTranscript(persist(compactionThread.slice(0, 2))));
    fixture.contextTokens = 300_001;
    await act(async () => { receive('status', { status: 'ready' }); await stream.fetchTelemetrySnapshot(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    expect(messageIds()).toEqual(compactionThread.slice(0, 3).map(entry => entry.id));
    expect(host.textContent).not.toContain('The route inspection is complete.');
  });
  it('preserves the old reply and boundary when compaction runs before a queued send', async () => {
    act(() => stream.replaceTranscript(persist(compactionThread.slice(0, 2))));
    fixture.contextTokens = 850_001;
    await act(async () => { receive('status', { status: 'ready' }); await stream.fetchTelemetrySnapshot(); });
    let handle: ReturnType<OrchestratorStreamResult['send']> = null;
    await act(async () => {
      handle = stream.send(compactionThread[3].text, { backend: 'codex' });
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(messageIds().slice(0, 3)).toEqual(compactionThread.slice(0, 3).map(entry => entry.id));
    expect(stream.messages[3]?.text).toBe(compactionThread[3].text);
    if (handle) act(() => stream.undoSend(handle!));
  });
  it('preserves live turns when priming the compacted session and inserts one divider', async () => {
    const first = persist(compactionThread.slice(0, 2));
    act(() => stream.replaceTranscript(first));
    await act(async () => { await stream.compactNow(); });
    expect(messageIds()).toEqual(compactionThread.slice(0, 3).map(entry => entry.id));
    expect(host.textContent).toContain('Context compacted · 1 turn · 11:33');
    expect(host.textContent).not.toContain('The route inspection is complete.');
    act(() => stream.appendLocalEntries(compactionThread.slice(3)));
    expect(messageIds()).toEqual(compactionThread.map(entry => entry.id));
  });
  it.each([true, false])('rejects carried turns and their output while preserving the active reply (scorer: %s)', async (scored) => {
    const entries = compactionThread.map(entry => !scored && entry.compaction ? { ...entry, compaction: { ...entry.compaction, scorer: undefined } } : entry);
    persist(entries.slice(0, 4));
    act(() => stream.replaceTranscript(entries.slice(0, 4)));
    await act(async () => {
      receive('output', { assistantMessageId: compactionThread[4].id, text: compactionThread[4].text });
      receive('turn-start', { userMessageId: 'orch-user-orch-send-prime', assistantMessageId: 'prime-reply', message: compactionThread[0].text, timestamp: compactionThread[0].timestamp });
      receive('output', { assistantMessageId: 'prime-reply', text: 'Synthetic summary stream must stay hidden.' });
      receive('status', { assistantMessageId: 'prime-reply', status: 'ready' });
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    });
    expect(host.textContent).not.toContain('Synthetic summary stream must stay hidden.');
    expect(messageIds()).toEqual(compactionThread.map(entry => entry.id));
    await act(async () => {
      receive('status', { assistantMessageId: compactionThread[4].id, status: 'ready' });
    });
    expect(messageIds()).toEqual(compactionThread.map(entry => entry.id));
    expect(stream.messages.find(entry => entry.id === compactionThread[4].id)?.text).toBe(compactionThread[4].text);
    expect(host.textContent).toContain(compactionThread[4].text);
    const restored = persist(stream.messages);
    await act(async () => root.render(createElement(Harness, { restored })));
    expect(messageIds()).toEqual(compactionThread.map(entry => entry.id));
  });
  it('renders the reloaded persisted order once, with the summary only behind its disclosure', async () => {
    const restored = persist(compactionThread);
    await act(async () => root.render(createElement(Harness, { restored })));
    expect(messageIds()).toEqual(compactionThread.map(entry => entry.id));
    const divider = host.querySelector('[data-o8-message-id="compact-sample"]')!;
    expect(divider.textContent).toContain('Context compacted · 1 turn · 11:33');
    expect(host.textContent).not.toContain('(COMPACTED');
    expect(host.textContent).not.toContain('The route inspection is complete.');
    act(() => divider.querySelector('button')!.click());
    expect(divider.textContent).toContain('The route inspection is complete.');
    expect(host.querySelectorAll('[data-o8-message-id="orch-user-orch-send-first"]')).toHaveLength(1);
  });
  it('keeps a later real send even when it repeats the kept message text', async () => {
    const repeated = compactionThread.map(entry => entry.id === compactionThread[3].id ? { ...entry, text: compactionThread[0].text } : entry);
    await act(async () => root.render(createElement(Harness, { restored: persist(repeated) })));
    expect(messageIds()).toEqual(compactionThread.map(entry => entry.id));
  });
  it('keeps the persisted compaction position when a queued send has an earlier timestamp', () => {
    const queued = compactionThread.map(entry => entry.id === compactionThread[3].id
      ? { ...entry, timestamp: compactionThread[2].timestamp! - 10 } : entry);
    act(() => stream.replaceTranscript(persist(queued)));
    expect(messageIds()).toEqual(compactionThread.map(entry => entry.id));
  });
});
