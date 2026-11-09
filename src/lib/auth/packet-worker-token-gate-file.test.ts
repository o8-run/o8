import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';

// Every rewrite of the gate's packet-token file must happen while its process holds the database
// write lock: that lock is what orders rewrites from different processes, so a stale rewrite can
// never put a revoked hash back. The startup rebuild only reads before it writes, so only an
// immediate transaction gives it that lock.
const writesUnderWriteLock: boolean[] = [];
vi.mock('@/lib/auth/worker-token', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/worker-token')>();
  const { getSqlite } = await import('@/lib/db');
  return {
    ...actual,
    writePacketWorkerTokenHashes: (hashes: string[]) => {
      // Another connection, as another process would open it, cannot take the write lock now.
      const other = new Database(getSqlite().name, { timeout: 0 });
      try {
        other.exec('BEGIN IMMEDIATE');
        other.exec('ROLLBACK');
        writesUnderWriteLock.push(false);
      } catch (error) {
        writesUnderWriteLock.push((error as { code?: string }).code === 'SQLITE_BUSY');
      } finally {
        other.close();
      }
      actual.writePacketWorkerTokenHashes(hashes);
    },
  };
});

it('rewrites the gate file only while the changing transaction holds the write lock', async () => {
  const { mintPacketWorkerToken, syncPacketWorkerTokenHashes } = await import('@/lib/auth/packet-worker-token');
  const { revokeToken } = await import('@/lib/worker/tokens');
  const { getSqlite } = await import('@/lib/db');
  const { PACKET_WORKER_TOKEN_HASHES_PATH } = await import('@/lib/auth/worker-token');
  const hash = (token: string) => createHash('sha256').update(token).digest('hex');

  const kept = mintPacketWorkerToken('fixture-gate-file-kept');
  const revoked = mintPacketWorkerToken('fixture-gate-file-revoked');
  const { id } = getSqlite().prepare('SELECT id FROM worker_tokens WHERE token_hash = ?').get(hash(revoked)) as { id: string };
  expect(revokeToken(id)).toBe(true);
  syncPacketWorkerTokenHashes();

  expect(writesUnderWriteLock).toEqual([true, true, true, true]);
  const file = readFileSync(PACKET_WORKER_TOKEN_HASHES_PATH, 'utf8');
  expect(file).toContain(hash(kept));
  expect(file).not.toContain(hash(revoked));
});
