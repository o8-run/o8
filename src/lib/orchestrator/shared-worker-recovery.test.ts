import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { heldSharedCheckoutRepairs, settleSharedCheckoutTeams } from './shared-worker-recovery';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('settleSharedCheckoutTeams', () => {
  it('holds a repair behind a stale lock until the lock changes or its backoff ends, and logs it once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'o8-shared-repair-'));
    roots.push(root);
    const repoPath = join(root, 'repo');
    mkdirSync(repoPath);
    const dataDir = join(root, 'data');
    const directory = join(dataDir, 'shared-checkout-teams');
    mkdirSync(directory, { recursive: true });
    const path = realpathSync(repoPath);
    const id = createHash('sha256').update(path).digest('hex').slice(0, 24);
    writeFileSync(join(directory, `${id}.json`), JSON.stringify({ id, path, branch: 'main', baseHead: 'abc',
      parentThreadId: 'thoughts-owner', createdAt: new Date().toISOString(), members: [] }));
    // A lock left behind by a crashed operation: older than the 30 s stale bound.
    const lock = join(directory, `${id}.lock`);
    mkdirSync(lock);
    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(lock, old, old);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let clock = 1_000_000;
    const now = () => clock;

    await settleSharedCheckoutTeams(dataDir, now);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[shared-checkout] Membership repair held:', `${id}.json`,
      expect.stringContaining('lock is stale'));
    expect(heldSharedCheckoutRepairs()).toMatchObject([{ delayMs: 60_000, retryAt: clock + 60_000 }]);

    // The next heartbeats skip the held repair: no attempt doubles the backoff.
    for (const step of [5_000, 5_000, 5_000]) {
      clock += step;
      await settleSharedCheckoutTeams(dataDir, now);
    }
    expect(heldSharedCheckoutRepairs()).toMatchObject([{ delayMs: 60_000 }]);

    // After the backoff one attempt runs, fails the same way, waits twice as long and stays quiet.
    clock = 1_000_000 + 61_000;
    await settleSharedCheckoutTeams(dataDir, now);
    expect(heldSharedCheckoutRepairs()).toMatchObject([{ delayMs: 120_000 }]);
    expect(warn).toHaveBeenCalledTimes(1);

    // Clearing the lock retries at once and the repair completes.
    rmSync(lock, { recursive: true });
    clock += 1_000;
    await settleSharedCheckoutTeams(dataDir, now);
    expect(heldSharedCheckoutRepairs()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
