import { lstat, readdir, realpath } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';

export function refuseOwnedSessionPath(reason: string): never {
  const message = `Owned session storage refused: ${reason}.`;
  console.warn(`[owned-store] ${message}`);
  throw new Error(message);
}

/** Active and archive directories are siblings in one owned namespace. Resolve
 * the namespace parent, never a possibly redirected child, as the anchor. */
export async function assertOwnedSessionPath(root: string, target: string, options: {
  missing?: boolean; kind?: 'directory' | 'file' | 'entry'; identity?: Stats;
} = {}): Promise<Stats | null> {
  const active = path.resolve(root); const archive = `${active}-archive`;
  const absolute = path.resolve(target);
  const scope = [active, archive].find(value => absolute === value || absolute.startsWith(`${value}${path.sep}`));
  if (!scope) refuseOwnedSessionPath('session directory is outside its owned root');
  const parent = path.dirname(active);
  const parentStat = await lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) refuseOwnedSessionPath('owned namespace parent is redirected or invalid');
  const canonicalParent = await realpath(parent);
  const parts = [path.basename(scope), ...path.relative(scope, absolute).split(path.sep).filter(Boolean)];
  let named = parent; let canonical = canonicalParent;
  let result: Stats | null = null;
  for (let index = 0; index < parts.length; index++) {
    named = path.join(named, parts[index]); canonical = path.join(canonical, parts[index]);
    const label = index === 0 ? scope === archive ? 'sessions-archive' : 'sessions root'
      : index === 1 ? 'session directory' : 'session artifact';
    try { result = await lstat(named); }
    catch (error) {
      if (options.missing && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (result.isSymbolicLink()) refuseOwnedSessionPath(`${label} is a symbolic link`);
    const last = index === parts.length - 1;
    if ((!last || options.kind === 'directory') && !result.isDirectory()
      || last && options.kind === 'file' && !result.isFile()) refuseOwnedSessionPath(`${label} has an invalid file type`);
    const resolved = await realpath(named);
    if (!resolved.startsWith(`${canonicalParent}${path.sep}`) || resolved !== canonical) {
      refuseOwnedSessionPath(`${label} resolves outside its owned destination`);
    }
    const after = await lstat(named);
    if (after.isSymbolicLink() || after.dev !== result.dev || after.ino !== result.ino) refuseOwnedSessionPath(`${label} changed during validation`);
  }
  const afterParent = await lstat(parent);
  if (afterParent.isSymbolicLink() || afterParent.dev !== parentStat.dev || afterParent.ino !== parentStat.ino
    || await realpath(parent) !== canonicalParent) refuseOwnedSessionPath('owned namespace parent changed during validation');
  if (options.identity && (result?.dev !== options.identity.dev || result?.ino !== options.identity.ino)) {
    refuseOwnedSessionPath('session directory changed before mutation');
  }
  return result;
}

/** A directory rename does not dereference descendants, but its metadata update
 * does. Refuse redirected entries throughout the moved tree before either step. */
export async function assertOwnedSessionTree(root: string, directory: string, depth = 0): Promise<void> {
  if (depth > 64) refuseOwnedSessionPath('session artifact directory depth is unsafe');
  const before = await assertOwnedSessionPath(root, directory, { kind: 'directory' });
  for (const name of await readdir(directory)) {
    const target = path.join(directory, name);
    const entry = await assertOwnedSessionPath(root, target, { kind: 'entry' });
    if (entry?.isDirectory()) await assertOwnedSessionTree(root, target, depth + 1);
    else if (!entry?.isFile()) refuseOwnedSessionPath('session artifact has an invalid file type');
  }
  await assertOwnedSessionPath(root, directory, { kind: 'directory', identity: before! });
}
