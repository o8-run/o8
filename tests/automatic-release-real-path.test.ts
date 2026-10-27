import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';
import type { GitHubPullRequestSnapshot } from '@/lib/github-broker/store';

vi.mock('@/lib/lane/terminal-lane-cleanup', () => ({ scheduleTerminalLaneCleanup: vi.fn() }));
vi.mock('@/lib/lane/worktree-cleanup', () => ({
  pruneRepoWorktrees: vi.fn(async () => []),
  cleanupLaneWorktree: vi.fn(async () => false), // Retirement stays held; this fixture proves release/archival.
}));
vi.mock('@/lib/github-broker/sync', () => ({
  ensureGitHubPullRequest: vi.fn(async () => ({ pr: null })),
  ensureGitHubPullRequestByHead: vi.fn(async () => ({ pr: null })),
}));
const LIVE_INVENTORY = { meta: { mode: 'live', observablePending: false }, agents: [] };
vi.mock('@/lib/runtime/inventory', () => ({ getRuntimeInventorySnapshot: vi.fn(async () => LIVE_INVENTORY) }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
vi.mock('@/lib/lane/durable-review-approval', () => ({ hasDurableApprovedReview: vi.fn(async () => true) }));

const dataDir = mkdtempSync(join(tmpdir(), 'o8-automatic-release-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
const roots = [dataDir];
const { closeDb, getSqlite } = await import('@/lib/db');
const { archiveLane, createLane, getLane, listLanes, updateLane } = await import('@/lib/lane/registry');
const { recordLaneEvent } = await import('@/lib/lane/events');
const { recordMission } = await import('@/lib/db/missions-store');
const { upsertGitHubPullRequest } = await import('@/lib/github-broker/store');
const { runWorktreeReaperTick } = await import('@/lib/lane/worktree-reaper');
const { MAINTENANCE_PHASES, readMaintenanceState, writeMaintenanceState } = await import('@/lib/worktree/maintenance-discovery');
const { WORKTREE_MAINTENANCE_POLICY } = await import('@/lib/worktree/maintenance-budget');
const control = await import('@/lib/orchestrator/control-plane');
const { readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
const { createEmptyOrchestratorMissionState, packetReleaseBlockedBy } = await import('@/lib/orchestrator/store');
const { releaseMergedPullRequestPacket } = await import('@/lib/orchestrator/automatic-release');
const { runHeadlessSprintTick } = await import('@/lib/orchestrator/headless-loop');
const { hasDurableApprovedReview } = await import('@/lib/lane/durable-review-approval');
const { runAwaitingReviewAutoReleaseSweep } = await import('@/lib/supervisor/heal-bot-auto-release');
let sequence = 0;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commit(cwd: string, content: string): string {
  writeFileSync(join(cwd, 'app.txt'), `${content}\n`);
  git(cwd, 'add', 'app.txt');
  git(cwd, 'commit', '-qm', 'fixture');
  return git(cwd, 'rev-parse', 'HEAD');
}

function fixture(location: 'current' | 'registry' = 'current') {
  const root = mkdtempSync(join(tmpdir(), 'o8-auto-release-git-'));
  roots.push(root);
  const repoPath = join(root, 'repo'), worktreePath = join(root, 'worktree');
  const number = ++sequence, packetId = `pkt-auto-release-${number}`, branch = `inline/${packetId}`;
  git(root, 'init', '-qb', 'main', repoPath);
  git(repoPath, 'config', 'user.name', 'o8-test');
  git(repoPath, 'config', 'user.email', 'test@example.test');
  git(repoPath, 'remote', 'add', 'origin', `https://github.com/example/release-${number}.git`);
  commit(repoPath, 'base');
  git(repoPath, 'worktree', 'add', '-qb', branch, worktreePath);
  const headSha = commit(worktreePath, 'merged work');
  git(repoPath, 'merge', '--squash', branch);
  git(repoPath, 'commit', '-qm', 'merged fixture');
  const mergeCommit = git(repoPath, 'rev-parse', 'HEAD');
  const lane = createLane({ repoPath, worktreePath, branch, baseBranch: 'main', runtime: 'codex', packetId });
  updateLane(lane.id, { status: 'reviewing', prNumber: number }, 'system');
  const packet: OrchestratorPacket = { id: packetId, referenceLabel: packetId, title: packetId, summary: packetId,
    runtime: 'codex', workspaceTargetPath: repoPath, branchTarget: branch, dependencyLabels: [], dependencyPacketIds: [],
    queueState: 'held', releaseState: 'pending', status: 'awaiting_review', attemptCount: 1,
    lane: { laneId: lane.id, tileId: lane.id, tabId: lane.id, repoPath, worktreePath, runtime: 'codex' },
  };
  const dependent = { ...packet, id: `${packetId}-next`, referenceLabel: `${packetId}-next`, title: 'Dependent work', lane: null,
    status: 'queued' as const, queueState: 'queued' as const, dependencyPacketIds: [packetId] };
  const mission: OrchestratorMissionState = { ...createEmptyOrchestratorMissionState(),
    missionId: `mission-${packetId}`, repoPath, packets: [packet, dependent] };
  const persist = () => {
    control.writeOrchestratorControlPlaneState(location === 'current' ? mission : createEmptyOrchestratorMissionState());
    if (location === 'registry') recordMission({ id: mission.missionId!, repoPath, runtime: 'codex',
      prompt: 'release fixture', summary: 'release fixture', constraints: '', packetMeta: [], totalWaves: 2, missionState: mission });
  };
  persist();
  const read = () => location === 'current' ? control.readOrchestratorControlPlaneState()
    : readMissionRegistryEntry(mission.missionId!, { includeArchived: true })!.mission;
  const pull: GitHubPullRequestSnapshot = { pullRequestId: number, repoFullName: `example/release-${number}`,
    number, title: 'fixture', state: 'closed', author: null, body: '', headRefName: branch, baseRefName: 'main',
    additions: 1, deletions: 0, changedFiles: 1, reviewDecision: null, statusCheckRollup: [], url: 'https://example.test/pr',
    createdAt: '2026-09-10T00:00:00Z', updatedAt: '2026-09-10T00:02:00Z', closedAt: '2026-09-10T00:02:00Z',
    mergedAt: '2026-09-10T00:02:00Z', headSha, mergeCommit };
  upsertGitHubPullRequest(pull);
  return { repoPath, worktreePath, lane: getLane(lane.id)!, packet, mission, pull, persist, read };
}

interface MaintenancePass {
  candidates: number;
  discoveryPages: number;
  readBytes: number;
  admissionMilliseconds: number;
  outcomes: Array<{ phase: string; scope: string; outcome: string }>;
}

function maintenanceProgress(): string {
  return JSON.stringify([readMaintenanceState('next-phase'),
    ...MAINTENANCE_PHASES.map(phase => readMaintenanceState(`cursor:${phase}`))]);
}

/** Reach the exact target through real bounded passes; visitation is not permission to release. */
async function runReaperUntilVisited(laneId: string) {
  const trace: MaintenancePass[] = [];
  for (let passes = 1; passes <= 16; passes += 1) {
    const before = maintenanceProgress();
    await runWorktreeReaperTick();
    const pass = readMaintenanceState<MaintenancePass>('last-pass')!;
    trace.push(pass);
    expect(pass.candidates).toBeLessThanOrEqual(WORKTREE_MAINTENANCE_POLICY.candidates);
    expect(pass.discoveryPages).toBeLessThanOrEqual(WORKTREE_MAINTENANCE_POLICY.candidates + MAINTENANCE_PHASES.length);
    expect(pass.readBytes).toBeLessThanOrEqual(WORKTREE_MAINTENANCE_POLICY.metadataBytes);
    expect(pass.admissionMilliseconds).toBe(WORKTREE_MAINTENANCE_POLICY.admissionMilliseconds);
    const outcome = pass.outcomes.find(outcome => outcome.phase === 'active' && outcome.scope === laneId);
    if (outcome) {
      expect(outcome.outcome, JSON.stringify(trace)).toBe('reconciled');
      return { passes, outcome };
    }
    expect(maintenanceProgress(), `No cursor progress toward ${laneId}: ${JSON.stringify(trace)}`).not.toBe(before);
  }
  throw new Error(`Target ${laneId} not visited within 16 bounded passes: ${JSON.stringify(trace)}`);
}

afterEach(() => {
  vi.restoreAllMocks();
  // Worktree maintenance is bounded per tick (#3439), so an earlier test's lane
  // must not take the slot of the lane the next test proves.
  for (const lane of listLanes()) if (lane.status !== 'archived') archiveLane(lane.id, 'system');
});
afterAll(() => { closeDb(); for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true }); });

describe('automatic PR release through the real reaper and durable missions', () => {
  it.each(['current', 'new-steer'] as const)('pins the approved ancestry auto-release to %s work', async (mode) => {
    const f = fixture();
    git(f.repoPath, 'merge', '--no-ff', '-m', 'fixture merge', f.lane.branch);
    git(f.repoPath, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    updateLane(f.lane.id, { lastEventAt: '2026-01-01T00:00:00Z' }, 'system');
    vi.mocked(hasDurableApprovedReview).mockImplementationOnce(async () => {
      if (mode === 'new-steer') recordLaneEvent(f.lane.id, 'steered_packet', 'user', { message: 'new work' });
      return true;
    });
    await runAwaitingReviewAutoReleaseSweep();
    if (mode === 'new-steer') {
      expect(f.read().packets[0].releaseState).toBe('pending');
      expect(getLane(f.lane.id)?.status).toBe('reviewing');
    } else {
      expect(f.read().packets[0].releaseStatePayload).toMatchObject({
        source: 'heal_bot_auto_release', headSha: f.pull.headSha, mergeCommit: git(f.repoPath, 'rev-parse', 'HEAD'),
      });
    }
  });

  it.each(['current', 'registry'] as const)('releases proved %s work and unblocks its sequential dependent', async (location) => {
    const f = fixture(location);
    expect(packetReleaseBlockedBy(f.mission.packets[1], f.mission.packets)?.id).toBe(f.packet.id);
    await runReaperUntilVisited(f.lane.id);
    await runHeadlessSprintTick();
    const saved = f.read();
    expect(saved.packets[0]).toMatchObject({ releaseState: 'released', releaseStatePayload: {
      source: 'headless_released', evidenceKind: 'pull_request_merged', headSha: f.pull.headSha, mergeCommit: f.pull.mergeCommit,
    } });
    expect(packetReleaseBlockedBy(saved.packets[1], saved.packets)).toBeNull();
    expect(saved.packets[1].blockedReason ?? '').not.toContain('explicitly released');
    expect(getLane(f.lane.id)?.status).toBe('archived');
  });

  it.each(['current', 'registry'] as const)('preserves a newer unmerged commit in a %s mission', async (location) => {
    const f = fixture(location);
    const successor = commit(f.worktreePath, 'unmerged successor');
    await runReaperUntilVisited(f.lane.id);
    expect(f.read().packets[0].releaseState).toBe('pending');
    expect(getLane(f.lane.id)?.status).toBe('reviewing');
    expect(git(f.worktreePath, 'rev-parse', 'HEAD')).toBe(successor);
  });

  it.each(['stop', 'archive', 'missing-proof', 'dirty'] as const)('refuses automatic release for %s', async (reason) => {
    const f = fixture();
    if (reason === 'stop') f.packet.operatorStopped = true;
    if (reason === 'archive') f.packet.archivedAt = new Date().toISOString();
    if (reason === 'missing-proof') upsertGitHubPullRequest({ ...f.pull, headSha: null, mergeCommit: null });
    if (reason === 'dirty') writeFileSync(join(f.worktreePath, 'app.txt'), 'dirty successor');
    f.persist();
    await runReaperUntilVisited(f.lane.id);
    expect(f.read().packets[0].releaseState).toBe('pending');
    expect(getLane(f.lane.id)?.status).toBe('reviewing');
  });

  it.each(['held', 'running'] as const)('refuses automatic release while a live writer owns a %s packet', async (state) => {
    // The fixture packet is operator-held; a held packet reconciles to blocked before its writer is read.
    const f = fixture();
    const sessionKey = 'codex-owned:auto-release-live-writer';
    updateLane(f.lane.id, { sessionKey }, 'system');
    if (state === 'running') f.packet.status = 'running';
    f.persist();
    const { getRuntimeInventorySnapshot } = await import('@/lib/runtime/inventory');
    const inventory = vi.mocked(getRuntimeInventorySnapshot);
    inventory.mockImplementation(async () => ({ ...LIVE_INVENTORY, agents: [{ sessionKey, runtime: 'codex', status: 'running',
      runtimeSurface: { ownership: 'owned', capabilities: { interrupt: true, sendInput: true }, lifecycle: { availability: 'running' } } }] }) as never);
    try {
      await runReaperUntilVisited(f.lane.id);
      expect(f.read().packets[0].releaseState).toBe('pending');
      expect(getLane(f.lane.id)?.status).toBe('reviewing');
    } finally {
      inventory.mockImplementation(async () => LIVE_INVENTORY as never);
    }
  });

  it('refuses automatic release while the runtime inventory is still warming', async () => {
    // A warming snapshot lists no agents, which must not read as "no live writer".
    const f = fixture();
    updateLane(f.lane.id, { sessionKey: 'codex-owned:auto-release-warming' }, 'system');
    f.persist();
    const { getRuntimeInventorySnapshot } = await import('@/lib/runtime/inventory');
    const inventory = vi.mocked(getRuntimeInventorySnapshot);
    inventory.mockImplementation(async () => ({ meta: { mode: 'stale', observablePending: true }, agents: [] }) as never);
    try {
      await runReaperUntilVisited(f.lane.id);
      expect(f.read().packets[0].releaseState).toBe('pending');
      expect(getLane(f.lane.id)?.status).toBe('reviewing');
    } finally {
      inventory.mockImplementation(async () => LIVE_INVENTORY as never);
    }
  });

  it('refuses a delayed release after a new steer enters the same lane', async () => {
    const f = fixture();
    const lockedWrite = vi.spyOn(control, 'withLockedState');
    let releasing!: ReturnType<typeof releaseMergedPullRequestPacket>;
    await control.withControlPlaneLock(async () => {
      releasing = releaseMergedPullRequestPacket(f.lane, f.pull);
      await vi.waitFor(() => expect(lockedWrite).toHaveBeenCalled());
      recordLaneEvent(f.lane.id, 'steered_packet', 'user', { message: 'new work' });
    });
    expect(await releasing).toBe('held');
    expect(f.read().packets[0].releaseState).toBe('pending');
  });

  it('replays an interrupted release behind a retained active-lane backlog', async () => {
    const earlier = fixture();
    for (let i = 0; i <= WORKTREE_MAINTENANCE_POLICY.candidates; i += 1) {
      const lane = createLane({ repoPath: earlier.repoPath, branch: `backlog-${i}`,
        runtime: 'codex', packetId: `pkt-backlog-${i}` });
      updateLane(lane.id, { status: 'running' }, 'system');
    }
    const f = fixture();
    expect(await releaseMergedPullRequestPacket(f.lane, f.pull)).toBe('released');
    writeMaintenanceState('next-phase', 0);
    getSqlite().prepare("DELETE FROM worktree_maintenance_state WHERE key = 'cursor:active'").run();
    await runWorktreeReaperTick();
    const first = readMaintenanceState<MaintenancePass>('last-pass')!;
    expect(first.candidates).toBeLessThanOrEqual(WORKTREE_MAINTENANCE_POLICY.candidates);
    expect(first.outcomes.some(outcome => outcome.phase === 'active' && outcome.scope === f.lane.id)).toBe(false);
    const deferredCursor = readMaintenanceState<{ after: string; upper: string }>('cursor:active')!;
    expect(deferredCursor.after).not.toBe('');
    expect(deferredCursor.after < deferredCursor.upper).toBe(true);
    expect(getLane(f.lane.id)?.status).toBe('reviewing');
    const replay = await runReaperUntilVisited(f.lane.id);
    expect(getLane(f.lane.id)?.status).toBe('archived');
    expect(replay.outcome).toEqual({ phase: 'active', scope: f.lane.id, outcome: 'reconciled' });
    for (const lane of listLanes().filter(lane => lane.packetId?.startsWith('pkt-backlog-'))) {
      expect(lane.status).toBe('running');
    }
    process.stdout.write('[bounded-release-replay] ' + JSON.stringify({ firstPassCandidates: first.candidates,
      firstPassDiscoveryPages: first.discoveryPages, firstPassTargetVisited: false,
      deferredCursorAdvanced: Boolean(deferredCursor.after), replayPasses: replay.passes,
      targetOutcome: replay.outcome.outcome }) + '\n');
    expect(f.read().packets[0].releaseStatePayload?.headSha).toBe(f.pull.headSha);
  });

  it('can finish archiving after release was persisted by an interrupted reaper', async () => {
    const f = fixture();
    expect(await releaseMergedPullRequestPacket(f.lane, f.pull)).toBe('released');
    expect(getLane(f.lane.id)?.status).toBe('reviewing');
    await runReaperUntilVisited(f.lane.id);
    expect(getLane(f.lane.id)?.status).toBe('archived');
    expect(f.read().packets[0].releaseStatePayload?.headSha).toBe(f.pull.headSha);
  });

  it('does not archive when Stop wins the lock after Git proof was captured', async () => {
    const f = fixture();
    const archived = vi.fn();
    let releasing!: ReturnType<typeof releaseMergedPullRequestPacket>;
    await control.withControlPlaneLock(async () => {
      releasing = releaseMergedPullRequestPacket(f.lane, f.pull, archived);
      f.packet.operatorStopped = true;
      f.persist();
    });
    expect(await releasing).toBe('held');
    expect(archived).not.toHaveBeenCalled();
    expect(f.read().packets[0].operatorStopped).toBe(true);
  });
});
