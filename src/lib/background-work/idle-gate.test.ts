import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { atRest, idleGateStats, noteActivity, noteClientMessage, noteRequest, pausedLoopNames, resetIdleGate, startIdleGate } from './idle-gate';
import { recurring } from './ledger';

let live: boolean | string = false;
const timers: NodeJS.Timeout[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  resetIdleGate();
  live = false;
  startIdleGate({ liveSessions: () => live });
});
afterEach(() => {
  for (const timer of timers.splice(0)) clearInterval(timer);
  resetIdleGate();
  vi.useRealTimers();
});

it('pauses an idle-safe loop at rest and runs it within one check when an agent starts', () => {
  const run = vi.fn();
  timers.push(recurring('fixture-idle-safe', run, 1_000));
  vi.advanceTimersByTime(59_000);
  const beforeRest = run.mock.calls.length;
  expect(beforeRest).toBeGreaterThan(50);
  vi.advanceTimersByTime(60_000);
  expect(atRest()).toBe(true);
  const atRestCalls = run.mock.calls.length;
  vi.advanceTimersByTime(30_000);
  expect(run.mock.calls.length).toBe(atRestCalls);
  expect(pausedLoopNames()).toEqual(['fixture-idle-safe']);

  live = true;
  // The session cache and the wake check both settle within five seconds.
  vi.advanceTimersByTime(5_000);
  expect(run.mock.calls.length).toBeGreaterThan(atRestCalls);
  expect(pausedLoopNames()).toEqual([]);
});

it('wakes at once on client activity and keeps "always" loops running', () => {
  const idleSafe = vi.fn();
  const always = vi.fn();
  timers.push(recurring('fixture-idle', idleSafe, 1_000));
  timers.push(recurring('fixture-always', always, 1_000, { class: 'always', reason: 'test' }));
  vi.advanceTimersByTime(120_000);
  const pausedAt = idleSafe.mock.calls.length;
  const alwaysAt = always.mock.calls.length;
  vi.advanceTimersByTime(10_000);
  expect(idleSafe.mock.calls.length).toBe(pausedAt);
  expect(always.mock.calls.length).toBe(alwaysAt + 10);

  // The server's own reads and a background window's reads do not wake it.
  noteRequest({ 'x-o8-background': '1' }, 'POST');
  noteRequest({ 'x-o8-foreground': '0' }, 'GET');
  // Nor does a client's socket keepalive.
  noteClientMessage('{"type":"ping"}');
  expect(idleSafe.mock.calls.length).toBe(pausedAt);
  expect(idleGateStats().ignored['socket keepalive']).toBe(1);
  // A window in front (or one that does not say) does, without waiting for a tick.
  noteRequest({}, 'GET');
  expect(idleSafe.mock.calls.length).toBe(pausedAt + 1);
  noteActivity();
  expect(atRest()).toBe(false);
});

it('never rests with the gate turned off', () => {
  vi.stubEnv('O8_IDLE_GATE', '0');
  vi.advanceTimersByTime(300_000);
  expect(atRest()).toBe(false);
  vi.unstubAllEnvs();
});

it('keeps a loop with queued or outstanding work running at rest, and pauses it once the work is gone', () => {
  let queued = true;
  const drain = vi.fn();
  const other = vi.fn();
  timers.push(recurring('fixture-drain', drain, 1_000, { busy: () => queued }));
  timers.push(recurring('fixture-other', other, 1_000));
  vi.advanceTimersByTime(120_000);
  expect(atRest()).toBe(true);
  const drainAt = drain.mock.calls.length;
  const otherAt = other.mock.calls.length;
  vi.advanceTimersByTime(10_000);
  // Work is due: the loop that owns it keeps running; the rest stay paused.
  expect(drain.mock.calls.length).toBe(drainAt + 10);
  expect(other.mock.calls.length).toBe(otherAt);

  queued = false;
  vi.advanceTimersByTime(10_000);
  const settled = drain.mock.calls.length;
  vi.advanceTimersByTime(10_000);
  expect(drain.mock.calls.length).toBe(settled);
  expect(pausedLoopNames()).toContain('fixture-drain');
});

it('runs every loop once after the last session ends before resting, even a slow one', () => {
  const reaper = vi.fn();
  const fast = vi.fn();
  live = true;
  // A ten-minute reaper and a ten-second loop, with a session running and no client.
  timers.push(recurring('fixture-reaper', reaper, 600_000));
  timers.push(recurring('fixture-fast', fast, 10_000));
  vi.advanceTimersByTime(600_000);
  expect(reaper).toHaveBeenCalledTimes(1);
  expect(atRest()).toBe(false);

  // The session ends between reaper runs; the gate rests at its next check.
  live = false;
  vi.advanceTimersByTime(5_000);
  expect(atRest()).toBe(true);
  // Entering rest ran the reaper once after the session ended, then paused it.
  vi.advanceTimersByTime(10_000);
  expect(reaper).toHaveBeenCalledTimes(2);
  const fastAtRest = fast.mock.calls.length;
  // Its next ticks are paused.
  vi.advanceTimersByTime(1_200_000);
  expect(reaper).toHaveBeenCalledTimes(2);
  expect(fast.mock.calls.length).toBe(fastAtRest);
  expect(pausedLoopNames()).toEqual(['fixture-fast', 'fixture-reaper']);
});

it("wakes on neither of the server's own requests to itself, and still wakes on an unmarked one", async () => {
  const { conflictScanRequestHeaders } = await import('@/lib/ws-server/conflict-gate');
  const { readTerminalInventory } = await import('@/lib/app-update/idle-window');
  const dataDir = mkdtempSync(join(tmpdir(), 'o8-idle-gate-'));
  vi.stubEnv('O8_DATA_DIR', dataDir);
  vi.stubEnv('CORTEX_IDE_DATA_DIR', dataDir);
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ sessions: [] }));
  vi.stubGlobal('fetch', fetchMock);
  // What the server's HTTP handler receives: Node lowercases header names.
  const received = (headers: HeadersInit | undefined) => Object.fromEntries(new Headers(headers).entries());
  try {
    await readTerminalInventory();
    const voiceSessions = received((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.headers);
    const conflicts = received(conflictScanRequestHeaders('token'));

    const run = vi.fn();
    timers.push(recurring('fixture-self-requests', run, 1_000));
    vi.advanceTimersByTime(120_000);
    expect(atRest()).toBe(true);
    const pausedAt = run.mock.calls.length;

    noteRequest(voiceSessions, 'GET'); // GET /terminal-voice-sessions
    noteRequest(conflicts, 'GET'); // GET /api/worktrees/conflicts
    vi.advanceTimersByTime(10_000);
    expect(atRest()).toBe(true);
    expect(run.mock.calls.length).toBe(pausedAt);

    // The same request without the header is client activity.
    const { 'x-o8-background': _marker, ...unmarked } = conflicts;
    noteRequest(unmarked, 'GET');
    expect(atRest()).toBe(false);
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

it('reports awake and resting time and names what kept the gate awake', () => {
  vi.advanceTimersByTime(120_000);
  expect(atRest()).toBe(true);
  noteRequest({ 'x-o8-foreground': '0' }, 'GET', '/api/mission?since=1');
  noteRequest({ 'x-o8-background': '1' }, 'POST', '/api/internal');
  noteRequest({}, 'GET', '/api/missions/0123456789abcdef0123456789abcdef?x=1');
  vi.advanceTimersByTime(30_000);
  live = 'lane running';
  vi.advanceTimersByTime(30_000);

  const stats = idleGateStats();
  // Rested from 60 s until the request at 120 s, then awake through the live lane.
  expect(stats.restingMs).toBeGreaterThanOrEqual(55_000);
  expect(stats.restingMs).toBeLessThanOrEqual(65_000);
  expect(stats.awakeMs + stats.restingMs).toBe(180_000);
  expect(stats.activity).toEqual({ 'GET /api/missions/:id': 1 });
  expect(stats.ignored).toEqual({ 'background window read': 1, 'server self-request': 1 });
  expect(stats.live['lane running']).toBeGreaterThan(0);
});

