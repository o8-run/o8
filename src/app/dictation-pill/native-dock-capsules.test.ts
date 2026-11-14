// @ts-expect-error jsdom is a test dependency without bundled declarations.
import { JSDOM } from 'jsdom';
import { act, createElement, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DockNotchSurface } from '@/components/desktop/dictation/DockNotchSurface';
import { dockOwner, type DockOwner, type DockPrecedenceInput } from '@/components/desktop/dictation/dockPrecedence';
import type { DictationSnapshot } from '@/components/desktop/dictation/types';
import { useNativeDictationPill, type NativeDockAction } from './useNativeDictationPill';
import { nativeDockFrame, useNativeDockFrame, webDockView, webDockVisible, type NativeDockInput } from './nativeDockFrame';

vi.mock('@/lib/tauri/bridge', () => ({ isTauri: () => true }));
vi.mock('@/lib/mobile/ws-token-client', () => ({ getMobileWsToken: () => 'fixture' }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => undefined }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => ({ active: false }) }));

const IDLE: DictationSnapshot = { state: 'idle', audioLevel: 0, durationMs: 0, error: null, partialTranscript: '' };
const QUIET: DockPrecedenceInput = {
  dictationState: 'idle', ttsState: 'idle', askOpen: false, panelPending: false, agentConfirm: false, agentWorking: false,
  dropActive: false, stagedFiles: false, showWorkers: false, workerCount: 0, realtimeVoice: 'off',
};

describe('dock precedence', () => {
  /**
   * Independent reference, transcribed by hand from DockNotchSurface.tsx at
   * 7a3572414423cb6f95f4e98e0b42b8e81bb7d9b4 (origin/main before this PR): the
   * flag guards at :568-606 and the body if/else chain at :843-1304. It is
   * written as "first branch in body order whose own guard holds", without the
   * helper under test.
   */
  function reference(i: DockPrecedenceInput): DockOwner {
    const idle = i.dictationState === 'idle';
    const speaking = idle && i.ttsState !== 'idle'; // :568
    const asking = i.askOpen && (idle || i.panelPending); // :575
    const confirming = i.agentConfirm && idle; // :585
    const working = i.agentWorking && !confirming && idle && !asking && !speaking; // :586
    const drop = i.dropActive && idle && !confirming && !asking; // :590
    const staged = !drop && i.stagedFiles && idle && !confirming && !asking && !speaking && !working; // :592
    const workersInfo = i.showWorkers && i.workerCount > 0 && idle && !confirming && !asking && !speaking && !working && !drop && !staged; // :596
    const voice = i.realtimeVoice !== 'off' && idle && !confirming && !asking && !speaking && !working && !drop && !staged && !workersInfo; // :603
    // Body order :843 confirm, :847 drop, :888 staged, :971 working, :1015 workers,
    // :1064 voice, :1144 ask, :1210 speaking, then the dictation modes.
    const chain: [boolean, DockOwner][] = [
      [confirming, 'confirm'], [drop, 'drop'], [staged, 'staged'], [working, 'working'], [workersInfo, 'workers'],
      [voice, 'voice'], [asking, 'ask'], [speaking, 'speaking'], [!idle, 'dictation'],
    ];
    return chain.find(([holds]) => holds)?.[1] ?? 'idle';
  }

  /** The surface DockNotchSurface actually draws for these inputs. */
  function drawn(input: DockPrecedenceInput): DockOwner {
    const markup = renderToStaticMarkup(createElement(DockNotchSurface, {
      snapshot: { ...IDLE, state: input.dictationState },
      ttsState: input.ttsState,
      askOpen: input.askOpen,
      askMode: 'answer',
      askThread: [{ role: 'assistant', text: 'Answer' }],
      panelPending: input.panelPending ? { phase: 'listening', text: '' } : null,
      agentConfirm: input.agentConfirm ? { confirmationId: 'c', taskId: 't', tool: 'tool', summary: 'Review' } : null,
      agentWorking: input.agentWorking,
      dropActive: input.dropActive,
      stagedFiles: input.stagedFiles ? [{ name: 'notes.txt', size: 2048 }] : null,
      showWorkers: input.showWorkers,
      workerCount: input.workerCount,
      workerWorking: input.workerCount,
      realtimeVoice: input.realtimeVoice,
    }));
    const markers: [DockOwner, string][] = [
      ['confirm', 'for confirmation"'], ['drop', 'They ride your next question'], ['staged', 'Staged — hold'],
      ['working', 'aria-label="Stop (Esc)"'], ['workers', '2 packets in flight'], ['voice', 'Voice live — tap to stop'],
      ['voice', 'aria-label="Connecting voice"'], ['ask', 'aria-label="Close"'], ['speaking', '>Speaking<'], ['speaking', '>Paused<'],
    ];
    const found = markers.filter(([, marker]) => markup.includes(marker)).map(([owner]) => owner);
    expect(found.length).toBeLessThanOrEqual(1);
    if (found[0]) return found[0];
    // The listening capsule is a waveform; the done capsule shows the pasted text.
    return markup.includes('aria-label="Finish listening"') || markup.includes('>Pasted</p>') ? 'dictation' : 'idle';
  }

  it('the helper and the rendered dock match an independent reference for every combination', () => {
    const owners = new Set<DockOwner>();
    let cases = 0;
    for (const dictationState of ['idle', 'recording', 'success'] as const)
      for (const ttsState of ['idle', 'playing', 'paused'] as const)
        for (const realtimeVoice of ['off', 'connecting', 'live'] as const)
          for (const workerCount of [0, 2])
            for (let mask = 0; mask < 1 << 7; mask++) {
              const bit = (n: number) => (mask & (1 << n)) !== 0;
              const input: DockPrecedenceInput = {
                dictationState, ttsState, realtimeVoice, workerCount, askOpen: bit(0), panelPending: bit(1), agentConfirm: bit(2),
                agentWorking: bit(3), dropActive: bit(4), stagedFiles: bit(5), showWorkers: bit(6),
              };
              const expected = reference(input);
              owners.add(expected);
              cases++;
              expect(dockOwner(input), JSON.stringify(input)).toBe(expected);
              expect(drawn(input), JSON.stringify(input)).toBe(expected);
            }
    expect(cases).toBe(6912);
    expect(owners.size).toBe(10);
  });

  /**
   * The edit chip and glints are not in the order: page.tsx draws them below
   * whatever the dock shows. Batch 3 composition, stated without the helpers:
   * the native frame is dictation when active, else the reference owner's
   * capsule, the fleet orbit when nothing owns the dock and workers exist, or
   * the chip/glint alone; any other owner is a handoff to the web. The chip and
   * glint go native with a drawn frame, except beside native dictation while
   * the web draws Ask, a confirmation, a drop or staged files. When origin/main
   * would hide the web dock (no top-pill preference and nothing else keeping
   * it visible), the fleet and a lone chip or glint draw nowhere.
   */
  it('composes the chip and glint with every dock state, native and web', () => {
    const edit = { id: 1, app: 'Notes', status: 'ready' as const, until: 1 };
    const glint = { key: 'k', text: 'Remembered', tone: 'progress' as const, fadeAt: 1, until: 2 };
    const seen = new Set<string>();
    for (const topPill of [false, true])
    for (const dictationState of ['idle', 'recording', 'success'] as const)
      for (const ttsState of ['idle', 'playing', 'paused'] as const)
        for (const realtimeVoice of ['off', 'connecting', 'live'] as const)
          for (const workerCount of [0, 2])
            for (let mask = 0; mask < 1 << 7; mask++) {
              const bit = (n: number) => (mask & (1 << n)) !== 0;
              const input: DockPrecedenceInput = {
                dictationState, ttsState, realtimeVoice, workerCount, askOpen: bit(0), panelPending: bit(1), agentConfirm: bit(2),
                agentWorking: bit(3), dropActive: bit(4), stagedFiles: bit(5), showWorkers: bit(6),
              };
              const owner = reference(input);
              const active = dictationState !== 'idle';
              // origin/main nativeDockFrame.ts:91 dockVisible with the flag off, at idle dictation.
              const shownOnMain = topPill || ttsState !== 'idle' || input.askOpen || input.agentWorking || input.agentConfirm || realtimeVoice !== 'off';
              const state = active ? dictationState
                : owner === 'speaking' || owner === 'working' || owner === 'voice' ? owner
                  : (owner === 'workers' || owner === 'idle') && !shownOnMain ? 'idle'
                    : owner === 'workers' || owner === 'idle' && workerCount > 0 ? 'workers'
                      : owner === 'idle' ? 'extras' : 'idle';
              const webBeside = active && (input.askOpen || input.agentConfirm || input.dropActive || input.stagedFiles);
              const handoff = !active && ['confirm', 'ask', 'drop', 'staged'].includes(owner);
              const siblings = state !== 'idle' && !webBeside ? 'native' : webBeside || handoff ? 'web' : 'hidden';
              const { frame } = nativeDockFrame({
                ...input, snapshot: { ...IDLE, state: dictationState }, dictationSession: 1, speechSpeed: 1, agentTool: '', agentStartedAt: 1, edit, glint, topPill,
              }, { speaking: 1, voice: 1, workers: 1, extras: 1 });
              const view = webDockView(true, frame, dictationState, { ...input, showWorkers: input.showWorkers, workerCount });
              const visible = webDockVisible(true, false, view, { ...input, snapshot: { ...IDLE, state: dictationState } }, { topPillEnabled: topPill, staged: input.stagedFiles });
              const label = JSON.stringify({ ...input, topPill });
              expect(frame.state, label).toBe(state);
              const drawnBy = view.nativeEdit && view.nativeGlint ? 'native' : view.nativeEdit || view.nativeGlint ? 'split' : visible ? 'web' : 'hidden';
              expect(drawnBy, label).toBe(siblings);
              expect(view.workerCount, label).toBe(0);
              seen.add(`${state}:${siblings}`);
            }
    expect([...seen].sort()).toEqual([
      'extras:native', 'idle:hidden', 'idle:web', 'recording:native', 'recording:web', 'speaking:native', 'success:native', 'success:web',
      'voice:native', 'workers:native', 'working:native',
    ]);
  });

  it('never draws the resting worker orbit alongside staged-file chips (origin/main body chain :858 before :1274)', () => {
    const input: DockPrecedenceInput = { ...QUIET, stagedFiles: true, workerCount: 2 };
    expect(reference(input)).toBe('staged');
    const markup = renderToStaticMarkup(createElement(DockNotchSurface, {
      snapshot: IDLE, ttsState: 'idle', stagedFiles: [{ name: 'notes.txt', size: 2048 }], workerCount: 2, workerWorking: 2,
    }));
    expect(markup).toContain('Staged — hold');
    expect(markup).not.toContain('>work<');
    // Without the staged chips the same dock shows the orbit, so the marker is real.
    expect(renderToStaticMarkup(createElement(DockNotchSurface, { snapshot: IDLE, ttsState: 'idle', workerCount: 2, workerWorking: 2 }))).toContain('>work<');
    // Natively: staged is a handoff (web draws the chips), then the orbit returns natively.
    const base = { snapshot: IDLE, dictationSession: 1, speechSpeed: 1, agentTool: '', agentStartedAt: 1, topPill: true };
    expect(nativeDockFrame({ ...input, ...base }, { speaking: 1, voice: 1 }).frame).toMatchObject({ state: 'idle', handoff: true });
    expect(nativeDockFrame({ ...input, ...base, stagedFiles: false }, { speaking: 1, voice: 1 }).frame).toMatchObject({ state: 'workers', expanded: false });
  });

  it('orders dictation, confirm, ask, drop, speaking, working, staged, workers, voice', () => {
    const order: [DockOwner, Partial<DockPrecedenceInput>][] = [
      ['dictation', { dictationState: 'recording' }], ['confirm', { agentConfirm: true }], ['ask', { askOpen: true }],
      ['drop', { dropActive: true }], ['speaking', { ttsState: 'paused' }], ['working', { agentWorking: true }],
      ['staged', { stagedFiles: true }], ['workers', { showWorkers: true, workerCount: 2 }], ['voice', { realtimeVoice: 'connecting' }],
    ];
    for (let index = 0; index < order.length; index++) {
      const all = Object.assign({}, QUIET, ...order.slice(index).map(([, patch]) => patch));
      expect(dockOwner(all)).toBe(order[index][0]);
    }
    expect(dockOwner({ ...QUIET, dictationState: 'recording', askOpen: true, panelPending: true })).toBe('ask');
  });
});

let root: Root;
let dom: JSDOM;
let input: NativeDockInput;
let native = false;
let onAction = vi.fn<(action: NativeDockAction) => void>();
let mounted = true;
const frames: { action: string; session?: number; immediate?: boolean; snapshot?: Record<string, unknown> }[] = [];
let reply: Record<string, unknown>;

function Probe() {
  const frame = useNativeDockFrame(input);
  const ownership = useNativeDictationPill(frame.frame, frame.session, () => undefined, onAction);
  useLayoutEffect(() => { native = ownership.native; }, [ownership.native]);
  return null;
}
async function render(patch: Partial<NativeDockInput>) {
  input = { ...input, ...patch };
  await act(async () => { root.render(createElement(Probe)); });
}
async function tick(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
const sent = () => frames.filter(frame => frame.action === 'frame').at(-1)?.snapshot;

describe('native dock capsules through the real hook', () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    native = false; frames.length = 0; onAction = vi.fn(); mounted = true;
    input = {
      ...QUIET, snapshot: IDLE, dictationSession: 0, speechSpeed: 1, agentTool: '', agentStartedAt: 0,
    };
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
    root = createRoot(document.createElement('div'));
  });
  afterEach(async () => {
    if (mounted) await act(async () => root.unmount());
    dom.window.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
  });

  it.each([
    ['speaking', { ttsState: 'playing' }, { state: 'speaking', paused: false, speed: 1 }],
    ['working', { agentWorking: true, agentStartedAt: 990_000, agentTool: 'o8_ask' }, { state: 'working', startedAt: 990_000, tool: 'o8_ask' }],
    ['voice', { realtimeVoice: 'connecting' }, { state: 'voice', connecting: true }],
  ] as const)('%s draws natively, then retires with one release naming its session', async (_name, patch, expected) => {
    await render({});
    expect(native).toBe(true);
    await render(patch);
    await tick(300);
    expect(sent()).toMatchObject(expected);
    const session = sent()?.session;
    expect(typeof session).toBe('number');
    await render(QUIET);
    await tick(2000);
    const releases = frames.filter(frame => frame.action === 'release');
    expect(releases).toEqual([expect.objectContaining({ session, kind: _name, immediate: false })]);
    expect(frames.at(-1)?.action).toBe('release');
  });

  it('dictation takes the panel over speaking and returns it when dictation ends', async () => {
    await render({ ttsState: 'playing' }); await tick(200);
    expect(sent()?.state).toBe('speaking');
    await render({ snapshot: { ...IDLE, state: 'recording' }, dictationSession: 5 }); await tick(200);
    expect(sent()).toMatchObject({ state: 'recording', session: 5 });
    await render({ snapshot: IDLE }); await tick(200);
    expect(sent()?.state).toBe('speaking');
  });

  it('a still-web surface takes the dock: the native capsule is released at once and the web draws it', async () => {
    await render({ ttsState: 'playing' }); await tick(200);
    await render({ askOpen: true }); await tick(200);
    expect(frames.at(-1)).toMatchObject({ action: 'release', immediate: true });
    const count = frames.length;
    await tick(2000);
    expect(frames).toHaveLength(count);
    for (const patch of [{ agentConfirm: true }, { dropActive: true }]) {
      await render({ askOpen: false, agentConfirm: false, dropActive: false }); await tick(200);
      expect(sent()?.state).toBe('speaking');
      await render(patch); await tick(200);
      expect(frames.at(-1)).toMatchObject({ action: 'release', immediate: true });
    }
  });

  it('runs each reported click exactly once, only for the capsule on screen', async () => {
    await render({ ttsState: 'playing' }); await tick(200);
    const session = sent()?.session as number;
    reply = { native: true, enabled: true, actions: [
      { session, state: 'speaking', action: 'pause', value: null },
      { session, state: 'speaking', action: 'speed', value: 0.85 },
      { session: session - 1, state: 'speaking', action: 'stop', value: null },
      { session, state: 'working', action: 'interrupt', value: null },
    ] };
    await tick(1000);
    expect(onAction.mock.calls.map(([clicked]) => [clicked.action, clicked.value])).toEqual([['pause', null], ['speed', 0.85]]);
  });

  it('ignores a voice stop while connecting and runs it once when live', async () => {
    await render({ realtimeVoice: 'connecting' }); await tick(200);
    const session = sent()?.session as number;
    reply = { native: true, enabled: true, actions: [{ session, state: 'voice', action: 'voice-stop', value: null }] };
    await tick(200);
    expect(onAction).not.toHaveBeenCalled();
    await render({ realtimeVoice: 'live' }); await tick(200);
    expect(sent()?.session).toBe(session);
    reply = { native: true, enabled: true, actions: [{ session, state: 'voice', action: 'voice-stop', value: null }] };
    await tick(1000);
    expect(onAction).toHaveBeenCalledOnce();
  });

  it('does nothing with a click reported after fallback', async () => {
    await render({ agentWorking: true, agentStartedAt: 999_000 }); await tick(200);
    reply = { native: false, enabled: true, absent: false };
    await tick(200);
    expect(native).toBe(false);
    reply = { native: true, enabled: true, actions: [{ session: 999_000, state: 'working', action: 'interrupt', value: null }] };
    await tick(2000);
    expect(onAction).not.toHaveBeenCalled();
  });

  it('sends the working start once; frames do not tick the elapsed timer', async () => {
    await render({ agentWorking: true, agentStartedAt: 999_000 });
    await tick(3000);
    const working = frames.filter(frame => frame.snapshot?.state === 'working');
    expect(working.length).toBeGreaterThan(20);
    expect(new Set(working.map(frame => JSON.stringify(frame.snapshot)))).toHaveLength(1);
    expect(working[0].snapshot).toMatchObject({ startedAt: 999_000 });
  });

  it('falls back mid-playback within the deadline and releases the playback session', async () => {
    await render({ ttsState: 'playing' }); await tick(200);
    const session = sent()?.session;
    expect(native).toBe(true);
    vi.mocked(fetch).mockImplementation((_url, init) => {
      frames.push(JSON.parse(String(init?.body)));
      return new Promise<Response>(() => undefined);
    });
    await tick(100);
    await tick(499);
    expect(native).toBe(true);
    await tick(1);
    expect(native).toBe(false);
    expect(frames.at(-1)).toMatchObject({ action: 'release', session, kind: 'speaking' });
    expect(webDockView(native, { ...IDLE, state: 'speaking' }, 'idle', { ttsState: 'playing', realtimeVoice: 'off', agentWorking: false, askOpen: false }))
      .toMatchObject({ nativeCapsule: false, ttsState: 'playing' });
  });

  it('flag off: one probe, no listener, no frames, and the web dock draws exactly what it would', async () => {
    reply = { native: false, enabled: false };
    const events = await import('@tauri-apps/api/event');
    const listener = vi.spyOn(events, 'listen');
    await render({});
    for (const patch of [{ ttsState: 'playing' }, { agentWorking: true, agentStartedAt: 1 }, { realtimeVoice: 'live' }, QUIET] as Partial<NativeDockInput>[]) {
      await render(patch); await tick(5000);
    }
    expect(frames).toHaveLength(1);
    expect(listener).not.toHaveBeenCalled();
    expect(native).toBe(false);
    for (const state of ['speaking', 'working', 'voice', 'recording', 'idle'] as const) {
      const live = { ttsState: 'paused', realtimeVoice: 'live', agentWorking: true, askOpen: false } as const;
      expect(webDockView(false, { ...IDLE, state }, 'idle', live)).toEqual({
        nativeDrawn: false, nativeCapsule: false, ttsState: 'paused', realtimeVoice: 'live', agentWorking: true,
        showWorkers: false, workerCount: 0, nativeEdit: false, nativeGlint: false,
      });
    }
  });
});
