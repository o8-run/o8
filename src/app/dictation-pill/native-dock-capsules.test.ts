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
import { useNativeDockFrame, webDockView, type NativeDockInput } from './nativeDockFrame';

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
      });
    }
  });
});
