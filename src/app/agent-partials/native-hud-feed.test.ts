// @ts-expect-error jsdom is a test dependency without bundled declarations.
import { JSDOM } from 'jsdom';
import { act, createElement, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useNativeDictationPill, type NativeDockSnapshot } from '@/app/dictation-pill/useNativeDictationPill';
import { SHIPPED_DARK_FLAG_MANIFEST } from '@/lib/operator/shipped-dark-manifest';
import { hudTitle, nativeHudFrame, readPlacement, webHudPaints, type HudPlacement, type HudState } from './nativeHudFrame';

vi.mock('@/lib/tauri/bridge', () => ({ isTauri: () => true }));
vi.mock('@/lib/mobile/ws-token-client', () => ({ getMobileWsToken: () => 'fixture' }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => undefined }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => ({ active: false }) }));

const listening: HudState = { phase: 'listening', level: 0.4, agent: false, text: 'hello', clipboardOnly: false, surface: 'caret', mode: 'dictation' };
const caret: HudPlacement = { surface: 'caret', x: 40, y: 80, width: 460, height: 138 };
const base = { state: listening, claimed: false, graceElapsed: true, elapsedSeconds: 3, solid: false, reducedMotion: false, placement: caret };

describe('HUD frame and ownership', () => {
  it('maps each phase to a native dictation state with the shared wording', () => {
    const phases: [HudState['phase'], string][] = [
      ['starting', 'requesting-mic'], ['listening', 'recording'], ['transcribing', 'transcribing'],
      ['polishing', 'polishing'], ['final', 'success'], ['error', 'error'],
    ];
    for (const [phase, state] of phases) {
      const frame = nativeHudFrame({ ...base, state: { ...listening, phase } });
      expect(frame.state).toBe(state);
      expect(frame.hud?.title).toBe(hudTitle({ ...listening, phase }));
    }
    const frame = nativeHudFrame(base);
    expect(frame).toMatchObject({ audioLevel: 0.4, durationMs: 3000, hud: { surface: 'caret', text: 'hello', dim: false, solid: false, reducedMotion: false, placement: { x: 40, y: 80, width: 460, height: 138 } } });
    expect(nativeHudFrame({ ...base, state: { ...listening, text: '' } }).hud).toMatchObject({ text: 'Listening', dim: true });
    expect(nativeHudFrame({ ...base, state: { ...listening, phase: 'final', clipboardOnly: true } }).hud?.title).toBe('Symon · Copied');
    expect(nativeHudFrame({ ...base, solid: true, reducedMotion: true }).hud).toMatchObject({ solid: true, reducedMotion: true });
  });

  it('yields to a composer claim and waits for the paint grace, on both surfaces', () => {
    expect(nativeHudFrame({ ...base, claimed: true }).state).toBe('idle');
    expect(webHudPaints(listening, true, true, false)).toBe(false);
    expect(nativeHudFrame({ ...base, graceElapsed: false }).state).toBe('idle');
    expect(webHudPaints(listening, false, false, false)).toBe(false);
    expect(nativeHudFrame({ ...base, state: null }).state).toBe('idle');
  });

  it('paints on the web only while the native panel does not own the HUD', () => {
    expect(webHudPaints(listening, false, true, false)).toBe(true);
    expect(webHudPaints(listening, false, true, true)).toBe(false);
  });

  it('passes only a placement for the active surface, and the newest words', () => {
    expect(nativeHudFrame({ ...base, placement: { ...caret, surface: 'hud' } }).hud?.placement).toBeUndefined();
    expect(nativeHudFrame({ ...base, placement: null }).hud?.placement).toBeUndefined();
    const long = nativeHudFrame({ ...base, state: { ...listening, text: 'a'.repeat(700) + 'END' } });
    expect(long.hud?.text.endsWith('END')).toBe(true);
    expect(Array.from(long.hud?.text ?? '')).toHaveLength(600);
    expect(readPlacement({ surface: 'hud', x: 1, y: 2, width: 820, height: 220 })).toEqual({ surface: 'hud', x: 1, y: 2, width: 820, height: 220 });
    expect(readPlacement({ surface: 'caret', x: Number.NaN, y: 2, width: 3, height: 4 })).toBeNull();
    expect(readPlacement({ surface: 'off', x: 1, y: 2, width: 3, height: 4 })).toBeNull();
    expect(readPlacement({ surface: 'caret', x: 1, y: 2, width: 0, height: 4 })).toBeNull();
  });

  it('ships default off as a deliberate opt-in', () => {
    expect(SHIPPED_DARK_FLAG_MANIFEST.nativeDictationHud).toMatchObject({ lifecycle: 'deliberate-default-off' });
  });
});

describe('HUD feed through the shared dock hook', () => {
  let root: Root;
  let dom: JSDOM;
  let native = false;
  let frame: NativeDockSnapshot;
  let session = 1;
  const bodies: Record<string, unknown>[] = [];
  let reply: Record<string, unknown>;
  function Probe() {
    const ownership = useNativeDictationPill(frame, session, () => undefined, undefined, 'hud');
    useLayoutEffect(() => { native = ownership.native; }, [ownership.native]);
    return null;
  }
  const render = async (next: NativeDockSnapshot) => {
    frame = next;
    await act(async () => { root.render(createElement(Probe)); });
  };
  const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
  const idle = () => nativeHudFrame({ ...base, state: null });
  beforeEach(() => {
    vi.useFakeTimers(); native = false; bodies.length = 0; session = 1;
    reply = { native: true, enabled: true };
    dom = new JSDOM('', { url: 'http://localhost' });
    vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify(reply));
    }));
    root = createRoot(document.createElement('div'));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    dom.window.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
  });

  it('is inert with the flag off: one probe, web keeps drawing', async () => {
    reply = { native: false, enabled: false };
    await render(idle()); await tick(1000);
    await render(nativeHudFrame(base)); await tick(10000);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ action: 'prepare', surface: 'hud' });
    expect(native).toBe(false);
  });

  it('owns the session natively, sends the HUD detail, and releases when a claim lands', async () => {
    await render(idle()); expect(native).toBe(true);
    await render(nativeHudFrame(base)); await tick(250);
    const frames = bodies.filter(body => body.action === 'frame');
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.every(body => body.surface === 'hud')).toBe(true);
    expect(frames.at(-1)).toMatchObject({ snapshot: { state: 'recording', session: 1, hud: { surface: 'caret', text: 'hello', placement: { x: 40 } } } });
    await render(nativeHudFrame({ ...base, claimed: true })); await tick(10);
    expect(bodies.at(-1)).toMatchObject({ action: 'release', session: 1, surface: 'hud' });
    expect(native).toBe(true);
  });

  it('returns the HUD to the web when the native side stops acknowledging', async () => {
    await render(idle()); await render(nativeHudFrame(base)); await tick(100);
    expect(native).toBe(true);
    vi.mocked(fetch).mockImplementation(() => new Promise<Response>(() => undefined));
    await tick(700);
    expect(native).toBe(false);
    // The web paints this session again, within the request deadline.
    expect(webHudPaints(listening, false, true, native)).toBe(true);
  });
});
