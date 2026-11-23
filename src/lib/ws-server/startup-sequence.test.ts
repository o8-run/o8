import { describe, expect, it } from 'vitest';
import { startupRecoveryDone } from '@/lib/startup/recovery-barrier';
import { runStartupSequence } from './startup-sequence';

const settled = async (promise: Promise<unknown>) => {
  let done = false;
  void promise.then(() => { done = true; }, () => { done = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  return done;
};

describe('ws-server startup sequence', () => {
  it('is ready while a maintenance step is still pending, and holds worktree creation until it ends', async () => {
    let finishMaintenance!: () => void;
    let maintenanceStarted = false;
    const startup = runStartupSequence({
      ready: async () => {},
      maintenance: () => new Promise<void>((resolve) => { maintenanceStarted = true; finishMaintenance = resolve; }),
    });
    await startup.ready;
    expect(maintenanceStarted).toBe(true);
    expect(await settled(startup.recovered)).toBe(false);
    expect(await settled(startupRecoveryDone())).toBe(false);
    finishMaintenance();
    await startup.recovered;
    expect(await settled(startupRecoveryDone())).toBe(true);
  });

  it('opens worktree creation when maintenance fails', async () => {
    const startup = runStartupSequence({ ready: async () => {}, maintenance: async () => { throw new Error('sweep failed'); } });
    await expect(startup.recovered).rejects.toThrow('sweep failed');
    expect(await settled(startupRecoveryDone())).toBe(true);
  });
});

describe('worktree creation during startup recovery', () => {
  it('waits for recovery before touching the repository', async () => {
    const { WorktreeManager } = await import('@/lib/worktree/manager');
    let finishMaintenance!: () => void;
    const startup = runStartupSequence({ ready: async () => {}, maintenance: () => new Promise<void>((resolve) => { finishMaintenance = resolve; }) });
    await startup.ready;
    const create = new WorktreeManager('/nonexistent/o8-startup-recovery-repo')
      .create({ agentType: 'codex', taskName: 'during recovery', baseBranch: 'main' });
    expect(await settled(create)).toBe(false);
    finishMaintenance();
    await startup.recovered;
    await expect(create).rejects.toBeDefined();
  });
});
