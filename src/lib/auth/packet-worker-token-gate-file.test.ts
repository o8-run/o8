import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';

// Every rewrite of the gate's packet-token file must happen inside the transaction that changed
// worker_tokens: the database lock is what orders rewrites from different processes, so a stale
// rewrite can never put a revoked hash back.
const writesInTransaction: boolean[] = [];
vi.mock('@/lib/auth/worker-token', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/worker-token')>();
  const { getSqlite } = await import('@/lib/db');
  return {
    ...actual,
    writePacketWorkerTokenHashes: (hashes: string[]) => {
      writesInTransaction.push(getSqlite().inTransaction);
      actual.writePacketWorkerTokenHashes(hashes);
    },
  };
});

it('rewrites the gate file only while the changing transaction holds the database', async () => {
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

  expect(writesInTransaction).toEqual([true, true, true, true]);
  const file = readFileSync(PACKET_WORKER_TOKEN_HASHES_PATH, 'utf8');
  expect(file).toContain(hash(kept));
  expect(file).not.toContain(hash(revoked));
});
