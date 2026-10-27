// @vitest-environment jsdom
import { act, createElement, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import type { VisualizationReference } from '@/lib/visualizations/types';
const observed = vi.hoisted(() => ({ rows: [] as Array<{ id: string; streaming: boolean; animate: boolean }>, turns: 0 }));
// jsdom has no canvas text metrics; browser coverage uses the real measurement.
vi.mock('@/lib/pretext/hooks', () => ({ usePretextHeight: () => 24 }));
vi.mock('../../DesktopAgentMessage', async (original) => {
  const actual = await original<typeof import('../../DesktopAgentMessage')>();
  return { ...actual, DesktopAgentMessage: (props: Parameters<typeof actual.DesktopAgentMessage>[0]) => {
    observed.rows.push({ id: props.entry.id, streaming: props.isStreaming ?? false, animate: props.animateStreaming ?? true });
    return createElement(actual.DesktopAgentMessage, props);
  } };
});
vi.mock('../../transcript/TranscriptTurns', async (original) => {
  const actual = await original<typeof import('../../transcript/TranscriptTurns')>();
  const component = actual.TranscriptTurns as typeof actual.TranscriptTurns & {
    type: (props: ComponentProps<typeof actual.TranscriptTurns>) => ReactNode;
  };
  // Observe the production render body while retaining its real memo comparator.
  return { ...actual, TranscriptTurns: { ...component, type: (props: ComponentProps<typeof actual.TranscriptTurns>) => {
    observed.turns++;
    return component.type(props);
  } } };
});
// Document rendering is covered separately; observe metadata reaching its boundary.
vi.mock('../../visualizations/VisualizationFrame', () => ({
  VisualizationFrame: ({ reference }: { reference: VisualizationReference }) => createElement('div', {
    'data-saved-visualization': reference.id,
  }, JSON.stringify(reference)),
}));
const { ChatMessageList } = await import('./ChatMessageList');
let root: Root;
let host: HTMLDivElement;
const resizeObservers: Array<{ callback: ResizeObserverCallback; targets: Set<Element> }> = [];
const history: MobileTranscriptEntry[] = Array.from({ length: 8 }, (_, index) => [
  { id: `old-user-${index}`, role: 'user' as const, text: `Request ${index}` },
  { id: `old-assistant-${index}`, role: 'assistant' as const, text: `Completed answer ${index}` },
]).flat();
const live: MobileTranscriptEntry[] = [...history,
  { id: 'live-user', role: 'user', text: 'Current request' },
  { id: 'live-assistant', role: 'assistant', text: 'Current output' },
];
async function render(active: boolean, messages = live, waiting = true, scope?: { repoPath: string; threadId: string }) {
  await act(async () => root.render(createElement(ChatMessageList, {
    ...scope,
    active, displayMessages: messages, displayWaiting: waiting, isOrchestratorMode: true,
    activeTargetLabel: 'Fixture', activeTargetColor: 'var(--t-accent)', thoughtsMutedGlass: 'transparent',
    thoughtsElevatedBorder: 'none', thoughtsElevatedShadow: 'none', emptyStateFallback: null,
  })));
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  resizeObservers.length = 0;
  vi.stubGlobal('ResizeObserver', class {
    readonly targets = new Set<Element>();
    constructor(readonly callback: ResizeObserverCallback) { resizeObservers.push(this); }
    observe(target: Element) { this.targets.add(target); }
    unobserve(target: Element) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); observed.rows = []; observed.turns = 0;
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
it('reuses closed turns when a retained transcript becomes hidden and visible', async () => {
  await render(true);
  observed.rows = [];
  await render(false);
  await render(true);
  expect(observed.rows.filter(row => row.id.startsWith('old-'))).toEqual([]);
  expect(observed.rows.filter(row => row.id === 'live-assistant')).toEqual([
    { id: 'live-assistant', streaming: true, animate: false },
    { id: 'live-assistant', streaming: true, animate: true },
  ]);
  expect(host.textContent).toContain('Completed answer 0');
});
it('still updates changed history and the final live response', async () => {
  await render(false);
  observed.rows = [];
  const changed = live.map(entry => entry.id === 'old-assistant-3' ? { ...entry, text: 'Corrected history' }
    : entry.id === 'live-assistant' ? { ...entry, text: 'Final answer' } : entry);
  await render(false, changed, false);
  expect(host.textContent).toContain('Corrected history');
  expect(host.textContent).toContain('Final answer');
  expect(observed.rows.some(row => row.id === 'old-assistant-3')).toBe(true);
  expect(observed.rows.some(row => row.id === 'live-assistant' && !row.streaming)).toBe(true);
});
it('preserves visible post-stream animation drain on the latest assistant', async () => {
  vi.useFakeTimers();
  const text = 'Draining the final response smoothly. '.repeat(20);
  const messages = live.map(entry => entry.id === 'live-assistant' ? { ...entry, text } : entry);
  try {
    await render(true, messages);
    await act(async () => vi.advanceTimersByTime(20));
    observed.rows = [];
    await render(true, messages, false);
    expect(observed.rows.find(row => row.id === 'live-assistant')).toEqual({ id: 'live-assistant', streaming: false, animate: true });
    expect(host.textContent).not.toContain(text);
    await act(async () => vi.advanceTimersByTime(2000));
    expect(host.textContent).toContain(text);
    expect(observed.rows.filter(row => row.id.startsWith('old-'))).toEqual([]);
  } finally { vi.useRealTimers(); }
});

it('does not walk hidden histories during background output and catches up on reveal', async () => {
  await render(true);
  const scroller = host.querySelector('.thoughts-scroll')!;
  await render(false);
  host.style.display = 'none';
  await act(async () => {
    for (const observer of resizeObservers) if (observer.targets.has(host.firstElementChild!)) {
      observer.callback([{ target: host.firstElementChild!, contentRect: { width: 0 } } as ResizeObserverEntry], {} as ResizeObserver);
    }
  });
  observed.rows = [];
  let reads = 0;
  const updated = live.map(entry => entry.id === 'live-assistant' ? { ...entry, text: 'Complete background tail' } : entry);
  const tracked = new Proxy(updated, { get(target, key, receiver) { reads++; return Reflect.get(target, key, receiver); } });
  await render(false, tracked);
  expect(reads).toBe(0);
  expect(observed.rows).toEqual([]);
  expect(host.textContent).not.toContain('Complete background tail');
  host.style.display = '';
  await act(async () => {
    for (const observer of resizeObservers) if (observer.targets.has(host.firstElementChild!)) {
      observer.callback([{ target: host.firstElementChild!, contentRect: { width: 900 } } as ResizeObserverEntry], {} as ResizeObserver);
    }
  });
  // A visible but unfocused split must update without an active-flag change.
  expect(host.textContent).toContain('Complete background tail');
  vi.useFakeTimers();
  try {
    await render(true, updated, false);
    await act(async () => vi.advanceTimersByTime(2000));
    expect(host.textContent).toContain('Complete background tail');
    expect(host.querySelector('.thoughts-scroll')).toBe(scroller);
  } finally { vi.useRealTimers(); }
});

it('does not re-render any unchanged settled transcript row on hide and return', async () => {
  await render(true, history, false);
  observed.rows = [];
  await render(false, history, false);
  await render(true, history, false);
  expect(observed.rows).toEqual([]);
});

it('reuses the final turn after its streamed tail has drained', async () => {
  vi.useFakeTimers();
  const messages = live.map(entry => entry.id === 'live-assistant'
    ? { ...entry, text: 'A response that drains before the next tab visit. '.repeat(10) } : entry);
  try {
    await render(true, messages);
    await act(async () => vi.advanceTimersByTime(20));
    await render(true, messages, false);
    await act(async () => vi.advanceTimersByTime(2000));
    observed.rows = [];
    await render(false, messages, false);
    await render(true, messages, false);
    expect(observed.rows).toEqual([]);
  } finally { vi.useRealTimers(); }
});

const visual: VisualizationReference = {
  kind: 'o8-visualization', id: 'vis-12345678-1234-1234-1234-123456789abc',
  title: 'Saved visualization', height: 100, createdAt: '2026-10-26T00:00:00.000Z', version: 1,
};
const visualScope = { repoPath: '/fixture/repo', threadId: 'thoughts-visual-reuse' };
function visualizationResponses(initial: VisualizationReference[]) {
  let refs = initial;
  const fetch = vi.fn(async () => Response.json({ result: { visualizations: refs } }));
  vi.stubGlobal('fetch', fetch);
  return { fetch, replace: (next: VisualizationReference[]) => { refs = next; } };
}

it('reuses rows and turn derivation across five returns with unchanged saved visualization metadata', async () => {
  const responses = visualizationResponses([visual]);
  await render(true, history, false, visualScope);
  expect(host.querySelector('[data-saved-visualization]')?.textContent).toContain(visual.title);
  expect(observed.turns).toBeGreaterThan(0);
  for (let visit = 0; visit < 5; visit++) {
    observed.rows = []; observed.turns = 0;
    await render(false, history, false, visualScope);
    await render(true, history, false, visualScope);
    expect({ rows: observed.rows, turns: observed.turns }).toEqual({ rows: [], turns: 0 });
  }
  expect(responses.fetch).toHaveBeenCalledTimes(6);
});

it('refreshes changed visualization metadata after a hidden return, scope changes, and removal', async () => {
  const responses = visualizationResponses([visual]);
  await render(true, history, false, visualScope);
  const revised = { ...visual, id: 'vis-87654321-4321-4321-4321-cba987654321', rootId: visual.id,
    parentId: visual.id, version: 2, title: 'Revised visualization', height: 180 };
  await render(false, history, false, visualScope);
  responses.replace([revised]);
  observed.rows = []; observed.turns = 0;
  await render(false, history, false, visualScope);
  expect(responses.fetch).toHaveBeenCalledTimes(1);
  expect(observed.rows).toEqual([]);
  await render(true, history, false, visualScope);
  expect(host.querySelector('[data-saved-visualization]')?.textContent).toBe(JSON.stringify(revised));
  expect(observed.rows.length).toBeGreaterThan(0);
  expect(observed.turns).toBeGreaterThan(0);
  await render(true, history, false, { ...visualScope, threadId: 'thoughts-other-scope' });
  expect(host.querySelector('[data-saved-visualization]')?.textContent).toBe(JSON.stringify(revised));
  responses.replace([]);
  await render(false, history, false, visualScope);
  await render(true, history, false, visualScope);
  expect(host.querySelector('[data-saved-visualization]')).toBeNull();
});
