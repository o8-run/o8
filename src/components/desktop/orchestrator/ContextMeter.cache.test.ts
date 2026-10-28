// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ContextMeter } from './ContextMeter';
import { SessionCacheProvider } from '../SessionCacheIndicator';
import { CACHE_OBSERVATIONS_KEY } from '@/lib/prompt-cache/observations';

const now = Date.UTC(2026, 9, 28, 12);
let host: HTMLDivElement;
let root: Root;
const entries: [] = [];
async function show(session = 'warm', runtime = 'codex', model = 'fixture') {
  await act(async () => root.render(createElement(SessionCacheProvider, { session, runtime, model, entries, running: false },
    createElement(ContextMeter, { tokenCount: 0, runningTotal: 0 }))));
}
const pill = () => host.querySelector<HTMLButtonElement>('[data-context-meter]')!;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Cache status must not send requests'); }));
  localStorage.clear();
  localStorage.setItem(CACHE_OBSERVATIONS_KEY, JSON.stringify(['warm', 'expired'].map(session => ({
    id: session, session, runtime: 'codex', model: 'fixture', startedAt: now - 660_000,
    endedAt: session === 'warm' ? now : now - 600_000, input: 100, read: 900, write: 0,
    requestedLifetimeMs: 300_000, idleGapMs: null,
  }))));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('updates the existing pill immediately for the selected conversation, runtime and model', async () => {
  await show();
  expect(pill().textContent).toBe('Warm ~5m');
  expect(pill().getAttribute('aria-label')).toContain('Cache warm · about 5 min left · estimate');
  await show('expired');
  expect(pill().textContent).toBe('Cold · est.');
  expect(pill().getAttribute('aria-label')).toContain('Cache likely cold · estimate');
  await show('unseen'); expect(pill().textContent).toBe('Cache ?');
  await show('warm', 'codex', 'other-model'); expect(pill().textContent).toBe('Cache ?');
  await show('warm', 'unavailable'); expect(pill().textContent).toBe('Cache n/a');
  expect(pill().getAttribute('aria-label')).toContain('unavailable for this runtime');
  await show(); expect(pill().textContent).toBe('Warm ~5m');
  expect(fetch).not.toHaveBeenCalled();
});
it('uses the existing refresh interval and expiry math without counting below zero', async () => {
  await show();
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(pill().textContent).toBe('Warm ~4m');
  await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
  expect(pill().textContent).toBe('Cold · est.');
  expect(pill().textContent).not.toMatch(/\d/);
  expect(fetch).not.toHaveBeenCalled();
});
it('exposes the full explanation on keyboard focus and retains the existing context popover', async () => {
  await show();
  await act(async () => pill().focus());
  const tooltip = document.querySelector('[role="tooltip"]')!;
  expect(tooltip.textContent).toContain('Cache warm · about 5 min left · estimate');
  expect(tooltip.textContent).toContain('reuse is not guaranteed');
  expect(pill().getAttribute('aria-describedby')).toBe(tooltip.id);
  await act(async () => pill().click());
  expect(pill().getAttribute('aria-expanded')).toBe('true');
  expect(document.body.textContent).toContain('Estimated locally');
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
