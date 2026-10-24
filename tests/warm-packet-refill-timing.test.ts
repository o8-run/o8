import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Timing policy only. The real manager/HTTP/process paths run in the adjacent
// resource-owning tests; this fixture must never create a checkout or installer.
const fixture = vi.hoisted(() => ({
  setup: { installOnCreateWorkspace: true, installCommand: 'npm ci --offline' },
  create: vi.fn(async () => { throw new Error('Fixture admission refusal'); }),
}));
vi.mock('@/lib/lane/registry', () => ({ appendEvent: vi.fn() }));
vi.mock('@/lib/lane/pre-run-cancellation', () => ({ withoutPreRunAdmission: (fn: () => unknown) => fn() }));
vi.mock('@/lib/lane/creation-base', () => ({ readPinnedLaneCreationBaseCommit: vi.fn() }));
vi.mock('@/lib/repos/registry', () => ({ listReposFresh: async () => [{ localPath: '/fixture', setup: fixture.setup }] }));
vi.mock('@/lib/worktree/metadata-store', () => ({ readWorktreeMetaSnapshot: async () => ({}) }));
vi.mock('@/lib/worktree/materialization-identity', () => ({ captureWorktreeMaterializationIdentity: async () => ({ canonicalPath: '/fixture' }) }));
vi.mock('@/lib/worktree/materialization-execution', () => ({
  withWorktreeMaterializationExecution: (_p: string, _i: unknown, fn: () => unknown) => fn(),
  materializationAwareExecFile: async () => ({ stdout: 'refs/heads/main ' + 'a'.repeat(40) }),
}));
vi.mock('@/lib/worktree/materialization-leaf-io', () => ({ readPinnedWorkspaceFile: async () => null }));
vi.mock('@/lib/worktree/warm-packet-recovery', () => ({ recoverWarmPacketTransfers: async () => {} }));
vi.mock('@/lib/worktree/warm-packet-budget', () => ({
  supportsWarmPacketWorktrees: () => true,
  assertWarmFilesystemBudget: async () => {},
  reserveWarmPacketSlot: () => 'fixture-token',
  releaseUnmaterializedWarmPacketSlot: () => true,
}));

beforeEach(() => {
  vi.resetModules(); fixture.create.mockClear();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
});
afterEach(() => vi.useRealTimers());

async function scheduled() {
  const pool = await import('@/lib/worktree/warm-packet-pool');
  const manager = { prepareWarmWorktree: fixture.create } as unknown as import('@/lib/worktree/manager').WorktreeManager;
  const options = { repoRoot: '/fixture', agentType: 'codex', repoSetup: fixture.setup } as import('@/lib/worktree/warm-packet-pool').WarmPacketOptions;
  return { pool, schedule: () => pool.scheduleWarmPacketWorktrees(options, manager) };
}

it('waits exactly five simulated seconds before a refill enters admission', async () => {
  const f = await scheduled(); f.schedule();
  await vi.advanceTimersByTimeAsync(4_999);
  expect(fixture.create).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(fixture.create).toHaveBeenCalledOnce();
  await f.pool.shutdownWarmPacketWorktrees();
}, 5_000);

it('extends the quiet window after another foreground launch without wall-clock sleep', async () => {
  const f = await scheduled(); f.schedule();
  await vi.advanceTimersByTimeAsync(3_000); f.schedule();
  await vi.advanceTimersByTimeAsync(4_999);
  expect(fixture.create).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(fixture.create).toHaveBeenCalledOnce();
  await f.pool.shutdownWarmPacketWorktrees();
}, 5_000);

it('pool shutdown cancels a scheduled refill before any admission or tree creation', async () => {
  const f = await scheduled(); f.schedule();
  await f.pool.shutdownWarmPacketWorktrees();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(fixture.create).not.toHaveBeenCalled();
}, 5_000);
