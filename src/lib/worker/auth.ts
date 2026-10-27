import 'server-only';

import { createHash, timingSafeEqual } from 'node:crypto';
import { getSqlite } from '@/lib/db';

export interface VerifyOk {
  ok: true;
  workerTokenId: string;
}

export interface VerifyErr {
  ok: false;
  status: 401 | 403;
}

interface WorkerTokenRow {
  id: string;
  token_hash: string;
  revoked_at: string | null;
  scope: string;
}

export function verifyWorkerToken(authHeader: string | null): VerifyOk | VerifyErr {
  if (!authHeader?.startsWith('Bearer ')) {
    return { ok: false, status: 401 };
  }

  const token = authHeader.slice(7).trim();
  if (token.startsWith('o8ro_') || token.startsWith('o8br_')) return { ok: false, status: 403 };
  if (!token) {
    return { ok: false, status: 401 };
  }

  const hexHash = createHash('sha256').update(token).digest('hex');

  try {
    const row = getSqlite()
      .prepare(`
        SELECT id, token_hash, revoked_at, scope
        FROM worker_tokens
        WHERE token_hash = ?
        LIMIT 1
      `)
      .get(hexHash) as WorkerTokenRow | undefined;

    if (!row) {
      return { ok: false, status: 401 };
    }

    const presentedHash = Buffer.from(hexHash, 'hex');
    const storedHash = Buffer.from(row.token_hash, 'hex');
    if (storedHash.length !== presentedHash.length || !timingSafeEqual(storedHash, presentedHash)) {
      return { ok: false, status: 401 };
    }

    if (row.revoked_at || row.scope === 'local-read-only') {
      return { ok: false, status: 403 };
    }

    return {
      ok: true,
      workerTokenId: row.id,
    };
  } catch (error) {
    console.error('[worker-auth] lookup failed:', error);
    throw error;
  }
}
