// @ts-expect-error jsdom is a test dependency without bundled declarations.
import { JSDOM } from 'jsdom';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AgentPartialsPage from './page';
import DictationPillPage from '../dictation-pill/page';

// Exercise both actual route controllers and the caret modal. Only the native
// event transport and animation timing are fixtures; no lifecycle is mocked.
const bus = vi.hoisted(() => new Map<string, Set<(event: { payload: Record<string, unknown> }) => void>>());
const motionPreference = vi.hoisted(() => ({ reduced: true }));
vi.mock('@/lib/tauri/bridge', () => ({ isTauri: () => true }));
vi.mock('framer-motion', async () => {
  const { createElement: h, forwardRef } = await import('react');
  return {
    useReducedMotion: () => motionPreference.reduced,
    AnimatePresence: ({ children }: { children: ReactNode }) => children,
    motion: { div: forwardRef<HTMLDivElement, Record<string, unknown>>((props, ref) => {
      const { initial: _initial, animate: _animate, exit: _exit, transition: _transition, ...domProps } = props;
      return h('div', { ...domProps, ref });
    }) },
  };
});

let dom: JSDOM;
let root: Root;
let host: HTMLDivElement;
let dock: HTMLDivElement;
let hud: HTMLDivElement;

async function event(type: string, data: Record<string, unknown> = {}) {
  await act(async () => {
    bus.get('o8:stt-event')?.forEach(callback => callback({ payload: { origin: 'system', type, ...data } }));
  });
}
async function wait(ms: number) {
  await act(async () => { vi.advanceTimersByTime(ms); });
}
function modal() { return hud.querySelector<HTMLElement>('[role="status"]'); }
function listeningAtNotch() { return dock.querySelector('[aria-label="Finish listening"]'); }
function tallestBar() {
  return Math.max(...[...modal()!.querySelectorAll('rect')].map(bar => {
    const scale = Number(bar.style.transform.match(/scaleY\(([^)]+)\)/)?.[1] ?? 1);
    return Number(bar.getAttribute('height')) * scale;
  }));
}

beforeEach(async () => {
  vi.useFakeTimers();
  bus.clear();
  motionPreference.reduced = true;
  dom = new JSDOM('', { url: 'http://localhost/agent-partials' });
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'localStorage', 'MutationObserver'] as const) {
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name]);
  }
  const callbacks = new Map<number, (event: { payload: Record<string, unknown> }) => void>();
  const listeners = new Map<number, { name: string; callback: (event: { payload: Record<string, unknown> }) => void }>();
  let nextId = 0;
  Object.assign(dom.window, {
    __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: 'dock' }, currentWebview: { label: 'dock' } },
      transformCallback: (callback: (event: { payload: Record<string, unknown> }) => void) => {
        callbacks.set(++nextId, callback); return nextId;
      },
      unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: vi.fn(async (command: string, args: { event?: string; handler?: number; eventId?: number }) => {
        if (command === 'plugin:event|listen') {
          const name = args.event!; const callback = callbacks.get(args.handler!)!;
          const entries = bus.get(name) ?? new Set(); bus.set(name, entries); entries.add(callback);
          listeners.set(++nextId, { name, callback }); return nextId;
        }
        if (command === 'plugin:event|unlisten') {
          const entry = listeners.get(args.eventId!); if (entry) bus.get(entry.name)?.delete(entry.callback);
        }
        return undefined;
      }),
    },
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => undefined },
  });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } })));
  vi.spyOn(dom.window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(createElement('div', null,
      createElement('div', { id: 'dock' }, createElement(DictationPillPage)),
      createElement('div', { id: 'hud' }, createElement(AgentPartialsPage))));
  });
  await act(async () => {
    await vi.waitFor(() => expect(bus.get('o8:top-pill-preference')?.size).toBe(1));
  });
  dock = host.querySelector('#dock')!;
  hud = host.querySelector('#hud')!;
});
afterEach(async () => {
  await act(async () => root.unmount());
  dom.window.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('native Fn dictation surfaces', () => {
  it('keeps listening, measured waveform, polishing and pasted text in the caret modal', async () => {
    expect((dock.firstElementChild as HTMLElement).style.display).toBe('none');
    await event('system-start', { hud: true, surface: 'caret', mode: 'dictation' });
    await event('status', { sessionId: 12, text: 'listening' });
    await wait(300);
    expect(modal()?.textContent).toContain('Listening');
    expect(listeningAtNotch()).toBeNull();
    const quiet = tallestBar();
    await event('level', { sessionId: 12, level: 0.8 });
    expect(tallestBar()).toBeGreaterThan(quiet);
    await event('partial', { sessionId: 12, text: 'fixture raw words' });
    await event('final', { sessionId: 12, text: 'fixture raw words' });
    await event('audio_file', { sessionId: 12 });
    expect(modal()?.textContent).toContain('Transcribing');
    await event('polishing', { sessionId: 12 });
    expect(modal()?.textContent).toContain('Polishing');
    expect(modal()?.textContent).not.toContain('Listening');
    expect(modal()?.querySelector('[aria-label="Polishing"]')).not.toBeNull();
    await event('partial', { sessionId: 12, text: 'late raw frame' });
    await event('final', { sessionId: 12, text: 'late raw frame' });
    await event('audio_file', { sessionId: 12 });
    expect(modal()?.textContent).toContain('Polishing');
    expect(modal()?.textContent).not.toContain('late raw frame');
    await event('complete', { sessionId: 12 });
    await event('ready');
    expect(modal()?.textContent).toContain('Polishing');
    await event('system-pasted', { sessionId: 12, text: 'Fixture polished words.' });
    expect(modal()?.textContent).toContain('Fixture polished words.');
    expect(modal()?.textContent).toContain('Pasted');
    expect(modal()?.textContent).not.toContain('fixture raw words');
    expect(listeningAtNotch()).toBeNull();
    await wait(900);
    expect(modal()).toBeNull();
  });

  it('does not let duplicate completion or an old session clear a newer dictation', async () => {
    await event('system-start', { hud: true, surface: 'caret' });
    await event('status', { sessionId: 21, text: 'listening' });
    await wait(300);
    await event('audio_file', { sessionId: 21 });
    await event('system-pasted', { sessionId: 21, text: 'First fixture.' });
    await wait(700);
    await event('system-pasted', { sessionId: 21, text: 'First fixture.' });
    await wait(200);
    expect(modal()).toBeNull();
    await event('system-start', { hud: true, surface: 'caret' });
    await event('status', { sessionId: 22, text: 'listening' });
    await wait(300);
    await event('partial', { sessionId: 22, text: 'second fixture' });
    await event('system-pasted', { sessionId: 21, text: 'First fixture.' });
    await event('error', { sessionId: 21, text: 'Old error' });
    await wait(1000);
    expect(modal()?.textContent).toContain('second fixture');
    await event('system-idle', { sessionId: 22 });
    await wait(900);
    expect(modal()).toBeNull();
  });

  it('keeps measured voice levels through partial text and responds to ordinary speech', async () => {
    await event('system-start', { hud: true, surface: 'caret' });
    await event('status', { sessionId: 25, text: 'listening' });
    await wait(32);
    // Ordinary speech, about -38 dBFS on the recorder's -50..-10 dBFS meter.
    await event('level', { sessionId: 25, level: 0.3 });
    const speaking = tallestBar();
    expect(speaking).toBeGreaterThan(10);
    await event('partial', { sessionId: 25, text: 'normal speaking fixture' });
    expect(tallestBar()).toBe(speaking);
    await event('level', { sessionId: 25, level: 0 });
    expect(tallestBar()).toBe(2);
  });

  it('keeps the polishing stroke moving until delivery and honors reduced motion', async () => {
    motionPreference.reduced = false;
    await event('system-start', { hud: true, surface: 'caret' });
    await wait(32);
    await event('polishing', { sessionId: 26 });
    expect(modal()?.querySelector('animate[repeatCount="indefinite"]')).not.toBeNull();
    await event('complete', { sessionId: 26 });
    await event('ready');
    await wait(3000);
    expect(modal()?.querySelector('animate[repeatCount="indefinite"]')).not.toBeNull();
    await event('system-pasted', { sessionId: 26, text: 'Finished fixture.' });
    expect(modal()?.querySelector('animate')).toBeNull();
    await wait(900);
    motionPreference.reduced = true;
    await event('system-start', { hud: true, surface: 'caret' });
    await wait(32);
    await event('polishing', { sessionId: 27 });
    expect(modal()?.textContent).toContain('Polishing');
    expect(modal()?.querySelector('animate')).toBeNull();
  });

  it('labels a clipboard fallback accurately while showing the final text', async () => {
    await event('system-start', { hud: true, surface: 'caret' });
    await wait(32);
    await event('system-pasted', { sessionId: 28, text: 'Copied fixture.', clipboardOnly: true });
    expect(modal()?.textContent).toContain('Symon · Copied');
    expect(modal()?.textContent).toContain('Copied fixture.');
    expect(modal()?.textContent).not.toContain('Pasted');
    await wait(900);
    expect(modal()).toBeNull();
  });

  it('shows a terminal error in the modal and frees the next session', async () => {
    await event('system-start', { hud: true, surface: 'caret' });
    await event('status', { sessionId: 31 });
    await wait(300);
    await event('audio_file', { sessionId: 31 });
    await event('error', { sessionId: 31, text: 'Fixture paste declined.' });
    expect(modal()?.textContent).toContain('Fixture paste declined.');
    expect(modal()?.textContent).not.toContain('Listening');
    await wait(2500);
    expect(modal()).toBeNull();
    await event('system-start', { hud: true, surface: 'caret' });
    await event('status', { sessionId: 32, text: 'listening' });
    await wait(300);
    expect(modal()?.textContent).toContain('Listening');
  });

  it('preserves the legacy agent dock and honors the disabled modal preference', async () => {
    await event('system-start', { lane: 'agent' });
    expect(listeningAtNotch()).not.toBeNull();
    await event('system-idle');
    await wait(900);
    await event('system-start', { surface: 'off' });
    await wait(300);
    expect(modal()).toBeNull();
    expect(listeningAtNotch()).not.toBeNull();
  });

  it('changes the resting top pill live without moving dictation feedback out of the modal', async () => {
    expect((dock.firstElementChild as HTMLElement).style.display).toBe('none');
    expect(bus.get('o8:top-pill-preference')?.size).toBe(1);
    await act(async () => {
      bus.get('o8:top-pill-preference')?.forEach(callback => callback({ payload: { enabled: true } }));
    });
    expect((dock.firstElementChild as HTMLElement).style.display).toBe('flex');
    await event('system-start', { hud: true, surface: 'caret' });
    await wait(300);
    await event('polishing', { sessionId: 35 });
    expect(modal()?.textContent).toContain('Polishing');
    expect(dock.querySelector('[aria-label="Polishing"]')).toBeNull();
    await act(async () => {
      bus.get('o8:top-pill-preference')?.forEach(callback => callback({ payload: { enabled: false } }));
    });
    expect((dock.firstElementChild as HTMLElement).style.display).toBe('none');
    expect(modal()?.textContent).toContain('Polishing');
  });

  it('paints Fn feedback within 32 ms and waits for actual capture before claiming Listening', async () => {
    await event('system-start', { hud: true, surface: 'caret' });
    await wait(31);
    expect(modal()).toBeNull();
    await wait(1);
    expect(modal()?.textContent).toContain('Starting microphone');
    expect(modal()?.textContent).not.toContain('Listening');
    await event('status', { sessionId: 37, text: 'listening' });
    expect(modal()?.textContent).toContain('Listening');
  });

  it('ignores a duplicate start interleaved with capture and after delivery', async () => {
    const start = { hud: true, surface: 'caret', startId: 'fixture-start-1' };
    await event('system-start', start);
    await event('status', { sessionId: 38, text: 'listening' });
    await wait(32);
    await event('system-start', start);
    await event('partial', { sessionId: 38, text: 'current fixture' });
    await wait(32);
    expect(modal()?.textContent).toContain('current fixture');
    await event('system-pasted', { sessionId: 38, text: 'Current fixture.' });
    await event('system-start', start);
    expect(modal()?.textContent).toContain('Current fixture.');
    await wait(900);
    expect(modal()).toBeNull();
  });

  it('completes three consecutive sessions, including a skipped polish and a brush cancel', async () => {
    for (const sessionId of [41, 42, 43]) {
      await event('system-start', { hud: true, surface: 'caret' });
      await event('status', { sessionId, text: 'listening' });
      await wait(300);
      await event('final', { sessionId, text: `raw ${sessionId}` });
      if (sessionId !== 42) await event('polishing', { sessionId });
      await event('system-pasted', { sessionId, text: `Delivered ${sessionId}.` });
      expect(modal()?.textContent).toContain(`Delivered ${sessionId}.`);
      await wait(900);
      expect(modal()).toBeNull();
      expect(listeningAtNotch()).toBeNull();
    }
    await event('system-start', { hud: true, surface: 'caret' });
    await event('system-idle');
    await wait(300);
    expect(modal()).toBeNull();
  });
});
