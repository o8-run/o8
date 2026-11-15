/**
 * #1282 Failure B — zombie-reap must SALVAGE completed-but-uncommitted work
 * instead of stranding it as `recovering`.
 *
 * Live repro: a `running` lane's owner process died AFTER the worker finished
 * its edits but BEFORE it reported completion, so the pre-review auto-commit
 * never ran. The reaper dropped the lane to `recovering` and the complete,
 * correct work sat uncommitted in the worktree — reading as a failure.
 *
 * Invariants under test (src/lib/lane/reaper.ts → reapZombieLane):
 *   - a `running` lane with a worktree holding real uncommitted work is
 *     committed and routed to `reviewing` (lastEventLabel zombie_reap_salvaged,
 *     event payload { salvaged: true })
 *   - a `running` lane whose worktree has NOTHING reviewable falls through to
 *     the existing `recovering` path unchanged
 *   - a `merging` lane is NEVER salvaged (mid-write — committing its tree could
 *     corrupt the in-flight merge); it stays on the `recovering` path and its
 *     worktree is left untouched
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ZombieLaneCandidate } from '@/lib/lane/reaper';
import type { Lane } from '@/lib/lane/types';
import { resetCodexProcessCwdIndexForTesting, setCodexProcessReaderForTesting } from '@/lib/runtimes/shared/codex-process-cwd';
import { resetOwnedSessionIndex } from '@/lib/runtimes/shared/owned-session-index';

// The SQLite store resolves its data dir at module load — point it at a temp
// dir BEFORE importing anything that touches the registry (dynamic below for
// the same reason; static imports would hoist above this assignment).
process.env.O8_DATA_DIR = mkdtempSync(join(tmpdir(), 'o8-reaper-salvage-'));
process.env.CORTEX_IDE_OWNED_CODEX_ROOT = mkdtempSync(join(tmpdir(), 'o8-owned-codex-'));

const { createLane, getLane, setLaneStatus, updateLane, getLaneEvents } = await import('@/lib/lane/registry');
const { LANE_HEARTBEAT_STALE_MS, listZombieLaneCandidates, reapZombieLane, recordLaneHeartbeat } = await import('@/lib/lane/reaper');
const { rebindLaneSessionIfChanged } = await import('@/lib/lane/session-rebind');

let ownedRoot: string | null = null;

afterEach(() => {
  if (ownedRoot) rmSync(ownedRoot, { recursive: true, force: true });
  ownedRoot = null;
  delete process.env.CORTEX_IDE_OWNED_CODEX_ROOT;
  resetCodexProcessCwdIndexForTesting();
  resetOwnedSessionIndex();
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

/** A temp git repo on `main` with one base commit; optionally leave a dirty edit. */
function makeWorktree(opts: { dirty: boolean; branch?: string }): string {
  const dir = mkdtempSync(join(tmpdir(), 'o8-reaper-wt-'));
  git(dir, ['init', '-q', '-b', opts.branch ?? 'main']);
  git(dir, ['config', 'user.email', 'test@o8.dev']);
  git(dir, ['config', 'user.name', 'o8 test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--no-verify', '-m', 'base']);
  if (opts.dirty) {
    writeFileSync(join(dir, 'feature.ts'), 'export const shipped = true;\n');
  }
  return dir;
}

function isDirty(cwd: string): boolean {
  return git(cwd, ['status', '--porcelain']).trim().length > 0;
}

function writeOwnedSession(surfaceId: string, activeRun?: { pid: number }) {
  // Self-provision the owned root: the liveness suite's afterEach deletes the
  // env var, so each test that writes a session gets a fresh isolated root.
  if (!process.env.CORTEX_IDE_OWNED_CODEX_ROOT) {
    ownedRoot = mkdtempSync(join(tmpdir(), 'o8-owned-codex-'));
    process.env.CORTEX_IDE_OWNED_CODEX_ROOT = ownedRoot;
  }
  const id = surfaceId.replace(/^codex-owned:/, '');
  const dir = join(process.env.CORTEX_IDE_OWNED_CODEX_ROOT, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.json'), JSON.stringify({
    surfaceId,
    activeRun,
  }));
  resetOwnedSessionIndex();
}

function deadCandidate(
  lane: Lane,
  reason: ZombieLaneCandidate['reason'] = 'missing_heartbeat',
): ZombieLaneCandidate {
  return {
    lane,
    staleMs: 999_999,
    lastHeartbeatAt: null,
    probe: { alive: false, source: 'test', note: 'owner confirmed dead' },
    reason,
  };
}

describe('reapZombieLane salvage (#1282 Failure B)', () => {
  it('does not classify an owned Codex lane dead when a live codex process cwd matches the worktree', async () => {
    const wt = makeWorktree({ dirty: false });
    ownedRoot = mkdtempSync(join(tmpdir(), 'o8-reaper-owned-codex-'));
    process.env.CORTEX_IDE_OWNED_CODEX_ROOT = ownedRoot;
    resetOwnedSessionIndex();

    const surfaceId = 'codex-owned:reaper-live-cwd';
    const sessionDir = join(ownedRoot, 'reaper-live-cwd');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({
      surfaceId,
      activeRun: { pid: 2_147_483_647 },
    }));
    setCodexProcessReaderForTesting(async () => [{
      pid: 23456,
      command: '/opt/homebrew/bin/codex exec --resume reaper',
      cwd: wt,
    }]);

    const lane = createLane({
      repoPath: wt,
      branch: 'pkt/reaper-live-cwd',
      runtime: 'codex',
      worktreePath: wt,
      baseBranch: 'main',
      sessionKey: surfaceId,
      packetId: 'pkt-reaper-live-cwd',
    });
    setLaneStatus(lane.id, 'running', 'system');
    const now = Date.now();
    updateLane(lane.id, {
      lastHeartbeatAt: now - LANE_HEARTBEAT_STALE_MS - 5_000,
      lastEventAt: new Date(now - LANE_HEARTBEAT_STALE_MS - 5_000).toISOString(),
      lastEventLabel: 'session_launched',
    });

    const candidates = await listZombieLaneCandidates(now);

    expect(candidates.some((candidate) => candidate.lane.id === lane.id)).toBe(false);
    expect(getLane(lane.id)?.status).toBe('running');
  });

  it('commits a running lane\'s uncommitted work and routes it to reviewing', async () => {
    // The lane's checkout is on the lane's branch.
    const wt = makeWorktree({ dirty: true, branch: 'pkt/salvage-me' });
    const lane = createLane({
      repoPath: wt,
      branch: 'pkt/salvage-me',
      runtime: 'codex',
      worktreePath: wt,
      baseBranch: 'main',
      packetId: 'pkt-1282b-salvage',
    });
    setLaneStatus(lane.id, 'running', 'system');
    expect(isDirty(wt)).toBe(true); // precondition: work is stranded uncommitted

    const result = await reapZombieLane(deadCandidate(getLane(lane.id)!), { source: 'manual' });

    expect(result?.status).toBe('reviewing');
    expect(result?.lastEventLabel).toBe('zombie_reap_salvaged');
    expect(result?.sessionKey ?? null).toBeNull();
    // The stranded work is now committed in the worktree.
    expect(isDirty(wt)).toBe(false);

    const salvageEvent = getLaneEvents(lane.id).find((e) => e.verb === 'zombie_reap');
    expect(salvageEvent?.payload.salvaged).toBe(true);
    expect(salvageEvent?.payload.autoCommitted).toBe(true);
    const preservedBranch = salvageEvent?.payload.preservedBranch;
    expect(typeof preservedBranch).toBe('string');
    expect(preservedBranch).toMatch(/^preserved\//);
    expect(git(wt, ['show', `${preservedBranch as string}:feature.ts`])).toContain('shipped = true');
  });

  it('does not reap after a steer-style rebind while the old owned key is dead', async () => {
    const wt = makeWorktree({ dirty: false });
    const oldSessionKey = 'codex-owned:codex-owned-test-old';
    const liveSessionKey = 'codex-owned:codex-owned-test-live';
    writeOwnedSession(oldSessionKey);
    writeOwnedSession(liveSessionKey, { pid: process.pid });

    const lane = createLane({
      repoPath: wt,
      branch: 'pkt/rebound-owned-session',
      runtime: 'codex',
      worktreePath: wt,
      baseBranch: 'main',
      packetId: 'pkt-rebind-owned-session',
      sessionKey: oldSessionKey,
    });
    setLaneStatus(lane.id, 'running', 'system');

    const rebound = rebindLaneSessionIfChanged(lane.id, oldSessionKey, liveSessionKey, 'orchestrator');
    expect(rebound?.sessionKey).toBe(liveSessionKey);

    const baseNow = Date.now();
    recordLaneHeartbeat(lane.id, baseNow - (LANE_HEARTBEAT_STALE_MS * 2));
    const candidates = await listZombieLaneCandidates(baseNow + LANE_HEARTBEAT_STALE_MS + 5_000);

    expect(candidates.some((candidate) => candidate.lane.id === lane.id)).toBe(false);
  });

  it('gives actor-driven running transitions a reaper grace window', async () => {
    const wt = makeWorktree({ dirty: false });
    const sessionKey = 'codex-owned:codex-owned-test-dead-after-steer';
    writeOwnedSession(sessionKey);
    const lane = createLane({
      repoPath: wt,
      branch: 'pkt/recent-steer-grace',
      runtime: 'codex',
      worktreePath: wt,
      baseBranch: 'main',
      packetId: 'pkt-recent-steer-grace',
      sessionKey,
    });
    setLaneStatus(lane.id, 'running', 'orchestrator', 'steered_packet');

    const baseNow = Date.now();
    recordLaneHeartbeat(lane.id, baseNow - (LANE_HEARTBEAT_STALE_MS * 2));
    const candidates = await listZombieLaneCandidates(baseNow + LANE_HEARTBEAT_STALE_MS - 1_000);

    expect(candidates.some((candidate) => candidate.lane.id === lane.id)).toBe(false);
  }, 20_000);

  it('falls through to recovering when the worktree has nothing reviewable', async () => {
    const wt = makeWorktree({ dirty: false });
    const lane = createLane({
      repoPath: wt,
      branch: 'pkt/nothing-to-salvage',
      runtime: 'codex',
      worktreePath: wt,
      baseBranch: 'main',
    });
    setLaneStatus(lane.id, 'running', 'system');

    const result = await reapZombieLane(deadCandidate(getLane(lane.id)!), { source: 'manual' });

    expect(result?.status).toBe('recovering');
    expect(result?.lastEventLabel).toBe('zombie_reap');
    const event = getLaneEvents(lane.id).find((e) => e.verb === 'zombie_reap');
    expect(event?.payload.salvaged).toBeUndefined();
  });

  it('never salvages a merging lane (mid-write) and leaves its worktree untouched', async () => {
    const wt = makeWorktree({ dirty: true });
    const lane = createLane({
      repoPath: wt,
      branch: 'pkt/mid-merge',
      runtime: 'codex',
      worktreePath: wt,
      baseBranch: 'main',
    });
    setLaneStatus(lane.id, 'merging', 'system');

    const result = await reapZombieLane(deadCandidate(getLane(lane.id)!, 'stale_merging'), {
      source: 'manual',
    });

    expect(result?.status).toBe('recovering');
    expect(result?.lastEventLabel).toBe('zombie_reap');
    // The in-flight merge tree was NOT committed — its changes are still dirty.
    expect(isDirty(wt)).toBe(true);
  });
});
