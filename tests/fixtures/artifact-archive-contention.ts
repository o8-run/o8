import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { expect, onTestFinished, vi } from 'vitest';
import * as leases from '@/lib/orchestrator/workspace-lifecycle-lease';
import { withOwnedArtifactAdmission } from '@/lib/runtimes/shared/owned-session/artifact-admission';
import { workerO8CliRoot } from '@/lib/runtimes/shared/owned-session/worker-o8-cli-paths';
import { getOwnedSessionLifecycle } from '@/lib/runtimes/shared/owned-session-lifecycle';

/** Hold real leases; observe the real refusal without substituting lock authority. */
export async function holdArchiveContention(
  root: string,
  namespace: 'runtime' | 'cli',
  surfaceId: string,
): Promise<() => Promise<void>> {
  const canonical = path.join(await realpath(path.dirname(root)), path.basename(root));
  const cliRoot = path.join(await realpath(path.dirname(workerO8CliRoot())), 'worker-cli');
  const key = `${namespace === 'runtime' ? 'owned-artifacts' : 'owned-cli-artifacts'}:${createHash('sha256')
    .update(namespace === 'runtime' ? canonical : cliRoot).digest('hex')}`;
  const acquire = leases.acquireWorkspaceLifecycleLease;
  const archiving = new AsyncLocalStorage<boolean>();
  const lifecycle = getOwnedSessionLifecycle(surfaceId)!;
  const archive = lifecycle.archiveSession.bind(lifecycle);
  const archiveObservation = vi.spyOn(lifecycle, 'archiveSession').mockImplementation((...args) =>
    archiving.run(args[0] === surfaceId, () => archive(...args)));
  let refused = false;
  const observation = vi.spyOn(leases, 'acquireWorkspaceLifecycleLease').mockImplementation(async (...args) => {
    try { return await acquire(...args); }
    catch (error) {
      if (archiving.getStore() && args[0] === key && error instanceof leases.WorkspaceLifecycleLeaseUnavailableError
        && error.reason === 'contended') refused = true;
      throw error;
    }
  });
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  // A different runtime still shares the worker CLI namespace.
  const owner = withOwnedArtifactAdmission(namespace === 'runtime' ? root : `${root}-other-runtime`, async () => {
    entered();
    await gate;
  });
  const cleanup = async () => {
    release();
    try { await owner; } finally { observation.mockRestore(); archiveObservation.mockRestore(); }
  };
  onTestFinished(cleanup);
  await Promise.race([ready, owner]);
  return async () => {
    try {
      await vi.waitFor(() => expect(refused, `archive must encounter the live ${namespace} lease`).toBe(true),
        { timeout: 10_000, interval: 10 });
      console.info(`[cap-archive] Archive refused by the fixture's live ${namespace} lifecycle owner before release.`);
    } finally { await cleanup(); }
  };
}
