import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Pi Durable resumes unfinished work on open and has no process ownership gate.
 * Hold an OS-backed exclusive claim before opening its store, for the entire
 * harness lifetime. A crash releases the lock; there is no expiring lease that
 * could admit another writer while the original process is still running.
 */
export function claimSymonBrainStore(storagePath: string): () => void {
  const directory = dirname(storagePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = new Database(join(directory, '.brain-store.lock'), { timeout: 0 });
  try {
    lock.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    lock.close();
    if (['SQLITE_BUSY', 'SQLITE_LOCKED'].includes((error as { code?: string }).code ?? '')) {
      throw new Error('symon_brain_owned: Another process owns the durable Symon brain store. Stop that process before retrying.');
    }
    throw error;
  }
  return () => lock.close();
}
