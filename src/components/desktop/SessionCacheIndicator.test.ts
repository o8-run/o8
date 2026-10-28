// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CapacityRows } from './settings-quick-drawer/capacity-rows';
import { SessionCacheIndicator, ProviderCacheStats } from './SessionCacheIndicator';
import { CACHE_OBSERVATIONS_KEY } from '@/lib/prompt-cache/observations';
import { parseOrchestratorTurnUsage } from '@/lib/lane/orchestrator-stream-events';
import { parseTerminalUsage } from './thoughts/use-orchestrator-stream/terminal-receipt';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
let root: Root; let host: HTMLDivElement;
let entries: MobileTranscriptEntry[];
const now = Date.parse('2026-10-24T12:00:00Z');
function turn(id: number, start: number, end: number, input: number, read: number | undefined, ttl?: number): MobileTranscriptEntry[] {
  return [{ id: `user-${id}`, role: 'user', text: 'private prompt must not be stored', timestamp: start },
    { id: `assistant-${id}`, role: 'assistant', model: 'fixture-model', text: 'private answer must not be stored', timestamp: end,
      tokens: { input, output: 10, ...(read !== undefined ? { cacheRead: read } : {}), cacheWrite: 0,
        ...(ttl ? { cacheRetentionMs: ttl } : {}) } }];
}
async function show(runtime = 'codex', model = 'fixture-model', session = 'session-a', running = false) {
  await act(async () => root.render(createElement('div', {},
    createElement(SessionCacheIndicator, { session, runtime, model, entries, running }),
    createElement(ProviderCacheStats, { runtime }))));
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now); localStorage.clear(); entries = [];
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected cache keep-alive'); }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it.each(['codex', 'claude-code'])('learns a %s warm resume, persists its gap and counts down without requests', async runtime => {
  entries = [...turn(1, now - 180_000, now - 120_000, 100, 900), ...turn(2, now - 60_000, now, 100, 900)];
  await show(runtime); expect(host.textContent).toContain('Cache warm · about 1 min left · estimate');
  expect(host.textContent).toContain('90% of input from cache');
  const saved = localStorage.getItem(CACHE_OBSERVATIONS_KEY)!;
  expect(JSON.parse(saved)[1].idleGapMs).toBe(60_000);
  expect(JSON.parse(saved)[1].read).toBe(900);
  expect(saved).not.toContain('private prompt'); expect(saved).not.toContain('private answer');
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(host.textContent).toContain('Cache likely cold · estimate');
  expect(fetch).not.toHaveBeenCalled();
});
it('prefers the provider-reported lifetime and retains it through the production usage decoder', async () => {
  const usage = parseTerminalUsage(parseOrchestratorTurnUsage({ usage: {
    input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 900,
    cache_creation: { ephemeral_1h_input_tokens: 100 }, cache_creation_input_tokens: 100,
  } }));
  entries = turn(1, now - 60_000, now, 100, 900); entries[1].tokens = usage;
  await show('claude-code'); expect(host.textContent).toContain('about 60 min left · estimate');
  expect(host.querySelector('[data-session-cache]')?.getAttribute('title')).toContain('reported cache lifetime');
});
it('records an observed cold resume and shows its provider daily count', async () => {
  entries = [...turn(1, now - 600_000, now - 540_000, 100, 900), ...turn(2, now - 60_000, now, 20_000, 0)];
  await show(); expect(host.textContent).toContain('Cache likely cold · estimate'); expect(host.textContent).toContain('1 cold resumes');
  expect(host.textContent).toContain('2/2 turns measured');
});
it('does not manufacture a cold resume when the upstream cache counters were absent', async () => {
  const unknown = parseTerminalUsage(parseOrchestratorTurnUsage({ usage: { input_tokens: 20_000, output_tokens: 20 } }));
  entries = [...turn(1, now - 600_000, now - 540_000, 100, 900), ...turn(2, now - 60_000, now, 20_000, 0)];
  entries[3].tokens = unknown; await show();
  expect(host.textContent).toContain('Cache unknown · estimate'); expect(host.textContent).toContain('0 cold resumes');
  expect(host.textContent).toContain('1/2 turns measured');
});
it('does not learn from a running or partially reported turn, or inherit another model or runtime', async () => {
  entries = turn(1, now - 60_000, now, 100, 900, 300_000);
  await show('codex', 'fixture-model', 'session-a', true); expect(host.textContent).toContain('Cache unknown');
  await show(); expect(host.textContent).toContain('Cache warm');
  await show('codex', 'other-model'); expect(host.textContent).toContain('Cache unknown');
  await show('unknown-runtime'); expect(host.textContent).toBe('');
});
it('deduplicates remounts and recovers local observations across a component reload', async () => {
  entries = [...turn(1, now - 180_000, now - 120_000, 100, 900), ...turn(2, now - 60_000, now, 100, 900)];
  await show(); const saved = localStorage.getItem(CACHE_OBSERVATIONS_KEY);
  await act(async () => root.render(null)); entries = []; await show();
  expect(host.textContent).toContain('Cache warm'); expect(host.textContent).toContain('2/2 turns measured');
  expect(localStorage.getItem(CACHE_OBSERVATIONS_KEY)).toBe(saved); expect(fetch).not.toHaveBeenCalled();
});
it('handles malformed storage and midnight without stale daily counts', async () => {
  localStorage.setItem(CACHE_OBSERVATIONS_KEY, 'not-json'); await show(); expect(host.textContent).toContain('cache share unknown');
  entries = turn(1, now - 60_000, now, 100, 900, 300_000); await show(); expect(host.textContent).toContain('1/1 turns measured');
  await act(async () => { vi.setSystemTime(new Date('2026-10-25T00:00:01')); await vi.advanceTimersByTimeAsync(15_000); });
  expect(host.textContent).toContain('0/0 turns measured');
});

it('shows the observed provider totals through the actual capacity drawer rows', async () => {
  entries = [...turn(1, now - 600_000, now - 540_000, 100, 900), ...turn(2, now - 60_000, now, 20_000, 0)];
  await show();
  await act(async () => root.render(createElement(CapacityRows, { loading: false, error: null, onRefresh() {}, snapshot: {
    schema: 'o8/runtime-capacity-control/v1', generatedAt: now, identities: [], runtimes: [],
    capacities: [{ runtime: 'codex', identityId: null, status: 'unavailable', reason: 'fixture', observedAt: null, source: null, confidence: null, buckets: [] }],
  } })));
  expect(host.querySelector('[data-provider-cache="codex"]')?.textContent).toContain('1 cold resumes');
  expect(host.textContent).toContain('2/2 turns measured'); expect(fetch).not.toHaveBeenCalled();
});

it('preserves an unreported cache-write count as unknown instead of inventing a measured zero', async () => {
  entries = turn(1, now - 60_000, now, 100, 900, 300_000);
  entries[1].tokens = parseTerminalUsage(parseOrchestratorTurnUsage({ usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 900 } }));
  await show();
  expect(JSON.parse(localStorage.getItem(CACHE_OBSERVATIONS_KEY)!)[0].write).toBeNull();
  expect(host.textContent).toContain('0/1 turns measured');
  expect(host.textContent).toContain('cache share unknown');
});
