// @o8-test-browser
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { webkit } from 'playwright-core';
import { expect, it, vi } from 'vitest';

const directory = process.env.O8_OUTSIDE_TRANSCRIPT_PROOF_DIR ?? process.env.CORTEX_IDE_DATA_DIR!;
async function measure(engine: string, control = false, surface = 'outside', hiddenDocument = false, invalidateRows = false) {
  await mkdir(directory, { recursive: true });
  const name = `${surface}-${engine}${hiddenDocument ? '-document-hidden' : ''}${control ? '-control' : ''}${invalidateRows ? '-row-control' : ''}`;
  const receipt = join(directory, `${name}.json`);
  await rm(receipt, { force: true });
  let failed = false; let stderr = '';
  try {
    const result = await promisify(execFile)(process.execPath, ['scripts/bench/interactions/outside-transcript-background.mjs',
      `--engine=${engine}`, `--surface=${surface}`, `--output=${receipt}`, `--screenshot=${join(directory, `${name}.png`)}`,
      ...(hiddenDocument ? ['--hidden-document'] : []),
      ...(control ? ['--force-foreground'] : []),
      ...(surface === 'outside' ? ['--expect-reuse'] : []),
      ...(invalidateRows ? ['--force-row-invalidation'] : []),
    ], { timeout: 90000 });
    stderr = result.stderr;
  } catch (error) { failed = true; stderr = String((error as { stderr?: string }).stderr ?? error); }
  try { return { failed, receipt: JSON.parse(await readFile(receipt, 'utf8')) }; }
  catch (error) { throw new Error(`${name} benchmark receipt missing or unreadable.\n${stderr}`, { cause: error }); }
}
for (const engine of ['chromium', 'webkit']) it.runIf(engine !== 'webkit' || existsSync(webkit.executablePath()))(
  `bounds selected transcripts in a hidden document and catches up in ${engine}`, async () => {
    const { failed, receipt } = await measure(engine, false, 'outside', true);
    expect(receipt.errors).toEqual([]);
    expect(receipt.error).toBeUndefined();
    expect(receipt.observations).toHaveLength(3);
    expect(receipt).toMatchObject({ passed: true, documentWasHidden: true, windowCatchUp: true, transcriptHealthy: true,
      catchUp: true, retained: true, scrollPreserved: true, selectionPreserved: true });
    expect(failed).toBe(false);
  }, 120000);
it('rejects foreground visibility in the hidden-document workload', async () => {
  const { failed, receipt } = await measure('chromium', true, 'outside', true);
  expect(receipt.errors).toEqual([]);
  expect(receipt.error).toBeUndefined();
  expect(receipt.observations).toHaveLength(3);
  expect(receipt.transcriptHealthy).toBe(true);
  expect(receipt.documentWasHidden).toBe(false);
  expect(receipt.observations.every((row: { visibleBatches: number }) => row.visibleBatches > 4)).toBe(true);
  expect(receipt.passed).toBe(false);
  expect(failed).toBe(true);
}, 120000);
for (const surface of ['outside', 'workspace']) {
  for (const engine of ['chromium', 'webkit']) it.runIf(engine !== 'webkit' || existsSync(webkit.executablePath()))(
    `bounds hidden ${surface} transcripts and preserves scroll in ${engine}`, async () => {
      const { failed, receipt } = await measure(engine, false, surface);
      expect(receipt.errors).toEqual([]);
      expect(receipt.error).toBeUndefined();
      expect(receipt.observations).toHaveLength(3);
      expect(receipt).toMatchObject({ passed: true, transcriptHealthy: true, catchUp: true, retained: true, scrollPreserved: true, selectionPreserved: true, draftRetained: true, draftSelectionRetained: true });
      if (surface === 'outside') {
        expect(receipt.observations.every((row: { closedRowRenders: number }) => row.closedRowRenders === 0)).toBe(true);
        expect(receipt.switches).toHaveLength(6);
        expect(receipt.switches.every((row: { closedRowRenders: number; shown: boolean }) => row.closedRowRenders === 0 && row.shown)).toBe(true);
        expect(receipt.medianFrameP95Ms).toBeGreaterThan(0);
        expect(receipt.medianSwitchMs).toBeGreaterThan(0);
      }
      expect(failed).toBe(false);
    }, 120000);
  it(`rejects foreground cadence in hidden ${surface} panes`, async () => {
    const { failed, receipt } = await measure('chromium', true, surface);
    expect(receipt.error).toBeUndefined();
    expect(receipt.errors).toEqual([]);
    expect(receipt.observations).toHaveLength(3);
    expect(receipt.transcriptHealthy).toBe(true);
    expect(receipt.observations.every((row: { hiddenBatches: number[] }) => row.hiddenBatches.every(count => count > 4))).toBe(true);
    expect(receipt.passed).toBe(false);
    expect(failed).toBe(true);
  }, 120000);
}

it('rejects repeated historical rendering during hidden streaming and tab switches', async () => {
  const { failed, receipt } = await measure('chromium', false, 'outside', false, true);
  expect(receipt.errors).toEqual([]);
  expect(receipt.error).toBeUndefined();
  expect(receipt.observations).toHaveLength(3);
  expect(receipt.observations.every((row: { closedRowRenders: number }) => row.closedRowRenders > 0)).toBe(true);
  expect(receipt.switches).toHaveLength(6);
  expect(receipt.switches.every((row: { closedRowRenders: number }) => row.closedRowRenders > 0)).toBe(true);
  expect(receipt.passed).toBe(false);
  expect(failed).toBe(true);
}, 120000);

it('reuses persisted history delivered through the real history route on hidden flush and return', async () => {
  const { GET } = await import('@/app/api/mobile/history/route');
  const { NextRequest } = await import('next/server');
  const { writePersistedLlmChat, readPersistedLlmChat, deleteCanonicalChatHistoryRecord } = await import('@/lib/llm/chat-history-store');
  const { transcriptStore } = await import('@/lib/transcripts/store');
  const { bootstrapTranscripts } = await import('@/lib/transcripts/bootstrap');
  const { ORCHESTRATOR_RUNTIME_IDS } = await import('@/lib/orchestrator/runtime-capabilities');
  const { OutsideConversationPane } = await import('@/components/desktop/workspace-terminal/OutsideConversationPane');
  const markdown = await import('@/components/desktop/LLMMarkdown');
  const { JSDOM } = await vi.importActual<{
    JSDOM: new (markup: string, options: { url: string; pretendToBeVisual: boolean }) => { window: Window };
  }>('jsdom');
  const { act, createElement } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const threadId = 'persisted-history-reuse';
  const sessionKey = `llm-chat:${threadId}`;
  const history = Array.from({ length: 20 }, (_, index) => ({ id: `history-${index}`,
    role: index % 2 ? 'assistant' as const : 'user' as const, content: `Persisted history ${index}`, timestamp: 1 }));
  const persist = (content: string) => writePersistedLlmChat(threadId, { messages: [
    ...history, { id: 'tail', role: 'assistant', content, timestamp: 2 },
  ] }, { replace: true });
  persist('Original persisted tail');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const routeFetch = vi.fn(async (input: string) => {
    const response = await GET(new NextRequest(new URL(input, 'http://localhost/')));
    expect(response.status).toBe(200);
    return response;
  });
  vi.stubGlobal('fetch', routeFetch);
  vi.useFakeTimers();
  const host = document.getElementById('root')!;
  const root = createRoot(host);
  const show = (active: boolean) => root.render(createElement(OutsideConversationPane, {
    sessionKey, runtime: ORCHESTRATOR_RUNTIME_IDS[0], active,
    tab: { id: threadId, kind: 'chat', label: 'Persisted conversation', tmuxSession: null, createdAt: 1, lastActivity: 1 },
  }));
  try {
    await act(async () => { show(false); await bootstrapTranscripts([sessionKey]); });
    expect(host.textContent).toContain('Persisted history 1');
    const original = host.querySelector('[data-outside-transcript-entry="history-1"]');
    const renderMarkdown = vi.spyOn(markdown, 'renderLLMMarkdown');
    persist('Latest persisted tail');
    await act(async () => bootstrapTranscripts([sessionKey], { refetchFresh: true }));
    expect(transcriptStore.getSlice(sessionKey).messages.at(-1)?.text).toBe('Latest persisted tail');
    expect(host.textContent).not.toContain('Latest persisted tail');
    await act(async () => vi.advanceTimersByTime(1000));
    expect(host.textContent).toContain('Latest persisted tail');
    await act(async () => show(true));
    expect(readPersistedLlmChat(threadId)?.history.messages.at(-1)?.content).toBe('Latest persisted tail');
    expect(routeFetch).toHaveBeenCalled();
    expect(host.querySelector('[data-outside-transcript-entry="history-1"]')).toBe(original);
    expect(renderMarkdown.mock.calls.filter(([text]) => text.startsWith('Persisted history'))).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); dom.window.close();
    transcriptStore.clear(sessionKey); deleteCanonicalChatHistoryRecord(threadId);
    (await import('@/lib/db')).closeDb();
  }
}, 120000);
