// @ts-expect-error jsdom is a test dependency without bundled declarations.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { act, createElement, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useNativeDictationPill } from './useNativeDictationPill';
import { SHIPPED_DARK_FLAG_MANIFEST } from '@/lib/operator/shipped-dark-manifest';
import type { DictationSnapshot } from '@/components/desktop/dictation/types';

vi.mock('@/lib/tauri/bridge', () => ({ isTauri: () => true }));
vi.mock('@/lib/mobile/ws-token-client', () => ({ getMobileWsToken: () => 'fixture' }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => undefined }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => ({ active: false }) }));
let root: Root;
let dom: JSDOM;
let native = false;
let snapshot: DictationSnapshot;
let session = 1;
let finish = vi.fn();
let mounted = true;
const frames: { action: string; snapshot?: Record<string, unknown> }[] = [];
let reply: Record<string, unknown>;
function Probe() {
  const ownership = useNativeDictationPill(snapshot, session, finish);
  useLayoutEffect(() => { native = ownership.native; }, [ownership.native]);
  return null;
}
async function render(state: DictationSnapshot['state']) {
  snapshot = { ...snapshot, state };
  await act(async () => { root.render(createElement(Probe)); });
}
async function tick(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
beforeEach(() => {
  vi.useFakeTimers(); frames.length = 0; session = 1; finish = vi.fn(); mounted = true;
  snapshot = { state: 'idle', audioLevel: 0.5, durationMs: 123, error: null, partialTranscript: '' };
  reply = { native: true, enabled: true };
  dom = new JSDOM('', { url: 'http://localhost' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    frames.push(JSON.parse(init.body));
    return new Response(JSON.stringify(reply));
  }));
  root = createRoot(document.createElement('div'));
});
afterEach(async () => {
  if (mounted) await act(async () => root.unmount());
  dom.window.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
});
it('uses one disabled probe and one per session, with no idle polling', async () => {
  reply = { native: false, enabled: false };
  await render('idle'); await tick(60000);
  expect(frames).toHaveLength(1);
  await render('recording'); await tick(60000);
  expect(frames).toHaveLength(2);
});
it('retains native ownership at idle, releases once, and checks the next session with its first frame', async () => {
  await render('idle'); expect(native).toBe(true);
  await tick(60000); expect(frames).toHaveLength(1);
  await render('recording'); await tick(60000);
  expect(frames.filter(frame => frame.action === 'frame')).toHaveLength(601);
  await render('idle');
  const count = frames.length;
  await tick(60000);
  expect(frames).toHaveLength(count);
  expect(frames.filter(frame => frame.action === 'release')).toHaveLength(1);
  expect(native).toBe(true);
  session++; await render('recording');
  expect(frames.at(-1)?.action).toBe('frame');
});
it.each([true, false])('restores web after mid-session failure with absent=%s and preserves the lease fence', async absent => {
  await render('idle'); await render('recording');
  reply = { native: false, enabled: true, absent };
  await tick(100);
  expect(native).toBe(!absent);
  if (!absent) {
    await tick(999); expect(native).toBe(true);
    await tick(1); expect(native).toBe(false);
  }
});
it('keeps multi-byte and escaped text below the byte cap and omits unused partials', async () => {
  await render('idle');
  snapshot.partialTranscript = '語😀'.repeat(2000);
  snapshot.pastedText = '語😀\u0001"'.repeat(2000);
  snapshot.error = '錯😀'.repeat(2000);
  await render('success');
  const frame = frames.at(-1)!;
  expect(frame.action).toBe('frame');
  expect(frame.snapshot).not.toHaveProperty('partialTranscript');
  expect(new TextEncoder().encode(JSON.stringify(frame)).length).toBeLessThan(8192);
});

it('records the opt-in feature in the next release', () => {
  const entry = SHIPPED_DARK_FLAG_MANIFEST.nativeDictationPill;
  expect(entry).toBeDefined();
  if (!entry) throw new Error('Missing native dictation pill manifest entry');
  expect(entry.landedRelease).toBe('0.1.821');
});

// Pair the native model/executor tests with the actual shell ingress wiring.
it('parks the production native installer until frame ingress wakes it', () => {
  const source = readFileSync('native/o8-next/src/native_pill.rs', 'utf8');
  const install = source.split('pub(crate) fn install')[1].split('mod macos')[0];
  expect(install).toContain('wait_for_work(visible, &WAKE.1');
  expect(install).not.toContain('.timer(');
});
it('rejects unsupported-platform ingress before queueing', () => {
  const source = readFileSync('native/o8-next/src/native_pill.rs', 'utf8');
  const ingress = source.split('pub(crate) fn enqueue')[1].split('fn enqueue_supported')[0];
  expect(ingress).toContain('#[cfg(not(target_os = "macos"))]');
  expect(ingress).toContain('"ok":false');
  expect(ingress).toContain('return;');
});
it('uses the real-window predicate at the shell close entry point', () => {
  const source = readFileSync('native/o8-next/src/shell_view.rs', 'utf8');
  expect(source.split('cx.on_window_closed')[1]).toContain('!crate::native_pill::has_real_windows(cx)');
});

function controlledFetch() {
  const pending: { body: typeof frames[number]; resolve: (reply: Record<string, unknown>) => void }[] = [];
  vi.mocked(fetch).mockImplementation((_url, init) => {
    const body = JSON.parse(String(init?.body));
    frames.push(body);
    return new Promise<Response>(resolve => {
      pending.push({ body, resolve: value => resolve(new Response(JSON.stringify(value))) });
    });
  });
  return pending;
}
async function acknowledge(pending: ReturnType<typeof controlledFetch>, value = reply) {
  await act(async () => { pending.shift()!.resolve(value); });
}
it('waits for listener registration and the initial quiet-mode read before frames', async () => {
  const events = await import('@tauri-apps/api/event');
  const core = await import('@tauri-apps/api/core');
  let register!: (off: () => void) => void;
  let read!: (mode: { active: boolean }) => void;
  const listener = vi.spyOn(events, 'listen').mockImplementation(() => new Promise(resolve => { register = resolve; }));
  const initialRead = vi.spyOn(core, 'invoke').mockImplementation(() => new Promise(resolve => { read = resolve; }));
  await render('idle'); await render('recording');
  expect(listener).toHaveBeenCalledOnce();
  expect(initialRead).not.toHaveBeenCalled();
  expect(frames).toHaveLength(0);
  await act(async () => { register(() => undefined); });
  expect(initialRead).toHaveBeenCalledOnce();
  expect(frames.filter(frame => frame.action === 'frame')).toHaveLength(0);
  await act(async () => { read({ active: true }); });
  await tick(100);
  expect(native).toBe(true);
  expect(frames.some(frame => frame.action === 'frame')).toBe(true);
  expect(frames.filter(frame => frame.action === 'frame').every(frame => frame.snapshot?.state === 'idle')).toBe(true);
});
it('serializes rapid session changes and replaces pending snapshots with the latest session', async () => {
  await render('idle');
  const pending = controlledFetch();
  await render('recording');
  session = 2; await render('polishing');
  session = 3; await render('recording');
  snapshot.audioLevel = 0.9; await render('recording');
  expect(pending).toHaveLength(1);
  expect(pending[0].body.snapshot?.session).toBe(1);
  await acknowledge(pending);
  expect(pending).toHaveLength(1);
  expect(pending[0].body.snapshot).toMatchObject({ session: 3, state: 'recording', audioLevel: 0.9 });
  expect(frames.some(frame => frame.snapshot?.session === 2)).toBe(false);
  await acknowledge(pending);
  await tick(100);
  expect(pending).toHaveLength(1);
  expect(pending[0].body.snapshot?.session).toBe(3);
});
it.each([true, false])('ignores an older session reply for ownership and finish, native=%s', async available => {
  await render('idle');
  const pending = controlledFetch();
  await render('recording');
  session = 2; await render('recording');
  await acknowledge(pending, { native: available, absent: true, finishSession: 2 });
  expect(native).toBe(true);
  expect(finish).not.toHaveBeenCalled();
  expect(pending).toHaveLength(1);
  expect(pending[0].body.snapshot?.session).toBe(2);
});
it('ignores an old prepare acknowledgement after a newer session starts', async () => {
  const pending = controlledFetch();
  await render('recording');
  session = 2; await render('recording');
  await acknowledge(pending);
  expect(native).toBe(false);
  expect(pending).toHaveLength(1);
  expect(pending[0].body.action).toBe('prepare');
  await acknowledge(pending);
  expect(native).toBe(true);
  expect(pending[0].body.snapshot?.session).toBe(2);
});
it('does not update ownership or finish after unmount with a request in flight', async () => {
  await render('idle');
  const pending = controlledFetch();
  await render('recording');
  await act(async () => root.unmount()); mounted = false;
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await acknowledge(pending, { native: false, absent: true, finishSession: 1 });
  await tick(2000);
  expect(native).toBe(true);
  expect(finish).not.toHaveBeenCalled();
  expect(pending).toHaveLength(0);
  expect(error).not.toHaveBeenCalled();
});
it('serializes idle release ahead of the next session frame without delivering an old final state', async () => {
  await render('idle');
  const pending = controlledFetch();
  await render('recording');
  await render('success');
  await render('idle');
  session = 2; await render('recording');
  expect(pending).toHaveLength(1);
  await acknowledge(pending);
  expect(pending[0].body.action).toBe('release');
  await acknowledge(pending);
  expect(pending[0].body.snapshot).toMatchObject({ state: 'recording', session: 2 });
  expect(frames.some(frame => frame.snapshot?.state === 'success')).toBe(false);
  expect(frames.filter(frame => frame.action === 'release')).toHaveLength(1);
});

it('does not let a previous session fallback timer revoke a new session owner', async () => {
  await render('idle'); await render('recording');
  reply = { native: false, enabled: true, absent: false };
  await tick(100);
  expect(native).toBe(true);
  reply = { native: true, enabled: true };
  session = 2; await render('recording');
  await tick(1100);
  expect(native).toBe(true);
});

it('still probes the latest session when an older disabled prepare spans retirement', async () => {
  const pending = controlledFetch();
  await render('recording');
  await render('idle');
  session = 2; await render('recording');
  expect(pending).toHaveLength(1);
  await acknowledge(pending, { native: false, enabled: false });
  expect(pending).toHaveLength(1);
  expect(pending[0].body.action).toBe('prepare');
  await acknowledge(pending);
  expect(native).toBe(true);
  expect(pending[0].body.snapshot?.session).toBe(2);
});
