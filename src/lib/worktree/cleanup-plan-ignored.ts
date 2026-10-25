import { createHash } from 'node:crypto';
import { lstat, opendir, readlink } from 'node:fs/promises';
import path from 'node:path';

import { laneGit } from '@/lib/lane/lane-git';
import { WORKTREE_MAINTENANCE_POLICY } from './maintenance-budget';

/** Ignored data is still operator data. Never follow links or accept a partial inventory. */
export async function cleanupIgnoredFingerprint(repositoryPath: string, workspacePath: string, generated = false, omitDependencyMount = false): Promise<string> {
  const rootBefore = await lstat(workspacePath);
  const list = () => laneGit(workspacePath, repositoryPath,
    ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
    { timeout: 5_000, maxBuffer: WORKTREE_MAINTENANCE_POLICY.rootBytes });
  const inventory = await list();
  const roots = inventory.stdout.split('\0').filter(Boolean).map(name => name.replace(/\/$/, '')).sort();
  const digest = createHash('sha256');
  const deadline = Date.now() + 5_000;
  let entries = 0;
  async function visit(relative: string): Promise<void> {
    if (++entries > 10_000 || Date.now() > deadline) throw new Error('Ignored contents exceed the bounded review inventory; retain this workspace.');
    if (!relative || relative.includes('\uFFFD') || path.isAbsolute(relative) || relative.split('/').some(part => part === '..' || part === '.')) {
      throw new Error('Ignored contents have an unverifiable path.');
    }
    const file = path.join(workspacePath, relative);
    const before = await lstat(file);
    const target = before.isSymbolicLink() ? await readlink(file) : null;
    if (!before.isFile() && !before.isDirectory() && !before.isSymbolicLink()) throw new Error('Ignored special files require separate review.');
    digest.update(JSON.stringify([relative, before.mode, before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs, target]));
    if (before.isDirectory()) {
      const children: string[] = [];
      for await (const child of await opendir(file)) {
        if (children.length + entries >= 10_000 || Date.now() > deadline) throw new Error('Ignored contents exceed the bounded review inventory; retain this workspace.');
        children.push(child.name);
      }
      children.sort();
      for (const child of children) await visit(`${relative}/${child}`);
    }
    const after = await lstat(file);
    if (after.dev !== before.dev || after.ino !== before.ino || after.mode !== before.mode
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error('Ignored contents changed during review; preview again.');
    }
  }
  for (const name of roots) {
    if (omitDependencyMount && (name === 'node_modules' || name.startsWith('node_modules/'))) continue;
    // .next has its own separately selected generated-output lifecycle. Removing that
    // approved dependency must not invalidate the containing workspace's other data.
    if ((name === '.next' || name.startsWith('.next/')) === generated) await visit(name);
  }
  if ((await list()).stdout !== inventory.stdout) throw new Error('Ignored contents changed during review; preview again.');
  const rootAfter = await lstat(workspacePath);
  if (rootAfter.dev !== rootBefore.dev || rootAfter.ino !== rootBefore.ino
    || rootAfter.mtimeMs !== rootBefore.mtimeMs || rootAfter.ctimeMs !== rootBefore.ctimeMs) {
    throw new Error('Ignored contents changed during review; preview again.');
  }
  return digest.digest('hex');
}
