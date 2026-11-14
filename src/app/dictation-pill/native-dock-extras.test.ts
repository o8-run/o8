// @ts-expect-error jsdom is a test dependency without bundled declarations.
import { JSDOM } from 'jsdom';
import { act, createElement, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DockPrecedenceInput } from '@/components/desktop/dictation/dockPrecedence';
import type { DictationSnapshot } from '@/components/desktop/dictation/types';
import { useNativeDock, type NativeDockInput } from './nativeDockFrame';
import { DockGlint, useDockGlint, type TimedGlint } from './DockGlint';
import { EditRevertChip } from './EditRevertChip';

const bus = vi.hoisted(() => ({ handlers: new Map<string, (event: { payload: unknown }) => void>(), names: [] as string[] }));
vi.mock('@/lib/tauri/bridge', () => ({ isTauri: () => true }));
vi.mock('@/lib/mobile/ws-token-client', () => ({ getMobileWsToken: () => 'fixture' }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    bus.names.push(name); bus.handlers.set(name, handler);
    return () => bus.handlers.delete(name);
  },
}));
const invoke = vi.hoisted(() => vi.fn(async (command: string) => (command === 'agent_edit_revert' ? { outcome: 'restored' } : { active: false })));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

const IDLE: DictationSnapshot = { state: 'idle', audioLevel: 0, durationMs: 0, error: null, partialTranscript: '' };
const QUIET: Omit<DockPrecedenceInput, 'dictationState' | 'panelPending'> = {
  ttsState: 'idle', askOpen: false, agentConfirm: false, agentWorking: false,
  dropActive: false, stagedFiles: false, showWorkers: false, workerCount: 0, realtimeVoice: 'off',
};
type Input = Omit<NativeDockInput, 'edit' | 'glint' | 'topPill'> & { topPill?: boolean; glint?: TimedGlint | null };
type Dock = ReturnType<typeof useNativeDock>;
type Frame = { action: string; session?: number; kind?: string; immediate?: boolean; snapshot?: Record<string, unknown> };

let root: Root;
let host: HTMLDivElement;
let dom: JSDOM;
let input: Input;
let dock: Dock;
let showGlint: (text: string) => void;
let expandWorkers = vi.fn();
let reply: Record<string, unknown>;
const frames: Frame[] = [];
const fleet = (working: number, waiting = 0) => ({
  workerCount: working + waiting,
  workers: { count: working + waiting, working, waiting, label: 'ready', repos: ['o8'] },
});

const noop = () => undefined;
function Probe() {
  const glint = useDockGlint();
  const { topPill, glint: fixed, ...rest } = input;
  const view = useNativeDock({ ...rest, glint: fixed === undefined ? glint.glint : fixed }, {
    finishSystemDictation: () => undefined, handleTogglePause: () => undefined, handleStop: () => undefined,
    handleInterrupt: () => undefined, stopRealtimeVoice: () => undefined, handleSpeechSpeed: () => undefined,
    expandWorkers, invokeCmd: noop, onError: noop,
  }, { topPillEnabled: topPill === true, staged: input.stagedFiles });
  useLayoutEffect(() => { dock = view; showGlint = glint.showGlint; });
  // The web glint exactly as page.tsx renders it.
  return view.webGlint ? createElement(DockGlint, { key: view.webGlint.key, glint: view.webGlint, fading: glint.fading, handedBack: view.webGlintHandedBack }) : null;
}
/** The web glint's animation as rendered, or null when the web draws none. */
const webGlintAnimation = () => (host.firstElementChild as HTMLElement | null)?.style.animation ?? null;
const ORIGIN_ENTER = 'o8GlintIn 0.3s cubic-bezier(0.22, 1, 0.36, 1)';
async function render(patch: Partial<Input>) {
  input = { ...input, ...patch };
  await act(async () => { root.render(createElement(Probe)); });
}
async function tick(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
async function emit(name: string, payload: unknown) {
  await act(async () => { bus.handlers.get(name)?.({ payload }); });
}
const sent = () => frames.filter(frame => frame.action === 'frame').at(-1)?.snapshot;
const after = (count: number) => frames.slice(count);

beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  frames.length = 0; bus.handlers.clear(); bus.names.length = 0; invoke.mockClear(); expandWorkers = vi.fn();
  input = { ...QUIET, snapshot: IDLE, dictationSession: 0, speechSpeed: 1, agentTool: '', agentStartedAt: 0, topPill: true };
  reply = { native: true, enabled: true };
  dom = new JSDOM('', { url: 'http://localhost' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    frames.push(JSON.parse(init.body));
    const value = reply;
    if (reply.actions) reply = { native: true, enabled: true };
    return new Response(JSON.stringify(value));
  }));
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  dom.window.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
});

describe('native glints, chip and fleet through the real dock hook', () => {
  it('a lone glint is one frame and one release; its fade and end are sent once and never ticked', async () => {
    await render({}); await tick(100);
    expect(dock.native).toBe(true);
    const mounted = frames.length;
    await act(async () => { showGlint('Remembered'); });
    await tick(100);
    expect(sent()).toMatchObject({
      state: 'extras', holdMs: 4800,
      glint: { text: 'Remembered', tone: 'progress', fadeAt: 1_004_300, until: 1_004_900 },
    });
    expect(dock.webGlint).toBeNull();
    expect(dock.dockVisible).toBe(false);
    await tick(10_000);
    const traffic = after(mounted);
    expect(traffic.map(frame => frame.action)).toEqual(['frame', 'release']);
    expect(traffic[1]).toMatchObject({ kind: 'extras', session: traffic[0].snapshot?.session, immediate: false });
  });

  it('a lone fleet orbit holds with one keep-alive every 4 s; a tap expands it without waiting', async () => {
    await render({}); await tick(100);
    const mounted = frames.length;
    await render(fleet(2));
    await tick(60_000);
    const traffic = after(mounted);
    expect(traffic.every(frame => frame.action === 'frame' && frame.snapshot?.holdMs === 5000)).toBe(true);
    expect(traffic.length).toBeGreaterThanOrEqual(15);
    expect(traffic.length).toBeLessThanOrEqual(16);
    expect(sent()).toMatchObject({ state: 'workers', expanded: false, workers: { count: 2, working: 2, label: 'ready', repos: ['o8'] } });
    expect(dock.webWorkerCount).toBe(0);
    const count = frames.length;
    await render({ showWorkers: true }); await tick(10);
    expect(after(count)).toEqual([expect.objectContaining({ action: 'frame', snapshot: expect.objectContaining({ state: 'workers', expanded: true }) })]);
    expect(dock.webShowWorkers).toBe(false);
    expect(dock.nativeCapsule).toBe(true);
    await render({ showWorkers: false }); await tick(10);
    expect(sent()).toMatchObject({ state: 'workers', expanded: false });
    await render({ workerCount: 0, workers: undefined }); await tick(10);
    expect(frames.at(-1)).toMatchObject({ action: 'release', kind: 'workers' });
  });

  it('live voice carries the in-flight worker count, which batch 2 left on the web', async () => {
    await render({ realtimeVoice: 'live', ...fleet(3) }); await tick(200);
    expect(sent()).toMatchObject({ state: 'voice', connecting: false, workers: { working: 3 } });
    await render({ realtimeVoice: 'connecting' }); await tick(200);
    expect(sent()).not.toHaveProperty('workers');
  });

  it.each([
    ['dictation', { snapshot: { ...IDLE, state: 'recording' as const }, dictationSession: 3 }, 'recording'],
    ['done', { snapshot: { ...IDLE, state: 'success' as const }, dictationSession: 3 }, 'success'],
    ['speaking', { ttsState: 'playing' as const }, 'speaking'],
    ['working', { agentWorking: true, agentStartedAt: 999_000 }, 'working'],
    ['voice', { realtimeVoice: 'live' as const }, 'voice'],
    ['fleet orbit', fleet(1), 'workers'],
    ['fleet capsule', { ...fleet(1), showWorkers: true }, 'workers'],
    ['nothing else', {}, 'extras'],
  ] as const)('the chip and glint compose below %s natively, and the web draws neither', async (_name, patch, state) => {
    await render({}); await tick(100);
    await emit('o8:edit-applied', { app: 'Notes' });
    await act(async () => { showGlint('Remembered'); });
    await render(patch); await tick(150);
    expect(sent()).toMatchObject({ state, edit: { id: 1, app: 'Notes', status: 'ready', until: 1_020_100 }, glint: { text: 'Remembered' } });
    expect(dock.webEdit).toBeNull();
    expect(dock.webGlint).toBeNull();
    expect(dock.edit).toMatchObject({ id: 1 });
  });

  it.each([
    ['Ask', { askOpen: true }], ['a confirmation', { agentConfirm: true }], ['a drop', { dropActive: true }], ['staged files', { stagedFiles: true }],
  ] as const)('beside native dictation, %s keeps the chip and glint on the web, under that surface', async (_name, patch) => {
    await render({}); await tick(100);
    await emit('o8:edit-applied', { app: 'Notes' });
    await act(async () => { showGlint('Remembered'); });
    await render({ ...patch, snapshot: { ...IDLE, state: 'recording' }, dictationSession: 4 }); await tick(150);
    expect(sent()?.state).toBe('recording');
    expect(sent()).not.toHaveProperty('edit');
    expect(sent()).not.toHaveProperty('glint');
    expect(dock.webEdit).toMatchObject({ id: 1 });
    expect(dock.webGlint).toMatchObject({ text: 'Remembered' });
    expect(dock.dockVisible).toBe(true);
    // Without dictation the still-web surface wins: native releases at once, the web draws all of it.
    await render({ snapshot: IDLE }); await tick(150);
    expect(frames.at(-1)).toMatchObject({ action: 'release', immediate: true });
    expect(dock.webEdit).toMatchObject({ id: 1 });
    expect(dock.webGlint).not.toBeNull();
  });

  it('the chip dismisses from its timestamp: sent once, unchanged on every frame, then gone', async () => {
    await render({ agentWorking: true, agentStartedAt: 999_000 }); await tick(100);
    await emit('o8:edit-applied', { app: 'Notes' });
    await tick(5000);
    const carrying = frames.filter(frame => frame.snapshot?.edit);
    expect(carrying.length).toBeGreaterThan(40);
    expect(new Set(carrying.map(frame => JSON.stringify(frame.snapshot?.edit)))).toEqual(new Set([JSON.stringify({ id: 1, app: 'Notes', status: 'ready', until: 1_020_100 })]));
    await tick(14_899);
    expect(sent()?.edit).toMatchObject({ id: 1 });
    // act() renders at the end of each tick, as the page renders after the timer.
    await tick(101); await tick(200);
    expect(sent()).not.toHaveProperty('edit');
    await emit('o8:edit-applied', { app: '' });
    await emit('o8:edit-revert-settled', { outcome: 'copied_to_clipboard' });
    await tick(150);
    expect(sent()?.edit).toEqual({ id: 2, app: '', status: 'copied', until: Date.now() - 150 + 1800 });
  });

  it('runs a revert exactly once, only for the chip on screen still offering it', async () => {
    await render({}); await tick(100);
    await emit('o8:edit-applied', { app: 'Notes' });
    await tick(100);
    const session = sent()?.session as number;
    expect(sent()).toMatchObject({ state: 'extras', edit: { id: 1, status: 'ready' } });
    const reverts = () => invoke.mock.calls.filter(([command]) => command === 'agent_edit_revert');
    reply = { native: true, enabled: true, actions: [
      { session, state: 'extras', action: 'revert', value: null, edit: 2 },
      { session: session + 1, state: 'extras', action: 'revert', value: null, edit: 1 },
      { session, state: 'working', action: 'revert', value: null, edit: 1 },
    ] };
    // A static frame has no keep-alive: the next event's frame carries the reply.
    await act(async () => { showGlint('Remembered'); });
    await tick(100);
    expect(reply.actions).toBeUndefined();
    expect(reverts()).toHaveLength(0);
    reply = { native: true, enabled: true, actions: [
      { session, state: 'extras', action: 'revert', value: null, edit: 1 },
      { session, state: 'extras', action: 'revert', value: null, edit: 1 },
    ] };
    await act(async () => { showGlint('Remembered again'); });
    await tick(100);
    expect(reverts()).toHaveLength(1);
    expect(dock.edit).toMatchObject({ id: 1, status: 'reverted', until: Date.now() - 100 + 1800 });
    expect(sent()?.edit).toMatchObject({ id: 1, status: 'reverted' });
    // Once reverted the chip no longer offers it.
    reply = { native: true, enabled: true, actions: [{ session, state: 'extras', action: 'revert', value: null, edit: 1 }] };
    await emit('o8:edit-revert-settled', { outcome: 'restored' });
    await tick(100);
    expect(reply.actions).toBeUndefined();
    expect(reverts()).toHaveLength(1);
  });

  it('runs a fleet tap once for the orbit on screen and drops a stale or late one', async () => {
    await render(fleet(2)); await tick(100);
    const session = sent()?.session as number;
    reply = { native: true, enabled: true, actions: [
      { session: session + 1, state: 'workers', action: 'workers-expand', value: null },
      { session, state: 'voice', action: 'workers-expand', value: null },
      { session, state: 'workers', action: 'workers-expand', value: null },
    ] };
    await render({ ...fleet(3) }); await tick(100);
    expect(expandWorkers).toHaveBeenCalledOnce();
    // A fleet tap is never run for another capsule, even one that names itself.
    await render({ ttsState: 'playing' }); await tick(100);
    const speaking = sent()?.session as number;
    reply = { native: true, enabled: true, actions: [{ session: speaking, state: 'speaking', action: 'workers-expand', value: null }] };
    await tick(200);
    expect(expandWorkers).toHaveBeenCalledOnce();
    await render({ ttsState: 'idle' }); await tick(100);
    reply = { native: false, enabled: true, absent: true };
    await render({ ...fleet(4) }); await tick(100);
    expect(dock.native).toBe(false);
    reply = { native: true, enabled: true, actions: [{ session, state: 'workers', action: 'workers-expand', value: null }] };
    await render({ ...fleet(5) }); await tick(6000);
    expect(expandWorkers).toHaveBeenCalledOnce();
  });

  it.each([
    ['glint', async () => { await act(async () => { showGlint('Remembered'); }); }],
    ['chip', async () => { await emit('o8:edit-applied', { app: 'Notes' }); }],
    ['fleet orbit', async () => { await render(fleet(2)); }],
  ] as const)('a stalled %s frame returns the web surface within the deadline', async (_name, start) => {
    await render({}); await tick(100);
    vi.mocked(fetch).mockImplementation((_url, init) => {
      frames.push(JSON.parse(String(init?.body)));
      return new Promise<Response>(() => undefined);
    });
    await start();
    await tick(499);
    expect(dock.native).toBe(true);
    await tick(1);
    expect(dock.native).toBe(false);
    expect(frames.at(-1)).toMatchObject({ action: 'release' });
    expect(dock.webGlint !== null || dock.webEdit !== null || dock.webWorkerCount === 2).toBe(true);
  });
});

describe('the top-pill preference and an unknown flag', () => {
  it('with the top-pill preference off, the orbit, chip and glint alone draw nothing anywhere', async () => {
    await render({ topPill: false }); await tick(100);
    const mounted = frames.length;
    await render(fleet(2)); await tick(100);
    await render({ showWorkers: true }); await tick(100);
    await emit('o8:edit-applied', { app: 'Notes' });
    await act(async () => { showGlint('Remembered'); });
    await tick(30_000);
    expect(after(mounted)).toEqual([]);
    expect(dock.nativeActive).toBe(false);
    expect(dock.dockVisible).toBe(false);
    // Beside a capsule the dock is visible on the web too, so the chip and glint draw with it.
    await render({ ttsState: 'playing', showWorkers: false });
    await emit('o8:edit-applied', { app: 'Notes' });
    await act(async () => { showGlint('Again'); });
    await tick(150);
    expect(sent()).toMatchObject({ state: 'speaking', edit: { app: 'Notes' }, glint: { text: 'Again' } });
    // The preference on: the same idle surfaces draw natively.
    await render({ ttsState: 'idle', topPill: true }); await tick(150);
    expect(sent()).toMatchObject({ state: 'workers', edit: { app: 'Notes' } });
  });

  it.each([
    ['times out', () => new Promise<Response>(() => undefined)],
    ['errors', () => Promise.reject(new Error('route down'))],
    ['returns a server error', () => Promise.resolve(new Response('{}', { status: 500 }))],
  ] as const)('when the startup probe %s, the orbit, chip and glint send nothing; dictation retries as before', async (_name, probe) => {
    let first = true;
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      frames.push(JSON.parse(String(init?.body)));
      if (first) { first = false; return probe(); }
      return new Response(JSON.stringify(reply));
    });
    await render({}); await tick(600);
    expect(frames).toHaveLength(1);
    for (const patch of [fleet(2), { showWorkers: true }, fleet(3), { showWorkers: false }, { workerCount: 0, workers: undefined }]) {
      await render(patch); await tick(500);
      await emit('o8:edit-applied', { app: 'Notes' });
      await act(async () => { showGlint('Remembered'); });
      await tick(6000);
    }
    expect(frames).toHaveLength(1);
    expect(dock.native).toBe(false);
    expect(dock.webWorkerCount).toBe(0);
    // A dictation session prepares once, as origin/main does after a failed probe;
    // once a reply says the flag is on, the orbit may go native.
    await render({ snapshot: { ...IDLE, state: 'recording' }, dictationSession: 9 }); await tick(150);
    expect(frames[1]).toMatchObject({ action: 'prepare', checkSettings: true });
    await render({ snapshot: IDLE, ...fleet(2) }); await tick(150);
    expect(sent()).toMatchObject({ state: 'workers' });
  });

  it('a glint the native panel hands back to the web mid-life does not replay its fade-in', async () => {
    await render({}); await tick(100);
    await act(async () => { showGlint('Remembered'); });
    await tick(100);
    expect(sent()).toMatchObject({ state: 'extras', glint: { text: 'Remembered' } });
    expect(webGlintAnimation()).toBeNull();
    // The panel's next request stalls; the deadline hands the glint back to the web.
    vi.mocked(fetch).mockImplementation((_url, init) => {
      frames.push(JSON.parse(String(init?.body)));
      return new Promise<Response>(() => undefined);
    });
    await render({ ...fleet(1) }); await tick(600);
    expect(dock.native).toBe(false);
    expect(dock.webGlintHandedBack).toBe(true);
    expect(webGlintAnimation()).toBe('none');
    // A new glint shown while the web owns it enters normally.
    await act(async () => { showGlint('Next'); });
    expect(dock.webGlintHandedBack).toBe(false);
    expect(webGlintAnimation()).toBe(ORIGIN_ENTER);
  });
});

describe('flag off', () => {
  /**
   * Independent statement of origin/main (fc3e50f986652f73cbba27b7456faa57f69f7bae)
   * with the flag off, transcribed from src/app/dictation-pill/page.tsx:858-1000
   * and nativeDockFrame.ts:59-100: DockNotchSurface receives the live snapshot,
   * speech, live voice, working, worker count and showWorkers unchanged; the
   * EditRevertChip and DockGlint always draw on the web; the dock is visible for
   * the top-pill preference, any dictation, speech, Ask, working, a
   * confirmation or live voice.
   */
  function reference(i: Omit<Input, 'glint'> & { glint: boolean; edit: boolean }) {
    return {
      native: false, nativeCapsule: false, webSnapshot: i.snapshot, webTts: i.ttsState, webRealtime: i.realtimeVoice,
      webAgentWorking: i.agentWorking, webShowWorkers: i.showWorkers, webWorkerCount: i.workerCount, webEdit: i.edit, webGlint: i.glint,
      // DockGlint on origin/main always renders its entering animation.
      glintAnimation: i.glint ? 'o8GlintIn 0.3s cubic-bezier(0.22, 1, 0.36, 1)' : null,
      dockVisible: i.topPill === true || i.snapshot.state !== 'idle' || i.ttsState !== 'idle' || i.askOpen || i.agentWorking
        || i.agentConfirm || i.realtimeVoice !== 'off',
    };
  }

  it('draws exactly what origin/main draws for every combination, with no new listener, timer or request', async () => {
    reply = { native: false, enabled: false };
    await render({}); await tick(100);
    let cases = 0;
    for (const edit of [false, true]) {
      if (edit) await emit('o8:edit-applied', { app: 'Notes' });
      for (const dictation of ['idle', 'recording'] as const)
        for (const ttsState of ['idle', 'playing'] as const)
          for (const realtimeVoice of ['off', 'live'] as const)
            for (const workers of [0, 2])
              for (let mask = 0; mask < 1 << 8; mask++) {
                const bit = (n: number) => (mask & (1 << n)) !== 0;
                const patch: Input = {
                  ...input, snapshot: { ...IDLE, state: dictation }, ttsState, realtimeVoice, ...fleet(workers),
                  askOpen: bit(0), agentConfirm: bit(1), agentWorking: bit(2), dropActive: bit(3), stagedFiles: bit(4), showWorkers: bit(5), topPill: bit(6),
                  glint: bit(7) ? { key: 'k', text: 'Remembered', tone: 'progress', fadeAt: 1, until: 2 } : null,
                };
                await render(patch);
                const actual = {
                  native: dock.native, nativeCapsule: dock.nativeCapsule, webSnapshot: dock.webSnapshot, webTts: dock.webTts,
                  webRealtime: dock.webRealtime, webAgentWorking: dock.webAgentWorking, webShowWorkers: dock.webShowWorkers,
                  webWorkerCount: dock.webWorkerCount, webEdit: dock.webEdit !== null, webGlint: dock.webGlint !== null, dockVisible: dock.dockVisible,
                  glintAnimation: webGlintAnimation(),
                };
                expect(actual, JSON.stringify(patch)).toEqual(reference({ ...patch, edit, glint: bit(7) }));
                cases++;
              }
    }
    expect(cases).toBe(8192);
    await render({ glint: undefined });
    await act(async () => { showGlint('Remembered'); });
    expect(dock.webGlint).toMatchObject({ text: 'Remembered' });
    await tick(60_000);
    expect(frames).toHaveLength(1);
    // Only the chip's own two listeners, as on origin/main; no quiet-mode listener.
    expect(bus.names.sort()).toEqual(['o8:edit-applied', 'o8:edit-revert-settled']);
  });

  it.each([0, 299, 300, 1000, 4000])('a glint committed %i ms after showGlint enters exactly as on origin/main', async (late) => {
    reply = { native: false, enabled: false };
    await render({}); await tick(100);
    // showGlint and the commit in one act: a long task delays the render by `late` ms.
    await act(async () => { showGlint('Remembered'); vi.setSystemTime(Date.now() + late); });
    expect(dock.webGlintHandedBack).toBe(false);
    expect(webGlintAnimation()).toBe(ORIGIN_ENTER);
  });

  it('keeps the web chip and glint timings and words', async () => {
    reply = { native: false, enabled: false };
    await render({}); await tick(100);
    await emit('o8:edit-applied', { app: 'Notes' });
    const markup = (edit: Dock['edit']) => renderToStaticMarkup(createElement(EditRevertChip, { edit, onRevert: () => undefined }));
    expect(markup(dock.webEdit)).toContain('>Rewrote in Notes — Revert<');
    expect(markup(dock.webEdit)).not.toContain('disabled');
    expect(markup(dock.webEdit && { ...dock.webEdit, status: 'pending' })).toMatch(/disabled.*Reverting…/);
    await tick(19_999);
    expect(dock.webEdit).not.toBeNull();
    await tick(1);
    expect(dock.webEdit).toBeNull();
    await emit('o8:edit-applied', { app: 'Notes' });
    await act(async () => { await dock.revertEdit(); });
    expect(markup(dock.webEdit)).toContain('>Reverted<');
    await tick(1799);
    expect(dock.webEdit).not.toBeNull();
    await tick(1);
    expect(dock.webEdit).toBeNull();
    await act(async () => { showGlint('Remembered'); });
    await tick(4799);
    expect(dock.webGlint).not.toBeNull();
    await tick(1);
    expect(dock.webGlint).toBeNull();
  });
});
