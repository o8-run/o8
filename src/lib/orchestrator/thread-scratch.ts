import { mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

/**
 * A chat with no project runs its agent in its own scratch folder under the
 * data directory. The folder is a working directory, never a project: saved
 * chat records keep no repository for it, and dispatch admits it without Git.
 */
const THREAD_ID = /^thoughts-[A-Za-z0-9_-]{1,80}$/;

function scratchRoot(): string {
  return join(getDataDir(), 'thread-scratch');
}

function canonical(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

export function threadScratchPath(threadId: string): string {
  if (!THREAD_ID.test(threadId)) throw new Error('A valid chat is required.');
  return join(scratchRoot(), threadId);
}

/** Creates the chat's scratch folder on first use and returns its real path. */
export function ensureThreadScratch(threadId: string): string {
  const path = threadScratchPath(threadId);
  mkdirSync(path, { recursive: true });
  return realpathSync(path);
}

export function isThreadScratchPath(path: string | null | undefined): boolean {
  if (typeof path !== 'string' || !path.trim()) return false;
  const candidate = canonical(path.trim());
  return THREAD_ID.test(basename(candidate)) && dirname(candidate) === canonical(scratchRoot());
}
