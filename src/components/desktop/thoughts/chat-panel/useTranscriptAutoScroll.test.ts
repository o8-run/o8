// @vitest-environment jsdom
import { act, createElement, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deleteChatHistory } from '@/lib/llm/chat-history';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { LiveCaptions } from '@/lib/voice/managed-live/captions';
import { visibleVoiceTranscript } from '@/lib/transcripts/voice-captions';
import { dedupeDisplayMessages } from './dedupe-display-messages';
import { useTranscriptAutoScroll } from './useTranscriptAutoScroll';
import { voiceContinuityReplay } from './voice-continuity-replay.fixture';

let root: Root; let host: HTMLDivElement; let scroller: HTMLDivElement;
let height: number; let top: number; let resize: () => void;
let observed: Set<Element>;
const suppress = { current: false };
const scrollTopDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop');
const scrollToDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
function Harness({ messages, scope = 'chat', historyComplete = false }: { messages: MobileTranscriptEntry[]; scope?: string; status?: string; historyComplete?: boolean }) {
  const end = useRef<HTMLDivElement>(null);
  useTranscriptAutoScroll({ endRef: end, suppressRef: suppress, scope, historyComplete, messageIds: messages.map(message => message.id) });
  return createElement('div', { className: 'thoughts-scroll' }, createElement('div', null,
    messages.map(m => createElement('div', { key: m.id, 'data-o8-message-id': m.id }, m.text)), createElement('div', { ref: end })));
}
async function render(messages: MobileTranscriptEntry[], scope = 'chat', status = 'idle', historyComplete = false) {
  await act(async () => root.render(createElement(Harness, { messages, scope, status, historyComplete })));
}
async function frame() { await act(async () => vi.advanceTimersByTimeAsync(32)); }
function scrollTo(value: number) { top = value; scroller.dispatchEvent(new Event('scroll')); }
beforeEach(async () => {
  localStorage.clear();
  vi.useFakeTimers(); height = 18853; top = 18161; suppress.current = false; observed = new Set();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => setTimeout(() => fn(0), 16));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  vi.stubGlobal('ResizeObserver', class {
    constructor(fn: () => void) { resize = fn; }
    observe(element: Element) { observed.add(element); }
    disconnect() { observed.clear(); }
  });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => height);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(692);
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', { configurable: true, get: () => top,
    set: (value: number) => { top = Math.min(height - 692, Math.max(0, value)); } });
  HTMLElement.prototype.scrollTo = function(options?: ScrollToOptions | number, y?: number) {
    this.scrollTop = typeof options === 'number' ? y ?? top : options?.top ?? top;
  };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await render([]); scroller = host.querySelector('.thoughts-scroll')!; await frame();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  for (const [name, descriptor] of [['scrollTop', scrollTopDescriptor], ['scrollTo', scrollToDescriptor]] as const) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, name);
  }
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('replays live captions without taking the reader away from history, then follows after returning to the bottom', async () => {
  let messages: MobileTranscriptEntry[] = []; const captions = new LiveCaptions('replay', entries => { messages = dedupeDisplayMessages([...messages, ...entries]); });
  let reading = false; let resumed = false; let anchor = 0;
  const nodes = new Map<string, Element>();
  for (const item of voiceContinuityReplay) {
    if (!reading && item.at >= 8007) {
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -650 })); scrollTo(top - 650); anchor = top; reading = true;
    }
    if (!resumed && item.at >= 27000) { scrollTo(height - 692); resumed = true; }
    captions.observe(item.event);
    const count = messages.length; captions.observe(item.event); expect(messages).toHaveLength(count);
    const visible = visibleVoiceTranscript(messages);
    height += 2; await render(visible); resize?.(); await frame();
    if (reading && !resumed) expect(top).toBe(anchor);
    else expect(height - top - 692).toBe(0);
    for (const node of host.querySelectorAll('[data-o8-message-id]')) {
      const id = node.getAttribute('data-o8-message-id')!;
      if (nodes.has(id)) expect(node).toBe(nodes.get(id));
      nodes.set(id, node);
    }
    expect([...host.querySelectorAll('[data-o8-message-id]')].map(n => n.textContent)).toEqual(visible.map(m => m.text));
  }
  expect(nodes.size).toBeGreaterThan(1);
});

it('cancels a pending follow when the reader scrolls before the next frame, including within the old 120px threshold', async () => {
  await render([{ id: 'one', role: 'user', text: 'New speech' }]);
  scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -50 })); scrollTo(top - 50); const anchor = top;
  await frame(); expect(top).toBe(anchor);
  await render([{ id: 'one', role: 'user', text: 'New speech grows' }], 'chat', 'busy');
  height += 300; resize?.(); await frame(); expect(top).toBe(anchor);
});

it('follows text reveal and viewport resize only while attached to the bottom', async () => {
  height += 400; resize(); await frame(); expect(top).toBe(height - 692);
  scrollTo(top - 300); const anchor = top; height += 400; resize(); await frame(); expect(top).toBe(anchor);
  scrollTo(height - 692); height += 30; resize(); await frame(); expect(top).toBe(height - 692);
});

it('preserves backfill compensation, resets following for a different chat and cancels work on unmount', async () => {
  scrollTo(top - 650); const anchor = top; suppress.current = true;
  height += 200; await render([{ id: 'old', role: 'user', text: 'Older history' }]);
  scrollTo(anchor + 200); resize?.(); await frame(); expect(top).toBe(anchor + 200);
  await render([{ id: 'new', role: 'user', text: 'Different chat' }], 'other'); await frame(); expect(top).toBe(height - 692);
  height += 30; resize?.(); await act(async () => root.unmount()); const after = top; await frame(); expect(top).toBe(after);
  root = createRoot(host);
});

it('observes overflowing bubble sizes and refreshes them when direct transcript children change', async () => {
  const content = scroller.firstElementChild!;
  const bubble = document.createElement('div');
  await act(async () => { content.insertBefore(bubble, content.lastElementChild); });
  expect(observed.has(bubble)).toBe(true);
  height += 100;
  if (observed.has(bubble)) resize();
  await frame();
  expect(top).toBe(height - 692);
  scrollTo(top - 650); const anchor = top;
  height += 100; resize(); await frame(); expect(top).toBe(anchor);
  await act(async () => bubble.remove());
  expect(observed.has(bubble)).toBe(false);
});

it('keeps following when backfill adds no visible height and therefore emits no scroll event', async () => {
  suppress.current = true;
  await render([{ id: 'folded', role: 'assistant', text: 'Older folded work' }]);
  await frame();
  height += 100;
  resize();
  await frame();
  expect(top).toBe(height - 692);
});

function readingLayout() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    const id = this.getAttribute('data-o8-message-id');
    const y = id ? Number(id.slice(1)) * 1000 - top : 0;
    const size = id ? 200 : 692;
    return { top: y, bottom: y + size, height: size, left: 0, right: 800, width: 800 } as DOMRect;
  });
  return [1, 2, 3].map(index => ({ id: `m${index}`, role: 'user' as const, text: `Message ${index}` }));
}

it('restores a message and offset after remount, waiting for its history page without saving the tail over it', async () => {
  const messages = readingLayout();
  await render(messages.slice(1)); await frame();
  scrollTo(2100);
  await render(messages); await frame();
  window.dispatchEvent(new Event('pagehide'));
  expect(JSON.parse(localStorage.getItem('o8:transcript-reading:v1:chat')!).anchor.rows[0].index).toBe(1);
  await act(async () => root.unmount());
  root = createRoot(host); top = 0;
  await render([messages[2]]); scroller = host.querySelector('.thoughts-scroll')!; await frame();
  // An asynchronous tail-page scroll is not a reader choosing a new location.
  scrollTo(0);
  height += 100;
  await render(messages); resize(); await frame();
  expect(top).toBe(2100);
  height += 300; resize(); await frame();
  expect(top).toBe(2100);
});

it('keeps separate saved positions for two chats and persists bottom-follow intent across remount', async () => {
  const messages = readingLayout();
  await render(messages, 'a'); await frame(); scrollTo(2100);
  await render(messages, 'b'); await frame(); scrollTo(3100);
  await render(messages, 'a'); await frame(); expect(top).toBe(2100);
  await render(messages, 'b'); await frame(); expect(top).toBe(3100);
  scrollTo(height - 692);
  await act(async () => root.unmount()); root = createRoot(host); top = 0; height += 500;
  await render(messages, 'b'); scroller = host.querySelector('.thoughts-scroll')!; await frame();
  expect(top).toBe(height - 692);
  height += 500; resize(); await frame(); expect(top).toBe(height - 692);
});

it('lets a reader abandon a pending restoration and tolerates unavailable storage', async () => {
  const messages = readingLayout();
  await render(messages); await frame(); scrollTo(2100);
  await act(async () => root.unmount()); root = createRoot(host); top = 0;
  await render([messages[2]]); scroller = host.querySelector('.thoughts-scroll')!;
  scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -50 })); scrollTo(50);
  await render(messages); resize(); await frame(); expect(top).toBe(50);
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage blocked'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage full'); });
  await render(messages, 'unavailable'); await frame(); expect(top).toBe(height - 692);
});

it.each([true, false])('settles a permanently removed anchor after backfill completes and resumes saving (saved order: %s)', async withOrder => {
  const messages = readingLayout();
  await render(messages); await frame(); scrollTo(2100);
  await act(async () => root.unmount()); root = createRoot(host); top = 0;
  if (!withOrder) {
    const key = 'o8:transcript-reading:v1:chat';
    const saved = JSON.parse(localStorage.getItem(key)!);
    for (const row of saved.anchor.rows) delete row.index;
    localStorage.setItem(key, JSON.stringify(saved));
  }
  await render([messages[2]]); scroller = host.querySelector('.thoughts-scroll')!; await frame();
  const key = 'o8:transcript-reading:v1:chat';
  expect(JSON.parse(localStorage.getItem(key)!).anchor.rows[0].id).toBe('m2');
  await render([messages[0], messages[2]], 'chat', 'idle', true); await frame();
  expect(top).toBe(withOrder ? 3000 : 1000);
  expect(JSON.parse(localStorage.getItem(key)!).anchor.rows[0].id).toBe(withOrder ? 'm3' : 'm1');
  scrollTo(1000);
  expect(JSON.parse(localStorage.getItem(key)!).top).toBe(1000);
});

it('falls back to following an exhausted empty history without retaining a missing identity', async () => {
  const messages = readingLayout();
  await render(messages); await frame(); scrollTo(2100);
  await act(async () => root.unmount()); root = createRoot(host); top = 0;
  await render([], 'chat', 'idle', true); scroller = host.querySelector('.thoughts-scroll')!; await frame();
  expect(top).toBe(height - 692);
  expect(localStorage.getItem('o8:transcript-reading:v1:chat')).toBeNull();
  height += 500; resize(); await frame(); expect(top).toBe(height - 692);
});

it('deletes active and inactive conversation positions across workspace buckets without recreating them on pagehide or unmount', async () => {
  const messages = readingLayout();
  const a = JSON.stringify(['/repo', 'thread', 'a']);
  const alias = JSON.stringify(['/alias', 'thread', 'a']);
  const b = JSON.stringify(['/repo', 'thread', 'b']);
  for (const scope of [alias, a, b]) { await render(messages, scope); await frame(); scrollTo(2100); }
  window.dispatchEvent(new CustomEvent('cortex-llm-history-deleted', { detail: { tabId: 'a' } }));
  expect(localStorage.getItem(`o8:transcript-reading:v1:${a}`)).toBeNull();
  expect(localStorage.getItem(`o8:transcript-reading:v1:${alias}`)).toBeNull();
  expect(localStorage.getItem(`o8:transcript-reading:v1:${b}`)).not.toBeNull();
  const remove = vi.fn().mockResolvedValueOnce(new Response(null, { status: 500 })).mockResolvedValueOnce(new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', remove);
  await deleteChatHistory('b');
  expect(localStorage.getItem(`o8:transcript-reading:v1:${b}`)).not.toBeNull();
  await deleteChatHistory('b');
  window.dispatchEvent(new Event('pagehide')); scrollTo(1000);
  await render(messages, 'new-chat'); await frame();
  expect(localStorage.getItem(`o8:transcript-reading:v1:${b}`)).toBeNull();
});

it('removes a closed chat record through the deletion client with no mounted transcript', async () => {
  const scope = JSON.stringify(['/repo', 'thread', 'closed']);
  await render(readingLayout(), scope); await frame(); scrollTo(2100);
  await act(async () => root.unmount()); root = createRoot(host);
  expect(localStorage.getItem(`o8:transcript-reading:v1:${scope}`)).not.toBeNull();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
  await deleteChatHistory('closed');
  expect(localStorage.getItem(`o8:transcript-reading:v1:${scope}`)).toBeNull();
});

it('does not persist empty replacement conversations on scroll, pagehide, replacement or disposal', async () => {
  const scope = (id: string) => JSON.stringify(['/repo', 'thread', id]);
  const positions = () => Object.keys(localStorage).filter(key => key.startsWith('o8:transcript-reading:v1:'));
  height = 692; top = 0;
  await render([], scope('thoughts-placeholder-a')); await frame();
  scrollTo(0); window.dispatchEvent(new Event('pagehide'));
  expect(positions()).toEqual([]);
  await render([], scope('thoughts-placeholder-b')); await frame();
  window.dispatchEvent(new Event('pagehide'));
  await act(async () => root.unmount()); root = createRoot(host);
  expect(positions()).toEqual([]);
});

it('retires an existing empty default record when its placeholder is replaced or deleted', async () => {
  const scope = JSON.stringify(['/repo', 'thread', 'thoughts-placeholder']);
  const key = `o8:transcript-reading:v1:${scope}`;
  localStorage.setItem(key, JSON.stringify({ following: true, top: 0, anchor: null }));
  height = 692; top = 0;
  await render([], scope); await frame();
  await render(readingLayout(), 'real-chat'); await frame();
  expect(localStorage.getItem(key)).toBeNull();
  await render([], scope); await frame();
  window.dispatchEvent(new CustomEvent('o8:chat-history-deleted', { detail: { tabId: 'thoughts-placeholder' } }));
  window.dispatchEvent(new Event('pagehide'));
  expect(localStorage.getItem(key)).toBeNull();
});

it('keeps saved bottom-follow through a layout clamp without capturing deferred history, then follows live growth after reload', async () => {
  const messages = readingLayout();
  await render(messages, 'bottom-chat'); await frame();
  window.dispatchEvent(new Event('pagehide'));
  await act(async () => root.unmount()); root = createRoot(host); top = 0;
  await render(messages, 'bottom-chat'); scroller = host.querySelector('.thoughts-scroll')!; await frame();
  // The browser clamps the bottom by a few pixels when a deferred turn settles.
  // Measuring historical rows would lay out skipped turns and expand the range
  // again, so that measurement must not turn this clamp into a reading anchor.
  let deferred = true;
  const layout = vi.mocked(HTMLElement.prototype.getBoundingClientRect).getMockImplementation()!;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    if (deferred && this.hasAttribute('data-o8-message-id')) { height += 2780; deferred = false; }
    return layout.call(this);
  });
  height -= 5; scrollTo(height - 692);
  window.dispatchEvent(new Event('pagehide'));
  expect(JSON.parse(localStorage.getItem('o8:transcript-reading:v1:bottom-chat')!)).toMatchObject({ following: true, top: 0, anchor: null });
  height += 2733; resize(); await frame();
  expect(height - top - 692).toBe(0);
  await act(async () => root.unmount()); root = createRoot(host); top = 0;
  await render(messages, 'bottom-chat'); scroller = host.querySelector('.thoughts-scroll')!; await frame();
  expect(height - top - 692).toBe(0);
});

it('keeps the departing real conversation position when the replacement has no messages', async () => {
  const messages = readingLayout();
  await render(messages, 'real-chat'); await frame(); scrollTo(2100);
  await render([], 'empty-replacement'); await frame();
  window.dispatchEvent(new Event('pagehide'));
  expect(localStorage.getItem('o8:transcript-reading:v1:empty-replacement')).toBeNull();
  expect(JSON.parse(localStorage.getItem('o8:transcript-reading:v1:real-chat')!)).toMatchObject({ following: false, top: 2100 });
  await render(messages, 'real-chat'); await frame(); expect(top).toBe(2100);
});
