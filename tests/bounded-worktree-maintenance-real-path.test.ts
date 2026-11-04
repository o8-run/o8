import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { resolveTsxProcess } from '@/lib/testing/tsx-process';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'o8-bounded-maintenance-')));
process.env.O8_DATA_DIR = path.join(root, 'data');
process.env.CORTEX_IDE_DATA_DIR = process.env.O8_DATA_DIR;
process.env.O8_WORKTREE_ROOT = path.join(root, 'workspaces');
mkdirSync(process.env.O8_WORKTREE_ROOT);
process.env.CORTEX_IDE_OWNED_CODEX_ROOT = path.join(root, 'sessions');
let live = false;
let replaceOnRead: { target: string; replacement: string } | null = null;
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    if (replaceOnRead?.target === String(args[0])) {
      const read = handle.read;
      Object.defineProperty(handle, 'read', { value: async (...readArgs: unknown[]) => {
        if (replaceOnRead?.target === String(args[0])) {
          renameSync(replaceOnRead.replacement, replaceOnRead.target);
          replaceOnRead = null;
        }
        return Reflect.apply(read, handle, readArgs);
      } });
    }
    return handle;
  } };
});
vi.mock('@/lib/worktree/live-process-guard', async (original) => ({
  ...await original<typeof import('@/lib/worktree/live-process-guard')>(),
  allowWorktreeRemoval: vi.fn(async () => !live),
}));

const { closeDb, getSqlite } = await import('@/lib/db');
const { createLane, getLane } = await import('@/lib/lane/registry');
const { addRepo, findRepoByLocalPath } = await import('@/lib/repos/registry');
const { getWorktreeManager } = await import('@/lib/worktree/launch');
const { withWorktreeMetaTransaction, readWorktreeMetaSnapshot } = await import('@/lib/worktree/metadata-store');
const { runBoundedWorktreeMaintenance } = await import('@/lib/lane/bounded-worktree-maintenance');
const { runWorktreeMaintenanceTick, startWorktreeReaper, stopWorktreeReaper } = await import('@/lib/lane/worktree-reaper');
const { nextMaintenanceCandidate, advanceMaintenanceCandidate, readWorktreeMaintenanceStatus,
  readMaintenanceState, writeMaintenanceState, WORKTREE_LANE_BASENAME_SQL } = await import('@/lib/worktree/maintenance-discovery');
const { resolveWorktreeRootLayout } = await import('@/lib/worktree/root-layout');
const { WORKTREE_MAINTENANCE_POLICY, withWorktreeMaintenanceBudget } = await import('@/lib/worktree/maintenance-budget');
const { captureWorktreeMaterializationIdentity } = await import('@/lib/worktree/materialization-identity');
const { readPinnedWorkspaceFile } = await import('@/lib/worktree/materialization-leaf-io');
const { GET } = await import('@/app/api/orchestrator/workspace/maintenance/route');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
const { resolveRequestPrincipal } = await import('@/lib/auth/principal');
const { createPacketStorageAdmissionCoordinator } = await import('@/lib/orchestrator/storage-admission');
const { readOwnedSessionMetadata } = await import('@/lib/runtimes/shared/owned-session/metadata-read');
const { hasStandaloneWorkspaceLane } = await import('@/lib/lane/workspace-ownership-query');

let sequence = 0;
function git(repo: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function coldRead(mode: 'status' | 'cursor') {
  const receipt = path.join(root, `${mode}-read.json`);
  const command = resolveTsxProcess([path.join(process.cwd(), 'tests/fixtures/bounded-maintenance-child.ts'),
    mode, root, path.join(root, 'unused-entered'), path.join(root, 'unused-release'), receipt]);
  execFileSync(command.file, command.args, { cwd: process.cwd(), timeout: 20_000,
    env: { ...process.env, NODE_OPTIONS: '--conditions=react-server' }, stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(readFileSync(receipt, 'utf8'));
}

async function fixture() {
  const id = `bounded-${++sequence}`;
  const repoPath = path.join(root, id);
  mkdirSync(repoPath);
  git(repoPath, 'init', '-q', '-b', 'main');
  git(repoPath, 'config', 'user.name', 'o8 test');
  git(repoPath, 'config', 'user.email', 'test@o8.local');
  writeFileSync(path.join(repoPath, 'README.md'), 'recoverable\n');
  git(repoPath, 'add', 'README.md');
  git(repoPath, 'commit', '-qm', 'fixture');
  const repo = await addRepo(repoPath);
  const sessionKey = `codex-owned:${id}`;
  const lane = createLane({ repoPath, runtime: 'codex', branch: `inline/${id}`,
    baseBranch: 'main', packetId: id, sessionKey });
  const manager = getWorktreeManager(repoPath);
  const workspace = await manager.create({ agentType: 'codex', taskName: id, packetId: id,
    laneId: lane.id, branchName: lane.branch, baseBranch: 'main', managed: true,
    isolationPreference: 'git-worktree', skipSetup: true });
  await withWorktreeMetaTransaction(repoPath, async (tx) => {
    const entry = (await tx.readAll())[workspace.id]!;
    await tx.save(entry.id, { ...entry, sessionKey });
  });
  const sessionDir = path.join(process.env.CORTEX_IDE_OWNED_CODEX_ROOT!, id);
  mkdirSync(sessionDir, { recursive: true });
  const now = new Date().toISOString();
  const session: OwnedSessionRecord = {
    surfaceId: sessionKey, packetId: id, sessionDir, cwd: workspace.path, repoPath: workspace.path,
    workspaceBinding: { logicalWorkspaceId: `packet:${id}`, repositoryUuid: repo.id,
      packetId: id, cwd: workspace.path, version: 1, verifiedAt: now },
    title: id, createdAt: now, updatedAt: now, latestPrompt: 'fixture', latestSummary: 'fixture',
    recentRuns: [], runIdentityLedger: { version: 1, totalRuns: 0, complete: true },
  };
  writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify(session));
  getSqlite().prepare("UPDATE lanes SET status = 'archived', worktree_path = ? WHERE id = ?")
    .run(workspace.path, lane.id);
  return { repoPath, laneId: lane.id, manager, workspace, session,
    metadataRoot: resolveWorktreeRootLayout(repoPath).primaryBase };
}

afterEach(async () => {
  await runBoundedWorktreeMaintenance(async () => {}, { primaryRepoPath: root, admissionMilliseconds: 1 });
  live = false; replaceOnRead = null; vi.restoreAllMocks(); stopWorktreeReaper();
});
afterAll(() => { closeDb(); rmSync(root, { recursive: true, force: true }); });

describe('bounded automatic worktree reconciliation', () => {
  it('cleans an eligible managed workspace while an oversized root stays visibly held across restart', async () => {
    const held = await fixture();
    await withWorktreeMetaTransaction(held.repoPath, async (tx) => {
      const entry = (await tx.readAll())[held.workspace.id]!;
      await tx.save(entry.id, { ...entry, taskName: 'x'.repeat(WORKTREE_MAINTENANCE_POLICY.rootBytes) });
    });
    const eligible = await fixture();
    const unknown = path.join(eligible.metadataRoot, 'packet-unknown-abcd');
    mkdirSync(unknown); writeFileSync(path.join(unknown, 'unique.txt'), 'keep\n');
    for (let tick = 0; tick < 20 && existsSync(eligible.workspace.path); tick += 1) {
      await runWorktreeMaintenanceTick(eligible.repoPath);
    }
    expect(existsSync(eligible.workspace.path)).toBe(false);
    expect(getLane(eligible.laneId)?.worktreePath).toBeNull();
    expect(existsSync(held.workspace.path)).toBe(true);
    expect(readFileSync(path.join(unknown, 'unique.txt'), 'utf8')).toBe('keep\n');
    expect(readWorktreeMaintenanceStatus().holds).toEqual(expect.arrayContaining([
      expect.objectContaining({ metadataRoot: held.metadataRoot, reason: expect.stringContaining('exceeds') }),
    ]));
    expect(coldRead('status').holds).toEqual(expect.arrayContaining([
      expect.objectContaining({ metadataRoot: held.metadataRoot, reason: expect.stringContaining('exceeds') }),
    ]));
    const pass = readMaintenanceState<{ readBytes: number; candidates: number; discoveryPages: number }>('last-pass')!;
    expect(pass.readBytes).toBeLessThanOrEqual(WORKTREE_MAINTENANCE_POLICY.metadataBytes);
    expect(pass.candidates).toBeLessThanOrEqual(WORKTREE_MAINTENANCE_POLICY.candidates);
    expect(pass.discoveryPages).toBeLessThanOrEqual(WORKTREE_MAINTENANCE_POLICY.candidates + 7);
  }, 120_000);

  it('bounds actual SQL metadata reads before parsing an oversized blob', async () => {
    const held = await fixture();
    const original = getSqlite().prepare('SELECT payload_json FROM worktree_metadata_state WHERE metadata_root = ?')
      .get(held.metadataRoot) as { payload_json: string };
    getSqlite().prepare('UPDATE worktree_metadata_state SET payload_json = ? WHERE metadata_root = ?')
      .run(' '.repeat(1_000_000) + original.payload_json, held.metadataRoot);
    const budget = { readBytes: 0, remainingBytes: 64, rootBytes: 64, rootEntries: 1 };
    await expect(withWorktreeMaintenanceBudget(budget, () => readWorktreeMetaSnapshot(held.repoPath)))
      .rejects.toThrow('exceeds the read allowance');
    expect(budget.readBytes).toBe(0);
    getSqlite().prepare('UPDATE worktree_metadata_state SET payload_json = ? WHERE metadata_root = ?')
      .run(original.payload_json, held.metadataRoot);
  }, 60_000);

  it('persists fair keyset cursors across restart and wraps a finite cycle', async () => {
    const sqlite = getSqlite();
    sqlite.prepare("DELETE FROM worktree_maintenance_state WHERE key = 'cursor:terminal'").run();
    const ids: string[] = [];
    for (let n = 0; n < 45; n += 1) {
      const lane = createLane({ repoPath: root, runtime: 'codex', branch: `cursor/${n}` });
      sqlite.prepare("UPDATE lanes SET status = 'archived', created_at = ? WHERE id = ?")
        .run(`9999-01-01T00:00:${String(n).padStart(2, '0')}.000Z`, lane.id);
      ids.push(lane.id);
    }
    const seen = new Set<string>();
    let lastKey = '';
    for (let n = 0; n < 100; n += 1) {
      const row = nextMaintenanceCandidate('terminal');
      if (!row) break;
      expect(row.key > lastKey).toBe(true);
      lastKey = row.key; seen.add(row.id!);
      advanceMaintenanceCandidate('terminal', row.key);
      if (n === 19) expect(coldRead('cursor').after).toBe(row.key);
    }
    expect(ids.every((id) => seen.has(id))).toBe(true);
    expect(nextMaintenanceCandidate('terminal')).not.toBeNull();
    const plan = getSqlite().prepare(`EXPLAIN QUERY PLAN SELECT id FROM lanes INDEXED BY idx_maintenance_terminal_lanes
      WHERE status IN ('completed', 'archived') AND (created_at, id) > (?, ?)
      ORDER BY created_at, id LIMIT 1`).all('', '') as Array<{ detail: string }>;
    expect(plan.some((row) => row.detail.includes('idx_maintenance_terminal_lanes'))).toBe(true);
  });

  it('refuses a detached session ledger after atomic replacement during the actual bounded read', async () => {
    const target = path.join(root, 'atomic-session.json');
    const replacement = `${target}.replacement`;
    writeFileSync(target, JSON.stringify({ runIdentityLedger: { complete: true }, activeRun: null }));
    writeFileSync(replacement, JSON.stringify({ runIdentityLedger: { complete: false }, activeRun: { pid: 123 } }));
    replaceOnRead = { target, replacement };
    const budget = { readBytes: 0, remainingBytes: 1_000, rootBytes: 1_000, rootEntries: 1 };
    await expect(withWorktreeMaintenanceBudget(budget, () => readOwnedSessionMetadata(target)))
      .rejects.toThrow('metadata changed during the read');
    expect(replaceOnRead).toBeNull();
    expect(budget.readBytes).toBe(0);
    expect(await readOwnedSessionMetadata(target)).toEqual({
      runIdentityLedger: { complete: false }, activeRun: { pid: 123 },
    });
  });

  it('indexes matching standalone owners, refuses foreign exact paths and retains matching-owner overflow', async () => {
    const source = await fixture();
    const standalone = await source.manager.create({ agentType: 'codex', taskName: `standalone-${++sequence}`,
      branchName: `inline/standalone-${sequence}`, baseBranch: 'main', managed: true,
      isolationPreference: 'git-worktree', skipSetup: true });
    const sqlite = getSqlite();
    for (let n = 0; n < 100; n += 1) {
      createLane({ repoPath: source.repoPath, runtime: 'codex', branch: `unrelated/${n}`,
        ...(n < 34 ? { worktreePath: path.join(root, `unrelated-${n}`) } : {}) });
    }
    const owned = () => hasStandaloneWorkspaceLane(source.repoPath, standalone.path, standalone.id);
    expect(owned()).toBe(false);
    const plan = sqlite.prepare(`EXPLAIN QUERY PLAN SELECT id FROM lanes INDEXED BY idx_maintenance_lane_basename
      WHERE ${WORKTREE_LANE_BASENAME_SQL} IN (?, ?, ?, '.', '..') AND worktree_path IS NOT NULL LIMIT ?`)
      .all(standalone.id, standalone.id, standalone.id, 33) as Array<{ detail: string }>;
    expect(plan.some((row) => /SEARCH.*idx_maintenance_lane_basename.*<expr>=\?/.test(row.detail))).toBe(true);
    expect(plan.some((row) => /SCAN/.test(row.detail))).toBe(false);
    const foreign = createLane({ repoPath: path.join(root, 'foreign-repo'), runtime: 'codex',
      branch: 'foreign', worktreePath: standalone.path });
    expect(owned()).toBe(true);
    expect(await source.manager.cleanup(standalone.id, { force: true })).toBe(false);
    expect(readFileSync(path.join(standalone.path, 'README.md'), 'utf8')).toBe('recoverable\n');
    sqlite.prepare('UPDATE lanes SET worktree_path = NULL WHERE id = ?').run(foreign.id);
    expect(owned()).toBe(false);
    const matches: string[] = [];
    for (let n = 0; n < 33; n += 1) {
      const lane = createLane({ repoPath: source.repoPath, runtime: 'codex', branch: `matching/${n}`,
        worktreePath: path.join(root, `old-namespace-${n}`, standalone.id) + (n === 0 ? path.sep : '') });
      matches.push(lane.id);
      if (n === 0) {
        expect(owned()).toBe(true);
        expect(await source.manager.cleanup(standalone.id, { force: true })).toBe(false);
      }
    }
    expect(owned).toThrow('bounded owner policy');
    expect(await source.manager.cleanup(standalone.id, { force: true })).toBe(false);
    expect(existsSync(standalone.path)).toBe(true);
    for (const id of matches) sqlite.prepare('UPDATE lanes SET worktree_path = NULL WHERE id = ?').run(id);
    expect(owned()).toBe(false);
    expect(await source.manager.cleanup(standalone.id, { force: true })).toBe(true);
    expect(existsSync(standalone.path)).toBe(false);
  }, 120_000);

  it.each(['foreign-trailing-separator', 'foreign-dot-component', 'repository-alias'])(
    'refuses standalone cleanup for normalized ownership: %s', async (variant) => {
      const source = await fixture();
      const standalone = await source.manager.create({ agentType: 'codex', taskName: `normalized-${++sequence}`,
        branchName: `inline/normalized-${sequence}`, baseBranch: 'main', managed: true,
        isolationPreference: 'git-worktree', skipSetup: true });
      const alias = path.join(root, `repo-alias-${sequence}`);
      symlinkSync(source.repoPath, alias, 'dir');
      createLane({ repoPath: variant === 'repository-alias' ? alias : path.join(root, 'foreign-repo'),
        runtime: 'codex', branch: `normalized/${variant}`,
        worktreePath: variant === 'repository-alias' ? path.join(root, 'old-namespace', standalone.id)
          : standalone.path + path.sep + (variant === 'foreign-dot-component' ? '.' : '') });
      expect(await source.manager.cleanup(standalone.id, { force: true })).toBe(false);
      expect(readFileSync(path.join(standalone.path, 'README.md'), 'utf8')).toBe('recoverable\n');
    }, 90_000,
  );

  it('holds single-flight exclusion until a slow admitted action settles', async () => {
    const lane = createLane({ repoPath: root, runtime: 'codex', branch: 'slow' });
    writeMaintenanceState('next-phase', 0);
    getSqlite().prepare("DELETE FROM worktree_maintenance_state WHERE key = 'cursor:active'").run();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const action = vi.fn(async () => wait);
    const first = runBoundedWorktreeMaintenance(action, { primaryRepoPath: root, maxCandidates: 1, admissionMilliseconds: 5_000 });
    await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const second = runBoundedWorktreeMaintenance(action, { primaryRepoPath: root });
    expect(second).toBe(first);
    expect(getLane(lane.id)?.status).toBe('idle');
    release(); await first; await second;
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('cancels both startup and periodic timers on stop', async () => {
    vi.useFakeTimers();
    startWorktreeReaper();
    expect(vi.getTimerCount()).toBe(2);
    stopWorktreeReaper();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('refuses FIFO registry and metadata descriptors without blocking or using a cached authority', async () => {
    const registry = path.join(process.env.O8_DATA_DIR!, 'repos.json');
    await findRepoByLocalPath(root); // Prime the interactive cache before replacing the authority.
    const saved = `${registry}.saved`;
    renameSync(registry, saved);
    const budget = () => ({ readBytes: 0, remainingBytes: 1_000_000, rootBytes: 256_000, rootEntries: 256 });
    try {
      execFileSync('mkfifo', [registry]);
      await expect(withWorktreeMaintenanceBudget(budget(), () => findRepoByLocalPath(root)))
        .rejects.toThrow('regular-file');
      rmSync(registry);
      writeFileSync(registry, ' '.repeat(300_000));
      await expect(withWorktreeMaintenanceBudget(budget(), () => findRepoByLocalPath(root)))
        .rejects.toThrow('read allowance');
    } finally { rmSync(registry, { force: true }); renameSync(saved, registry); }
    const repo = path.join(root, 'fifo-repo');
    mkdirSync(repo);
    const base = resolveWorktreeRootLayout(repo).primaryBase;
    mkdirSync(base, { recursive: true });
    execFileSync('mkfifo', [path.join(base, '.meta.json')]);
    const identity = await captureWorktreeMaterializationIdentity(base);
    const started = Date.now();
    await expect(withWorktreeMaintenanceBudget(budget(), () => readWorktreeMetaSnapshot(repo)))
      .rejects.toThrow('regular file');
    await expect(withWorktreeMaintenanceBudget(budget(), () => readPinnedWorkspaceFile(base, identity, '.meta.json')))
      .rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 20_000);

  // The collision id takes a random four-character suffix, so its metadata key
  // can sort before or after the original's. Pin each order once.
  it.each([
    { order: 'before', random: 0.1 }, // suffix "3lll" sorts below the original's "index" leaf
    { order: 'after', random: 0.9 }, // suffix "wwww" sorts above it
  ])('recovers an exact collision slot after a terminal lane loses its public path (collision sorts $order)', async ({ order, random }) => {
    const source = await fixture();
    const second = createLane({ repoPath: source.repoPath, runtime: 'codex', branch: 'inline/collision',
      packetId: source.session.packetId, sessionKey: `codex-owned:collision-new-${order}` });
    const admission = createPacketStorageAdmissionCoordinator();
    const lease = await admission.reserveForLaunch({ id: source.session.packetId!,
      workspaceTargetPath: source.repoPath, storageAdmissionEpoch: 2, launchAttempts: 0 } as OrchestratorPacket);
    const pinned = vi.spyOn(Math, 'random').mockReturnValue(random);
    const collision = await source.manager.create({ agentType: 'codex', taskName: 'collision',
      packetId: source.session.packetId, laneId: second.id, branchName: second.branch,
      storageAdmissionReservationId: lease.reservation.reservationId,
      baseBranch: 'main', managed: true, isolationPreference: 'git-worktree', skipSetup: true })
      .finally(() => pinned.mockRestore());
    await admission.commitAfterLaunch(lease);
    expect(collision.path).not.toBe(source.workspace.path);
    const sessionDir = path.join(process.env.CORTEX_IDE_OWNED_CODEX_ROOT!, `collision-new-${order}`);
    mkdirSync(sessionDir);
    const session = { ...source.session, surfaceId: second.sessionKey!, sessionDir, cwd: collision.path,
      repoPath: collision.path, workspaceBinding: { ...source.session.workspaceBinding!, cwd: collision.path } };
    writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify(session));
    await withWorktreeMetaTransaction(source.repoPath, async (tx) => {
      const entry = (await tx.readAll())[collision.id]!;
      await tx.save(entry.id, { ...entry, sessionKey: second.sessionKey! });
    });
    getSqlite().prepare("UPDATE lanes SET status = 'idle' WHERE id = ?").run(source.laneId);
    getSqlite().prepare("UPDATE lanes SET status = 'archived', worktree_path = NULL WHERE id = ?").run(second.id);
    expect(coldRead('status').schema).toBe('o8/worktree-maintenance/v1');
    // Bound the metadata cursor so the collision is the next candidate in either
    // order: start after the original when it sorts first, otherwise at the root.
    const originalKey = `${source.metadataRoot}\0${source.workspace.id}`;
    const collisionKey = `${source.metadataRoot}\0${collision.id}`;
    expect(collisionKey < originalKey).toBe(order === 'before');
    const cursor = { after: originalKey < collisionKey ? originalKey : `${source.metadataRoot}\0`, upper: collisionKey };
    writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify({ ...session,
      workspaceBinding: { ...session.workspaceBinding, cwd: source.workspace.path, version: 2 } }));
    writeMaintenanceState('next-phase', 3);
    writeMaintenanceState('cursor:metadata', cursor);
    expect(nextMaintenanceCandidate('metadata')?.worktreeId).toBe(collision.id);
    const refused = await runBoundedWorktreeMaintenance(async () => {}, { primaryRepoPath: source.repoPath, maxCandidates: 1 });
    expect(refused.removed).toBe(0);
    expect(existsSync(collision.path)).toBe(true);
    writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify(session));
    writeMaintenanceState('next-phase', 3);
    writeMaintenanceState('cursor:metadata', cursor);
    await runBoundedWorktreeMaintenance(async () => {}, { primaryRepoPath: source.repoPath, maxCandidates: 1 });
    expect(existsSync(collision.path)).toBe(false);
    expect(existsSync(source.workspace.path)).toBe(true);
    expect(getLane(source.laneId)?.worktreePath).toBe(source.workspace.path);
  }, 120_000);

  it('holds an old metadata generation when its durable lane now points elsewhere', async () => {
    const source = await fixture();
    const replacement = path.join(root, 'replacement');
    mkdirSync(replacement); writeFileSync(path.join(replacement, 'keep.txt'), 'new generation');
    getSqlite().prepare('UPDATE lanes SET worktree_path = ? WHERE id = ?').run(replacement, source.laneId);
    writeMaintenanceState('next-phase', 3);
    writeMaintenanceState('cursor:metadata', { after: `${source.metadataRoot}\0`, upper: `${source.metadataRoot}\0${source.workspace.id}` });
    const result = await runBoundedWorktreeMaintenance(async () => {}, { primaryRepoPath: source.repoPath, maxCandidates: 1 });
    expect(result.outcomes[0]?.outcome).toContain('another generation');
    expect(existsSync(source.workspace.path)).toBe(true);
    expect(readFileSync(path.join(replacement, 'keep.txt'), 'utf8')).toBe('new generation');
  }, 60_000);

  it('replays an exact renamed retirement claim after a cold read while the public name is absent', async () => {
    const source = await fixture();
    const { prepareWorkspaceMaterializationRetirement } = await import('@/lib/workspace/workspace-materialization-retirement');
    const { retireExactManagedDirectory } = await import('@/lib/workspace/exact-managed-directory-retirement');
    const { readExactWorkspaceClaim } = await import('@/lib/workspace/exact-workspace-claim-state');
    const entry = (await readWorktreeMetaSnapshot(source.repoPath))[source.workspace.id]!;
    await prepareWorkspaceMaterializationRetirement(source.repoPath, source.workspace.path, 'cleanup');
    await expect(retireExactManagedDirectory({ repositoryPath: source.repoPath, worktreeId: source.workspace.id,
      directoryPath: source.workspace.path, identity: entry.materializationIdentity!,
      parentIdentity: entry.materializationParentIdentity!,
      afterRetirementRename: async () => { throw new Error('Interrupted after owned rename'); },
    })).rejects.toThrow('Interrupted after owned rename');
    const claim = readExactWorkspaceClaim('managed-retirement', source.repoPath, source.workspace.id)!;
    expect(existsSync(source.workspace.path)).toBe(false);
    expect(existsSync(claim.claimPath)).toBe(true);
    expect(coldRead('status').schema).toBe('o8/worktree-maintenance/v1');
    writeMaintenanceState('next-phase', 4);
    getSqlite().prepare("DELETE FROM worktree_maintenance_state WHERE key = 'cursor:claims'").run();
    for (let n = 0; n < 5 && readExactWorkspaceClaim('managed-retirement', source.repoPath, source.workspace.id); n += 1) {
      await runBoundedWorktreeMaintenance(async () => {}, { primaryRepoPath: source.repoPath });
    }
    expect(existsSync(claim.claimPath)).toBe(false);
    expect(readExactWorkspaceClaim('managed-retirement', source.repoPath, source.workspace.id)).toBeNull();
  }, 120_000);

  it('excludes a second process through the first admitted action settlement', async () => {
    createLane({ repoPath: root, runtime: 'codex', branch: 'cross-process' });
    writeMaintenanceState('next-phase', 0);
    getSqlite().prepare("DELETE FROM worktree_maintenance_state WHERE key = 'cursor:active'").run();
    const release = path.join(root, 'release');
    const entered = path.join(root, 'entered');
    const firstReceipt = path.join(root, 'first.json');
    const secondReceipt = path.join(root, 'second.json');
    const start = (mode: string, signal: string, receipt: string) => {
      const command = resolveTsxProcess([path.join(process.cwd(), 'tests/fixtures/bounded-maintenance-child.ts'),
        mode, root, signal, release, receipt]);
      const child = spawn(command.file, command.args, { cwd: process.cwd(),
        env: { ...process.env, NODE_OPTIONS: '--conditions=react-server' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (bytes) => { output += bytes; });
      child.stderr.on('data', (bytes) => { output += bytes; });
      const settled = new Promise<void>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Child ${code}: ${output}`)));
      });
      void settled.catch(() => {}); // Observe early startup failures while waiting for the entry signal.
      return { child, settled };
    };
    const first = start('wait', entered, firstReceipt);
    let second: ReturnType<typeof start> | undefined;
    try {
      await vi.waitFor(() => expect(existsSync(entered)).toBe(true), { timeout: 15_000 });
      second = start('fast', `${entered}-second`, secondReceipt);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(existsSync(secondReceipt)).toBe(false);
      writeFileSync(release, 'settle');
      await first.settled; await second.settled;
      const a = JSON.parse(readFileSync(firstReceipt, 'utf8'));
      const b = JSON.parse(readFileSync(secondReceipt, 'utf8'));
      expect(a.pid).not.toBe(b.pid);
      expect(Date.parse(b.result.startedAt)).toBeGreaterThanOrEqual(Date.parse(a.result.finishedAt));
      expect(getSqlite().prepare('SELECT 1 FROM worktree_metadata_leases WHERE metadata_root = ?')
        .get(path.join(process.env.O8_DATA_DIR!, 'worktree-maintenance-lock'))).toBeUndefined();
    } finally {
      writeFileSync(release, 'settle');
      await Promise.allSettled([first.settled, ...(second ? [second.settled] : [])]);
    }
  }, 45_000);

  it('serves bounded private status to an operator and refuses anonymous and persisted worker callers', async () => {
    const route = 'http://localhost/api/orchestrator/workspace/maintenance';
    const operator = getOrCreateWsToken();
    for (let n = 0; n < 60; n += 1) getSqlite().prepare(`INSERT OR REPLACE INTO worktree_maintenance_roots
      (metadata_root, repository_path, held_reason, checked_at) VALUES (?, ?, 'private hold', 1)`)
      .run(path.join(root, `auth-${String(n).padStart(2, '0')}`), root);
    const heldCount = (getSqlite().prepare('SELECT COUNT(*) AS count FROM worktree_maintenance_roots WHERE held_reason IS NOT NULL')
      .get() as { count: number }).count;
    const worker = mintPacketWorkerToken('maintenance-worker');
    closeDb();
    const workerRequest = new NextRequest(route, { headers: { host: 'localhost', authorization: `Bearer ${worker}` } });
    expect(resolveRequestPrincipal(workerRequest)).toBe('worker');
    for (const request of [new NextRequest(route, { headers: { host: 'localhost' } }), workerRequest]) {
      const response = await GET(request);
      expect(response.status).toBe(403);
      expect(JSON.stringify(await response.json())).not.toMatch(/private hold|auth-00|metadataRoot|lastPass/);
    }
    const response = await GET(new NextRequest(route, { headers: { authorization: `Bearer ${operator}` } }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result.holds).toHaveLength(50);
    expect(body.result.policy.candidates).toBe(20);
    const next = await GET(new NextRequest(`${route}?after=${encodeURIComponent(body.result.holds.at(-1).metadataRoot)}`,
      { headers: { authorization: `Bearer ${operator}` } }));
    expect((await next.json()).result.holds).toHaveLength(Math.min(50, heldCount - 50));
    expect((await GET(new NextRequest(`${route}?after=${'x'.repeat(4_097)}`,
      { headers: { authorization: `Bearer ${operator}` } }))).status).toBe(400);
    expect((await GET(new NextRequest('http://example.invalid/api/orchestrator/workspace/maintenance',
      { headers: { host: 'example.invalid' } }))).status).toBe(401);
  });
});
