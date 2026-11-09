import 'server-only';

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { getSqlite } from '@/lib/db';
import { writePacketWorkerTokenHashes } from './worker-token';

const PACKET_ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;
const PACKET_WORKER_SCOPE = 'local-packet';

interface PacketWorkerTokenRow {
  id: string;
  token_hash: string;
  packet_id: string | null;
  revoked_at: string | null;
  lease_process_marker: string | null;
  lease_process_pid: number | null;
  lease_process_group_id: number | null;
}

export interface PacketWorkerIdentity {
  tokenId: string;
  packetId: string;
  leaseProcessMarker: string | null;
  leaseProcessPid: number | null;
  leaseProcessGroupId: number | null;
}

function normalizedPacketId(packetId: string): string {
  const normalized = packetId.trim();
  if (!PACKET_ID_PATTERN.test(normalized)) {
    throw new Error('A valid packet id is required to mint a worker credential.');
  }
  return normalized;
}

/**
 * Rewrite the gate's DB-free packet-token file from the unrevoked rows. Callers
 * run it inside the immediate transaction that changes worker_tokens, so the
 * database lock orders every process's rewrite and a stale one can never put a
 * revoked hash back.
 */
export function writeActivePacketWorkerTokenHashes(): void {
  const rows = getSqlite().prepare(`
    SELECT token_hash FROM worker_tokens
    WHERE scope = ? AND revoked_at IS NULL
    ORDER BY created_at, id
  `).all(PACKET_WORKER_SCOPE) as Array<{ token_hash: string }>;
  writePacketWorkerTokenHashes(rows.map((row) => row.token_hash));
}

/** Rebuild the gate's file from the database, dropping any revoked hash it still lists. */
export function syncPacketWorkerTokenHashes(): void {
  getSqlite().transaction(writeActivePacketWorkerTokenHashes).immediate();
}

/** Mint a one-way, packet-bound credential for one local worker process. */
export function mintPacketWorkerToken(
  packetId: string,
  options: { processMarker?: string } = {},
): string {
  const boundPacketId = normalizedPacketId(packetId);
  const processMarker = options.processMarker?.trim() || null;
  if (processMarker && (!/^[A-Za-z0-9._-]{1,160}$/.test(processMarker))) {
    throw new Error('A valid process marker is required to bind a worker credential.');
  }
  const id = `wtok_local_${randomUUID()}`;
  const plaintextToken = `o8pw_${randomBytes(32).toString('base64url')}`;
  const tokenHash = createHash('sha256').update(plaintextToken).digest('hex');
  const now = new Date().toISOString();

  // A failed file write rolls the row back, so no credential exists that the gate cannot see.
  getSqlite().transaction(() => {
    getSqlite().prepare(`
      INSERT INTO worker_tokens
        (id, token_hash, packet_id, label, scope, max_workers, created_at, revoked_at,
         lease_process_marker, lease_process_pid, lease_process_group_id)
      VALUES (?, ?, ?, ?, ?, 1, ?, NULL, ?, NULL, NULL)
    `).run(
      id,
      tokenHash,
      boundPacketId,
      `Local packet ${boundPacketId}`,
      PACKET_WORKER_SCOPE,
      now,
      processMarker,
    );
    writeActivePacketWorkerTokenHashes();
  }).immediate();
  return plaintextToken;
}

export function bindPacketWorkerTokenProcess(
  presented: string,
  input: { pid: number; processGroupId?: number; processMarker: string },
): void {
  if (!Number.isSafeInteger(input.pid) || input.pid <= 0) {
    throw new Error('A live worker process PID is required to bind its credential.');
  }
  const marker = input.processMarker.trim();
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(marker)) {
    throw new Error('A valid process marker is required to bind a worker credential.');
  }
  const processGroupId = input.processGroupId;
  if (processGroupId !== undefined
    && (!Number.isSafeInteger(processGroupId) || processGroupId <= 0)) {
    throw new Error('Worker process group identity is invalid.');
  }
  const tokenHash = createHash('sha256').update(presented).digest('hex');
  const updated = getSqlite().prepare(`
    UPDATE worker_tokens
    SET lease_process_pid = ?, lease_process_group_id = ?
    WHERE token_hash = ? AND scope = ? AND revoked_at IS NULL
      AND lease_process_marker = ?
  `).run(input.pid, processGroupId ?? null, tokenHash, PACKET_WORKER_SCOPE, marker);
  if (updated.changes !== 1) {
    throw new Error('Worker credential process binding could not be persisted.');
  }
}

/** Resolve a packet worker bearer against its authoritative persisted row. */
export function resolvePacketWorkerToken(presented: string): PacketWorkerIdentity | null {
  if (!presented) return null;
  const presentedHash = createHash('sha256').update(presented).digest('hex');
  try {
    const row = getSqlite().prepare(`
      SELECT id, token_hash, packet_id, revoked_at,
             lease_process_marker, lease_process_pid, lease_process_group_id
      FROM worker_tokens
      WHERE token_hash = ? AND scope = ?
      LIMIT 1
    `).get(presentedHash, PACKET_WORKER_SCOPE) as PacketWorkerTokenRow | undefined;
    if (!row || row.revoked_at || !row.packet_id) return null;
    const expected = Buffer.from(row.token_hash, 'hex');
    const actual = Buffer.from(presentedHash, 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    return {
      tokenId: row.id,
      packetId: row.packet_id,
      leaseProcessMarker: row.lease_process_marker,
      leaseProcessPid: row.lease_process_pid,
      leaseProcessGroupId: row.lease_process_group_id,
    };
  } catch {
    return null;
  }
}
