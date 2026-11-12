import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

const runtime = globalThis as typeof globalThis & { __o8MessagesOwner?: Database.Database };

/**
 * One owner per install, independent of transport flags. The retained connection
 * refuses repeat starts in this process. SQLite's exclusive OS lock refuses a
 * second process on the same data directory and releases automatically on exit
 * (including crashes); no stale PID record or timed lease can admit two owners.
 */
export function claimMessagesReceiver(): boolean {
  if (runtime.__o8MessagesOwner) return false;
  const directory = getDataDir();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = new Database(join(directory, '.messages-receiver.lock'), { timeout: 0 });
  try {
    lock.exec('BEGIN EXCLUSIVE');
    runtime.__o8MessagesOwner = lock;
    return true;
  } catch (error) {
    lock.close();
    if ((error as { code?: string }).code === 'SQLITE_BUSY') return false;
    throw error;
  }
}

export function ownsMessagesReceiver(): boolean {
  return Boolean(runtime.__o8MessagesOwner);
}

/**
 * A live older brain owner may run its own unclaimed receiver loop, so its
 * refusal keeps this one stopped. Any other brain failure (an unsupported Node
 * release, a missing store) leaves the receiver free: it answers through the
 * native planner and uses the brain only when it is available (#3486).
 */
export function brainRefusalBlocksReceiver(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('symon_brain_owned:');
}
