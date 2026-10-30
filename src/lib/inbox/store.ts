/**
 * Adapted from T3 Code (https://github.com/pingdotgg/t3code),
 * apps/server/src/orchestration-v2/Orchestrator.ts, commit
 * f58fad04162165653bf06f0c987bbfb0074a8a4b.
 * Copyright (c) 2026 T3 Tools Inc.; MIT; see licenses/t3code-MIT.txt.
 * Adapted for o8: atomic metadata in the existing SQLite app_state store,
 * separate from transcripts; shared WS/API activity and native read projection.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { getSqlite } from '@/lib/db';
import { emptySettlement, transitionSettlement, type InboxSettlement, type InboxSubject } from './settlement';

interface StoredInboxState extends InboxSettlement {
  runStatus?: 'running' | 'idle';
  runAt?: string;
  ownerPid?: number;
  observedRunAt?: string;
  overrideAt?: string;
}
export function inboxSubject(kind: InboxSubject['kind'], id: string, workspace: unknown, projectId?: unknown): InboxSubject {
  let path = typeof workspace === 'string' && workspace ? resolve(workspace) : null;
  if (path) { try { path = realpathSync.native(path); } catch { /* Offline checkout retains its recorded path. */ } }
  return { kind, id, workspace: path, projectId: typeof projectId === 'string' && projectId.trim() ? projectId.trim() : null };
}
function key(subject: InboxSubject): string {
  // Project metadata can be attached after creation. Recorded workspace and
  // qualified identity remain stable when the operator changes project scope.
  return `inbox:subject:${JSON.stringify([subject.kind, subject.workspace, subject.id])}`;
}
export function readInboxState(subject: InboxSubject): StoredInboxState {
  const row = getSqlite().prepare('SELECT value FROM app_state WHERE key = ?').get(key(subject)) as { value: string } | undefined;
  return row ? JSON.parse(row.value) as StoredInboxState : emptySettlement();
}
function write(subject: InboxSubject, state: StoredInboxState): void {
  getSqlite().prepare(`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key(subject), JSON.stringify(state), Date.now());
}
export function mutateInboxSettlement(subject: InboxSubject, action: 'settle' | 'unsettle', guard: () => void, wasPinned = false): InboxSettlement {
  return getSqlite().transaction(() => {
    guard();
    const state = readInboxState(subject);
    const now = new Date().toISOString();
    const transitioned = transitionSettlement(state, action, now);
    if (action === 'settle' && wasPinned) transitioned.settledAt = now;
    if (transitioned.settledOverride === state.settledOverride && transitioned.settledAt === state.settledAt
      && transitioned.unsettledAt === state.unsettledAt) return state;
    const next = { ...state, ...transitioned, overrideAt: now };
    write(subject, next);
    return next;
  }).immediate();
}
export function inboxProjection(subject: InboxSubject, parentInboxSubject: InboxSubject | null = null) {
  const state = readInboxState(subject);
  return { inboxSubject: subject, parentInboxSubject, settledOverride: state.settledOverride, settledAt: state.settledAt, unsettledAt: state.unsettledAt };
}

/** Called by the WS broadcast chokepoint, never by a client history save. */
export function recordInboxConversationEvent(event: { event?: string; data?: { threadId?: unknown; repoPath?: unknown; status?: unknown } }): void {
  const data = event.data;
  if (typeof data?.threadId !== 'string' || !data.threadId.startsWith('thoughts-') || typeof data.repoPath !== 'string') return;
  const busy = event.event === 'status' && data.status === 'busy';
  const finished = event.event === 'error' || (event.event === 'status' && ['ready', 'dead', 'failed'].includes(String(data.status)));
  if (!busy && !finished) return;
  const subject = inboxSubject('conversation', data.threadId, data.repoPath);
  getSqlite().transaction(() => {
    const prior = readInboxState(subject);
    const now = new Date().toISOString();
    write(subject, { ...prior, ...(busy ? transitionSettlement(prior, 'run', now) : {}),
      runStatus: busy ? 'running' : 'idle', runAt: now, ownerPid: process.pid });
  }).immediate();
}

/** A lifecycle run-start is evidence; lastActivityAt also includes metadata. */
export function observeInboxRuntimeRun(subject: InboxSubject, startedAt: string | undefined): void {
  if (!startedAt || !Number.isFinite(Date.parse(startedAt))) return;
  getSqlite().transaction(() => {
    const prior = readInboxState(subject);
    if (prior.observedRunAt && Date.parse(prior.observedRunAt) >= Date.parse(startedAt)) return;
    const next = prior.overrideAt && Date.parse(startedAt) > Date.parse(prior.overrideAt) && prior.settledOverride !== null
      ? transitionSettlement(prior, 'run', startedAt) : {};
    write(subject, { ...prior, ...next, observedRunAt: startedAt });
  }).immediate();
}
