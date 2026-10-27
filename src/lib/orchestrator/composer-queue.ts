import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { getSqlite } from '@/lib/db';
import { readPersistedLlmChat } from '@/lib/llm/chat-history-store';
import { isOrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import { validateComposerImageAttachments, composerBackendSupportsImages } from '@/lib/mobile/composer-image-validation';
import { isOrchestratorServiceTier } from './service-tier';
import { isThinkingEffort } from './thinking-effort';
import { isComposerWireMode } from './composer-wire';
import { assertOrchestratorPermissionMode, isOrchestratorPermissionMode } from './permission-mode';
import { type ComposerQueuePayload, type ComposerQueueTarget, type QueuedComposerSendRecord } from './composer-queue-types';

interface Row {
  sequence: number; id: string; repo_path: string; thread_id: string;
  intent: QueuedComposerSendRecord['intent']; payload_json: string;
  status: QueuedComposerSendRecord['status']; reason: string | null;
  created_at: number; updated_at: number; admitted_at: number | null;
}
const view = (row: Row): QueuedComposerSendRecord => ({ sequence: row.sequence, id: row.id,
  repoPath: row.repo_path, threadId: row.thread_id, intent: row.intent,
  payload: JSON.parse(row.payload_json) as ComposerQueuePayload, status: row.status,
  reason: row.reason, createdAt: row.created_at, updatedAt: row.updated_at, admittedAt: row.admitted_at });

/** Durable keys remain addressable even if a checkout is offline. */
export function composerQueueRepoKey(repoPath: string): string {
  try { return realpathSync(repoPath); } catch { return resolve(repoPath); }
}

export function validateComposerQueueTarget(input: unknown, requireSaved = true): ComposerQueueTarget {
  const target = input as Partial<ComposerQueueTarget> | null;
  if (!target || typeof target.repoPath !== 'string' || !target.repoPath.startsWith('/') || target.repoPath.length > 4096
    || typeof target.threadId !== 'string' || !/^thoughts-[A-Za-z0-9_-]{1,80}$/.test(target.threadId)) throw new Error('A valid repository and chat are required.');
  const history = readPersistedLlmChat(target.threadId);
  if ((!history?.history.repoPath && requireSaved) || (history?.history.repoPath && composerQueueRepoKey(history.history.repoPath) !== composerQueueRepoKey(target.repoPath))) throw new Error('The queued message must target its saved chat repository.');
  return { repoPath: requireSaved ? realpathSync(target.repoPath) : composerQueueRepoKey(target.repoPath), threadId: target.threadId };
}

export function validateComposerQueuePayload(input: unknown): ComposerQueuePayload {
  const payload = input as Partial<ComposerQueuePayload> | null;
  const routing = payload?.routing;
  if (!payload || typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 200_000
    || typeof payload.wireMessage !== 'string' || !payload.wireMessage.trim() || payload.wireMessage.length > 250_000
    || !routing || !isOrchestratorBackendId(routing.backend) || typeof routing.model !== 'string' || !routing.model.trim() || routing.model.length > 500
    || !isThinkingEffort(routing.effort) || (routing.serviceTier !== undefined && !isOrchestratorServiceTier(routing.serviceTier)) || !isOrchestratorPermissionMode(routing.permissionMode)
    || !['single', 'fleet', 'fusion'].includes(routing.mode) || !isComposerWireMode(routing.pickedMode)
    || typeof routing.collide !== 'boolean' || (routing.projectId !== undefined && (typeof routing.projectId !== 'string' || routing.projectId.length > 256))) throw new Error('The queued message needs a complete routing snapshot.');
  assertOrchestratorPermissionMode(routing.collide && routing.mode !== 'single' ? 'collide' : routing.backend, routing.permissionMode);
  const images = validateComposerImageAttachments(payload.images);
  if ((payload.afterTaskId !== undefined && (typeof payload.afterTaskId !== 'string'
    || !/^[A-Za-z0-9_-]{1,160}$/.test(payload.afterTaskId) || routing.pinBackend !== true))
    || (routing.pinBackend !== undefined && routing.pinBackend !== true)
    || (routing.pinBackend && routing.collide)) throw new Error('A bound follow-up requires an exact task and runtime.');
  if (images.length && !composerBackendSupportsImages(routing.backend)) throw new Error('The selected runtime cannot receive these images.');
  return { text: payload.text, wireMessage: payload.wireMessage,
    ...(payload.afterTaskId ? { afterTaskId: payload.afterTaskId } : {}),
    images: images.map(image => ({ name: image.name ?? 'Image', dataUri: image.dataUri })),
    routing: { backend: routing.backend, model: routing.model, effort: routing.effort,
      ...(routing.pinBackend ? { pinBackend: true as const } : {}),
      permissionMode: routing.permissionMode, mode: routing.mode, pickedMode: routing.pickedMode,
      collide: routing.collide, ...(routing.serviceTier ? { serviceTier: routing.serviceTier } : {}), ...(routing.projectId ? { projectId: routing.projectId } : {}) } };
}

export function readComposerSend(id: string): QueuedComposerSendRecord | null {
  const row = getSqlite().prepare('SELECT * FROM composer_send_queue WHERE id = ?').get(id) as Row | undefined;
  return row ? view(row) : null;
}
export function listQueuedComposerSends(target?: ComposerQueueTarget): QueuedComposerSendRecord[] {
  const rows = target ? getSqlite().prepare(`SELECT * FROM composer_send_queue WHERE repo_path = ? AND thread_id = ?
    AND status IN ('queued','dispatching','held') ORDER BY sequence`).all(composerQueueRepoKey(target.repoPath), target.threadId)
    : getSqlite().prepare(`SELECT * FROM composer_send_queue WHERE status IN ('queued','dispatching','held') ORDER BY sequence`).all();
  return (rows as Row[]).map(view);
}
export function listComposerQueueTargets(): ComposerQueueTarget[] {
  return getSqlite().prepare(`SELECT repo_path AS repoPath, thread_id AS threadId FROM composer_send_queue
    WHERE status IN ('queued','dispatching','held') GROUP BY repo_path, thread_id ORDER BY MIN(sequence)`).all() as ComposerQueueTarget[];
}
export function enqueueComposerSend(input: ComposerQueueTarget & { id: string; intent: QueuedComposerSendRecord['intent']; payload: unknown }): QueuedComposerSendRecord {
  if (!['send-next', 'steer-now'].includes(input.intent) || typeof input.id !== 'string' || !/^[A-Za-z0-9_-]{8,120}$/.test(input.id)) throw new Error('A valid queue identity is required.');
  const target = validateComposerQueueTarget(input);
  const payload = validateComposerQueuePayload(input.payload);
  const serialized = JSON.stringify(payload);
  return getSqlite().transaction(() => {
    const existing = readComposerSend(input.id);
    if (existing) {
      if (existing.repoPath !== target.repoPath || existing.threadId !== target.threadId || JSON.stringify(existing.payload) !== serialized) throw new Error('This queue identity already belongs to another message.');
      return existing;
    }
    if (payload.afterTaskId && listQueuedComposerSends(target).some(item => item.payload.afterTaskId)) {
      throw new Error('A voice follow-up is already queued. Remove it before replacing it.');
    }
    if (listQueuedComposerSends(target).length >= 20) throw new Error('This chat already has 20 queued messages. Remove one before adding another.');
    const now = Date.now();
    getSqlite().prepare(`INSERT INTO composer_send_queue (id, repo_path, thread_id, intent, payload_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`).run(input.id, target.repoPath, target.threadId, input.intent, serialized, now, now);
    return readComposerSend(input.id)!;
  })();
}
export function claimNextComposerSend(target: ComposerQueueTarget): QueuedComposerSendRecord | null {
  return getSqlite().transaction(() => {
    const first = listQueuedComposerSends(target)[0];
    if (first?.status !== 'queued' || first.intent !== 'send-next') return null;
    const claimed = getSqlite().prepare(`UPDATE composer_send_queue SET status = 'dispatching', updated_at = ? WHERE id = ? AND status = 'queued' AND intent = 'send-next'`).run(Date.now(), first.id);
    return claimed.changes ? readComposerSend(first.id) : null;
  })();
}

/** A promotion changes intent only; the saved destination and routing stay frozen. */
export function promoteComposerSend(target: ComposerQueueTarget, id: string): QueuedComposerSendRecord {
  return getSqlite().transaction(() => {
    const item = readComposerSend(id);
    if (!item || item.repoPath !== composerQueueRepoKey(target.repoPath) || item.threadId !== target.threadId) throw new Error('This queued message was not found in this chat.');
    if (item.intent === 'steer-now') return item;
    if (item.status !== 'queued' || item.admittedAt !== null || item.payload.afterTaskId) throw new Error('This message cannot be steered after delivery has started.');
    getSqlite().prepare("UPDATE composer_send_queue SET intent = 'steer-now', updated_at = ? WHERE id = ?").run(Date.now(), id);
    return readComposerSend(id)!;
  })();
}

export function claimComposerSteer(id: string): QueuedComposerSendRecord | null {
  const changed = getSqlite().prepare("UPDATE composer_send_queue SET status = 'dispatching', updated_at = ? WHERE id = ? AND status = 'queued' AND intent = 'steer-now' AND admitted_at IS NULL").run(Date.now(), id);
  return changed.changes ? readComposerSend(id) : null;
}

/** A definite refusal can safely become a next turn. Unknown delivery stays held. */
export function deferComposerSteer(id: string, reason: string): void {
  getSqlite().prepare("UPDATE composer_send_queue SET intent = 'send-next', status = 'queued', admitted_at = NULL, reason = ?, updated_at = ? WHERE id = ? AND status = 'dispatching'").run(reason, Date.now(), id);
}

export function listComposerTranscriptSends(target: ComposerQueueTarget): QueuedComposerSendRecord[] {
  const applied = getSqlite().prepare("SELECT * FROM composer_send_queue WHERE repo_path = ? AND thread_id = ? AND intent = 'steer-now' AND status = 'applied' ORDER BY sequence DESC LIMIT 40")
    .all(composerQueueRepoKey(target.repoPath), target.threadId) as Row[];
  const messages = readPersistedLlmChat(target.threadId)?.history.messages ?? [];
  return [...applied.map(view), ...listQueuedComposerSends(target)].sort((a, b) => a.sequence - b.sequence)
    .map(item => ({ ...item, steerAnchor: messages.find(message => message.id === `composer-steer-${item.id}`)?.steerAnchor }));
}
/** Recheck after every asynchronous preparation step, immediately before provider admission. */
export function assertComposerSendClaim(id: string): void {
  if (readComposerSend(id)?.status !== 'dispatching') throw new Error('The queued message was cancelled or held before execution.');
}
export function admitComposerSend(id: string): boolean {
  return getSqlite().prepare(`UPDATE composer_send_queue SET admitted_at = ?, updated_at = ?
    WHERE id = ? AND status = 'dispatching' AND admitted_at IS NULL`).run(Date.now(), Date.now(), id).changes > 0;
}
export function settleComposerSend(id: string, outcome: { status: 'applied' | 'held'; reason?: string }): boolean {
  return getSqlite().prepare(`UPDATE composer_send_queue SET status = ?, reason = ?, updated_at = ? WHERE id = ? AND status = 'dispatching' AND (? != 'applied' OR admitted_at IS NOT NULL)`)
    .run(outcome.status, outcome.reason ?? null, Date.now(), id, outcome.status).changes > 0;
}
export function cancelComposerSend(target: ComposerQueueTarget, id: string): boolean {
  return getSqlite().prepare(`UPDATE composer_send_queue SET status = 'cancelled', reason = 'Removed by operator.', updated_at = ?
    WHERE id = ? AND repo_path = ? AND thread_id = ? AND (status IN ('queued','held') OR (status = 'dispatching' AND admitted_at IS NULL))`)
    .run(Date.now(), id, composerQueueRepoKey(target.repoPath), target.threadId).changes > 0;
}
/** A provider may have received an interrupted dispatch. Never replay uncertain work. */
export function recoverComposerSends(): void {
  getSqlite().prepare(`UPDATE composer_send_queue SET status = 'held', reason = 'Delivery interrupted. Inspect the chat before sending again.', updated_at = ? WHERE status = 'dispatching'`).run(Date.now());
}
/** Stop also fences a claimed item while server preparation is still awaiting. */
export function holdComposerSends(target: ComposerQueueTarget): void {
  getSqlite().prepare(`UPDATE composer_send_queue SET status = 'held', reason = 'Chat stopped.', updated_at = ?
    WHERE repo_path = ? AND thread_id = ? AND status IN ('queued','dispatching')`).run(Date.now(), composerQueueRepoKey(target.repoPath), target.threadId);
}
