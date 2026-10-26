import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { readProcessCwdSnapshot } from '@/lib/runtime/process-cwd-snapshot';
import { probeLiveProcessInside } from '@/lib/worktree/live-process-guard';
import { assertWorktreeMaterializationIdentity, captureWorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import { captureExactDirectoryManifest, clearExactDirectoryContents, readCapturedPurgeCwdSnapshot,
  type CapturedPurgeProcessWitness } from './exact-directory-purge';
import { createExactChildDirectory, promoteExactChild } from './exact-parent-operation';
import { assertGeneratedOutputClaimsReleased, readGeneratedOutputResource, type GeneratedOutputResource } from './generated-output-state';
import { assertWorkspaceRetentionReleased } from './retention-holds';

/** Reserve a private compiler namespace before any child is allowed to write. */
export async function reserveBuildOutput(resource: GeneratedOutputResource, previousOwnership = resource.buildOwnership) {
  const output = resource.output!;
  const directory = path.join(output.canonicalPath, '.o8-release-build');
  if (previousOwnership?.state === 'complete' && previousOwnership.manifest) {
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
  await createExactChildDirectory(output.canonicalPath, output, directory, 0o700);
  return { scope: await captureWorktreeMaterializationIdentity(directory), state: 'reserved' as const };
}

/** Inventory only the reserved compiler namespace, never the shared output directory. */
export async function publishBuildOutput(resource: GeneratedOutputResource) {
  const ownership = resource.buildOwnership!;
  const output = resource.output!;
  await assertWorktreeMaterializationIdentity(output.canonicalPath, output);
  await assertWorktreeMaterializationIdentity(ownership.scope.canonicalPath, ownership.scope);
  const captured = await captureExactDirectoryManifest(ownership.scope.canonicalPath, ownership.scope);
  for (const entry of captured.entries.filter(entry => entry.relative !== '.' && !entry.relative.includes('/'))) {
    if (entry.kind !== 'file' && entry.kind !== 'directory') throw new Error('Build output cannot promote linked or special roots.');
    await promoteExactChild(ownership.scope, output, path.join(ownership.scope.canonicalPath, entry.relative),
      path.join(output.canonicalPath, entry.relative), entry, entry.kind);
  }
  await assertWorktreeMaterializationIdentity(output.canonicalPath, output);
  await assertWorktreeMaterializationIdentity(ownership.scope.canonicalPath, ownership.scope);
  if ((await readdir(ownership.scope.canonicalPath)).length) throw new Error('Build namespace changed during publication.');
  const root = captured.entries.find(entry => entry.relative === '.')!;
  const promoted = await Promise.all(captured.entries.filter(entry => entry.relative !== '.').map(async entry => {
    const actual = await lstat(path.join(output.canonicalPath, entry.relative));
    if (actual.dev !== entry.device || actual.ino !== entry.inode || (entry.kind === 'file'
      && (actual.size !== entry.size || actual.mtimeMs !== entry.mtimeMs))) {
      throw new Error('Promoted build output changed its original compiler identity.');
    }
    return { ...entry, ctimeMs: actual.ctimeMs };
  }));
  const remaining = await lstat(ownership.scope.canonicalPath);
  const entries = [{ ...root, device: output.device, inode: output.inode },
    ...promoted,
    { ...root, relative: path.basename(ownership.scope.canonicalPath), device: remaining.dev, inode: remaining.ino }];
  return { ...ownership, state: 'complete' as const, manifest: {
    entries, fingerprint: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
  } };
}
