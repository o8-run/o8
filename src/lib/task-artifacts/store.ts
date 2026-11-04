import 'server-only';
import { getSqlite } from '@/lib/db';
import type {
  TaskArtifactActionDelivery,
  TaskArtifactActionRecord,
  MissionCardSpec,
  TaskArtifactDeclaredAction,
  TaskArtifactRecord,
  TaskArtifactState,
  TaskArtifactTarget,
} from './types';

interface ArtifactRow {
  id: string;
  schema_version: number;
  title: string;
  html: string;
  target_kind: 'thread' | 'packet';
  repo_path: string;
  thread_id: string | null;
  packet_id: string | null;
  lane_id: string | null;
  session_key: string | null;
  origin_head: string | null;
  head_policy: 'pinned' | 'any';
  actions_json: string;
  card_json: string | null;
  state: TaskArtifactState;
  state_reason: string | null;
  created_by: TaskArtifactRecord['createdBy'];
  created_at: string;
  updated_at: string;
}

interface ActionRow {
  id: string;
  artifact_id: string;
  action: string;
  nonce: string;
  payload_hash: string;
  payload_json: string;
  target_json: string;
  actor: string;
  delivery: TaskArtifactActionDelivery;
  delivery_note: string | null;
  created_at: string;
  delivered_at: string | null;
}

function parseJson<T>(text: string, fallback: T): T {
  try { return JSON.parse(text) as T; } catch { return fallback; }
}

function rowToArtifact(row: ArtifactRow): TaskArtifactRecord {
  return {
    id: row.id,
    schemaVersion: row.schema_version,
    title: row.title,
    html: row.html,
    target: {
      kind: row.target_kind,
      repoPath: row.repo_path,
      threadId: row.thread_id,
      packetId: row.packet_id,
      laneId: row.lane_id,
      sessionKey: row.session_key,
    },
    originHead: row.origin_head,
    headPolicy: row.head_policy,
    actions: parseJson<TaskArtifactDeclaredAction[]>(row.actions_json, []),
    card: row.card_json ? parseJson<MissionCardSpec | null>(row.card_json, null) : null,
    state: row.state,
    stateReason: row.state_reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToAction(row: ActionRow): TaskArtifactActionRecord {
  return {
    id: row.id,
    artifactId: row.artifact_id,
    action: row.action,
    nonce: row.nonce,
    payloadHash: row.payload_hash,
    payload: parseJson<unknown>(row.payload_json, null),
    target: parseJson<TaskArtifactTarget>(row.target_json, {
      kind: 'thread', repoPath: '', threadId: null, packetId: null, laneId: null, sessionKey: null,
    }),
    actor: row.actor,
    delivery: row.delivery,
    deliveryNote: row.delivery_note,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
  };
}

export function insertTaskArtifact(record: TaskArtifactRecord): void {
  getSqlite().prepare(`
    INSERT INTO task_artifacts (
      id, schema_version, title, html, target_kind, repo_path, thread_id, packet_id, lane_id, session_key,
      origin_head, head_policy, actions_json, card_json, state, state_reason, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id, record.schemaVersion, record.title, record.html,
    record.target.kind, record.target.repoPath, record.target.threadId, record.target.packetId,
    record.target.laneId, record.target.sessionKey,
    record.originHead, record.headPolicy, JSON.stringify(record.actions),
    record.card ? JSON.stringify(record.card) : null,
    record.state, record.stateReason, record.createdBy, record.createdAt, record.updatedAt,
  );
}

export function getTaskArtifactById(id: string): TaskArtifactRecord | null {
  const row = getSqlite().prepare('SELECT * FROM task_artifacts WHERE id = ?').get(id) as ArtifactRow | undefined;
  return row ? rowToArtifact(row) : null;
}

export function listTaskArtifactsByThread(repoPath: string, threadId: string, limit = 50): TaskArtifactRecord[] {
  const rows = getSqlite().prepare(
    'SELECT * FROM task_artifacts WHERE thread_id = ? AND repo_path = ? ORDER BY created_at ASC, id ASC LIMIT ?',
  ).all(threadId, repoPath, limit) as ArtifactRow[];
  return rows.map(rowToArtifact);
}

export function listTaskArtifactsByPacket(packetId: string, limit = 50): TaskArtifactRecord[] {
  const rows = getSqlite().prepare(
    'SELECT * FROM task_artifacts WHERE packet_id = ? ORDER BY created_at ASC, id ASC LIMIT ?',
  ).all(packetId, limit) as ArtifactRow[];
  return rows.map(rowToArtifact);
}

/** Mission cards on one orchestrator thread, oldest first, for the transcript. */
export function listMissionCardsByThread(threadId: string, limit = 100): TaskArtifactRecord[] {
  const rows = getSqlite().prepare(
    'SELECT * FROM task_artifacts WHERE thread_id = ? AND card_json IS NOT NULL ORDER BY created_at ASC, id ASC LIMIT ?',
  ).all(threadId, limit) as ArtifactRow[];
  return rows.map(rowToArtifact);
}

export function listMissionCardsByPacket(packetId: string, limit = 100): TaskArtifactRecord[] {
  const rows = getSqlite().prepare(
    'SELECT * FROM task_artifacts WHERE packet_id = ? AND card_json IS NOT NULL ORDER BY created_at ASC, id ASC LIMIT ?',
  ).all(packetId, limit) as ArtifactRow[];
  return rows.map(rowToArtifact);
}

/** The one accepted decision a card took, if any. Rejected submissions never decide a card. */
export function acceptedCardDecision(artifactId: string): TaskArtifactActionRecord | null {
  const row = getSqlite().prepare(
    "SELECT * FROM task_artifact_actions WHERE artifact_id = ? AND delivery <> 'rejected' ORDER BY created_at ASC, id ASC LIMIT 1",
  ).get(artifactId) as ActionRow | undefined;
  return row ? rowToAction(row) : null;
}

export function updateTaskArtifactState(id: string, state: TaskArtifactState, reason: string | null, updatedAt: string): void {
  getSqlite().prepare('UPDATE task_artifacts SET state = ?, state_reason = ?, updated_at = ? WHERE id = ?')
    .run(state, reason, updatedAt, id);
}

export class TaskArtifactNonceReplayError extends Error {
  constructor(public readonly artifactId: string, public readonly nonce: string) {
    super(`nonce "${nonce}" was already accepted for artifact ${artifactId}`);
    this.name = 'TaskArtifactNonceReplayError';
  }
}

export function insertTaskArtifactAction(action: TaskArtifactActionRecord): void {
  try {
    getSqlite().prepare(`
      INSERT INTO task_artifact_actions (
        id, artifact_id, action, nonce, payload_hash, payload_json, target_json, actor, delivery, delivery_note, created_at, delivered_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      action.id, action.artifactId, action.action, action.nonce, action.payloadHash,
      JSON.stringify(action.payload ?? null), JSON.stringify(action.target), action.actor,
      action.delivery, action.deliveryNote, action.createdAt, action.deliveredAt,
    );
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed: task_artifact_actions\.artifact_id, task_artifact_actions\.nonce/.test(error.message)) {
      throw new TaskArtifactNonceReplayError(action.artifactId, action.nonce);
    }
    throw error;
  }
}

export function getTaskArtifactActionById(id: string): TaskArtifactActionRecord | null {
  const row = getSqlite().prepare('SELECT * FROM task_artifact_actions WHERE id = ?').get(id) as ActionRow | undefined;
  return row ? rowToAction(row) : null;
}

export function acceptedNonceExists(artifactId: string, nonce: string): boolean {
  const row = getSqlite().prepare(
    "SELECT 1 AS hit FROM task_artifact_actions WHERE artifact_id = ? AND nonce = ? AND delivery <> 'rejected' LIMIT 1",
  ).get(artifactId, nonce) as { hit: number } | undefined;
  return Boolean(row);
}

/**
 * Transition an action's delivery state. Only the expected prior state moves;
 * a second delivery attempt against an already-delivered row changes nothing
 * and reports false, which is how replay after restart is refused.
 */
export function transitionTaskArtifactActionDelivery(input: {
  actionId: string;
  from: TaskArtifactActionDelivery;
  to: TaskArtifactActionDelivery;
  note: string | null;
  deliveredAt: string | null;
}): boolean {
  const result = getSqlite().prepare(
    'UPDATE task_artifact_actions SET delivery = ?, delivery_note = ?, delivered_at = ? WHERE id = ? AND delivery = ?',
  ).run(input.to, input.note, input.deliveredAt, input.actionId, input.from);
  return result.changes === 1;
}

export function listTaskArtifactActions(artifactId: string, limit = 100): TaskArtifactActionRecord[] {
  const rows = getSqlite().prepare(
    'SELECT * FROM task_artifact_actions WHERE artifact_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
  ).all(artifactId, limit) as ActionRow[];
  return rows.map(rowToAction);
}

export function lastTaskArtifactAction(artifactId: string): TaskArtifactActionRecord | null {
  const row = getSqlite().prepare(
    'SELECT * FROM task_artifact_actions WHERE artifact_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
  ).get(artifactId) as ActionRow | undefined;
  return row ? rowToAction(row) : null;
}

export function acceptedActionStats(artifactId: string): { count: number; lastAcceptedAt: string | null } {
  const row = getSqlite().prepare(
    "SELECT COUNT(*) AS count, MAX(created_at) AS last FROM task_artifact_actions WHERE artifact_id = ? AND delivery <> 'rejected'",
  ).get(artifactId) as { count: number; last: string | null };
  return { count: row.count, lastAcceptedAt: row.last };
}
