import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { getSqlite } from '@/lib/db';
import { readPersistedLlmChat } from '@/lib/llm/chat-history-store';
import { readOwnedRecoveryState } from '@/lib/runtimes/shared/owned-session/automatic-recovery';
import { archiveRootForOwnedSessionRoot } from '@/lib/runtimes/shared/owned-session/archive';
import { ownedRoots } from '@/lib/runtimes/shared/owned-session-index';
import { manualReviewRequested } from '@/lib/lane/review-mode';
import { resolveReviewContinuationSync } from '@/lib/operator/defaults';
import { assertSharedCheckoutOwner, readActiveSharedCheckoutTeam } from './shared-checkout-team';
import { resolveChatTurnOrigin, type ReviewChatOrigin } from './review-continuation-origin';

interface ParentRow {
  surface_id: string; repo_path: string; thread_id: string; turn_id: string;
  origin_json: string; stopped_at: number | null;
}
export interface SharedWorkerReturn {
  id: string; surface_id: string; run_id: string; outcome: string; summary: string;
  status: 'pending' | 'running' | 'delivered' | 'held'; reason: string | null;
}
export interface SharedWorkerReturnBatch {
  repoPath: string; origin: ReviewChatOrigin; returns: SharedWorkerReturn[];
}
export interface SharedWorkerReturnHooks {
  readTranscript(surfaceId: string, limit: number): Promise<Array<{ id: string; role: string; text: string; timestamp?: number }>>;
  isBusy(repoPath: string, origin: ReviewChatOrigin): boolean;
  run(batch: SharedWorkerReturnBatch): Promise<void>;
  changed?(surfaceId: string): void;
}
let reconciling = false;
/** Per parent, the evidence stamp at which its worker last had nothing new to record. */
const settledEvidence = new Map<string, string>();

/**
 * Everything the record step reads about one worker: its session record, live
 * or archived (session saves replace the file), and its stored results. Finding
 * a session reads every session record in the store, so an unchanged stamp
 * skips that read.
 */
async function workerEvidenceStamp(db: ReturnType<typeof getSqlite>, surfaceId: string): Promise<string> {
  const root = ownedRoots().find(entry => surfaceId.startsWith(entry.marker));
  const name = root ? surfaceId.slice(root.marker.length) : '';
  const files = root && /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name)
    ? [join(root.root, name, 'session.json'), join(archiveRootForOwnedSessionRoot(root.root), name, 'session.json')]
    : [];
  const sessions = await Promise.all(files.map(file => stat(file).then(info => `${info.ino}:${info.size}:${info.mtimeMs}`, () => 'x')));
  const results = db.prepare('SELECT COUNT(*) AS count, MAX(updated_at) AS at FROM shared_worker_returns WHERE surface_id = ?')
    .get(surfaceId) as { count: number; at: number | null };
  return `${root?.marker ?? '-'}|${sessions.join('|')}|${results.count}:${results.at ?? ''}`;
}

export function registerSharedWorkerParent(input: {
  repoPath: string; surfaceId: string; origin: ReviewChatOrigin;
}): void {
  const { origin } = input;
  const sqlite = getSqlite();
  const existing = sqlite.prepare('SELECT * FROM shared_worker_parents WHERE surface_id = ?').get(input.surfaceId) as ParentRow | undefined;
  if (existing) {
    if (existing.repo_path !== input.repoPath || existing.thread_id !== origin.threadId || existing.turn_id !== origin.turnId) {
      throw new Error('Worker parent binding changed.');
    }
    return;
  }
  sqlite.prepare(`INSERT INTO shared_worker_parents
    (surface_id, repo_path, thread_id, turn_id, origin_json, created_at, stopped_at)
    VALUES (?, ?, ?, ?, ?, ?, (SELECT stopped_at FROM shared_worker_return_stops WHERE repo_path = ? AND thread_id = ? AND turn_id = ?))`)
    .run(input.surfaceId, input.repoPath, origin.threadId, origin.turnId, JSON.stringify(origin), Date.now(), input.repoPath, origin.threadId, origin.turnId);
}

export function stopSharedWorkerReturns(repoPath: string, threadId: string): void {
  const db = getSqlite();
  db.transaction(() => {
    // A dispatch may still be awaiting its process launch. Fence its existing
    // parent turn even before there is a surface to bind to it.
    const turns = new Set((readPersistedLlmChat(threadId)?.history.messages ?? [])
      .filter(row => row.role === 'assistant').map(row => row.id));
    for (const row of db.prepare('SELECT turn_id FROM shared_worker_parents WHERE repo_path = ? AND thread_id = ?')
      .all(repoPath, threadId) as Array<{ turn_id: string }>) turns.add(row.turn_id);
    for (const turnId of turns) db.prepare('INSERT OR IGNORE INTO shared_worker_return_stops VALUES (?, ?, ?, ?)')
      .run(repoPath, threadId, turnId, Date.now());
    db.prepare('UPDATE shared_worker_parents SET stopped_at = ? WHERE repo_path = ? AND thread_id = ?')
      .run(Date.now(), repoPath, threadId);
    db.prepare(`UPDATE shared_worker_returns SET status = 'held', reason = 'Parent stopped.', updated_at = ?
      WHERE status = 'pending' AND surface_id IN
      (SELECT surface_id FROM shared_worker_parents WHERE repo_path = ? AND thread_id = ?)`)
      .run(Date.now(), repoPath, threadId);
  })();
}

/** An admitted provider call may have executed. Keep its result receipt; never replay blindly. */
export function recoverSharedWorkerReturns(): void {
  getSqlite().prepare(`UPDATE shared_worker_returns SET status = 'held',
    reason = 'Parent delivery interrupted; inspect the original chat before resuming.', updated_at = ?
    WHERE status = 'running'`).run(Date.now());
}

/**
 * True when the worker's newest result reached its parent chat. With `runId`,
 * only a delivered result of that exact run counts.
 */
export function sharedWorkerResultDelivered(surfaceId: string, runId?: string | null): boolean {
  const row = getSqlite().prepare(`SELECT run_id, status FROM shared_worker_returns WHERE surface_id = ?
    ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(surfaceId) as { run_id: string; status: string } | undefined;
  return row?.status === 'delivered' && (!runId || row.run_id === runId);
}

export function listSharedWorkerReturns(threadId: string): SharedWorkerReturn[] {
  return getSqlite().prepare(`SELECT r.* FROM shared_worker_returns r
    JOIN shared_worker_parents p ON p.surface_id = r.surface_id WHERE p.thread_id = ?
    ORDER BY r.created_at, r.rowid`).all(threadId) as SharedWorkerReturn[];
}

function activeMembership(parent: ParentRow): boolean {
  try {
    const team = readActiveSharedCheckoutTeam(parent.repo_path);
    return team?.parentThreadId === parent.thread_id
      && team.members.some(member => member.surfaceId === parent.surface_id);
  } catch { return false; }
}

export function sharedReturnBlockReason(parent: ParentRow, origin: ReviewChatOrigin): string | null {
  const current = getSqlite().prepare('SELECT * FROM shared_worker_parents WHERE surface_id = ?').get(parent.surface_id) as ParentRow | undefined;
  if (!current || current.stopped_at !== null) return 'Parent stopped.';
  if (!activeMembership(parent)) return 'Shared checkout ownership is no longer active.';
  try { assertSharedCheckoutOwner({ repoPath: parent.repo_path, parentThreadId: parent.thread_id }); }
  catch { return 'Shared checkout branch or ownership changed.'; }
  if (manualReviewRequested() || !resolveReviewContinuationSync()) return 'Automatic continuation is paused.';
  const binding = resolveChatTurnOrigin({ repoPath: parent.repo_path, threadId: parent.thread_id, turnId: parent.turn_id });
  if (binding.kind !== 'bound' || JSON.stringify(binding.origin) !== JSON.stringify(origin)) return 'Parent chat routing or origin changed.';
  return null;
}

/** Re-check immediately before the provider call, including after project/context awaits. */
export function assertSharedReturnBatchActive(batch: SharedWorkerReturnBatch): void {
  for (const returned of batch.returns) {
    const parent = getSqlite().prepare('SELECT * FROM shared_worker_parents WHERE surface_id = ?').get(returned.surface_id) as ParentRow | undefined;
    if (!parent || parent.repo_path !== batch.repoPath || parent.thread_id !== batch.origin.threadId
      || parent.turn_id !== batch.origin.turnId) throw new Error('Worker return binding is unavailable.');
    const reason = sharedReturnBlockReason(parent, batch.origin);
    if (reason) throw new Error(reason);
  }
}

/** Reconcile on the existing supervisor heartbeat, with no second timer or model-based polling. */
export async function reconcileSharedWorkerReturns(hooks: SharedWorkerReturnHooks): Promise<void> {
  if (reconciling) return;
  reconciling = true;
  const db = getSqlite();
  const deliveries: Promise<void>[] = [];
  try {
    const parents = db.prepare('SELECT * FROM shared_worker_parents').all() as ParentRow[];
    for (const surfaceId of settledEvidence.keys()) {
      if (!parents.some(parent => parent.surface_id === surfaceId)) settledEvidence.delete(surfaceId);
    }
    for (const parent of parents) {
      if (!activeMembership(parent)) continue;
      const evidence = await workerEvidenceStamp(db, parent.surface_id);
      if (settledEvidence.get(parent.surface_id) === evidence) continue;
      const state = await readOwnedRecoveryState(parent.surface_id, { includeArchived: true });
      if (!state.owned || !state.runId || !state.outcome || state.outcome === 'running'
        || db.prepare('SELECT 1 FROM shared_worker_returns WHERE surface_id = ? AND run_id = ?').get(parent.surface_id, state.runId)) {
        settledEvidence.set(parent.surface_id, evidence);
        continue;
      }
      const entries = await hooks.readTranscript(parent.surface_id, 80);
      const current = await readOwnedRecoveryState(parent.surface_id, { includeArchived: true });
      if (!current.owned || current.runId !== state.runId || current.outcome !== state.outcome) continue;
      // Owned transcript parsers namespace entries by run ID. Wall clocks can
      // move across process boundaries; only exact generation evidence belongs
      // to this result, even when an older answer has a plausible timestamp.
      const answer = entries.filter(entry => entry.role === 'assistant' && entry.text.trim()
        && entry.id.startsWith(`${state.runId}:`)).at(-1);
      const summary = answer?.text.slice(0, 12_000) ?? 'No attributable answer was available. Inspect this worker before accepting its work.';
      const id = createHash('sha256').update(`${parent.surface_id}\0${state.runId}`).digest('hex').slice(0, 32);
      const now = Date.now();
      const inserted = db.prepare(`INSERT OR IGNORE INTO shared_worker_returns
        (id, surface_id, run_id, outcome, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(id, parent.surface_id, state.runId, state.interrupted ? 'interrupted' : state.outcome, summary, now, now);
      if (inserted.changes) hooks.changed?.(parent.surface_id);
    }
    const groups = new Map<string, { parent: ParentRow; origin: ReviewChatOrigin; returns: SharedWorkerReturn[] }>();
    for (const parent of parents) {
      const rows = db.prepare("SELECT * FROM shared_worker_returns WHERE surface_id = ? AND status = 'pending' ORDER BY created_at")
        .all(parent.surface_id) as SharedWorkerReturn[];
      if (!rows.length) continue;
      const origin = JSON.parse(parent.origin_json) as ReviewChatOrigin;
      const reason = sharedReturnBlockReason(parent, origin);
      if (reason) {
        db.prepare("UPDATE shared_worker_returns SET status = 'held', reason = ?, updated_at = ? WHERE surface_id = ? AND status = 'pending'")
          .run(reason, Date.now(), parent.surface_id);
        hooks.changed?.(parent.surface_id);
        continue;
      }
      const key = `${parent.repo_path}\0${parent.thread_id}\0${parent.turn_id}`;
      const group = groups.get(key) ?? { parent, origin, returns: [] };
      group.returns.push(...rows); groups.set(key, group);
    }
    for (const group of groups.values()) {
      if (hooks.isBusy(group.parent.repo_path, group.origin)) continue;
      const batch = { repoPath: group.parent.repo_path, origin: group.origin, returns: group.returns };
      const settleFailure = (error: unknown) => {
        for (const row of group.returns) db.prepare("UPDATE shared_worker_returns SET status = 'held', reason = ?, updated_at = ? WHERE id = ?")
          .run(error instanceof Error ? error.message : 'Parent delivery failed.', Date.now(), row.id);
      };
      try {
        const claimed = db.transaction(() => {
          assertSharedReturnBatchActive(batch);
          if (group.returns.some(row => (db.prepare('SELECT status FROM shared_worker_returns WHERE id = ?').get(row.id) as { status: string }).status !== 'pending')) return false;
          for (const row of group.returns) db.prepare("UPDATE shared_worker_returns SET status = 'running', updated_at = ? WHERE id = ?").run(Date.now(), row.id);
          return true;
        })();
        if (!claimed) continue;
        for (const row of group.returns) hooks.changed?.(row.surface_id);
        deliveries.push(hooks.run(batch).then(() => {
          for (const row of group.returns) db.prepare("UPDATE shared_worker_returns SET status = 'delivered', updated_at = ? WHERE id = ?").run(Date.now(), row.id);
        }).catch(settleFailure).finally(() => {
          for (const row of group.returns) hooks.changed?.(row.surface_id);
        }));
      } catch (error) {
        settleFailure(error);
        for (const row of group.returns) hooks.changed?.(row.surface_id);
      }
    }
  } finally { reconciling = false; }
  // Provider turns can be long. Their durable running claims and normal chat
  // abort registry prevent duplicates; do not stall observation of other chats.
  await Promise.all(deliveries);
}
