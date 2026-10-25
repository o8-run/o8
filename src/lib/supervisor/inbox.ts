import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { getSqlite } from '@/lib/db';
import { listLanes } from '@/lib/lane/registry';
import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import {
  problemDossierIdsForSupervisorSources,
  syncRecurringSupervisorProblems,
} from '@/lib/problems/dossiers';
import { isProblemSensorKind } from '@/lib/problems/source-policy';
import {
  DEFAULT_PROJECT_ID,
  getActiveProjectScopeForRepoSync,
} from '@/lib/repos/projects';
import type { OutsiderAttentionThreadKind } from './outsider-attention';
import {
  ACTIVE_OUTSIDE_INCIDENT_STATUSES,
  parseOutsideIncidentPayload,
  reconcileOutsideHumanWaitingInbox,
} from './outsider-inbox-builder';

export { summarizeInboxItems, type SupervisorInboxSummary } from './inbox-summary';

export type SupervisorInboxKind =
  | 'verification_failed'
  | 'session_lost'
  | 'packet_missing'
  | 'bounded_retry_exhausted'
  | 'merge_blocked'
  | 'fetch_unreachable'
  | 'repo_misconfigured'
  | 'launch_agent_crash_loop'
  | 'packet_no_changes'
  | 'worker_quota_exhausted'
  | 'outside_human_waiting'
  // #1502 — a lane reported progress/heartbeat while its sessionKey was null:
  // the worker is running into the void (no transcript, no completion signal).
  // FAULT queue item — never self-closes.
  | 'no_session_binding'
  // #613 — silent-exit detector kinds. See
  // `src/lib/supervisor/silent-exit-detector.ts` for the triage flow.
  | 'silent_exit_verification_failed'
  | 'silent_exit_no_work'
  | 'silent_exit_but_work_present'
  // #2448 — advisory: two consecutive loop checks at or above the
  // PROVISIONAL band. Quotes the repeated call and the receipt id.
  | 'possible_loop';

export type SupervisorInboxStatus =
  | 'pending'
  | 'healing'
  | 'self_healed'
  // Handed to the orchestrator via "Add to orchestrator chat". In-flight: a
  // human/orchestrator is actively driving a fix. Auto-resolves when the
  // faulting packet's latest lane merges (heal-bot). See #1075 — never a
  // direct-dispatch button.
  | 'escalated'
  // Auto-closed: the fault's packet finally merged. resolution_lane_id stamps
  // which lane closed it (audit trail).
  | 'resolved'
  | 'human_required'
  | 'dismissed';

export interface SupervisorInboxPayload {
  [key: string]: unknown;
}

export interface EnqueueInboxItemInput {
  repoPath: string;
  packetId?: string | null;
  kind: SupervisorInboxKind;
  payload: SupervisorInboxPayload;
  status?: SupervisorInboxStatus;
}

interface SupervisorInboxRow {
  id: string;
  project_id: string | null;
  incident_key: string | null;
  repo_path: string;
  packet_id: string | null;
  kind: SupervisorInboxKind;
  payload: string;
  created_at: string;
  last_seen_at: string | null;
  repeat_count: number | null;
  status: SupervisorInboxStatus;
  resolved_at: string | null;
  resolution_lane_id: string | null;
}

export interface SupervisorInboxItem {
  id: string;
  projectId: string;
  repoPath: string;
  packetId: string | null;
  kind: SupervisorInboxKind;
  incidentKey: string | null;
  payload: SupervisorInboxPayload;
  createdAt: string;
  lastSeenAt: string;
  repeatCount: number;
  status: SupervisorInboxStatus;
  resolvedAt: string | null;
  resolutionLaneId: string | null;
  packetTitle: string | null;
  packetReferenceLabel: string | null;
  sessionKey: string | null;
  worktreePath: string | null;
  transcriptLink: string | null;
  worktreeLink: string | null;
  errorExcerpt: string;
  problemDossierId: string | null;
}

export interface SupervisorInboxResolutionNote {
  note: string;
  packetId: string | null;
  laneId: string | null;
  event: string;
  terminalState?: 'released' | 'archived' | 'failed' | 'expired';
  probeKind?: string;
  evidence?: Record<string, unknown>;
  resolvedAt: string;
}

let supervisorInboxReady = false;

const HOUR_MS = 60 * 60_000;
export const RETENTION_POLICY: Partial<Record<SupervisorInboxKind, {
  defaultStatus: SupervisorInboxStatus;
  autoDismissAfterMs?: number;
}>> = {
  silent_exit_no_work: { defaultStatus: 'pending', autoDismissAfterMs: 24 * HOUR_MS },
  silent_exit_but_work_present: { defaultStatus: 'pending', autoDismissAfterMs: 24 * HOUR_MS },
  bounded_retry_exhausted: { defaultStatus: 'human_required' },
  verification_failed: { defaultStatus: 'human_required' },
  merge_blocked: { defaultStatus: 'human_required' },
  fetch_unreachable: { defaultStatus: 'human_required', autoDismissAfterMs: 7 * 24 * HOUR_MS },
  launch_agent_crash_loop: { defaultStatus: 'human_required' },
  no_session_binding: { defaultStatus: 'human_required' },
  packet_no_changes: { defaultStatus: 'pending', autoDismissAfterMs: 7 * 24 * HOUR_MS },
  worker_quota_exhausted: { defaultStatus: 'human_required' },
  outside_human_waiting: { defaultStatus: 'human_required' },
  possible_loop: { defaultStatus: 'pending', autoDismissAfterMs: 24 * HOUR_MS },
};

function ensureSupervisorInboxTable() {
  if (supervisorInboxReady) {
    return;
  }

  const sqlite = getSqlite();
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS supervisor_inbox (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      incident_key TEXT,
      repo_path TEXT NOT NULL,
      packet_id TEXT,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT,
      repeat_count INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending',
      resolved_at TEXT,
      resolution_lane_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_supervisor_inbox_status_created
      ON supervisor_inbox(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_supervisor_inbox_repo_path_created
      ON supervisor_inbox(repo_path, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_supervisor_inbox_packet_id
      ON supervisor_inbox(packet_id);
  `);

  const columns = sqlite.prepare('PRAGMA table_info(supervisor_inbox)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'project_id')) {
    sqlite.exec('ALTER TABLE supervisor_inbox ADD COLUMN project_id TEXT');
  }
  if (!columns.some((column) => column.name === 'incident_key')) {
    sqlite.exec('ALTER TABLE supervisor_inbox ADD COLUMN incident_key TEXT');
  }
  if (!columns.some((column) => column.name === 'last_seen_at')) {
    sqlite.exec('ALTER TABLE supervisor_inbox ADD COLUMN last_seen_at TEXT');
  }
  if (!columns.some((column) => column.name === 'repeat_count')) {
    sqlite.exec('ALTER TABLE supervisor_inbox ADD COLUMN repeat_count INTEGER NOT NULL DEFAULT 1');
  }
  if (!columns.some((column) => column.name === 'resolution_lane_id')) {
    sqlite.exec('ALTER TABLE supervisor_inbox ADD COLUMN resolution_lane_id TEXT');
  }
  sqlite.prepare(
    "UPDATE supervisor_inbox SET project_id = ? WHERE project_id IS NULL OR project_id = ''",
  ).run(DEFAULT_PROJECT_ID);
  sqlite.prepare(
    "UPDATE supervisor_inbox SET last_seen_at = created_at WHERE last_seen_at IS NULL OR last_seen_at = ''",
  ).run();
  sqlite.prepare(
    'UPDATE supervisor_inbox SET repeat_count = 1 WHERE repeat_count IS NULL OR repeat_count < 1',
  ).run();
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_supervisor_inbox_project_status_created
      ON supervisor_inbox(project_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_supervisor_inbox_incident_status
      ON supervisor_inbox(incident_key, status);
  `);

  supervisorInboxReady = true;
}

function syncProblemDossiersAfterInboxWrite(kind: SupervisorInboxKind): void {
  if (!isProblemSensorKind(kind)) return;
  try {
    syncRecurringSupervisorProblems();
  } catch (error) {
    console.warn(
      `[problem-dossiers] Recurrence projection failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parsePayload(raw: string): SupervisorInboxPayload {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as SupervisorInboxPayload;
    }
  } catch {
    // Preserve inbox reads even if a row contains malformed payload JSON.
  }
  return {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function payloadString(payload: SupervisorInboxPayload, key: string): string | null {
  return stringValue(payload[key]);
}

function firstMeaningfulLine(text: string | null): string {
  if (!text) {
    return 'Operator review required.';
  }

  const line = text
    .split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate && candidate !== '```');

  return line ?? 'Operator review required.';
}

function incidentHash(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 12);
}

function buildIncidentKey(input: {
  projectId: string;
  repoPath: string;
  packetId: string | null;
  kind: SupervisorInboxKind;
  payload: SupervisorInboxPayload;
}): string {
  if (input.kind === 'outside_human_waiting') {
    const threadKind = payloadString(input.payload, 'threadKind') ?? '';
    const threadNumber = typeof input.payload.threadNumber === 'number'
      ? String(input.payload.threadNumber)
      : '';
    return [input.repoPath, input.kind, threadKind, threadNumber].join('\u0000');
  }
  const laneId = payloadString(input.payload, 'laneId');
  const worktreePath = payloadString(input.payload, 'worktreePath');
  const stage = payloadString(input.payload, 'stage');
  const verificationKind = payloadString(input.payload, 'verificationKind');
  const errorLine = firstMeaningfulLine(
    payloadString(input.payload, 'errorExcerpt')
      ?? payloadString(input.payload, 'errorMessage')
      ?? payloadString(input.payload, 'retryHandoffError')
      ?? payloadString(input.payload, 'summary')
      ?? payloadString(input.payload, 'verificationOutput')
      ?? payloadString(input.payload, 'error')
      ?? payloadString(input.payload, 'note'),
  );
  const incidentIdentity = input.kind === 'launch_agent_crash_loop'
    ? payloadString(input.payload, 'label') ?? errorLine
    : errorLine;
  const anchor = input.packetId ?? laneId ?? worktreePath ?? input.repoPath;
  return [
    input.repoPath,
    input.kind,
    anchor,
    stage ?? '',
    verificationKind ?? '',
    incidentHash(incidentIdentity),
  ].join('\u0000');
}

function incidentKeyForRow(row: SupervisorInboxRow): string {
  return buildIncidentKey({
    projectId: row.project_id?.trim() || DEFAULT_PROJECT_ID,
    repoPath: row.repo_path,
    packetId: row.packet_id,
    kind: row.kind,
    payload: parsePayload(row.payload),
  });
}

function statusRank(status: SupervisorInboxStatus): number {
  switch (status) {
    case 'human_required':
      return 0;
    case 'pending':
      return 1;
    case 'healing':
      return 1;
    case 'escalated':
      return 1;
    case 'self_healed':
      return 2;
    case 'resolved':
      return 2;
    case 'dismissed':
      return 3;
    default:
      return 4;
  }
}

export function enqueueInboxItem(input: EnqueueInboxItemInput) {
  ensureSupervisorInboxTable();

  const sqlite = getSqlite();
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const status = input.status ?? RETENTION_POLICY[input.kind]?.defaultStatus ?? 'human_required';
  const packetId = input.packetId ?? null;
  const projectId = getActiveProjectScopeForRepoSync(input.repoPath).projectId;
  const incidentKey = buildIncidentKey({
    projectId,
    repoPath: input.repoPath,
    packetId,
    kind: input.kind,
    payload: input.payload,
  });
  const existing = sqlite.prepare(`
    SELECT id, project_id, incident_key, repo_path, packet_id, kind, payload, created_at, last_seen_at, repeat_count, status, resolved_at, resolution_lane_id
    FROM supervisor_inbox
    WHERE incident_key = ?
      AND status IN ('pending', 'healing', 'human_required', 'escalated')
    ORDER BY datetime(last_seen_at) DESC, datetime(created_at) DESC
    LIMIT 1
  `).get(incidentKey) as SupervisorInboxRow | undefined;

  if (existing) {
    sqlite.prepare(`
      UPDATE supervisor_inbox
      SET payload = ?,
          last_seen_at = ?,
          repeat_count = COALESCE(repeat_count, 1) + 1,
          incident_key = ?
      WHERE id = ?
    `).run(JSON.stringify(input.payload), createdAt, incidentKey, existing.id);

    syncProblemDossiersAfterInboxWrite(input.kind);

    return {
      id: existing.id,
      projectId: existing.project_id?.trim() || DEFAULT_PROJECT_ID,
      repoPath: existing.repo_path,
      packetId: existing.packet_id,
      kind: existing.kind,
      incidentKey,
      payload: input.payload,
      createdAt: existing.created_at,
      lastSeenAt: createdAt,
      repeatCount: Math.max(1, existing.repeat_count ?? 1) + 1,
      status: existing.status,
      resolvedAt: existing.resolved_at,
    };
  }

  sqlite.prepare(`
    INSERT INTO supervisor_inbox (
      id,
      project_id,
      incident_key,
      repo_path,
      packet_id,
      kind,
      payload,
      created_at,
      last_seen_at,
      repeat_count,
      status,
      resolved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    id,
    projectId,
    incidentKey,
    input.repoPath,
    packetId,
    input.kind,
    JSON.stringify(input.payload),
    createdAt,
    createdAt,
    1,
    status,
  );

  syncProblemDossiersAfterInboxWrite(input.kind);

  return {
    id,
    projectId,
    repoPath: input.repoPath,
    packetId,
    kind: input.kind,
    incidentKey,
    payload: input.payload,
    createdAt,
    lastSeenAt: createdAt,
    repeatCount: 1,
    status,
    resolvedAt: null,
  };
}

export function collapseActiveInboxIncidents(): number {
  ensureSupervisorInboxTable();
  const rows = getSqlite().prepare(`
    SELECT id, project_id, incident_key, repo_path, packet_id, kind, payload, created_at, last_seen_at, repeat_count, status, resolved_at, resolution_lane_id
    FROM supervisor_inbox
    WHERE status IN ('pending', 'healing', 'human_required', 'escalated')
  `).all() as SupervisorInboxRow[];

  const groups = new Map<string, SupervisorInboxRow[]>();
  for (const row of rows) {
    const key = incidentKeyForRow(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  let dismissed = 0;
  const now = new Date().toISOString();
  const db = getSqlite();
  for (const [incidentKey, group] of groups) {
    const sorted = [...group].sort((left, right) => {
      const statusDiff = statusRank(left.status) - statusRank(right.status);
      if (statusDiff !== 0) return statusDiff;
      return (right.last_seen_at ?? right.created_at).localeCompare(left.last_seen_at ?? left.created_at);
    });
    const survivor = sorted[0];
    if (!survivor) continue;

    const repeatCount = group.reduce((total, row) => total + Math.max(1, row.repeat_count ?? 1), 0);
    const lastSeenAt = sorted[0]?.last_seen_at ?? sorted[0]?.created_at ?? now;
    db.prepare(`
      UPDATE supervisor_inbox
      SET incident_key = ?,
          repeat_count = ?,
          last_seen_at = ?
      WHERE id = ?
    `).run(incidentKey, repeatCount, lastSeenAt, survivor.id);

    const duplicates = sorted.slice(1);
    for (const duplicate of duplicates) {
      db.prepare(`
        UPDATE supervisor_inbox
        SET incident_key = ?,
            status = 'dismissed',
            resolved_at = COALESCE(resolved_at, ?)
        WHERE id = ?
      `).run(incidentKey, now, duplicate.id);
      dismissed += 1;
    }
  }

  return dismissed;
}

export function countInboxItems(
  status: SupervisorInboxStatus = 'human_required',
  options: { includeAllProjects?: boolean; projectId?: string | null } = {},
): number {
  ensureSupervisorInboxTable();
  collapseActiveInboxIncidents();
  const projectId = options.projectId ?? getActiveProjectScopeForRepoSync().projectId;

  const row = options.includeAllProjects
    ? getSqlite()
      .prepare('SELECT COUNT(*) AS count FROM supervisor_inbox WHERE status = ?')
      .get(status) as { count?: number } | undefined
    : getSqlite()
      .prepare('SELECT COUNT(*) AS count FROM supervisor_inbox WHERE status = ? AND project_id = ?')
      .get(status, projectId) as { count?: number } | undefined;

  return row?.count ?? 0;
}

export function dismissInboxItem(id: string) {
  ensureSupervisorInboxTable();

  getSqlite().prepare(`
    UPDATE supervisor_inbox
    SET status = ?, resolved_at = ?
    WHERE id = ?
  `).run('dismissed', new Date().toISOString(), id);
}

/**
 * Operator handed this fault to the orchestrator via "Add to orchestrator
 * chat". No lane exists at this moment (the handoff only drafts a chat
 * message) — heal-bot's escalated-resolve sweep stamps the resolving lane and
 * flips the item to 'resolved' once the faulting packet's latest lane merges.
 * Guard keeps a terminal (dismissed/resolved) item from being re-opened.
 */
export function escalateInboxItem(id: string) {
  ensureSupervisorInboxTable();

  getSqlite().prepare(`
    UPDATE supervisor_inbox
    SET status = 'escalated', resolved_at = NULL
    WHERE id = ?
      AND status NOT IN ('dismissed', 'resolved')
  `).run(id);
}

/**
 * Auto-close: the fault's packet finally merged. Stamps the resolving lane id
 * for the audit trail. Called by heal-bot's escalated-resolve sweep.
 */
export function resolveInboxItem(
  id: string,
  resolutionLaneId: string | null,
  resolution?: SupervisorInboxResolutionNote,
) {
  ensureSupervisorInboxTable();
  const resolvedAt = resolution?.resolvedAt ?? new Date().toISOString();
  const row = resolution
    ? getSqlite().prepare('SELECT payload FROM supervisor_inbox WHERE id = ?').get(id) as { payload?: string } | undefined
    : undefined;
  const payload = row?.payload ? parsePayload(row.payload) : null;
  const nextPayload = payload && resolution
    ? {
      ...payload,
      autoResolution: resolution,
      autoResolutionNote: resolution.note,
    }
    : null;

  if (nextPayload) {
    getSqlite().prepare(`
      UPDATE supervisor_inbox
      SET status = 'resolved', resolved_at = ?, resolution_lane_id = ?, payload = ?
      WHERE id = ?
    `).run(resolvedAt, resolutionLaneId, JSON.stringify(nextPayload), id);
    return;
  }

  getSqlite().prepare(`
    UPDATE supervisor_inbox
    SET status = 'resolved', resolved_at = ?, resolution_lane_id = ?
    WHERE id = ?
  `).run(resolvedAt, resolutionLaneId, id);
}

export function bulkDismissInboxItems(): number {
  ensureSupervisorInboxTable();
  const projectId = getActiveProjectScopeForRepoSync().projectId;
  const result = getSqlite().prepare(`
    UPDATE supervisor_inbox
    SET status = ?, resolved_at = ?
    WHERE status IN ('pending', 'healing', 'human_required', 'escalated')
      AND project_id = ?
  `).run('dismissed', new Date().toISOString(), projectId);
  return result.changes;
}

export function selfHealActiveByKindAndRepo(kind: SupervisorInboxKind, repoPath: string): number {
  ensureSupervisorInboxTable();
  const result = getSqlite().prepare(`
    UPDATE supervisor_inbox
    SET status = ?, resolved_at = ?
    WHERE kind = ?
      AND repo_path = ?
      AND status IN ('pending', 'healing', 'human_required')
  `).run('self_healed', new Date().toISOString(), kind, repoPath);
  return result.changes;
}

const ORPHANED_WORKTREE_GRACE_MS = 48 * HOUR_MS;

export function runRetentionSweep(nowMs = Date.now()): number {
  ensureSupervisorInboxTable();
  const rows = getSqlite().prepare(`
    SELECT id, project_id, incident_key, repo_path, packet_id, kind, payload, created_at, last_seen_at, repeat_count, status, resolved_at, resolution_lane_id
    FROM supervisor_inbox
    WHERE status IN ('pending', 'human_required')
  `).all() as SupervisorInboxRow[];
  let dismissed = 0;
  for (const row of rows) {
    const createdMs = Date.parse(row.created_at);
    if (!Number.isFinite(createdMs)) continue;
    const ttl = RETENTION_POLICY[row.kind]?.autoDismissAfterMs;
    if (ttl && nowMs - createdMs >= ttl) {
      dismissInboxItem(row.id);
      dismissed += 1;
      continue;
    }
    // human_required incidents have no TTL by design — but once the worktree
    // they point at is gone from disk, "retry in the existing worktree" is
    // impossible and the card can only rot (the Jun 2026 queue carried 9-day-
    // old failures from pre-rename paths). 48h grace avoids racing a cleanup
    // that a redispatch is about to recreate.
    if (nowMs - createdMs < ORPHANED_WORKTREE_GRACE_MS) continue;
    const worktreePath = payloadStringFromRaw(row.payload, 'worktreePath');
    if (!worktreePath || existsSync(worktreePath)) continue;
    dismissInboxItem(row.id);
    dismissed += 1;
  }
  return dismissed;
}

function payloadStringFromRaw(rawPayload: string, key: string): string | null {
  try {
    const parsed = JSON.parse(rawPayload) as Record<string, unknown>;
    return stringValue(parsed[key]);
  } catch {
    return null;
  }
}

export function buildOutsideHumanWaitingInbox(
  now = new Date(),
  thresholdMs?: number,
): { created: number; resolved: number } {
  ensureSupervisorInboxTable();
  return reconcileOutsideHumanWaitingInbox({
    now,
    thresholdMs,
    enqueue: enqueueInboxItem,
    resolve: (id, resolvedAt, payload, insiderReplyAt) => resolveInboxItem(id, null, {
      note: 'GitHub mirror recorded an insider reply after the outside contributor.',
      packetId: null,
      laneId: null,
      event: 'outside_human_waiting_cleared',
      evidence: { url: payload.url, waitingSince: payload.waitingSince, insiderReplyAt },
      resolvedAt,
    }),
  });
}

export function listActiveOutsideHumanWaitingThreadNumbers(
  repoFullName: string,
  kind: OutsiderAttentionThreadKind,
): number[] {
  ensureSupervisorInboxTable();
  const placeholders = ACTIVE_OUTSIDE_INCIDENT_STATUSES.map(() => '?').join(', ');
  const rows = getSqlite().prepare(`
    SELECT payload
    FROM supervisor_inbox
    WHERE kind = 'outside_human_waiting'
      AND status IN (${placeholders})
  `).all(...ACTIVE_OUTSIDE_INCIDENT_STATUSES) as Array<{ payload: string }>;

  const numbers = new Set<number>();
  for (const row of rows) {
    const payload = parseOutsideIncidentPayload(row.payload);
    if (payload?.threadRepo === repoFullName && payload.threadKind === kind) {
      numbers.add(payload.threadNumber);
    }
  }
  return [...numbers];
}

interface InboxReadOptions {
  includeDismissed?: boolean;
  includeAllProjects?: boolean;
  projectId?: string | null;
}
export function listInboxItems(options: InboxReadOptions = {}): SupervisorInboxItem[] {
  return readInboxItems(options, true);
}
/** Recorded projection without incident reconciliation or dismissal. */
export function listRecordedInboxItems(options: InboxReadOptions = {}): SupervisorInboxItem[] {
  return readInboxItems(options, false);
}
function readInboxItems(options: InboxReadOptions, reconcile: boolean): SupervisorInboxItem[] {
  ensureSupervisorInboxTable();
  if (reconcile) {
    buildOutsideHumanWaitingInbox();
    collapseActiveInboxIncidents();
  }
  const projectId = options.projectId ?? getActiveProjectScopeForRepoSync().projectId;

  const rows = options.includeAllProjects
    ? getSqlite().prepare(`
      SELECT id, project_id, incident_key, repo_path, packet_id, kind, payload, created_at, last_seen_at, repeat_count, status, resolved_at, resolution_lane_id
      FROM supervisor_inbox
      WHERE 1 = 1
        ${options.includeDismissed ? '' : `AND status != 'dismissed'`}
      ORDER BY datetime(last_seen_at) DESC, datetime(created_at) DESC
    `).all() as SupervisorInboxRow[]
    : getSqlite().prepare(`
      SELECT id, project_id, incident_key, repo_path, packet_id, kind, payload, created_at, last_seen_at, repeat_count, status, resolved_at, resolution_lane_id
      FROM supervisor_inbox
      WHERE project_id = ?
        ${options.includeDismissed ? '' : `AND status != 'dismissed'`}
      ORDER BY datetime(last_seen_at) DESC, datetime(created_at) DESC
    `).all(projectId) as SupervisorInboxRow[];
  const dossierBySourceId = problemDossierIdsForSupervisorSources(rows.map((row) => row.id));

  const lanes = listLanes();
  const laneByPacketId = new Map(lanes.flatMap((lane) => (
    lane.packetId ? [[lane.packetId, lane] as const] : []
  )));
  const laneByRepoPath = new Map<string, (typeof lanes)[number]>();
  for (const lane of lanes) {
    if (laneByRepoPath.has(lane.repoPath)) {
      continue;
    }
    laneByRepoPath.set(lane.repoPath, lane);
  }

  const state = readOrchestratorControlPlaneState();
  const packetById = new Map(state.packets.map((packet) => [packet.id, packet] as const));

  return rows
    .map((row) => {
      const payload = parsePayload(row.payload);
      const packet = row.packet_id ? packetById.get(row.packet_id) ?? null : null;
      const lane = (row.packet_id ? laneByPacketId.get(row.packet_id) : undefined)
        ?? laneByRepoPath.get(row.repo_path)
        ?? null;

      const packetTitle = stringValue(payload.packetTitle)
        ?? packet?.title
        ?? stringValue(payload.laneLabel);
      const packetReferenceLabel = stringValue(payload.packetReferenceLabel)
        ?? packet?.referenceLabel
        ?? null;
      const sessionKey = stringValue(payload.sessionKey)
        ?? packet?.lane?.sessionKey
        ?? lane?.sessionKey
        ?? null;
      const worktreePath = stringValue(payload.worktreePath)
        ?? packet?.lane?.worktreePath
        ?? lane?.worktreePath
        ?? row.repo_path;

      const errorExcerpt = firstMeaningfulLine(
        stringValue(payload.errorExcerpt)
        ?? stringValue(payload.errorMessage)
        ?? stringValue(payload.retryHandoffError)
        ?? stringValue(payload.summary)
        ?? stringValue(payload.verificationOutput)
        ?? stringValue(payload.error)
        ?? stringValue(payload.note),
      );

      return {
        id: row.id,
        projectId: row.project_id?.trim() || DEFAULT_PROJECT_ID,
        repoPath: row.repo_path,
        packetId: row.packet_id,
        kind: row.kind,
        incidentKey: incidentKeyForRow(row),
        payload,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at ?? row.created_at,
        repeatCount: Math.max(1, row.repeat_count ?? 1),
        status: row.status,
        resolvedAt: row.resolved_at,
        resolutionLaneId: row.resolution_lane_id,
        packetTitle,
        packetReferenceLabel,
        sessionKey,
        worktreePath,
        transcriptLink: sessionKey
          ? `/api/runtime/transcript?sessionKey=${encodeURIComponent(sessionKey)}&limit=50`
          : null,
        worktreeLink: worktreePath ? `file://${encodeURI(worktreePath)}` : null,
        errorExcerpt,
        problemDossierId: dossierBySourceId.get(row.id) ?? null,
      } satisfies SupervisorInboxItem;
    })
    .sort((left, right) => {
      const statusDiff = statusRank(left.status) - statusRank(right.status);
      if (statusDiff !== 0) {
        return statusDiff;
      }
      return right.lastSeenAt.localeCompare(left.lastSeenAt);
    });
}
