import 'server-only';

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getSqlite } from '@/lib/db';
import { writeActivePacketWorkerTokenHashes } from '@/lib/auth/packet-worker-token';

function nowIso() {
  return new Date().toISOString();
}

export function createToken(input: {
  label: string;
  scope?: string;
  maxWorkers?: number;
}): { id: string; plaintextToken: string } {
  const label = input.label.trim();
  const scope = input.scope?.trim() || 'customer-worker';
  const maxWorkers = Number.isFinite(input.maxWorkers)
    ? Math.max(1, Math.floor(input.maxWorkers as number))
    : 10;
  const id = `wtok_${randomUUID()}`;
  const plaintextToken = `o8wt_${randomBytes(32).toString('base64url')}`;
  const tokenHash = createHash('sha256').update(plaintextToken).digest('hex');

  getSqlite()
    .prepare(`
      INSERT INTO worker_tokens (id, token_hash, label, scope, max_workers, created_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
    `)
    .run(id, tokenHash, label || null, scope, maxWorkers, nowIso());

  return { id, plaintextToken };
}

export function revokeToken(id: string): boolean {
  return getSqlite().transaction(() => {
    const result = getSqlite()
      .prepare(`
        UPDATE worker_tokens
        SET revoked_at = COALESCE(revoked_at, ?)
        WHERE id = ?
      `)
      .run(nowIso(), id);
    // The middleware gate recognizes packet credentials from a file; drop a revoked one now.
    if (result.changes > 0) writeActivePacketWorkerTokenHashes();
    return result.changes > 0;
  }).immediate();
}
