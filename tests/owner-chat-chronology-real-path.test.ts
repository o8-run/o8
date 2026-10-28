// @vitest-environment jsdom
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { serializeTranscriptForStorage } from '@/lib/transcripts/history-serde';
import { resolveDisplayMessages } from '@/components/desktop/thoughts/chat-panel/resolve-display-messages';
import { mergeSameThreadHistoryLoad } from '@/components/desktop/thoughts/utils';
import { ChatMessageList } from '@/components/desktop/thoughts/chat-panel/ChatMessageList';
import { useOrchestratorStream } from '@/components/desktop/thoughts/useOrchestratorStream';
import type { OrchestratorStreamResult } from '@/components/desktop/thoughts/use-orchestrator-stream/types';

const transport = vi.hoisted(() => ({ socket: null as WebSocket | null, summarize: () => {}, prompts: [] as string[] }));
vi.mock('@/components/desktop/thoughts/use-orchestrator-stream/shared', async original => ({
  ...await original<typeof import('@/components/desktop/thoughts/use-orchestrator-stream/shared')>(),
  openOrchestratorWebSocket: () => transport.socket,
}));
vi.mock('@/components/desktop/hooks/DesktopWebSocketContext', () => ({ useSharedDesktopWs: () => {} }));
vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => null }));
vi.mock('@/lib/repos/repo-path-registry', () => ({ resolveRepoPathFromRegistry: async (repoRoot: string) => ({ ok: true, repoRoot }) }));
vi.mock('@/lib/operator/defaults', () => ({ resolveInAppOrchestratorEnabledSync: () => true }));
vi.mock('@/lib/orchestrator/compaction-scorer', () => ({ scoreCompactionSegment: async () => null }));
vi.mock('@/lib/db/usage', () => ({ logUsage: vi.fn() }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
vi.mock('@/lib/runtimes/shared/cli-resolver', () => ({ resolveCli: async () => ({ path: 'fixture-summary' }) }));
vi.mock('@/lib/providers/child-process', async original => ({
  ...await original<typeof import('@/lib/providers/child-process')>(), spawn: (_command: string, args: string[]) => {
    transport.prompts.push(args.at(-1)!);
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
    transport.summarize = () => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Decisions made\n- Keep the fixture order.' } }) + '\n'));
      child.emit('close', 0);
    };
    return child;
  },
}));
// Use the real transcript and iframe boundary. Canvas metrics are absent in jsdom.
vi.mock('@/lib/pretext/hooks', () => ({ usePretextHeight: () => 24 }));
const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'o8-owner-chronology-')));
const repo = join(fixture, 'repo'); mkdirSync(repo);
// This fixture models an existing installation, after its historical migrations.
for (const marker of ['.transcript-order-repaired-v1', '.composer-preamble-repaired-v1']) {
  writeFileSync(join(fixture, marker), 'fixture');
}
vi.stubEnv('O8_DATA_DIR', fixture); vi.stubEnv('CORTEX_IDE_DATA_DIR', fixture);
vi.stubEnv('CORTEX_IDE_DB_PATH', join(fixture, 'history.db'));
const store = await import('@/lib/llm/chat-history-store');
const { closeDb } = await import('@/lib/db');
const { GET: readHistory, POST: saveHistory } = await import('@/app/api/v2/chat-history/route');
const { POST: compact } = await import('@/app/api/orchestrator/compact/route');
const { placeTranscriptVisualizations } = await import('@/lib/visualizations/transcript');
const threadId = 'thoughts-owner-chronology-fixture';
const at = Date.now() - 100_000;
const visual = { kind: 'o8-visualization' as const, id: 'vis-12345678-1234-1234-1234-123456789abc',
  title: 'Fixture chart', height: 100, createdAt: new Date(at + 250).toISOString() };
const entries: MobileTranscriptEntry[] = Array.from({ length: 35 }, (_, i) => [
  { id: `user-${i}`, role: 'user' as const, text: `Request ${i}`, timestamp: at + i * 1000 },
  { id: `reply-${i}`, role: 'assistant' as const, text: `Answer ${i}`, timestamp: at + i * 1000 + 500,
    ...(i === 0 ? { toolCalls: [{ id: 'render', name: 'o8_html_render', args: {}, status: 'done' as const, result: JSON.stringify({ visualization: visual }) }] } : {}) },
]).flat();
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let stream: OrchestratorStreamResult;
function Harness({ restored = [], history = [] }: { restored?: MobileTranscriptEntry[]; history?: MobileTranscriptEntry[] }) {
  const current = useOrchestratorStream(repo, { threadId });
  useEffect(() => { stream = current; }, [current]);
  return createElement(ChatMessageList, { displayMessages: resolveDisplayMessages({ historyEntries: history, chatMessages: restored, streamMessages: current.messages }),
    displayWaiting: false, threadId, isOrchestratorMode: true, activeTargetLabel: 'Fixture', activeTargetColor: 'var(--t-accent)',
    thoughtsMutedGlass: 'transparent', thoughtsElevatedBorder: 'none', thoughtsElevatedShadow: 'none', emptyStateFallback: null });
}
const ids = (messages: readonly { id: string }[]) => messages.map(entry => entry.id);
const renderedIds = () => [...host.querySelectorAll('[data-o8-message-id]')].map(node => node.getAttribute('data-o8-message-id'));
function persist(messages: MobileTranscriptEntry[]) {
  store.persistCanonicalChatHistoryRecord(threadId, { repoPath: repo, messages: serializeTranscriptForStorage(messages) });
}
async function page(before?: string) {
  const params = new URLSearchParams({ tabId: threadId, limit: '20', ...(before ? { before } : {}) });
  const response = await readHistory(new NextRequest(`http://localhost/api/v2/chat-history?${params}`));
  expect(response.status).toBe(200);
  return await response.json() as { messages: Parameters<typeof store.mapLlmHistoryToMobileTranscript>[0]; page: { beforeCursor: string } };
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({})));
  transport.socket = { readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn() } as unknown as WebSocket;
  persist(entries);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(createElement(Harness)));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); localStorage.clear(); vi.unstubAllGlobals(); });
afterAll(() => { closeDb(); vi.unstubAllEnvs(); rmSync(fixture, { recursive: true, force: true }); });

it('keeps an earlier live block before a fetched tail page, then backfills and reconnects without moving it below the tail', async () => {
  await act(async () => stream.replaceTranscript(entries));
  const tail = await page();
  const loaded = store.mapLlmHistoryToMobileTranscript(tail.messages);
  const merged = mergeSameThreadHistoryLoad(stream.messages, loaded);
  await act(async () => stream.replaceTranscript(merged.entries));
  expect(renderedIds()).toEqual(ids(entries));
  const older = await page(tail.page.beforeCursor);
  await act(async () => root.render(createElement(Harness, { restored: loaded, history: store.mapLlmHistoryToMobileTranscript(older.messages) })));
  expect(renderedIds()).toEqual(ids(entries));
  expect(placeTranscriptVisualizations([visual], stream.messages).size).toBe(0); // Original tool result owns the chart.
});

it('weaves overlapping retained history and stream by identity instead of appending older rows', async () => {
  await act(async () => stream.replaceTranscript(entries));
  await act(async () => root.render(createElement(Harness, { restored: entries.slice(-20) })));
  expect(renderedIds()).toEqual(ids(entries));
});

it('preserves causal source order through hydration with equal, missing and late tool timestamps', async () => {
  const causal = entries.slice(0, 6).map((entry, index) => ({ ...entry,
    timestamp: index === 1 ? at + 90_000 : index === 3 ? undefined : at,
  }));
  await act(async () => stream.replaceTranscript(causal));
  expect(renderedIds()).toEqual(ids(causal));
});

it('keeps persisted original order when a stale partial write overlaps a pending turn and a queued send', () => {
  const causal = entries.slice(0, 6).map((entry, index) => ({ ...entry, timestamp: index === 1 ? at + 90_000 : at }));
  persist(causal);
  store.writePersistedLlmChat(threadId, { repoPath: repo, messages: causal.filter((_, i) => i % 2 === 0)
    .map(entry => ({ id: entry.id, role: entry.role, content: entry.text, timestamp: entry.timestamp! })) });
  expect(ids(store.readPersistedLlmChat(threadId)!.history.messages)).toEqual(ids(causal));
});

it('does not let a stale write remove a completed reply or its visualization-producing tool result', () => {
  const complete = { ...entries[1], persistedVersion: 4 };
  persist([entries[0], complete]);
  store.writePersistedLlmChat(threadId, { repoPath: repo, messages: [{ id: complete.id, role: complete.role,
    content: 'Partial answer', timestamp: complete.timestamp!, persistedVersion: 2 }] });
  const saved = store.readPersistedLlmChat(threadId)!.history.messages;
  expect(saved[1]).toMatchObject({ content: complete.text, persistedVersion: 4, toolCalls: complete.toolCalls });
  expect(placeTranscriptVisualizations([visual], store.mapLlmHistoryToMobileTranscript(saved)).size).toBe(0);
});

it('keeps visualization revisions at the producing identity through partial pages and ignores timestamp inversions', () => {
  const anchors = new Map<string, string>();
  const producing = entries.slice(0, 6);
  expect(placeTranscriptVisualizations([visual], producing, anchors).size).toBe(0);
  const revision = { ...visual, id: 'vis-87654321-4321-4321-4321-cba987654321', rootId: visual.id, version: 2 };
  const noTools = producing.map(entry => ({ ...entry, toolCalls: undefined }));
  expect([...placeTranscriptVisualizations([revision], noTools, anchors)]).toEqual([[1, [revision]]]);
  expect(placeTranscriptVisualizations([revision], noTools.slice(2), anchors).size).toBe(0);
  expect([...placeTranscriptVisualizations([revision], noTools, anchors)]).toEqual([[1, [revision]]]);
  const fallback = [{ ...noTools[0], timestamp: at + 100_000 }, ...noTools.slice(1)];
  const laterVisual = { ...visual, createdAt: new Date(at + 1500).toISOString() };
  expect([...placeTranscriptVisualizations([laterVisual], fallback)]).toEqual([[3, [laterVisual]]]);
  const remembered = new Map<string, string>();
  const between = { ...visual, createdAt: new Date(at + 100).toISOString() };
  expect([...placeTranscriptVisualizations([between], noTools, remembered)]).toEqual([[1, [between]]]);
  expect([...placeTranscriptVisualizations([between], noTools, remembered)]).toEqual([[1, [between]]]);
});

it('retains all visible turns and tools through a real compaction, racing output, reload and repeated compaction', async () => {
  await act(async () => stream.replaceTranscript(entries));
  for (let iteration = 0; iteration < 2; iteration++) {
    const before = store.readPersistedLlmChat(threadId)!.history.messages;
    const run = compact(new NextRequest('http://localhost/api/orchestrator/compact', { method: 'POST',
      body: JSON.stringify({ repoPath: repo, threadId, keepTailCount: 4, trigger: 'manual' }) }));
    await vi.waitFor(() => expect(transport.summarize).not.toBe(previousSummary));
    const previous = transport.summarize;
    const late: MobileTranscriptEntry = { id: `late-${iteration}`, role: 'assistant', text: `Late output ${iteration}`, timestamp: Date.now(), persistedVersion: 3 };
    store.writePersistedLlmChat(threadId, { repoPath: repo, title: 'Renamed during summary', messages: [...before, { ...late, content: late.text, timestamp: late.timestamp! }] });
    previous();
    const response = await run;
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.applied).toBe(true);
    expect(ids(result.transcript)).not.toContain('user-0');
    expect(ids(result.transcript)).toContain(late.id);
    expect(result.resumePrelude).toContain(late.text);
    if (iteration > 0) expect(transport.prompts.at(-1)).not.toContain('Request 0');
    const saved = store.readPersistedLlmChat(threadId)!.history.messages;
    expect(store.readPersistedLlmChat(threadId)!.history.title).toBe('Renamed during summary');
    expect(ids(saved).filter(id => !id.startsWith('orch-compaction-'))).toEqual([...ids(before).filter(id => !id.startsWith('orch-compaction-')), late.id]);
    expect(saved.filter(entry => entry.type === 'compaction')).toHaveLength(iteration + 1);
    expect(saved.at(-1)?.type).toBe('compaction');
    expect(saved[1].toolCalls).toEqual(entries[1].toolCalls);
    const reloaded = store.mapLlmHistoryToMobileTranscript(saved);
    await act(async () => stream.replaceTranscript(reloaded));
    // Earlier assistant progress in a settled turn lives in Work details.
    // Expand via the existing disclosure before checking every retained row.
    await act(async () => {
      for (const details of host.querySelectorAll('details')) {
        details.open = true;
        details.dispatchEvent(new Event('toggle'));
      }
    });
    expect(renderedIds()).toEqual(ids(reloaded));
    expect(placeTranscriptVisualizations([visual], reloaded).size).toBe(0);
    previousSummary = previous;
  }
});

it('rejects a stale summary after an earlier summarized message changes, without replacing history', async () => {
  const run = compact(new NextRequest('http://localhost/api/orchestrator/compact', { method: 'POST',
    body: JSON.stringify({ repoPath: repo, threadId, keepTailCount: 4, trigger: 'manual' }) }));
  const previous = transport.summarize;
  await vi.waitFor(() => expect(transport.summarize).not.toBe(previous));
  const current = store.readPersistedLlmChat(threadId)!.history;
  const changed = current.messages.map(entry => entry.id === 'reply-0' ? { ...entry, content: 'Corrected result', persistedVersion: 8 } : entry);
  store.writePersistedLlmChat(threadId, { ...current, messages: changed });
  const expected = store.readPersistedLlmChat(threadId)!.history.messages;
  transport.summarize();
  const response = await run;
  expect(response.status).toBe(500);
  expect((await response.json()).error).toContain('Summarized messages changed');
  expect(store.readPersistedLlmChat(threadId)!.history.messages).toEqual(expected);
});

it('does not resurrect a conversation deleted while summarization is running', async () => {
  const previous = transport.summarize;
  const run = compact(new NextRequest('http://localhost/api/orchestrator/compact', { method: 'POST',
    body: JSON.stringify({ repoPath: repo, threadId, keepTailCount: 4, trigger: 'manual' }) }));
  await vi.waitFor(() => expect(transport.summarize).not.toBe(previous));
  store.deletePersistedLlmChat(threadId);
  transport.summarize();
  expect((await run).status).toBe(500);
  expect(store.readPersistedLlmChat(threadId)).toBeNull();
});
let previousSummary = transport.summarize;

it('inserts a late partial reply after its shared prompt before a newer stored prompt', async () => {
  const user = { id: 'u1', role: 'user', content: 'First prompt', timestamp: 100 };
  const post = (messages: unknown[], replace = false) => saveHistory(new NextRequest('http://localhost/api/v2/chat-history', {
    method: 'POST', body: JSON.stringify({ tabId: threadId, messages, replace, title: 'Fixture' }),
  }));
  expect((await post([user, { ...user, id: 'u2', content: 'Second prompt', timestamp: 200 }], true)).status).toBe(200);
  expect((await post([user, { id: 'a1', role: 'assistant', content: 'Delayed reply', timestamp: 150 }])).status).toBe(200);
  expect(ids(store.readPersistedLlmChat(threadId)!.history.messages)).toEqual(['u1', 'a1', 'u2']);
});

it('preserves two adjacent distinct summary boundaries through a partial route save', async () => {
  const markers = [1, 2].map(index => ({ id: `boundary-${index}`, role: 'system' as const, text: 'Context compaction event',
    type: 'compaction' as const, timestamp: at + index, compaction: { timestamp: at + index, trigger: 'manual' as const, source: 'summary' as const,
      summary: `Summary ${index}`, compactedThroughId: entries[0].id } }));
  persist([entries[0], ...markers]);
  const response = await saveHistory(new NextRequest('http://localhost/api/v2/chat-history', { method: 'POST',
    body: JSON.stringify({ tabId: threadId, messages: serializeTranscriptForStorage([entries[0]]) }) }));
  expect(response.status).toBe(200);
  expect(ids(store.readPersistedLlmChat(threadId)!.history.messages)).toEqual([entries[0].id, ...ids(markers)]);
});

it('sends only the compact context on the next actual o8 fallback turn and telemetry read', async () => {
  const previous = transport.summarize;
  const run = compact(new NextRequest('http://localhost/api/orchestrator/compact', { method: 'POST',
    body: JSON.stringify({ repoPath: repo, threadId, keepTailCount: 4, trigger: 'manual' }) }));
  await vi.waitFor(() => expect(transport.summarize).not.toBe(previous));
  transport.summarize();
  const result = await (await run).json();
  expect(result.applied).toBe(true);
  store.writePersistedLlmChat(threadId, { messages: [{ id: 'next-user', role: 'user', content: 'Continue.', timestamp: Date.now() }] });
  let request: { messages: Array<{ role: string; content: string }> } | undefined;
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    request = JSON.parse(String(init?.body));
    return new Response('data: [DONE]\n\n');
  }));
  const { createO8Backend } = await import('@/lib/lane/orchestrator-backends/o8');
  await createO8Backend({ blocker: () => 'Fixture platform' }).sendTurn(repo, 'Continue.', () => {}, { threadId });
  expect(request!.messages).toHaveLength(result.transcript.length + 2);
  expect(request!.messages[1]).toMatchObject({ role: 'system', content: expect.stringContaining('Keep the fixture order.') });
  expect(JSON.stringify(request)).not.toContain('Request 0');
  expect(request!.messages.at(-1)?.content).toBe('Continue.');
  const { readOrchestratorContextTelemetry } = await import('@/lib/orchestrator/context-telemetry');
  const { estimateOrchestratorContext } = await import('@/lib/orchestrator/context-estimate');
  const telemetry = await readOrchestratorContextTelemetry(threadId, 'codex');
  expect(telemetry.contextTokens).toBe(estimateOrchestratorContext([...result.transcript,
    { id: 'next-user', role: 'user', text: 'Continue.', timestamp: Date.now() }]));
  expect(store.readPersistedLlmChat(threadId)!.history.messages).toHaveLength(72);
});

it('waits for backfill before anchoring an older visualization on a cold tail', () => {
  const anchors = new Map<string, string>();
  const tail = entries.slice(-4).map(entry => ({ ...entry, toolCalls: undefined }));
  expect(placeTranscriptVisualizations([visual], tail, anchors).size).toBe(0);
  expect(anchors.size).toBe(0);
  const backfilled = entries.map(entry => ({ ...entry, toolCalls: undefined }));
  expect([...placeTranscriptVisualizations([visual], backfilled, anchors)]).toEqual([[1, [visual]]]);
  expect(anchors.get(visual.id)).toBe('reply-0');
});
