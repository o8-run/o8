import path from 'node:path';

import { getLane } from '@/lib/lane/registry';
import { assertWorktreeMaterializationIdentity, captureWorktreeMaterializationIdentity } from './materialization-identity';
import { materializationAwareExecFile, withWorktreeMaterializationExecution } from './materialization-execution';
import { readWorktreeMetaSnapshot, withWorktreeMetaTransaction } from './metadata-store';
import { withManagedWorktreeRegistryQueue } from './launch-storage-admission';
import { probeMetadataLockProcessIdentity, sameMetadataLockProcessIdentity } from './metadata-lock-process-identity';
import { allowWorktreeRemoval } from './live-process-guard';
import type { WorktreeManager } from './manager';

/** Replay an interrupted unused-tree transfer before admitting more idle trees. */
export async function recoverWarmPacketTransfers(repoRoot: string, manager: WorktreeManager): Promise<void> {
  const snapshot = await readWorktreeMetaSnapshot(repoRoot);
  for (const target of Object.values(snapshot)) {
    const transfer = target.warmTransfer;
    if (!transfer) continue;
    if (!target.materializationIdentity || !target.materializationParentIdentity || !target.creationOwner
      || !['creating', 'setup'].includes(target.status ?? '') || target.sessionKey
      || !/^warm-[a-z0-9-]+-index\.noindex$/.test(transfer.sourceId)) {
      throw new Error('Interrupted warm transfer has ambiguous ownership.');
    }
    const owner = await probeMetadataLockProcessIdentity(target.creationOwner.pid);
    if (owner.state === 'unknown' || (owner.state === 'live' && target.creationOwner.pid !== process.pid
      && sameMetadataLockProcessIdentity(owner.identity, target.creationOwner.identity))) {
      throw new Error('Interrupted warm transfer still has a live creator.');
    }
    const lane = target.laneId ? getLane(target.laneId) : null;
    if (lane?.sessionKey) throw new Error('Interrupted warm transfer already has a launched session.');
    const parent = target.materializationParentIdentity;
    await assertWorktreeMaterializationIdentity(parent.canonicalPath, parent);
    const destination = target.materializationIdentity.canonicalPath;
    const source = path.join(parent.canonicalPath, transfer.sourceId);
    const original = snapshot[transfer.sourceId];
    if (original && (!original.warmPool || original.materializationIdentity?.inode !== target.materializationIdentity.inode
      || original.materializationIdentity.device !== target.materializationIdentity.device)) {
      throw new Error('Interrupted warm transfer source metadata changed ownership.');
    }
    const sourceIdentity = { ...target.materializationIdentity, canonicalPath: source };
    const atTarget = await assertWorktreeMaterializationIdentity(destination, target.materializationIdentity).then(() => true, () => false);
    const atSource = await assertWorktreeMaterializationIdentity(source, sourceIdentity).then(() => true, () => false);
    if (atSource === atTarget) throw new Error('Interrupted warm transfer lost its unique directory identity.');
    if (atTarget) {
      if (!await allowWorktreeRemoval(destination, { logPrefix: 'warm-recovery' })) throw new Error('Interrupted warm transfer is still in use.');
      await withWorktreeMaterializationExecution(destination, target.materializationIdentity, async () => {
        if (target.isolationKind === 'git-worktree') {
          const repoIdentity = await captureWorktreeMaterializationIdentity(repoRoot);
          await withManagedWorktreeRegistryQueue(repoRoot, () => withWorktreeMaterializationExecution(repoRoot, repoIdentity, () => materializationAwareExecFile('git', ['worktree', 'repair', destination], {
            cwd: repoRoot, windowsHide: true, timeout: 5_000,
          })));
        }
        const branch = (await materializationAwareExecFile('git', ['branch', '--show-current'], { cwd: destination, timeout: 5_000 })).stdout.trim();
        const head = (await materializationAwareExecFile('git', ['rev-parse', 'HEAD'], { cwd: destination, timeout: 5_000 })).stdout.trim();
        if (![transfer.sourceBranch, target.branchName].includes(branch) || head !== transfer.head) {
          throw new Error('Interrupted warm transfer contains unexpected Git work.');
        }
        await withWorktreeMetaTransaction(repoRoot, async transaction => {
          await transaction.save(target.id, {
            ...target, branchName: branch, warmPool: { head, seal: transfer.seal },
            warmTransfer: undefined, packetId: undefined, laneId: undefined
          });
        });
      });
      await manager.retireWarmWorktree(target.id);
      await withWorktreeMetaTransaction(repoRoot, transaction => transaction.remove(transfer.sourceId));
    } else {
      await withWorktreeMetaTransaction(repoRoot, transaction => transaction.remove(target.id));
    }
  }
}
