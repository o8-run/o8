/** @vitest-environment jsdom */

import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { TranscriptTurns } from './TranscriptTurns';
import { TranscriptNavigator } from './TranscriptNavigator';
import { TranscriptActivity } from './TranscriptActivity';

let host: HTMLDivElement;
let root: Root;
const entries: MobileTranscriptEntry[] = [
  { id: 'u', role: 'user', text: 'Request' },
  { id: 'a', role: 'assistant', text: 'Inspecting' },
  { id: 't', role: 'assistant', text: '', toolCalls: [{ id: 'edit', name: 'Edit', status: 'done', args: { file_path: 'src/a.ts', old_string: 'old', new_string: 'new' } }] },
  { id: 'f', role: 'assistant', text: 'Final answer' },
];

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('completed activity through the shared renderer', () => {
  function render(busy: boolean) {
    act(() => root.render(<TranscriptTurns entries={entries} busy={busy} repoPath="/repo"
      nodes={entries.map(entry => <div key={entry.id} data-o8-message-id={entry.id}>{entry.text || 'Edited a file'}</div>)} />));
  }
  it('keeps the final answer and file card visible, reveals work on demand, and opens a scoped Review', () => {
    render(true); expect(host.textContent).toContain('Inspecting');
    render(false); expect(host.textContent).not.toContain('Inspecting');
    expect(host.textContent).toContain('Final answer');
    expect(host.textContent).toContain('Edited 1 file');
    expect(host.textContent).not.toContain('Undo');
    const details = host.querySelector('details')!;
    act(() => { details.open = true; details.dispatchEvent(new Event('toggle')); });
    expect(host.textContent).toContain('Inspecting');
    const listener = vi.fn(); window.addEventListener('o8:focus-review', listener);
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Open src/a.ts in Review"]')!.click());
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ repoPath: '/repo', file: 'src/a.ts' });
    window.removeEventListener('o8:focus-review', listener);
  });
  it('does not lose expanded history on a parent rerender', () => {
    render(false);
    const details = host.querySelector('details')!;
    act(() => { details.open = true; details.dispatchEvent(new Event('toggle')); });
    render(false); expect(host.textContent).toContain('Inspecting');
  });
  it('reuses turn derivation for fresh elements with unchanged props, but accepts changed content', () => {
    let derivations = 0;
    const tracked = new Proxy(entries, { get(target, key, receiver) {
      if (key === 'flatMap') derivations++;
      return Reflect.get(target, key, receiver);
    } });
    const renderNodes = (final = 'Final answer') => act(() => root.render(<TranscriptTurns entries={tracked} busy={false}
      nodes={entries.map(entry => <div key={entry.id}>{entry.id === 'f' ? final : entry.text}</div>)} />));
    renderNodes();
    expect(derivations).toBeGreaterThan(0);
    derivations = 0;
    renderNodes();
    expect(derivations).toBe(0);
    renderNodes('Revised final answer');
    expect(derivations).toBeGreaterThan(0);
    expect(host.textContent).toContain('Revised final answer');
  });
  it('retains expanded work and message identity when a growing history starts deferring layout', () => {
    render(false);
    const details = host.querySelector('details')!;
    act(() => { details.open = true; details.dispatchEvent(new Event('toggle')); });
    const original = host.querySelector('[data-o8-message-id="a"]');
    const growing: MobileTranscriptEntry[] = [...entries, ...Array.from({ length: 200 }, (_, index) => ({
      id: `later-${index}`, role: 'user' as const, text: `Later request ${index}`,
    }))];
    act(() => root.render(<TranscriptTurns entries={growing} busy={false} repoPath="/repo"
      nodes={growing.map(entry => <div key={entry.id} data-o8-message-id={entry.id}>{entry.text}</div>)} />));
    expect(host.querySelector('[data-o8-message-id="a"]')).toBe(original);
    expect(host.querySelector('details')).toBe(details);
    expect(details.open).toBe(true);
    expect(host.textContent).toContain('Inspecting');
  });
  it('keeps conversational captions separate from the CLI final answer and work disclosure', () => {
    const voice = { sessionId: 'live', direction: 'output' as const, revision: 1, startMs: 0, endMs: 100 };
    const mixed: MobileTranscriptEntry[] = [entries[0],
      { id: 'spoken-input', role: 'user', text: 'Another spoken thought', voice: { ...voice, direction: 'input' } },
      { id: 'ack', role: 'assistant', text: 'Spoken acknowledgment', voice },
      ...entries.slice(1), { id: 'spoken-answer', role: 'assistant', text: 'Spoken answer', voice }];
    act(() => root.render(<TranscriptTurns entries={mixed} busy={false} repoPath="/repo"
      nodes={mixed.map(entry => <div key={entry.id} data-o8-message-id={entry.id}>{entry.text}</div>)} />));
    expect(host.textContent).toContain('Final answer');
    expect(host.textContent).toContain('Spoken answer');
    expect(host.textContent).toContain('Spoken acknowledgment');
    expect(host.textContent).toContain('Another spoken thought');
    expect(host.textContent).not.toContain('Inspecting');
    expect(host.textContent).toContain('Edited 1 file');
  });
});

describe('prompt navigation', () => {
  it('only appears for an overflowing wide conversation, and scrolls only that pane', () => {
    vi.useFakeTimers();
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
    vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    window.matchMedia = vi.fn().mockReturnValue({ matches: true });
    const scroll = document.createElement('div'); const scrollRef = createRef<HTMLDivElement>(); scrollRef.current = scroll;
    let width = 900;
    Object.defineProperties(scroll, { clientWidth: { get: () => width }, clientHeight: { value: 400 }, scrollHeight: { value: 1800 } });
    scroll.scrollTo = vi.fn(); host.appendChild(scroll);
    const prompts = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, role: 'user' as const, text: `Prompt ${i}` }));
    for (const prompt of prompts) { const node = document.createElement('div'); node.dataset.o8MessageId = prompt.id; scroll.appendChild(node); }
    act(() => root.render(createElement(TranscriptNavigator, { entries: prompts, scrollRef })));
    act(() => vi.runOnlyPendingTimers());
    expect(host.querySelectorAll('nav button')).toHaveLength(6);
    act(() => host.querySelector<HTMLButtonElement>('nav button')!.click());
    expect(scroll.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'instant' }));
    const retained = host.querySelector('nav');
    width = 0;
    act(() => { scroll.dispatchEvent(new Event('scroll')); vi.runOnlyPendingTimers(); });
    expect(host.querySelector('nav')).toBe(retained);
    width = 480;
    act(() => { scroll.dispatchEvent(new Event('scroll')); vi.runOnlyPendingTimers(); });
    expect(host.querySelector('nav')).toBeNull();
  });
});

describe('long-history prompt navigation', () => {
  it('bounds layout reads per scroll while jumping to the correct prompt among 5,000 messages', () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
    vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    const scroll = document.createElement('div');
    const scrollRef = createRef<HTMLDivElement>(); scrollRef.current = scroll;
    Object.defineProperties(scroll, { clientWidth: { value: 900 }, clientHeight: { value: 400 }, scrollHeight: { value: 500000 } });
    scroll.getBoundingClientRect = () => ({ top: 0 } as DOMRect);
    scroll.scrollTo = vi.fn();
    window.matchMedia = vi.fn().mockReturnValue({ matches: true });
    let reads = 0;
    const history: MobileTranscriptEntry[] = Array.from({ length: 5000 }, (_, index) => ({
      id: `long-${index}`, role: index % 2 ? 'assistant' : 'user', text: `Message ${index}`,
    }));
    for (const [index, entry] of history.entries()) {
      const node = document.createElement('div'); node.dataset.o8MessageId = entry.id;
      node.getBoundingClientRect = () => { reads++; return { top: index * 100 - scroll.scrollTop } as DOMRect; };
      scroll.appendChild(node);
    }
    host.appendChild(scroll);
    act(() => root.render(<TranscriptNavigator entries={history} scrollRef={scrollRef} />));
    act(() => vi.runOnlyPendingTimers());
    reads = 0; scroll.scrollTop = 250000;
    const scans = vi.spyOn(scroll, 'querySelectorAll');
    act(() => { scroll.dispatchEvent(new Event('scroll')); vi.runOnlyPendingTimers(); });
    expect(host.querySelector('[aria-current="step"]')?.getAttribute('aria-label')).toContain('Message 2500');
    console.info('[transcript-navigation] messages=5000 layoutReads=%d DOMScans=%d', reads, scans.mock.calls.length);
    expect(reads).toBeLessThan(20);
    expect(scans).not.toHaveBeenCalled();
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Jump to prompt 2001: Message 4000"]')!.click());
    expect(scroll.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 399982 }));
  });
});

describe('composer activity', () => {
  it('opens a real structured plan and current-turn agent details without inventing a goal', () => {
    const activity: MobileTranscriptEntry[] = [{ id: 'request', role: 'user', text: 'Work' }, {
      id: 'work', role: 'assistant', text: '', toolCalls: [
        { name: 'update_plan', status: 'done', args: { plan: [{ step: 'Inspect source', status: 'completed' }, { step: 'Verify UI', status: 'in_progress' }] } },
        { id: 'scout', name: 'Task', status: 'running', args: { description: 'Check accessibility' } },
      ],
    }];
    act(() => root.render(<TranscriptActivity entries={activity} packets={[]} busy repoPath="/repo" />));
    expect(host.textContent).toContain('1 agent'); expect(host.textContent).toContain('Plan · 1/2');
    act(() => [...host.querySelectorAll('button')].find(button => button.textContent?.startsWith('Plan'))!.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Verify UI');
    act(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    act(() => [...host.querySelectorAll('button')].find(button => button.textContent?.startsWith('1 agent'))!.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Check accessibility');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Running');
  });
});
