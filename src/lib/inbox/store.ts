/**
 * Adapted from T3 Code (https://github.com/pingdotgg/t3code),
 * apps/server/src/orchestration-v2/Orchestrator.ts, commit
 * f58fad04162165653bf06f0c987bbfb0074a8a4b.
 * Copyright (c) 2026 T3 Tools Inc.; MIT; see licenses/t3code-MIT.txt.
 * Adapted for o8: atomic metadata in the existing SQLite app_state store,
 * separate from transcripts; shared WS/API activity and native read projection.
 */
import type Database from 'better-sqlite3';
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
type InboxReadStatement = Database.Statement<unknown[]>;
const readStatements = new WeakMap<ReturnType<typeof getSqlite>, Map<string, InboxReadStatement>>();
/** Cache compilation, never results; a reopened database gets its own statements. */
export function inboxReadStatement(sql: string, raw = false): InboxReadStatement {
  const db = getSqlite();
  let statements = readStatements.get(db);
  if (!statements) { statements = new Map(); readStatements.set(db, statements); }
  const cacheKey = `${raw ? 'raw:' : 'object:'}${sql}`;
  let statement = statements.get(cacheKey);
  if (!statement) {
    statement = db.prepare(sql).raw(raw);
    statements.set(cacheKey, statement);
  }
  return statement;
}
const workspaceCache = new Map<string, { path: string; expiresAt: number }>();
const subjectKeys = new WeakMap<InboxSubject, string>();
/** Reads and mutations share canonical identities, bounded to 256 paths / 30 seconds. */
function canonicalWorkspace(recorded: string): string {
  const absolute = resolve(recorded);
  const now = Date.now();
  const cached = workspaceCache.get(absolute);
  if (cached && cached.expiresAt > now) return cached.path;
  let path = absolute;
  try { path = realpathSync.native(absolute); } catch { /* Offline checkout retains its recorded path. */ }
  workspaceCache.delete(absolute);
  if (workspaceCache.size >= 256) workspaceCache.delete(workspaceCache.keys().next().value!);
  workspaceCache.set(absolute, { path, expiresAt: now + 30_000 });
  return path;
}
export interface InboxReadContext {
  states: Map<string, StoredInboxState>;
  workspaces: Map<string, string | null>;
}
/** One indexed prefix read per listing; never retained across requests. */
export function createInboxReadContext(kind?: InboxSubject['kind']): InboxReadContext {
  const prefix = kind ? `inbox:subject:["${kind}",` : 'inbox:subject:';
  const upper = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
  const rows = inboxReadStatement('SELECT key, value FROM app_state WHERE key >= ? AND key < ?')
    .all(prefix, upper) as Array<{ key: string; value: string }>;
  return { states: new Map(rows.map(row => [row.key, JSON.parse(row.value) as StoredInboxState])), workspaces: new Map() };
}
export function inboxSubject(kind: InboxSubject['kind'], id: string, workspace: unknown, projectId?: unknown, workspaces?: InboxReadContext['workspaces']): InboxSubject {
  let path = typeof workspace === 'string' && workspace ? workspace : null;
  if (path) {
    const recorded = path;
    if (workspaces?.has(recorded)) path = workspaces.get(recorded) ?? null;
    else {
      path = canonicalWorkspace(path);
      workspaces?.set(recorded, path);
    }
  }
  return { kind, id, workspace: path, projectId: typeof projectId === 'string' && projectId.trim() ? projectId.trim() : null };
}
function key(subject: InboxSubject): string {
  // Project metadata can be attached after creation. Recorded workspace and
  // qualified identity remain stable when the operator changes project scope.
  let stored = subjectKeys.get(subject);
  if (!stored) {
    stored = `inbox:subject:${JSON.stringify([subject.kind, subject.workspace, subject.id])}`;
    subjectKeys.set(subject, stored);
  }
  return stored;
}
/** No default-state allocation on read-only listing rows. */
export function inboxListingState(subject: InboxSubject, context: InboxReadContext): StoredInboxState | undefined {
  return context.states.size ? context.states.get(key(subject)) : undefined;
}
export function readInboxState(subject: InboxSubject, context?: InboxReadContext): StoredInboxState {
  if (context) return inboxListingState(subject, context) ?? emptySettlement();
  const row = inboxReadStatement('SELECT value FROM app_state WHERE key = ?').get(key(subject)) as { value: string } | undefined;
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
type InboxProjection = InboxSettlement & { inboxSubject: InboxSubject; parentInboxSubject: InboxSubject | null };
export interface InboxListingProjection {
  inboxSubject: InboxSubject;
  parentInboxSubject?: InboxSubject;
  settledOverride?: NonNullable<InboxSettlement['settledOverride']>;
  settledAt?: string;
  unsettledAt?: string;
}
/** Listing rows omit null fields on the wire; inboxSubject is always the capability flag. */
export function inboxListingProjection<T extends object>(subject: InboxSubject, parent: InboxSubject | null,
  context: InboxReadContext | undefined, base: T): T & InboxListingProjection {
  const state = context ? inboxListingState(subject, context) : readInboxState(subject);
  return Object.assign({}, base, { inboxSubject: subject, parentInboxSubject: parent ?? undefined,
    settledOverride: state?.settledOverride ?? undefined, settledAt: state?.settledAt ?? undefined,
    unsettledAt: state?.unsettledAt ?? undefined });
}
/** Mutation and mobile responses retain the full nullable shape. */
export function inboxProjection(subject: InboxSubject, parentInboxSubject: InboxSubject | null = null, context?: InboxReadContext): InboxProjection {
  const state = context ? inboxListingState(subject, context) : readInboxState(subject);
  return { inboxSubject: subject, parentInboxSubject, settledOverride: state?.settledOverride ?? null,
    settledAt: state?.settledAt ?? null, unsettledAt: state?.unsettledAt ?? null };
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
export function observeInboxRuntimeRun(subject: InboxSubject, startedAt: string | undefined, context?: InboxReadContext): void {
  if (!startedAt) return;
  const observed = readInboxState(subject, context).observedRunAt;
  if (observed === startedAt) return;
  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs) || (observed && Date.parse(observed) >= startedMs)) return;
  const updated = getSqlite().transaction(() => {
    const prior = readInboxState(subject);
    if (prior.observedRunAt && Date.parse(prior.observedRunAt) >= startedMs) return prior;
    const next = prior.overrideAt && startedMs > Date.parse(prior.overrideAt) && prior.settledOverride !== null
      ? transitionSettlement(prior, 'run', startedAt) : {};
    const updated = { ...prior, ...next, observedRunAt: startedAt };
    write(subject, updated);
    return updated;
  }).immediate();
  context?.states.set(key(subject), updated);
}
