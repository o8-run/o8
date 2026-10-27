import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { readProcessCwdSnapshot } from '@/lib/runtime/process-cwd-snapshot';
import { probeLiveProcessInside } from '@/lib/worktree/live-process-guard';
import { assertWorktreeMaterializationIdentity, captureWorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import { captureExactDirectoryManifest, clearExactDirectoryContents, readCapturedPurgeCwdSnapshot,
  type CapturedPurgeProcessWitness } from './exact-directory-purge';
import { createExactChildDirectory } from './exact-parent-operation';
import { assertGeneratedOutputClaimsReleased, readGeneratedOutputResource, type GeneratedOutputResource } from './generated-output-state';
import { assertWorkspaceRetentionReleased } from './retention-holds';
import type { BuildOutputWriter } from '../../../scripts/lib/build-output-writer.cjs';

/** Reserve a private compiler namespace before any child is allowed to write. */
export async function reserveBuildOutput(resource: GeneratedOutputResource, previousOwnership = resource.buildOwnership) {
  const output = resource.output!;
  const directory = path.join(output.canonicalPath, '.o8-release-build');
  if (previousOwnership?.state === 'complete' && previousOwnership.manifest) {
    if (previousOwnership.proof !== 'write-receipts-v1') {
      throw new Error('Preserved legacy build output without write-time writer proof.');
    }
    // A rebuild can clear only the preceding compiler's persisted inventory.
    // Keep the registered root and any foreign entries, including nested ones.
    const verify = async (captured?: CapturedPurgeProcessWitness) => {
      await assertWorktreeMaterializationIdentity(resource.workspace.canonicalPath, resource.workspace);
      await assertWorktreeMaterializationIdentity(output.canonicalPath, output);
      if (JSON.stringify(readGeneratedOutputResource(resource.resourceId)) !== JSON.stringify(resource)) {
        throw new Error('Build ownership changed before compiler replacement.');
      }
      assertGeneratedOutputClaimsReleased(resource.workspace);
      assertWorkspaceRetentionReleased(output.canonicalPath, output);
      if (await lstat(path.join(output.canonicalPath, 'lock')).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      })) throw new Error('Retained build output has an unresolved producer lock.');
      const processes = await probeLiveProcessInside(output.canonicalPath, { snapshot: captured
        ? await readCapturedPurgeCwdSnapshot(captured, output.canonicalPath)
        : await readProcessCwdSnapshot({ forceRefresh: true }) });
      if (processes.status !== 'clear') throw new Error('Retained build output has live or unknown processes.');
    };
    await clearExactDirectoryContents(output.canonicalPath, output, previousOwnership.manifest,
      async () => verify(), async (_candidate, captured) => verify(captured));
    if ((await readdir(output.canonicalPath)).length) {
      console.info('Preserved unowned entries in .next; prior compiler-owned entries were cleared for rebuild.');
    }
  }
  const created = await createExactChildDirectory(output.canonicalPath, output, directory, 0o700);
  const scope = await captureWorktreeMaterializationIdentity(directory);
  if (scope.device !== created.device || scope.inode !== created.inode) {
    throw new Error('Preserved a replaced build reservation; native creation ownership changed.');
  }
  return { scope, state: 'reserved' as const };
}

/** The scan is a comparison against write-time receipts, never an ownership grant. */
export async function publishBuildOutput(resource: GeneratedOutputResource, writer: BuildOutputWriter) {
  const ownership = resource.buildOwnership!;
  const output = resource.output!;
  await assertWorktreeMaterializationIdentity(output.canonicalPath, output);
  await assertWorktreeMaterializationIdentity(ownership.scope.canonicalPath, ownership.scope);
  const captured = await captureExactDirectoryManifest(ownership.scope.canonicalPath, ownership.scope);
  writer.prove(captured.entries);
  const entries = writer.promote(output, captured.entries);
  await assertWorktreeMaterializationIdentity(output.canonicalPath, output);
  await assertWorktreeMaterializationIdentity(ownership.scope.canonicalPath, ownership.scope);
  return { ...ownership, state: 'complete' as const, proof: 'write-receipts-v1' as const, manifest: {
    entries, fingerprint: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
  } };
}
