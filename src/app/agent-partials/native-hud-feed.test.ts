// @ts-expect-error jsdom is a test dependency without bundled declarations.
import { JSDOM } from 'jsdom';
import { act, createElement, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useNativeDictationPill, type NativeDockSnapshot } from '@/app/dictation-pill/useNativeDictationPill';
import { SHIPPED_DARK_FLAG_MANIFEST } from '@/lib/operator/shipped-dark-manifest';
import { hudTitle, nativeHudFrame, readPlacement, sessionPlacement, webHudPaints, type HudPlacement, type HudState } from './nativeHudFrame';

vi.mock('@/lib/tauri/bridge', () => ({ isTauri: () => true }));
vi.mock('@/lib/mobile/ws-token-client', () => ({ getMobileWsToken: () => 'fixture' }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => undefined }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => ({ active: false }) }));

const listening: HudState = { phase: 'listening', level: 0.4, agent: false, text: 'hello', clipboardOnly: false, surface: 'caret', mode: 'dictation' };
const caret: HudPlacement = { surface: 'caret', x: 40, y: 80, width: 460, height: 138, at: 0 };
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
    expect(nativeHudFrame({ ...base, state: { ...listening, level: Number.NaN } }).audioLevel).toBe(0);
    expect(nativeHudFrame({ ...base, state: { ...listening, level: 7 } }).audioLevel).toBe(1);
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

  it('paints on the web until the native panel has drawn the session', () => {
    expect(webHudPaints(listening, false, true, false)).toBe(true);
    expect(webHudPaints(listening, false, true, true)).toBe(false);
  });

  it('stays on the web until the shell anchors the active surface, and sends the newest words', () => {
    expect(nativeHudFrame({ ...base, placement: { ...caret, surface: 'hud' } }).state).toBe('idle');
    expect(nativeHudFrame({ ...base, placement: null }).state).toBe('idle');
    // The shell anchors just before the start event; an anchor from an earlier session is dropped.
    expect(sessionPlacement({ ...caret, at: 10_000 }, 10_004)).toMatchObject({ x: 40 });
    expect(sessionPlacement({ ...caret, at: 10_000 }, 12_000)).toBeNull();
    const long = nativeHudFrame({ ...base, state: { ...listening, text: 'a'.repeat(700) + 'END' } });
    expect(long.hud?.text.endsWith('END')).toBe(true);
    expect(Array.from(long.hud?.text ?? '')).toHaveLength(600);
    expect(readPlacement({ surface: 'hud', x: 1, y: 2, width: 820, height: 220 }, 5)).toEqual({ surface: 'hud', x: 1, y: 2, width: 820, height: 220, at: 5 });
    expect(readPlacement({ surface: 'caret', x: 1e9, y: 2, width: 3, height: 4 })).toBeNull();
    expect(readPlacement({ surface: 'caret', x: 1, y: 2, width: 1e6, height: 4 })).toBeNull();
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
  let drawn = false;
  let native = false;
  let frame: NativeDockSnapshot;
  let session = 1;
  const bodies: Record<string, unknown>[] = [];
  let reply: Record<string, unknown>;
  function Probe() {
    const ownership = useNativeDictationPill(frame, session, () => undefined, undefined, 'hud');
    useLayoutEffect(() => { native = ownership.native; drawn = ownership.drawn; }, [ownership.native, ownership.drawn]);
    return null;
  }
  const render = async (next: NativeDockSnapshot) => {
    frame = next;
    await act(async () => { root.render(createElement(Probe)); });
  };
  const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
  const idle = () => nativeHudFrame({ ...base, state: null });
  const sent = (action: string) => bodies.filter(body => body.action === action);
  beforeEach(() => {
    vi.useFakeTimers(); native = false; drawn = false; bodies.length = 0; session = 1;
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

  it('with the flag off keeps the web and rechecks the flag once per session, not per frame', async () => {
    reply = { native: false, enabled: false };
    await render(idle()); await tick(1000);
    await render(nativeHudFrame(base)); await tick(10000);
    expect(bodies).toHaveLength(2);
    expect(bodies.every(body => body.action === 'prepare' && body.surface === 'hud')).toBe(true);
    expect(drawn).toBe(false);
    // Turning the flag on takes effect at the next session without a restart.
    await render(idle()); reply = { native: true, enabled: true };
    session = 2; await render(nativeHudFrame(base)); await tick(10);
    expect(native).toBe(true);
    await tick(250);
    expect(drawn).toBe(true);
  });

  it('keeps the web bar until native acknowledges a frame it has drawn on screen, with no blank in between', async () => {
    await render(idle()); expect(native).toBe(true);
    const pending: ((value: Record<string, unknown>) => void)[] = [];
    vi.mocked(fetch).mockImplementation((_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Promise<Response>(resolve => { pending.push(value => resolve(new Response(JSON.stringify(value)))); });
    });
    await render(nativeHudFrame(base)); await tick(5);
    // The visible frame goes out at once while the web still paints.
    expect(sent('frame')).toHaveLength(1);
    expect(sent('frame')[0]).toMatchObject({ snapshot: { state: 'recording', hud: { placement: { x: 40 } } } });
    await tick(300);
    expect(drawn).toBe(false);
    expect(webHudPaints(listening, false, true, drawn)).toBe(true);
    // Native acknowledges once it is on screen; only then does the web bar go.
    await act(async () => { pending.shift()!({ native: true, enabled: true }); });
    expect(drawn).toBe(true);
    expect(webHudPaints(listening, false, true, drawn)).toBe(false);
    // A new session starts on the web again.
    session = 2; await render(nativeHudFrame(base));
    expect(drawn).toBe(false);
  });

  it('hides a session at once when a newer one retires it', async () => {
    await render(idle()); await render(nativeHudFrame(base)); await tick(150);
    expect(drawn).toBe(true);
    // The next session is in its paint grace (idle) when the old one retires.
    session = 2; await render(idle()); await tick(10);
    expect(sent('release').at(-1)).toMatchObject({ session: 1, immediate: true });
    // A session that simply ends fades out.
    await render(nativeHudFrame(base)); await tick(150);
    await render(idle()); await tick(10);
    expect(sent('release').at(-1)).toMatchObject({ session: 2, immediate: false });
  });

  it('releases when a claim lands', async () => {
    await render(idle()); await render(nativeHudFrame(base)); await tick(250);
    expect(drawn).toBe(true);
    await render(nativeHudFrame({ ...base, claimed: true })); await tick(10);
    expect(bodies.at(-1)).toMatchObject({ action: 'release', session: 1, surface: 'hud' });
  });

  it('returns the HUD to the web and hides native at once when acknowledgements stop', async () => {
    await render(idle()); await render(nativeHudFrame(base)); await tick(150);
    expect(drawn).toBe(true);
    vi.mocked(fetch).mockImplementation((_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Promise<Response>(() => undefined);
    });
    await tick(700);
    expect(drawn).toBe(false);
    expect(webHudPaints(listening, false, true, drawn)).toBe(true);
    expect(sent('release').at(-1)).toMatchObject({ session: 1, immediate: true, surface: 'hud' });
  });
});
