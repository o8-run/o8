import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-codex-app-sync-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;

const {
  CODEX_APP_SYNC_MAX_RETRY_MS,
  noteCodexAppTurn,
  resetCodexAppSyncState,
  syncCodexAppThreads,
} = await import('./app-thread-sync');
type Reader = Awaited<ReturnType<Parameters<typeof syncCodexAppThreads>[0]['openReader']>>;

const TICK_MS = 4_000;
let chat = 0;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-21T00:00:00.000Z'));
  resetCodexAppSyncState();
  // A fresh chat link per test, so no rollout path is remembered from the last one.
  chat += 1;
  noteCodexAppTurn({ tabId: `thoughts-${chat}`, repoPath: '/repo', threadId: `thread-${chat}`, turnId: 'turn-1' });
});
afterEach(() => {
  vi.useRealTimers();
});

/** Run the sync on its 4 s tick for `ms`, returning how many app-servers it started. */
async function runFor(ms: number, openReader: () => Promise<Reader>): Promise<number> {
  let opens = 0;
  const deps = {
    isBusy: () => false,
    openReader: () => { opens += 1; return openReader(); },
  };
  for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) {
    await syncCodexAppThreads(deps).catch(() => undefined);
    vi.advanceTimersByTime(TICK_MS);
  }
  return opens;
}

it('backs off exponentially, capped, when codex app-server will not start, and recovers at once after', async () => {
  const failing = async (): Promise<Reader> => { throw new Error('app-server exited'); };
  // One hour of 4 s ticks used to start 900 app-servers.
  const opens = await runFor(60 * 60_000, failing);
  // 4, 8, 16 ... s, capped at ten minutes: about a dozen attempts in the hour.
  expect(opens).toBeGreaterThanOrEqual(10);
  expect(opens).toBeLessThanOrEqual(15);
  const perCap = await runFor(CODEX_APP_SYNC_MAX_RETRY_MS * 3, failing);
  expect(perCap).toBeGreaterThanOrEqual(2);
  expect(perCap).toBeLessThanOrEqual(4);

  // Once it starts, the next tick after the backoff succeeds and the backoff is cleared.
  const closes = vi.fn(async () => undefined);
  const working = async (): Promise<Reader> => ({
    rolloutPath: async () => join(dataDir, 'missing-rollout.jsonl'),
    recentTurns: async () => [],
    close: closes,
  });
  await runFor(CODEX_APP_SYNC_MAX_RETRY_MS, working);
  const steady = await runFor(60_000, working);
  // The rollout path is saved and the file is gone, so later ticks need no app-server at all.
  expect(steady).toBe(0);
  expect(closes).toHaveBeenCalled();
});

it('backs off a chat whose Codex thread cannot be read, without starting an app-server every tick', async () => {
  const closes = vi.fn(async () => undefined);
  const unreadable = async (): Promise<Reader> => ({
    rolloutPath: async () => null,
    recentTurns: async () => [],
    close: closes,
  });
  const opens = await runFor(60 * 60_000, unreadable);
  expect(opens).toBeGreaterThanOrEqual(10);
  expect(opens).toBeLessThanOrEqual(15);
  expect(closes).toHaveBeenCalledTimes(opens);
});
