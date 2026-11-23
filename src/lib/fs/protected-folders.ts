/**
 * macOS asks the user before an app reads Documents, Desktop, Downloads,
 * iCloud Drive, cloud-storage folders or another volume. Until the prompt is
 * answered, every filesystem call on such a path blocks the calling thread:
 * a synchronous call there stops the server's event loop, and each pending
 * asynchronous call holds one of libuv's four pool threads.
 *
 * One asynchronous probe per protected folder finds out when the folder can be
 * read. Until it settles, callers skip or postpone the paths under it, so a
 * pending prompt delays only the repositories that live there.
 */

import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const HOME_FOLDERS = ['Documents', 'Desktop', 'Downloads', 'Library/Mobile Documents', 'Library/CloudStorage'];
const probes = new Map<string, Promise<void>>();
const settled = new Set<string>();

/** The protected folder a path sits in, or null when no prompt guards it. */
export function protectedFolderOf(path: string): string | null {
  const target = resolve(path);
  const home = homedir();
  for (const name of HOME_FOLDERS) {
    const folder = `${home}/${name}`;
    if (target === folder || target.startsWith(`${folder}/`)) return folder;
  }
  return /^\/Volumes\/[^/]+/.exec(target)?.[0] ?? null;
}

function probe(folder: string): Promise<void> {
  let pending = probes.get(folder);
  if (!pending) {
    // Any answer settles it: after a grant reads are fast, after a denial they fail fast.
    pending = readdir(folder).then(() => undefined, () => undefined).then(() => { settled.add(folder); });
    probes.set(folder, pending);
  }
  return pending;
}

/** True when a filesystem call on this path cannot wait on a privacy prompt.
 * Never blocks; the first call for a protected folder starts its probe. */
export function isPathReachable(path: string): boolean {
  const folder = protectedFolderOf(path);
  if (!folder || settled.has(folder)) return true;
  void probe(folder);
  return false;
}

/** Resolves once filesystem calls on this path can no longer wait on a prompt. */
export function whenPathReachable(path: string): Promise<void> {
  const folder = protectedFolderOf(path);
  if (!folder || settled.has(folder)) return Promise.resolve();
  return probe(folder);
}

/** Known to exist now. A path behind a pending prompt is not known to exist. */
export function existsWhenReachable(path: string): boolean {
  return isPathReachable(path) && existsSync(path);
}

/** Known to be gone now. A path behind a pending prompt is not known to be gone,
 * so cleanup never retires work just because its folder awaits a prompt. */
export function missingWhenReachable(path: string): boolean {
  return isPathReachable(path) && !existsSync(path);
}
