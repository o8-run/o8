import 'server-only';

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getSqlite } from '@/lib/db';
import { writeActivePacketWorkerTokenHashes } from '@/lib/auth/packet-worker-token';

export type FleetStatusKind = 'running' | 'completed' | 'failed' | 'cancelled';

export interface WorkerTokenSummary {
  id: string;
  label: string | null;
  scope: string;
  maxWorkers: number;
  createdAt: string;
  revokedAt: string | null;
}

export interface FleetStatusCounts {
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
}

export interface FleetTokenSummary {
  tokenId: string;
  label: string | null;
  totalRuns: number;
  lastRunAt: string;
  hasActiveRuns: boolean;
  counts: FleetStatusCounts;
}

export interface FleetStatusSummary {
  counts: FleetStatusCounts;
  tokens: FleetTokenSummary[];
}

interface FleetRunRow {
  worker_token_id: string;
  label: string | null;
  status: string;
  started_at: string;
  completed_at: string | null;
  last_event_at: string;
}

function createEmptyCounts(): FleetStatusCounts {
  return {
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeStatus(status: string): FleetStatusKind {
  if (status === 'completed') return 'completed';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'errored' || status === 'failed') return 'failed';
  return 'running';
}

function getRunTimestamp(row: FleetRunRow) {
  return row.last_event_at || row.completed_at || row.started_at;
}

export function listTokens(): WorkerTokenSummary[] {
  return getSqlite()
    .prepare(`
      SELECT id, label, scope, max_workers, created_at, revoked_at
      FROM worker_tokens
      ORDER BY created_at DESC
    `)
    .all()
    .map((row) => {
      const token = row as {
        id: string;
        label: string | null;
        scope: string;
        max_workers: number;
        created_at: string;
        revoked_at: string | null;
      };

      return {
        id: token.id,
        label: token.label,
        scope: token.scope,
        maxWorkers: token.max_workers,
        createdAt: token.created_at,
        revokedAt: token.revoked_at,
      };
    });
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

export function getFleetStatus(): FleetStatusSummary {
  const rows = getSqlite()
    .prepare(`
      SELECT wr.worker_token_id, wt.label, wr.status, wr.started_at, wr.completed_at, wr.last_event_at
      FROM worker_runs wr
      JOIN worker_tokens wt ON wt.id = wr.worker_token_id
      ORDER BY COALESCE(wr.last_event_at, wr.completed_at, wr.started_at) DESC
      LIMIT 100
    `)
    .all() as FleetRunRow[];

  const counts = createEmptyCounts();
  const tokenMap = new Map<string, FleetTokenSummary>();

  for (const row of rows) {
    const status = normalizeStatus(row.status);
    counts[status] += 1;

    const existing = tokenMap.get(row.worker_token_id) ?? {
      tokenId: row.worker_token_id,
      label: row.label,
      totalRuns: 0,
      lastRunAt: getRunTimestamp(row),
      hasActiveRuns: false,
      counts: createEmptyCounts(),
    };

    existing.totalRuns += 1;
    existing.counts[status] += 1;
    existing.hasActiveRuns = existing.hasActiveRuns || status === 'running';

    const runAt = getRunTimestamp(row);
    if (runAt > existing.lastRunAt) {
      existing.lastRunAt = runAt;
    }

    tokenMap.set(row.worker_token_id, existing);
  }

  return {
    counts,
    tokens: [...tokenMap.values()].sort((a, b) => {
      if (a.hasActiveRuns !== b.hasActiveRuns) {
        return a.hasActiveRuns ? -1 : 1;
      }
      if (a.lastRunAt !== b.lastRunAt) {
        return a.lastRunAt > b.lastRunAt ? -1 : 1;
      }
      return b.totalRuns - a.totalRuns;
    }),
  };
}
