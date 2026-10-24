import { statfs } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getSqlite } from '@/lib/db';
import { resolveWorktreeRootLayout } from './root-layout';

export const WARM_ENTRY_BYTES = 4 * 1024 ** 3;
export const WARM_ENTRY_COUNT = 2;

/** An arbitrary installer requires a kernel-enforced filesystem bound, not a poll. */
export async function assertWarmFilesystemBudget(repoRoot: string): Promise<void> {
  let candidate = resolveWorktreeRootLayout(repoRoot).primaryBase;
  for (;;) {
    try {
      const volume = await statfs(candidate);
      const capacity = Number(volume.blocks) * Number(volume.bsize);
      if (!Number.isSafeInteger(capacity) || capacity <= 0 || capacity > WARM_ENTRY_BYTES) throw new Error('Warm preparation requires a bounded filesystem of at most four GiB.');
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || candidate === path.dirname(candidate)) throw error;
      candidate = path.dirname(candidate);
    }
  }
}

function database() {
  const db = getSqlite();
  db.exec(`CREATE TABLE IF NOT EXISTS warm_packet_slots (
    slot INTEGER PRIMARY KEY CHECK(slot IN (0, 1)), token TEXT NOT NULL UNIQUE,
    repository_path TEXT NOT NULL, reserved_bytes INTEGER NOT NULL, created_at INTEGER NOT NULL
  )`);
  return db;
}

/** Reconcile authoritative metadata across every root, including unrequested repos. */
export function reserveWarmPacketSlot(repoRoot: string): string | null {
  const db = database();
  return db.transaction(() => {
    const slots = db.prepare('SELECT slot, token FROM warm_packet_slots').all() as Array<{ slot: number; token: string }>;
    if (slots.length >= WARM_ENTRY_COUNT) return null;
    const owners = new Set(slots.map(slot => slot.token));
    const identities = new Map<string, string | undefined>();
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='worktree_metadata_state'").get()) {
      let roots = 0;
      let bytes = 0;
      for (const row of db.prepare(`SELECT metadata_root, CASE WHEN length(CAST(payload_json AS BLOB)) <= 8388608 THEN payload_json END AS payload_json FROM worktree_metadata_state`).iterate() as Iterable<{ metadata_root: string; payload_json: string | null }>) {
        if (!row.payload_json) throw new Error('Warm admission cannot bound an unreadable metadata store.');
        bytes += Buffer.byteLength(row.payload_json);
        if (++roots > 1024 || bytes > 16 * 1024 ** 2) throw new Error('Warm admission exceeded its global reconciliation budget.');
        const payload = JSON.parse(row.payload_json) as { worktrees?: Record<string, { id: string; materializationIdentity?: { device: number; inode: number }; warmPool?: { slotToken?: string }; warmTransfer?: { sourceId: string; slotToken?: string } }> };
        if (!payload.worktrees || typeof payload.worktrees !== 'object') throw new Error('Warm admission cannot reconcile metadata ownership.');
        for (const entry of Object.values(payload.worktrees)) {
          if (entry.warmPool || entry.warmTransfer) {
            const token = entry.warmPool?.slotToken ?? entry.warmTransfer?.slotToken;
            // Legacy/unreserved trees have no proven byte bound. Keep them,
            // and refuse further speculative disk use across all repositories.
            if (!token || !slots.some(slot => slot.token === token)) return null;
            const key = token;
            const identity = entry.materializationIdentity ? `${entry.materializationIdentity.device}:${entry.materializationIdentity.inode}` : undefined;
            if (identities.has(key) && (!identity || identities.get(key) !== identity)) throw new Error('Warm reservation names multiple or unknown trees.');
            identities.set(key, identity);
            owners.add(key);
            if (owners.size >= WARM_ENTRY_COUNT) return null;
          }
        }
      }
    }
    if (owners.size >= WARM_ENTRY_COUNT) return null;
    const slot = [0, 1].find(value => !slots.some(row => row.slot === value));
    if (slot === undefined) return null;
    const token = randomUUID();
    db.prepare('INSERT INTO warm_packet_slots VALUES (?, ?, ?, ?, ?)').run(slot, token, path.resolve(repoRoot), WARM_ENTRY_BYTES, Date.now());
    return token;
  }).immediate();
}

export function assertWarmPacketSlot(repoRoot: string, token: string | undefined, worktreeId?: string): void {
  if (!token || !database().prepare('SELECT 1 FROM warm_packet_slots WHERE token = ? AND repository_path = ?').get(token, path.resolve(repoRoot))) {
    throw new Error('Warm creation has no durable global resource reservation.');
  }
  if (worktreeId && worktreeId !== `warm-${token}-index.noindex`) throw new Error('Warm reservation cannot create another workspace.');
}

export function releaseWarmPacketSlot(token: string | undefined): void {
  if (token) database().prepare('DELETE FROM warm_packet_slots WHERE token = ?').run(token);
}
