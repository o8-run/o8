// @vitest-environment jsdom
import { act, createElement, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatMessageList } from '@/components/desktop/thoughts/chat-panel/ChatMessageList';
import { useTranscriptAutoScroll } from '@/components/desktop/thoughts/chat-panel/useTranscriptAutoScroll';
import { useThreadHistoryBackfill } from '@/components/desktop/thoughts/chat-panel/useThreadHistoryBackfill';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';

vi.mock('@/lib/pretext/hooks', () => ({ usePretextHeight: () => 24 }));
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let top = 0;
let messages: MobileTranscriptEntry[];
let growth = new Map<string, number>();
let callbacks: Array<() => void>;
let backfill: ReturnType<typeof useThreadHistoryBackfill<MobileTranscriptEntry>>;
let resolvePage: (page: { messages: MobileTranscriptEntry[] }) => void;
const ids = () => [...host.querySelectorAll<HTMLElement>('[data-o8-message-id]')].map(node => node.dataset.o8MessageId!);
const height = () => ids().reduce((sum, id) => sum + 100 + (growth.get(id) ?? 0), 0);
function prepend(older: MobileTranscriptEntry[]) {
  messages = [...older, ...messages]; root.render(createElement(Harness));
}
function Harness({ scope = 'fixture' }: { scope?: string }) {
  const end = useRef<HTMLDivElement>(null);
  const suppress = useRef(false);
  useTranscriptAutoScroll({ endRef: end, suppressRef: suppress, scope });
  const activeBackfill = useThreadHistoryBackfill<MobileTranscriptEntry>({
    fetchPage: () => new Promise(resolve => { resolvePage = resolve; }),
    getScrollContainer: () => end.current?.closest('.thoughts-scroll') ?? null,
    onPrepend: prepend,
  });
  useEffect(() => { backfill = activeBackfill; }, [activeBackfill]);
  return createElement(ChatMessageList, { ref: end, displayMessages: messages, displayWaiting: false,
    activeTargetLabel: 'Fixture', activeTargetColor: 'var(--t-accent)', thoughtsMutedGlass: 'transparent',
    thoughtsElevatedBorder: 'none', thoughtsElevatedShadow: 'none', emptyStateFallback: null });
}
async function render(scope?: string) { await act(async () => root.render(createElement(Harness, { scope }))); }
async function frame() { await act(async () => vi.advanceTimersByTimeAsync(32)); }
function scroll(value: number) {
  top = value;
  host.querySelector('.thoughts-scroll')!.dispatchEvent(new Event('scroll'));
}
function relativeTop(id: string) { return host.querySelector(`[data-o8-message-id="${id}"]`)!.getBoundingClientRect().top; }
beforeEach(async () => {
  vi.useFakeTimers(); callbacks = []; growth = new Map(); top = 0;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { callbacks.push(() => callback([], {} as ResizeObserver)); }
    observe() {} disconnect() {}
  });
  // jsdom has no layout. Only geometry is supplied; the real list and both
  // production scroll hooks own reconciliation, listeners and restoration.
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(height);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(() => top);
  vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(value => { top = Math.max(0, Math.min(value, height() - 600)); });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    const order = ids(); const index = order.indexOf(this.dataset.o8MessageId ?? '');
    const y = index < 0 ? 0 : order.slice(0, index).reduce((sum, id) => sum + 100 + (growth.get(id) ?? 0), 0) - top;
    const h = index < 0 ? 600 : 100 + (growth.get(this.dataset.o8MessageId!) ?? 0);
    return { top: y, bottom: y + h, height: h, left: 0, right: 900, width: 900, x: 0, y, toJSON() {} };
  });
  messages = Array.from({ length: 220 }, (_, index) => ({ id: `row-${index}`, role: index % 2 ? 'assistant' : 'user', text: `Fixture passage ${index}` }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await render(); await frame();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('keeps the visible message and offset through delayed content growth, ordinary updates and replacement, then follows the live end', async () => {
  scroll(8040); const offset = relativeTop('row-80'); const node = host.querySelector('[data-o8-message-id="row-80"]');
  growth.set('row-1', 350); callbacks.forEach(callback => callback()); await frame();
  expect(relativeTop('row-80')).toBe(offset);
  messages = messages.map(entry => entry.id === 'row-219' ? { ...entry, text: 'New live output' } : entry);
  await render(); await frame(); expect(relativeTop('row-80')).toBe(offset);
  messages = [{ id: 'earlier', role: 'user', text: 'Earlier history' }, ...messages];
  await render(); await frame(); expect(relativeTop('row-80')).toBe(offset);
  expect(host.querySelector('[data-o8-message-id="row-80"]')).toBe(node);
  scroll(height() - 600); growth.set('row-219', 200); callbacks.forEach(callback => callback()); await frame();
  expect(top).toBe(height() - 600);
});

it('captures backfill position after the response, excludes concurrent tail growth and ignores an old-scope frame', async () => {
  scroll(8040);
  backfill.startBackfill('fixture', { beforeCursor: 'older', hasMore: true });
  await act(async () => vi.advanceTimersByTimeAsync(120));
  scroll(10040); const offset = relativeTop('row-100');
  growth.set('row-219', 700); callbacks.forEach(callback => callback()); await frame();
  await act(async () => resolvePage({ messages: [{ id: 'older', role: 'user', text: 'Older page' }] }));
  await frame(); expect(relativeTop('row-100')).toBe(offset);
  backfill.startBackfill('fixture', { beforeCursor: 'earlier', hasMore: true });
  await act(async () => vi.advanceTimersByTimeAsync(120));
  await act(async () => { resolvePage({ messages: [{ id: 'earlier', role: 'user', text: 'Earlier page' }] }); });
  backfill.cancelBackfill();
  await render('other-thread'); await frame();
  expect(top).toBe(height() - 600);
});
