import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { heldSharedCheckoutRepairs, settleSharedCheckoutTeams } from './shared-worker-recovery';

const launchLookups = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/lib/runtimes/shared/owned-session-index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtimes/shared/owned-session-index')>();
  return { ...actual, findOwnedLaunchByMutationId: (id: string) => {
    launchLookups.count += 1;
    return actual.findOwnedLaunchByMutationId(id);
  } };
});

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  launchLookups.count = 0;
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

  it('skips a settled repair until its receipt or an owned session record changes, or a launch grace window ends', async () => {
    const root = mkdtempSync(join(tmpdir(), 'o8-shared-settled-'));
    roots.push(root);
    const repoPath = join(root, 'repo');
    mkdirSync(repoPath);
    const path = realpathSync(repoPath);
    const dataDir = join(root, 'data');
    const directory = join(dataDir, 'shared-checkout-teams');
    mkdirSync(directory, { recursive: true });
    const ownedRoot = join(root, 'owned-codex');
    vi.stubEnv('CORTEX_IDE_OWNED_CODEX_ROOT', ownedRoot);
    const record = join(ownedRoot, 'worker-1', 'session.json');
    mkdirSync(join(ownedRoot, 'worker-1'), { recursive: true });
    const session = { surfaceId: 'codex-owned:worker-1', launchMutationId: 'mutation-1', cwd: path, repoPath: path,
      recentRuns: [{ id: 'run-1', outcome: 'finished' }] };
    writeFileSync(record, JSON.stringify(session));
    const id = createHash('sha256').update(path).digest('hex').slice(0, 24);
    const launchedAt = new Date().toISOString();
    const member = (name: string, mutation: string, surfaceId: string, state: string) => ({ surfaceId, runtime: 'codex',
      taskName: name, clientMutationId: mutation, launchedAt, paths: [], state,
      ...(state === 'settled' ? { settledOutcome: 'finished' } : {}) });
    const team = { id, path, branch: 'main', baseHead: 'abc', parentThreadId: 'thoughts-owner', createdAt: launchedAt,
      initialChangedPaths: [], members: [member('finished worker', 'mutation-1', 'codex-owned:worker-1', 'settled')] };
    writeFileSync(join(directory, `${id}.json`), JSON.stringify(team));
    let clock = Date.now();
    const now = () => clock;

    await settleSharedCheckoutTeams(dataDir, now);
    expect(launchLookups.count).toBe(1);
    // Nothing it reads changed: later heartbeats do not read the session records again.
    for (let beat = 0; beat < 3; beat += 1) {
      clock += 5_000;
      await settleSharedCheckoutTeams(dataDir, now);
    }
    expect(launchLookups.count).toBe(1);

    // A worker's record changing (a resume, an exit) repairs again.
    writeFileSync(record, JSON.stringify({ ...session, recentRuns: [{ id: 'run-2', outcome: 'finished' }, ...session.recentRuns] }));
    await settleSharedCheckoutTeams(dataDir, now);
    expect(launchLookups.count).toBe(2);
    await settleSharedCheckoutTeams(dataDir, now);
    expect(launchLookups.count).toBe(2);

    // A member whose record is missing inside its launch grace window is rechecked when the window ends.
    writeFileSync(join(directory, `${id}.json`), JSON.stringify({ ...team,
      members: [...team.members, member('launching worker', 'mutation-2', 'codex-owned:worker-2', 'reserved')] }));
    await settleSharedCheckoutTeams(dataDir, now);
    expect(launchLookups.count).toBe(4);
    clock += 60_000;
    await settleSharedCheckoutTeams(dataDir, now);
    expect(launchLookups.count).toBe(4);
    clock += 15 * 60_000;
    await settleSharedCheckoutTeams(dataDir, now);
    expect(launchLookups.count).toBe(6);
  });
});
