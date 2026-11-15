// @ts-expect-error jsdom is a test dependency without bundled declarations.
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AskTurn } from '@/components/desktop/dictation/DockAskPanel';
import { askFrame, askTurns } from './nativeDockAsk';

const bus = { handlers: new Map<string, Set<(event: { payload: unknown }) => void>>() };
vi.mock('@/lib/tauri/bridge', () => ({ isTauri: () => true }));
vi.mock('@/lib/mobile/ws-token-client', () => ({ getMobileWsToken: () => 'fixture' }));
const invoke = vi.fn(async (command: string, _args?: unknown): Promise<unknown> => {
  if (command === 'voice_prefs_get') return { dictation_top_pill: false, reading_speed: 1 };
  return { active: false };
});
/** The real @tauri-apps/api modules over a fake IPC bridge: listeners land in
 * `bus`, every other command in `invoke`. */
function tauriBridge() {
  const callbacks = new Map<number, (event: { payload: unknown }) => void>();
  const listeners = new Map<number, [string, (event: { payload: unknown }) => void]>();
  let next = 1;
  return {
    __TAURI_INTERNALS__: {
      transformCallback: (callback: (event: { payload: unknown }) => void) => { callbacks.set(next, callback); return next++; },
      unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: async (command: string, args: Record<string, unknown>) => {
        if (command === 'plugin:event|listen') {
          const name = String(args.event);
          const handler = callbacks.get(Number(args.handler))!;
          const set = bus.handlers.get(name) ?? new Set();
          set.add(handler); bus.handlers.set(name, set);
          listeners.set(next, [name, handler]);
          return next++;
        }
        if (command === 'plugin:event|unlisten') {
          const entry = listeners.get(Number(args.eventId));
          if (entry) bus.handlers.get(entry[0])?.delete(entry[1]);
          return undefined;
        }
        if (command.startsWith('plugin:event|')) return undefined;
        return invoke(command, args);
      },
    },
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => undefined },
  };
}
const pipe = vi.hoisted(() => ({ requestNextPill: vi.fn(), requestNextHud: vi.fn() }));
vi.mock('@/lib/next/browser-pipe', () => pipe);
vi.mock('@/lib/operator/defaults', () => ({ getOperatorDefaults: async () => ({ values: { nativeDictationPill: true } }) }));

type AskSent = { rev: number; copied?: number; turns: unknown[] };
type Frame = { action: string; session?: number; kind?: string; immediate?: boolean; snapshot?: Record<string, unknown> & { ask: AskSent } };
let root: Root;
let host: HTMLDivElement;
let dom: JSDOM;
let reply: Record<string, unknown>;
const frames: Frame[] = [];
const writes: string[] = [];
let clipboardFails = false;

async function tick(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
async function emit(name: string, payload: unknown) {
  await act(async () => { for (const handler of bus.handlers.get(name) ?? []) handler({ payload }); });
}
const sent = () => frames.filter(frame => frame.action === 'frame').at(-1)?.snapshot;
const expanded = () => invoke.mock.calls.filter(([command]) => command === 'dock_set_expanded').at(-1)?.[1];
/** What the web page paints: the dock wrapper's display and any Ask panel. */
const web = () => {
  const wrapper = host.firstElementChild as HTMLElement;
  return { visible: wrapper.style.display !== 'none', ask: host.innerHTML.includes('aria-label="Close"') };
};
const answer = (question: string, text: string) => emit('o8:ask-answer', { question, answer: text });

/** Mount the dock page; its listeners register through dynamic imports. */
async function mount() {
  const { default: Page } = await import('./page');
  await act(async () => { root.render(createElement(Page)); });
  await vi.waitFor(() => expect(bus.handlers.has('o8:agent-task-event') && bus.handlers.has('o8:ask-answer')).toBe(true));
  await tick(100);
}

beforeEach(async () => {
  // Real microtask and I/O scheduling for the page's dynamic imports; fake clocks only.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }); vi.setSystemTime(1_000_000);
  frames.length = 0; writes.length = 0; clipboardFails = false; bus.handlers.clear(); invoke.mockClear();
  reply = { native: true, enabled: true };
  dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true });
  Object.assign(dom.window, tauriBridge());
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('localStorage', dom.window.localStorage);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 16));
  vi.stubGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: {
    writeText: async (text: string) => { if (clipboardFails) throw new Error('denied'); writes.push(text); },
  } });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    frames.push(JSON.parse(init.body));
    const value = reply;
    if (reply.actions || reply.finishSession !== undefined) reply = { native: true, enabled: true };
    return new Response(JSON.stringify(value));
  }));
  host = document.createElement('div');
  root = createRoot(host);
  await mount();
});
afterEach(async () => {
  await act(async () => root.unmount());
  dom.window.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
});

describe('the Ask panel through the real dock page', () => {
  it('an answer opens the panel natively; the web paints nothing and keeps its window collapsed', async () => {
    await emit('o8:ask-open', {});
    await tick(150);
    expect(sent()).toMatchObject({ state: 'ask', ask: { listening: true, turns: [] } });
    expect(web()).toEqual({ visible: false, ask: false });
    await answer('What changed?', 'Two things.');
    await tick(150);
    const session = sent()?.session;
    expect(sent()).toMatchObject({ state: 'ask', ask: { listening: false, turns: [
      { index: 0, role: 'user', text: 'What changed?' }, { index: 1, role: 'assistant', text: 'Two things.' },
    ] } });
    expect(web()).toEqual({ visible: false, ask: false });
    expect(expanded()).toEqual({ expanded: false });
    // Ask is an interactive state: it keeps the 100 ms keep-alive, not a static hold.
    const count = frames.length;
    await tick(1000);
    expect(frames.length - count).toBeGreaterThanOrEqual(8);
    expect(sent()?.holdMs).toBeUndefined();
    expect(sent()?.session).toBe(session);
  });

  it('runs close, copy and activity once each, only for the thread on screen', async () => {
    await answer('Q1', 'A1');
    await tick(150);
    const session = sent()?.session as number;
    const rev = String(sent()?.ask.rev);
    // A copy drawn for an older thread, a copy of a question, and one from another session: all dropped.
    reply = { native: true, enabled: true, actions: [
      { session, state: 'ask', action: 'ask-copy', value: 1, ref: String(Number(rev) - 1) },
      { session, state: 'ask', action: 'ask-copy', value: 0, ref: rev },
      { session: session + 1, state: 'ask', action: 'ask-copy', value: 1, ref: rev },
      { session, state: 'speaking', action: 'ask-copy', value: 1, ref: rev },
    ] };
    await tick(150);
    expect(writes).toEqual([]);
    reply = { native: true, enabled: true, actions: [{ session, state: 'ask', action: 'ask-copy', value: 1, ref: rev }] };
    await tick(150);
    expect(writes).toEqual(['A1']);
    await tick(150);
    expect(sent()?.ask.copied).toBe(1);
    // act() commits at the end of each tick, as the page renders after the timer.
    await tick(1500); await tick(150);
    expect(sent()?.ask).not.toHaveProperty('copied');
    // A new turn moves the thread on: a copy drawn for the old one does nothing.
    await answer('Q2', 'A2');
    await tick(150);
    reply = { native: true, enabled: true, actions: [{ session, state: 'ask', action: 'ask-copy', value: 1, ref: rev }] };
    await tick(150);
    expect(writes).toEqual(['A1']);
    // A failed clipboard write never shows Copied.
    clipboardFails = true;
    const now = String(sent()?.ask.rev);
    reply = { native: true, enabled: true, actions: [{ session, state: 'ask', action: 'ask-copy', value: 3, ref: now }] };
    await tick(150); await tick(150);
    expect(sent()?.ask).not.toHaveProperty('copied');
    // Activity re-arms the 45 s idle collapse; without it the panel closes.
    await tick(40_000);
    reply = { native: true, enabled: true, actions: [{ session, state: 'ask', action: 'ask-active', value: null, ref: now }] };
    await tick(150);
    await tick(40_000);
    expect(sent()?.state).toBe('ask');
    reply = { native: true, enabled: true, actions: [{ session, state: 'ask', action: 'ask-close', value: null, ref: now }] };
    await tick(150);
    expect(frames.at(-1)).toMatchObject({ action: 'release', kind: 'ask', session });
    expect(web()).toEqual({ visible: false, ask: false });
  });

  it('a pending agent dictation draws inside the native panel and a click finishes it', async () => {
    await answer('Q1', 'A1');
    await tick(150);
    const session = sent()?.session as number;
    await emit('o8:stt-event', { type: 'system-start', origin: 'system', lane: 'agent', sessionId: 1, startId: 's1' });
    await emit('o8:stt-event', { type: 'partial', origin: 'system', text: 'and then', sessionId: 1, startId: 's1' });
    await tick(150);
    expect(sent()).toMatchObject({ state: 'ask', session, ask: { pending: { phase: 'listening', text: 'and then' } } });
    expect(web()).toEqual({ visible: false, ask: false });
    reply = { native: true, enabled: true, finishSession: session };
    await tick(150);
    expect(invoke.mock.calls.some(([command]) => command === 'o8_system_dictation_finish')).toBe(true);
    // A plain dictation (no pending turn) wins over Ask: neither surface draws Ask.
    await emit('o8:stt-event', { type: 'system-idle', origin: 'system', sessionId: 1, startId: 's1' });
    await tick(6000);
    await emit('o8:stt-event', { type: 'system-start', origin: 'system', sessionId: 2, startId: 's2' });
    await tick(150);
    expect(sent()?.state).toBe('recording');
    expect(web().ask).toBe(false);
  });

  it('falls back to the web Ask panel when the native panel stops acknowledging', async () => {
    await answer('Q1', 'A1');
    await tick(150);
    vi.mocked(fetch).mockImplementation((_url, init) => {
      frames.push(JSON.parse(String(init?.body)));
      return new Promise<Response>(() => undefined);
    });
    await tick(599);
    expect(web()).toEqual({ visible: true, ask: true });
    expect(frames.at(-1)).toMatchObject({ action: 'release', kind: 'ask', immediate: true });
    expect(expanded()).toEqual({ expanded: true });
  });
});

describe('the confirmation card through the real dock page', () => {
  const card = (id: string, task = 'task-1') => ({ confirmationId: id, taskId: task, tool: 'send', summary: 'Send the draft' });
  const decisions = () => invoke.mock.calls.filter(([command]) => command === 'agent_confirm_exact').map(([, args]) => args);

  it('draws the exact card natively and runs one decision for it', async () => {
    await emit('o8:agent-confirm', card('c-1'));
    await tick(150);
    const session = sent()?.session as number;
    expect(sent()).toMatchObject({ state: 'confirm', confirm: { id: 'c-1', task: 'task-1', kind: 'action', summary: 'Send the draft' } });
    expect(web()).toEqual({ visible: false, ask: false });
    expect(host.innerHTML).not.toContain('for confirmation');
    reply = { native: true, enabled: true, actions: [
      { session, state: 'confirm', action: 'confirm-allow', value: null, ref: 'c-1', task: 'task-1' },
      { session, state: 'confirm', action: 'confirm-deny', value: null, ref: 'c-1', task: 'task-1' },
    ] };
    await tick(150);
    expect(decisions()).toEqual([{ confirmationId: 'c-1', taskId: 'task-1', allow: true }]);
    await tick(150);
    expect(frames.at(-1)).toMatchObject({ action: 'release', kind: 'confirm', session });
  });

  it('a click on a card that has since changed does nothing', async () => {
    await emit('o8:agent-confirm', card('c-1'));
    await tick(150);
    const first = sent()?.session as number;
    await emit('o8:agent-confirm', card('c-2'));
    await tick(150);
    const second = sent()?.session as number;
    expect(second).not.toBe(first);
    reply = { native: true, enabled: true, actions: [
      { session: first, state: 'confirm', action: 'confirm-allow', value: null, ref: 'c-1', task: 'task-1' },
      { session: second, state: 'confirm', action: 'confirm-allow', value: null, ref: 'c-1', task: 'task-1' },
      { session: second, state: 'confirm', action: 'confirm-allow', value: null, ref: 'c-2', task: 'task-9' },
      { session: second, state: 'ask', action: 'confirm-allow', value: null, ref: 'c-2', task: 'task-1' },
    ] };
    await tick(150);
    expect(decisions()).toEqual([]);
    // Dismissed by the agent: a late click for it does nothing either.
    await emit('o8:agent-confirm-dismissed', { confirmationId: 'c-2', taskId: 'task-1' });
    await tick(150);
    reply = { native: true, enabled: true, actions: [{ session: second, state: 'confirm', action: 'confirm-deny', value: null, ref: 'c-2', task: 'task-1' }] };
    await tick(300);
    expect(decisions()).toEqual([]);
  });

  it('waits behind a real dictation on both surfaces and falls back to the web card', async () => {
    await emit('o8:agent-confirm', card('c-1'));
    await emit('o8:stt-event', { type: 'system-start', origin: 'system', sessionId: 1, startId: 's1' });
    await tick(150);
    expect(sent()?.state).toBe('recording');
    expect(host.innerHTML).not.toContain('for confirmation');
    await emit('o8:stt-event', { type: 'system-idle', origin: 'system', sessionId: 1, startId: 's1' });
    await tick(150);
    expect(sent()).toMatchObject({ state: 'confirm', confirm: { id: 'c-1' } });
    vi.mocked(fetch).mockImplementation((_url, init) => {
      frames.push(JSON.parse(String(init?.body)));
      return new Promise<Response>(() => undefined);
    });
    await tick(599);
    expect(host.innerHTML).toContain('for confirmation');
    expect(web().visible).toBe(true);
    expect(frames.at(-1)).toMatchObject({ action: 'release', kind: 'confirm', immediate: true });
  });

  it('the route forwards only a decision naming a confirmation and task', async () => {
    const { POST } = await import('@/app/api/next/dictation-pill/route');
    pipe.requestNextPill.mockResolvedValue({ ok: true, actions: [
      { session: 1, state: 'confirm', action: 'confirm-allow', value: null, ref: 'c-1', task: 't' },
      { session: 1, state: 'confirm', action: 'confirm-deny', value: 3, ref: 'c-1' },
      { session: 1, state: 'confirm', action: 'confirm-deny', value: null, ref: 'c\n1', task: 't' },
      { session: 1, state: 'ask', action: 'confirm-allow', value: null, ref: 'c-1', task: 't' },
    ] });
    const request = new Request('http://localhost/api/next/dictation-pill', { method: 'POST', body: JSON.stringify({ action: 'frame', checkSettings: true }) });
    expect((await (await POST(request as never)).json()).actions).toEqual([
      { session: 1, state: 'confirm', action: 'confirm-allow', value: null, ref: 'c-1', task: 't' },
    ]);
  });
});

describe('the drop target and staged chips through the real dock page', () => {
  /** A Finder drag as WKWebView delivers it: document-level DOM drag events carrying Files. */
  async function drag(type: 'dragenter' | 'dragover' | 'drop', files: File[] = []) {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files, dropEffect: 'none' } });
    await act(async () => { document.dispatchEvent(event); });
  }
  const file = (name: string, size: number) => new dom.window.File(['x'.repeat(size)], name, { type: 'text/plain' }) as File;

  it('with the top-pill preference, a drag draws the native drop target and a drop the native chips', async () => {
    await emit('o8:top-pill-preference', { enabled: true });
    await drag('dragenter');
    await tick(150);
    expect(sent()).toMatchObject({ state: 'drop', holdMs: 5000 });
    expect(host.innerHTML).not.toContain('Drop files for Symon');
    expect(web().visible).toBe(false);
    await drag('drop', [file('a.txt', 2048), file('b.md', 10), file('c.ts', 3000), file('d.json', 5)]);
    await vi.waitFor(() => expect(invoke.mock.calls.some(([command]) => command === 'agent_files_stage')).toBe(true));
    await tick(150);
    expect(sent()).toMatchObject({ state: 'staged', staged: { extra: 1, files: [
      { name: 'a.txt', size: '2 KB' }, { name: 'b.md', size: '1 KB' }, { name: 'c.ts', size: '3 KB' },
    ] } });
    expect(host.innerHTML).not.toContain('Staged — hold');
    // The chips relax after 6 s, as on the web, back to the resting sliver.
    await tick(6000); await tick(150);
    expect(sent()).toMatchObject({ state: 'sliver' });
  });

  it('without the preference neither dock draws them, as on main; a stall returns the web chips', async () => {
    await drag('dragenter');
    await tick(150);
    expect(frames.filter(frame => frame.action === 'frame')).toEqual([]);
    expect(web().visible).toBe(false);
    await drag('dragleave' as 'drop');
    await emit('o8:top-pill-preference', { enabled: true });
    await drag('dragenter');
    await drag('drop', [file('a.txt', 2048)]);
    await vi.waitFor(() => expect(invoke.mock.calls.some(([command]) => command === 'agent_files_stage')).toBe(true));
    await tick(150);
    expect(sent()?.state).toBe('staged');
    vi.mocked(fetch).mockImplementation((_url, init) => {
      frames.push(JSON.parse(String(init?.body)));
      return new Promise<Response>(() => undefined);
    });
    // A static frame's next request is its 4 s keep-alive; it stalls past the deadline.
    await tick(4700);
    expect(host.innerHTML).toContain('Staged — hold');
    expect(frames.at(-1)).toMatchObject({ action: 'release', kind: 'staged', immediate: true });
  });
});

describe('the idle sliver and the Voice settings shortcut through the real dock page', () => {
  const settings = () => invoke.mock.calls.filter(([command]) => command === 'open_voice_settings').length;

  it('draws the resting sliver natively only with the top-pill preference, and its double click opens Voice settings', async () => {
    expect(frames.filter(frame => frame.action === 'frame')).toEqual([]);
    await emit('o8:top-pill-preference', { enabled: true });
    await tick(150);
    const session = sent()?.session as number;
    expect(sent()).toMatchObject({ state: 'sliver', holdMs: 5000 });
    expect(web().visible).toBe(false);
    reply = { native: true, enabled: true, actions: [
      { session, state: 'sliver', action: 'voice-settings', value: null },
      { session: session + 1, state: 'sliver', action: 'voice-settings', value: null },
      { session, state: 'speaking', action: 'voice-settings', value: null },
    ] };
    await emit('o8:worker-status', { count: 0 });
    await tick(4200);
    expect(settings()).toBe(1);
    // Over speech the dock is not resting: a late shortcut does nothing.
    await emit('o8:tts-state', { state: 'playing' });
    await tick(150);
    expect(sent()?.state).toBe('speaking');
    reply = { native: true, enabled: true, actions: [{ session, state: 'sliver', action: 'voice-settings', value: null }] };
    await tick(300);
    expect(settings()).toBe(1);
    // The preference off: the sliver is released and nothing draws at idle.
    await emit('o8:tts-state', { state: 'idle' });
    await emit('o8:top-pill-preference', { enabled: false });
    await tick(300);
    expect(frames.at(-1)).toMatchObject({ action: 'release' });
  });

  it('the route forwards the shortcut only from the resting dock', async () => {
    const { POST } = await import('@/app/api/next/dictation-pill/route');
    pipe.requestNextPill.mockResolvedValue({ ok: true, actions: [
      { session: 1, state: 'sliver', action: 'voice-settings', value: null },
      { session: 1, state: 'workers', action: 'voice-settings', value: 2 },
      { session: 1, state: 'ask', action: 'voice-settings', value: null },
    ] });
    const request = new Request('http://localhost/api/next/dictation-pill', { method: 'POST', body: JSON.stringify({ action: 'frame', checkSettings: true }) });
    expect((await (await POST(request as never)).json()).actions).toEqual([
      { session: 1, state: 'sliver', action: 'voice-settings', value: null },
      { session: 1, state: 'workers', action: 'voice-settings', value: null },
    ]);
  });
});

describe('flag off', () => {
  it('the web page draws the Ask panel exactly as before and sends nothing after the probe', async () => {
    await act(async () => root.unmount());
    frames.length = 0;
    reply = { native: false, enabled: false };
    bus.handlers.clear();
    root = createRoot(host);
    await mount();
    await answer('Q1', 'A1');
    await emit('o8:agent-confirm', { confirmationId: 'c-1', taskId: 't', tool: 'send', summary: 'Send it' });
    await tick(5000);
    expect(frames).toHaveLength(1);
    expect(host.innerHTML).toContain('for confirmation');
    await emit('o8:agent-confirm-dismissed', { confirmationId: 'c-1', taskId: 't' });
    expect(web()).toEqual({ visible: true, ask: true });
    expect(expanded()).toEqual({ expanded: true });
  });
});

describe('Ask frame protocol', () => {
  const thread = (count: number, size: number): AskTurn[] => Array.from({ length: count }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user', text: `${index} ` + 'é'.repeat(size),
  }));

  it('keeps the newest turns within the byte budget, so the request stays under 8 KiB', () => {
    const turns = askTurns(thread(16, 900));
    expect(turns.at(-1)?.index).toBe(15);
    expect(turns[0].index).toBeGreaterThan(0);
    expect(new TextEncoder().encode(JSON.stringify(turns)).length).toBeLessThanOrEqual(4500);
    const one = askTurns([{ role: 'assistant', text: 'x'.repeat(20_000) }]);
    expect(one).toHaveLength(1);
    expect(one[0].text.endsWith('…')).toBe(true);
    const frame = askFrame({ mode: 'answer', thread: thread(16, 900), pending: { phase: 'listening', text: 'y'.repeat(5000) } }, 3,
      { agentWorking: true, agentTool: 'o8_ask', agentStartedAt: 5 }, 15);
    const body = JSON.stringify({ action: 'frame', checkSettings: false, deadline: Date.now(), snapshot: {
      state: 'ask', session: 1, audioLevel: 0.5, durationMs: 0, ask: frame,
      edit: { id: 1, app: 'a'.repeat(120), status: 'ready', until: 1 }, glint: { text: 'g'.repeat(200), tone: 'progress', fadeAt: 1, until: 2 },
    } });
    expect(new TextEncoder().encode(body).length).toBeLessThan(8192);
    expect(frame).toMatchObject({ rev: 3, working: { tool: 'o8_ask', startedAt: 5 }, copied: 15 });
  });

  it('words the sources line as the web panel does', () => {
    expect(askTurns([{ role: 'assistant', text: 'A', sources: [{ kind: 'note', title: 'One' }, { kind: 'note', title: 'Two' }] }]))
      .toEqual([{ index: 0, role: 'assistant', text: 'A', sources: '2 sources · One · Two' }]);
  });

  it('the route forwards only well-formed Ask intents', async () => {
    const { POST } = await import('@/app/api/next/dictation-pill/route');
    pipe.requestNextPill.mockResolvedValue({ ok: true, actions: [
      { session: 1, state: 'ask', action: 'ask-copy', value: 2, ref: '4' },
      { session: 1, state: 'ask', action: 'ask-copy', value: null, ref: '4' },
      { session: 1, state: 'ask', action: 'ask-close', value: null },
      { session: 1, state: 'ask', action: 'ask-close', value: null, ref: '4; drop' },
      { session: 1, state: 'speaking', action: 'ask-close', value: null, ref: '4' },
      { session: 1, state: 'ask', action: 'ask-active', value: null, ref: '4' },
    ] });
    const request = new Request('http://localhost/api/next/dictation-pill', { method: 'POST', body: JSON.stringify({ action: 'frame', checkSettings: true }) });
    const response = await POST(request as never);
    expect((await response.json()).actions).toEqual([
      { session: 1, state: 'ask', action: 'ask-copy', value: 2, ref: '4' },
      { session: 1, state: 'ask', action: 'ask-active', value: null, ref: '4' },
    ]);
  });
});
