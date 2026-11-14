// @ts-expect-error jsdom is a test dependency without bundled declarations.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { act, createElement } from 'react';
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
const frames: { action: string; snapshot?: Record<string, unknown> }[] = [];
let reply: Record<string, unknown>;
function Probe() {
  native = useNativeDictationPill(snapshot, session, () => undefined).native;
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
  vi.useFakeTimers(); frames.length = 0; session = 1;
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
  await act(async () => root.unmount());
  dom.window.close(); vi.unstubAllGlobals(); vi.useRealTimers();
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
  await render('recording'); await tick(1000);
  expect(frames.filter(frame => frame.action === 'frame')).toHaveLength(11);
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
  expect(SHIPPED_DARK_FLAG_MANIFEST.nativeDictationPill.landedRelease).toBe('0.1.821');
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
