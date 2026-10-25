import { lstatSync, realpathSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getSqlite } from '@/lib/db';
import { isMetadataLockProcessIdentity, probeMetadataLockProcessIdentitySync, sameMetadataLockProcessIdentity } from './metadata-lock-process-identity';
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
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS warm_packet_slots (
      slot INTEGER PRIMARY KEY CHECK(slot IN (0, 1)), token TEXT NOT NULL UNIQUE,
      repository_path TEXT NOT NULL, reserved_bytes INTEGER NOT NULL, created_at INTEGER NOT NULL
    )`);
    const columns = new Set((db.prepare('PRAGMA table_info(warm_packet_slots)').all() as Array<{ name: string }>).map(c => c.name));
    for (const [name, type] of [['owner_pid', 'INTEGER'], ['owner_identity', 'TEXT'], ['workspace_path', 'TEXT'], ['anchor_identity', 'TEXT'], ['materialization_started', 'INTEGER NOT NULL DEFAULT 0']] as const) {
      if (!columns.has(name)) db.exec(`ALTER TABLE warm_packet_slots ADD COLUMN ${name} ${type}`);
    }
  }).immediate();
  return db;
}

/** Reconcile authoritative metadata across every root, including unrequested repos. */
export function reserveWarmPacketSlot(repoRoot: string): string | null {
  const db = database();
  const owner = probeMetadataLockProcessIdentitySync(process.pid);
  if (owner.state !== 'live') throw new Error('Warm admission cannot prove its owning process identity.');
  return db.transaction(() => {
    recoverEmptyWarmPacketSlots(db);
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
    const workspace = path.join(resolveWorktreeRootLayout(repoRoot).primaryBase, `warm-${token}-index.noindex`);
    const anchor = reservationAnchor(path.dirname(workspace));
    db.prepare(`INSERT INTO warm_packet_slots
      (slot, token, repository_path, reserved_bytes, created_at, owner_pid, owner_identity, workspace_path, anchor_identity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(slot, token, path.resolve(repoRoot), WARM_ENTRY_BYTES, Date.now(),
      process.pid, JSON.stringify(owner.identity), workspace, JSON.stringify(anchor));
    return token;
  }).immediate();
}

interface WarmSlot {
  token: string;
  repository_path: string;
  owner_pid: number | null;
  owner_identity: string | null;
  workspace_path: string | null;
  anchor_identity: string | null;
  materialization_started: number;
}

function reservationAnchor(candidate: string): { path: string; device: number; inode: number } {
  for (;;) {
    try {
      const stat = lstatSync(candidate);
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(candidate) !== candidate) throw new Error('Warm reservation anchor is not exact.');
      return { path: candidate, device: stat.dev, inode: stat.ino };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || candidate === path.dirname(candidate)) throw error;
      candidate = path.dirname(candidate);
    }
  }
}

function hasMetadataOwner(db: ReturnType<typeof getSqlite>, token: string): boolean {
  const id = `warm-${token}-index.noindex`;
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_exact_claims'").get()
    && db.prepare('SELECT 1 FROM workspace_exact_claims WHERE worktree_id = ?').get(id)) return true;
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='worktree_metadata_state'").get()) return false;
  let roots = 0;
  let bytes = 0;
  for (const row of db.prepare(`SELECT CASE WHEN length(CAST(payload_json AS BLOB)) <= 8388608 THEN payload_json END AS payload_json FROM worktree_metadata_state`).iterate() as Iterable<{ payload_json: string | null }>) {
    if (!row.payload_json || ++roots > 1024 || (bytes += Buffer.byteLength(row.payload_json)) > 16 * 1024 ** 2) return true;
    const payload = JSON.parse(row.payload_json) as { worktrees?: Record<string, {
      id: string; warmPool?: { slotToken?: string }; warmTransfer?: { sourceId: string; slotToken?: string };
    }> };
    if (!payload.worktrees || typeof payload.worktrees !== 'object') return true;
    if (Object.values(payload.worktrees).some(e => e.id === id || e.warmPool?.slotToken === token
      || e.warmTransfer?.slotToken === token || e.warmTransfer?.sourceId === id)) return true;
  }
  return false;
}

function provenEmpty(db: ReturnType<typeof getSqlite>, slot: WarmSlot): boolean {
  try {
    if (!slot.workspace_path || !slot.anchor_identity || hasMetadataOwner(db, slot.token)) return false;
    const anchor = JSON.parse(slot.anchor_identity) as ReturnType<typeof reservationAnchor>;
    if (typeof anchor.path !== 'string' || !path.isAbsolute(anchor.path)) return false;
    const current = reservationAnchor(anchor.path);
    if (current.path !== anchor.path || current.device !== anchor.device || current.inode !== anchor.inode) return false;
    const relative = path.relative(anchor.path, slot.workspace_path);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
      || path.basename(slot.workspace_path) !== `warm-${slot.token}-index.noindex`) return false;
    try { lstatSync(slot.workspace_path); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
  } catch { return false; }
}

/** Reclaim only an exited creator's empty reservation before any mutator started. */
function recoverEmptyWarmPacketSlots(db: ReturnType<typeof getSqlite>): void {
  for (const slot of db.prepare('SELECT * FROM warm_packet_slots').all() as WarmSlot[]) {
    // A child can outlive its creator and mkdir after this check. Absence is
    // evidence only before the durable effect-start fence; uncertain effects
    // retain their charge rather than borrowing a second reservation.
    if (slot.materialization_started !== 0) continue;
    if (!slot.owner_pid || !slot.owner_identity) continue; // Unknown legacy owners remain charged.
    let identity: unknown;
    try { identity = JSON.parse(slot.owner_identity); } catch { continue; }
    if (!isMetadataLockProcessIdentity(identity)) continue;
    const owner = probeMetadataLockProcessIdentitySync(slot.owner_pid);
    if (owner.state === 'unknown' || owner.state === 'live' && sameMetadataLockProcessIdentity(owner.identity, identity)) continue;
    if (provenEmpty(db, slot)) db.prepare('DELETE FROM warm_packet_slots WHERE token = ?').run(slot.token);
  }
}

/** Persist before spawning the first child that can create the selected tree. */
export function markWarmPacketMaterializationStarted(repoRoot: string, token: string | undefined): void {
  const db = database();
  const owner = probeMetadataLockProcessIdentitySync(process.pid);
  if (!token || owner.state !== 'live') throw new Error('Warm materialization cannot prove its creator identity.');
  const changed = db.prepare(`UPDATE warm_packet_slots SET materialization_started = 1
    WHERE token = ? AND repository_path = ? AND owner_pid = ? AND owner_identity = ?`)
    .run(token, path.resolve(repoRoot), process.pid, JSON.stringify(owner.identity)).changes;
  if (changed !== 1) throw new Error('Warm materialization lost its durable creator reservation.');
}

/** Called only after this creator's failed materialization has fully settled. */
export function releaseUnmaterializedWarmPacketSlot(repoRoot: string, token: string): boolean {
  const db = database();
  return db.transaction(() => {
    const slot = db.prepare('SELECT * FROM warm_packet_slots WHERE token = ? AND repository_path = ? AND owner_pid = ?')
      .get(token, path.resolve(repoRoot), process.pid) as WarmSlot | undefined;
    if (!slot?.owner_identity) return false;
    const identity: unknown = JSON.parse(slot.owner_identity);
    const owner = probeMetadataLockProcessIdentitySync(process.pid);
    if (!isMetadataLockProcessIdentity(identity) || owner.state !== 'live'
      || !sameMetadataLockProcessIdentity(owner.identity, identity) || !provenEmpty(db, slot)) return false;
    return db.prepare('DELETE FROM warm_packet_slots WHERE token = ?').run(token).changes === 1;
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

export function supportsWarmPacketWorktrees(): boolean { return process.platform === 'linux'; }
