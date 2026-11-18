import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RepoSetupConfig } from '@/lib/repos/types';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const state = vi.hoisted(() => ({
  recipeKey: '', base: '', cloneReady: true, setupEnabled: true, nativeRuns: 0,
  metadataBytes: 4096, estimateCalls: 0, lastRequiredCloneKey: undefined as string | undefined,
}));
const COMMAND = 'npm ci --ignore-scripts';
vi.mock('@/lib/worktree/warm-packet-budget', async original => ({
  ...await original<typeof import('@/lib/worktree/warm-packet-budget')>(),
  assertWarmFilesystemBudget: async () => {}, assertWarmPacketSlot: () => {}, markWarmPacketMaterializationStarted: () => {},
}));
vi.mock('@/lib/worktree/live-process-guard', async original => ({
  ...await original<typeof import('@/lib/worktree/live-process-guard')>(), allowWorktreeRemoval: async () => true,
}));
vi.mock('@/lib/analytics/server', () => ({ emitProductEvent: vi.fn() }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn() }));
vi.mock('@/lib/workspace/dependency-manager-executable', () => ({
  resolvePackageManagerExecution: async () => ({ executable: 'npm', version: '11.8.0' }),
  resolveReceiptedPackageManagerExecution: async () => ({ executable: 'npm', version: '11.8.0' }),
}));
vi.mock('@/lib/workspace/dependency-install-process', () => ({
  dependencyInstallProcessesStopped: () => true,
  execDependencyInstallProcess: async () => { state.nativeRuns += 1; throw new Error('Fixture prohibits native installs'); },
}));
vi.mock('@/lib/workspace/dependency-directory-clone', async original => ({
  ...await original<typeof import('@/lib/workspace/dependency-directory-clone')>(),
  tryCloneDependencyDirectory: async ({ sourceWorkspace, workspace, options }: { sourceWorkspace: string; workspace: string; options: { requiredCloneRecipeKey?: string } }) => {
    state.lastRequiredCloneKey = options.requiredCloneRecipeKey;
    if (!state.cloneReady) return false;
    cpSync(path.join(sourceWorkspace, 'node_modules'), path.join(workspace, 'node_modules'), { recursive: true });
    return true;
  },
}));
vi.mock('@/lib/orchestrator/storage-dependency-reuse', () => ({
  observeDependencyReuse: async () => state.cloneReady ? {
    recipeKey: state.recipeKey, metadataBytes: state.metadataBytes, nativeWriteBytes: 0, entries: 1,
  } : null,
}));
vi.mock('@/lib/orchestrator/storage-estimate', async original => ({
  ...await original<typeof import('@/lib/orchestrator/storage-estimate')>(),
  observeRepoStorageEstimate: async (_repo: string, dependencies?: { creationBaseCommit?: string; readSetup?: () => Promise<RepoSetupConfig | null>; observeReuse?: unknown }) => {
    state.estimateCalls += 1;
    const enabled = dependencies?.readSetup ? (await dependencies.readSetup())?.installOnCreateWorkspace ?? true : state.setupEnabled;
    const discounted = enabled && dependencies?.creationBaseCommit && !dependencies.observeReuse;
    return { status: 'observed', source: discounted ? 'apfs-clone-growth' : 'source-size-fallback',
      exactBytes: enabled ? (discounted ? 80 : 160) * 1024 ** 2 : 1024, historySamples: 0, workspacePaths: [], error: null,
      ...(discounted ? { dependencyCloneContract: { creationBaseCommit: state.base, recipeKey: state.recipeKey,
        installCommand: 'npm ci --ignore-scripts', dependencyBytes: 4096 } } : {}),
    };
  },
}));
vi.mock('@/lib/worktree/storage-telemetry', async original => ({
  ...await original<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: async () => ({ accountingStatus: 'observed', probePath: '/',
    availableBytes: 90_000_000_000, freeBytes: 90_000_000_000, totalBytes: 100_000_000_000, error: null }),
}));

const roots: string[] = [];
let repo: string;
let base: string;
function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function setup(enabled = true): RepoSetupConfig {
  return { envMode: 'skip', envFiles: [], installCommand: COMMAND, installOnCreateWorkspace: enabled,
    buildCommand: null, runBuildOnCreateWorkspace: false, devCommand: null, defaultPort: null, workspaceIsolationPreference: 'git-worktree' };
}
beforeEach(async () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'o8-clone-admission-')));
  roots.push(root);
  repo = path.join(root, 'repo'); mkdirSync(repo);
  vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 7).toString('base64url'));
  vi.stubEnv('O8_WORKTREE_ROOT', path.join(root, 'worktrees'));
  vi.stubEnv('O8_SKIP_PRELAUNCH_TYPECHECK', '1');
  vi.stubEnv('O8_APFS_COW_WORKSPACES', '0');
  vi.stubEnv('O8_APFS_DEPENDENCY_IMAGES', '0');
  writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'clone-fixture', version: '1.0.0', packageManager: 'npm@11.8.0' }));
  writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'clone-fixture', version: '1.0.0' } } }));
  git('init', '-q', '-b', 'main'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
  git('remote', 'add', 'origin', repo); git('fetch', '-q', 'origin', 'main');
  base = git('rev-parse', 'HEAD');
  const { deriveDependencyInstallRecipeAtCommit } = await import('@/lib/workspace/dependency-install');
  state.recipeKey = (await deriveDependencyInstallRecipeAtCommit(repo, base, COMMAND)).key;
  Object.assign(state, { base, cloneReady: true, setupEnabled: true, nativeRuns: 0, metadataBytes: 4096, estimateCalls: 0, lastRequiredCloneKey: undefined });
  mkdirSync(path.join(repo, 'node_modules/fixture'), { recursive: true });
  writeFileSync(path.join(repo, 'node_modules/fixture/package.json'), '{"name":"fixture","version":"1.0.0"}');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

async function reserve(id: string, pinned = true) {
  const { createLane } = await import('@/lib/lane/registry');
  const lane = createLane({ repoPath: repo, branch: `packet/${id}`, baseBranch: 'main', runtime: 'codex', packetId: id,
    ...(pinned ? { baseCommit: base } : {}) });
  const { getPacketStorageAdmissionCoordinator } = await import('@/lib/orchestrator/storage-admission');
  const packet = { id, workspaceTargetPath: repo, storageAdmissionEpoch: 1, launchAttempts: 0 } as OrchestratorPacket;
  const lease = await getPacketStorageAdmissionCoordinator().reserveForLaunch(packet, 0, { creationBaseCommit: base });
  return { lane, lease };
}

it('persists clone-only authority and uses it through the real manager after setup changes', async () => {
  const { lane, lease } = await reserve('clone-persisted');
  const { getSqlite } = await import('@/lib/db');
  const row = getSqlite().prepare("SELECT result_json FROM storage_admission_mutations WHERE reservation_id = ? AND operation = 'reserve'").get(lease.reservation.reservationId) as { result_json: string };
  expect(JSON.parse(row.result_json).dependencyCloneContract).toMatchObject({ creationBaseCommit: base, recipeKey: state.recipeKey, installCommand: COMMAND });
  state.setupEnabled = false; // Registry no longer advertises the original dependency requirement.
  const { WorktreeManager } = await import('@/lib/worktree/manager');
  const info = await new WorktreeManager(repo).create({ agentType: 'codex', taskName: 'clone persisted', managed: true,
    baseBranch: 'main', packetId: 'clone-persisted', laneId: lane.id, repoSetup: setup(),
    storageAdmissionReservationId: lease.reservation.reservationId });
  expect(info.dependencyMaterialization).toMatchObject({ source: 'directory-clone', recipeKey: state.recipeKey });
  expect(existsSync(path.join(info.path, 'node_modules/fixture/package.json'))).toBe(true);
  expect(state.estimateCalls).toBe(1);
  expect(state.nativeRuns).toBe(0);
  expect(state.lastRequiredCloneKey).toBe(state.recipeKey);
});

it.each(['donor-disappears', 'missing-pinned-base', 'setup-disabled', 'setup-command-changed', 'metadata-growth'] as const)(
  'holds a persisted discounted reservation when %s without a native install', async reason => {
    const id = `clone-${reason}`;
    const { lane, lease } = await reserve(id, reason !== 'missing-pinned-base');
    state.setupEnabled = false;
    if (reason === 'donor-disappears') state.cloneReady = false;
    if (reason === 'metadata-growth') state.metadataBytes = 8192;
    const requestSetup = setup(reason !== 'setup-disabled');
    if (reason === 'setup-command-changed') requestSetup.installCommand = 'npm ci';
    const { WorktreeManager } = await import('@/lib/worktree/manager');
    await expect(new WorktreeManager(repo).create({ agentType: 'codex', taskName: id, managed: true,
      baseBranch: 'main', packetId: id, laneId: lane.id, repoSetup: requestSetup,
      storageAdmissionReservationId: lease.reservation.reservationId })).rejects.toThrow(/clone|creation|reuse|admission/i);
    expect(state.nativeRuns).toBe(0);
    const { StorageAdmissionStore } = await import('@/lib/workspace/storage-admission');
    const { getSqlite } = await import('@/lib/db');
    expect(new StorageAdmissionStore(getSqlite()).getReservation(lease.reservation.reservationId)?.state).toBe('reserved');
    expect(readFileSync(path.join(repo, 'package.json'), 'utf8')).toContain('clone-fixture');
  },
);


it.each(['snapshot', 'auto-detected'] as const)('refuses an unmarked small reservation with %s setup instead of granting new clone authority', async mode => {
  const id = `clone-no-original-authority-${mode}`;
  const { lane, lease } = await reserve(id);
  const { StorageAdmissionStore } = await import('@/lib/workspace/storage-admission');
  const { getSqlite } = await import('@/lib/db');
  const unmarked = await new StorageAdmissionStore(getSqlite()).reserve({ mutationId: `${id}:reserve`,
    reservationId: `${id}:reservation`, targetPath: lease.reservation.targetPath, rootIdentity: lease.reservation.rootIdentity,
    exactBytes: lease.reservation.exactBytes, ownerId: id, ownerGeneration: 2, leaseExpiresAt: Date.now() + 60000 });
  expect(unmarked.decision).toBe('reserved');
  state.setupEnabled = false;
  state.cloneReady = false;
  const { WorktreeManager } = await import('@/lib/worktree/manager');
  await expect(new WorktreeManager(repo).create({ agentType: 'codex', taskName: id, managed: true,
    baseBranch: 'main', packetId: id, laneId: lane.id, ...(mode === 'snapshot' ? { repoSetup: setup() } : {}),
    storageAdmissionReservationId: unmarked.reservation!.reservationId })).rejects.toThrow(/growth changed/);
  expect(state.nativeRuns).toBe(0);
});


it('retains pinned clone-only admission through the separate warm dependency preparation step', async () => {
  const admission = await import('@/lib/worktree/launch-storage-admission');
  const enter = vi.spyOn(admission, 'withManagedWorktreeStorageAdmission');
  const { WorktreeManager } = await import('@/lib/worktree/manager');
  const result = await new WorktreeManager(repo).prepareWarmWorktree({ agentType: 'codex', taskName: 'warm-clone',
    warmBaseCommit: base, warmReservationToken: 'fixture-slot', baseBranch: 'main', repoSetup: setup() }, () => {});
  expect(enter.mock.calls.some(([input]) => input.backgroundSetup && input.creationBaseCommit === base)).toBe(true);
  expect(result.worktree.dependencyMaterialization).toMatchObject({ source: 'directory-clone', recipeKey: state.recipeKey });
  expect(state.lastRequiredCloneKey).toBe(state.recipeKey);
  expect(state.estimateCalls).toBe(2);
  expect(state.nativeRuns).toBe(0);
});
