import { spawn } from '@/lib/providers/child-process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { nativeProcessHelperPath } from '@/lib/pi/sdk/scripts';
import { assertWorktreeMaterializationIdentity, type WorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';

/** Only this opt-in call requires atomic no-replace. No ordinary rename fallback. */
export async function moveExactDirectoryNoReplace(parent: WorktreeMaterializationIdentity,
  source: string, destination: string, identity: { device: number; inode: number }): Promise<void> {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Atomic directory move is unsupported.');
  for (const selected of [source, destination]) {
    if (path.dirname(selected) !== parent.canonicalPath || path.resolve(selected) !== selected) {
      throw new Error('Directory move escaped its exact parent.');
    }
  }
  await assertWorktreeMaterializationIdentity(parent.canonicalPath, parent);
  const directory = await open(parent.canonicalPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const held = await directory.stat();
    if (!held.isDirectory() || held.dev !== parent.device || held.ino !== parent.inode) throw new Error('Directory parent changed.');
    const helper = nativeProcessHelperPath();
    const receipt = await new Promise<string>((resolve, reject) => {
      const child = spawn(helper, ['move-directory-no-replace'], { cwd: '/',
        env: { NODE_ENV: 'production' }, stdio: ['pipe', 'pipe', 'pipe', directory.fd] });
      let output = ''; let error = ''; let failure: Error | null = null;
      const timer = setTimeout(() => { failure = new Error('Directory helper timed out; replay its durable intent.'); child.kill('SIGKILL'); }, 10_000);
      child.stdout!.on('data', bytes => { output += bytes; if (output.length > 16_384) { failure = new Error('Directory receipt exceeded its bound.'); child.kill('SIGKILL'); } });
      child.stderr!.on('data', bytes => { if (error.length < 16_384) error += bytes; });
      child.on('error', value => { failure = value; });
      child.stdin!.on('error', () => {});
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        if (failure || code !== 0 || signal) reject(failure ?? new Error(error.trim() || 'Directory helper failed; preserve and replay intent.'));
        else resolve(output);
      });
      child.stdin!.end(JSON.stringify({ parent: { path: parent.canonicalPath, dev: parent.device, ino: parent.inode },
        source: path.basename(source), destination: path.basename(destination),
        sourceId: { dev: identity.device, ino: identity.inode } }));
    });
    const value = JSON.parse(receipt);
    if (value.schema !== 'o8/directory-no-replace/v1' || value.moved !== true
      || value.device !== identity.device || value.inode !== identity.inode) throw new Error('Directory move returned ambiguous proof.');
    await assertWorktreeMaterializationIdentity(parent.canonicalPath, parent);
  } finally { await directory.close(); }
}
