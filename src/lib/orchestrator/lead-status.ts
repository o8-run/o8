import { getSqlite } from '@/lib/db';
import {
  UNREPORTED_LEAD_REASON,
  cleanLeadString,
  LeadLifecycleError,
  type LeadRow,
  type LeadStatus,
  type TurnRow,
} from '@/lib/orchestrator/lead-contract';
import { leadTurnOwnerState } from '@/lib/orchestrator/lead-turn-owner';

const TERMINAL = new Set<LeadStatus>(['unreported', 'completed', 'blocked', 'needs_approval', 'failed', 'stopped']);
const DEFAULT_LEAD_LIST_LIMIT = 100;

function leadOutcome(turn: TurnRow | undefined) {
  return turn?.outcome_kind ? {
    kind: turn.outcome_kind,
    summary: turn.outcome_summary,
    evidence: turn.outcome_evidence_json ? JSON.parse(turn.outcome_evidence_json) as unknown : [],
  } : null;
}

function turnReceipt(turn: TurnRow) {
  return {
    id: turn.id,
    rootTurnId: turn.root_turn_id ?? turn.id,
    ordinal: turn.ordinal,
    kind: turn.kind,
    status: turn.status,
    outcome: leadOutcome(turn),
    reason: turn.status === 'unreported' ? UNREPORTED_LEAD_REASON : null,
    resultText: turn.result_text?.slice(0, 2_000) ?? null,
    error: turn.error?.slice(0, 2_000) ?? null,
    errorTruncated: Boolean(turn.error && turn.error.length > 2_000),
    createdAt: turn.created_at,
    finishedAt: turn.finished_at,
  };
}

function leadReceipt(lead: LeadRow, resultTurn: TurnRow | undefined) {
  return {
    id: lead.id,
    threadId: lead.thread_id,
    repoPath: lead.repo_path,
    routing: { backend: lead.backend, model: lead.model, effort: lead.effort },
    status: lead.status,
    currentTurnId: lead.current_turn_id,
    result: lead.result_status ? {
      turnId: lead.result_turn_id,
      status: lead.result_status,
      outcome: leadOutcome(resultTurn?.lead_id === lead.id ? resultTurn : undefined),
      reason: lead.result_status === 'unreported' ? UNREPORTED_LEAD_REASON : null,
      text: lead.result_text?.slice(0, 2_000) ?? null,
      textTruncated: Boolean(lead.result_text && lead.result_text.length > 2_000),
      error: lead.error?.slice(0, 2_000) ?? null,
      errorTruncated: Boolean(lead.error && lead.error.length > 2_000),
    } : null,
    stopReason: lead.stop_reason,
    createdAt: lead.created_at,
    updatedAt: lead.updated_at,
  };
}

export function appendLeadEvent(
  leadId: string,
  turnId: string | null,
  kind: string,
  status: string,
  detail?: string,
): void {
  getSqlite().prepare(`
    INSERT INTO orchestrator_lead_events (lead_id, turn_id, kind, status, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(leadId, turnId, kind, status, detail?.slice(0, 1_000) ?? null, Date.now());
}

export function findLeadById(id: string): LeadRow | null {
  return getSqlite().prepare('SELECT * FROM orchestrator_leads WHERE id = ?').get(id) as LeadRow | undefined ?? null;
}

export function findLeadTurnByKey(leadId: string, key: string): TurnRow | null {
  return getSqlite().prepare(
    'SELECT * FROM orchestrator_lead_turns WHERE lead_id = ? AND idempotency_key = ?',
  ).get(leadId, key) as TurnRow | undefined ?? null;
}

/** Canonical receipts in two batches; unfiltered reads default to the newest 100 leads. */
export function readLeadStatuses(input: { threadIds?: string[]; sessionKey?: string } = {}) {
  recoverInterruptedLeadTurns();
  const sqlite = getSqlite();
  // Capture before reading: a concurrent change must invalidate a native snapshot.
  const cursor = (sqlite.prepare('SELECT COALESCE(MAX(cursor), 0) AS cursor FROM orchestrator_lead_events')
    .get() as { cursor: number }).cursor;
  const key = input.sessionKey ?? null;
  const threads = input.threadIds === undefined ? null : JSON.stringify([...new Set(input.threadIds)]);
  const unfiltered = key === null && threads === null;
  const rows = sqlite.prepare(`
    SELECT l.*,
      (SELECT COUNT(*) FROM orchestrator_lead_turns t WHERE t.lead_id = l.id AND t.status = 'queued') AS queue_depth,
      (SELECT id FROM orchestrator_lead_turns t WHERE t.lead_id = l.id ORDER BY ordinal DESC LIMIT 1) AS latest_turn_id
    FROM orchestrator_leads l
    WHERE (? IS NULL OR l.id = ? OR l.thread_id = ? OR EXISTS (
      SELECT 1 FROM orchestrator_lead_turns t WHERE t.lead_id = l.id AND t.session_id = ?
    )) AND (? IS NULL OR l.thread_id IN (SELECT value FROM json_each(?)))
    ORDER BY l.updated_at DESC, l.id LIMIT ?
  `).all(key, key, key, key, threads, threads, unfiltered ? DEFAULT_LEAD_LIST_LIMIT + 1 : -1) as Array<
    LeadRow & { queue_depth: number; latest_turn_id: string | null }>;
  const truncated = unfiltered && rows.length > DEFAULT_LEAD_LIST_LIMIT;
  const selected = truncated ? rows.slice(0, DEFAULT_LEAD_LIST_LIMIT) : rows;
  const turnIds = [...new Set(selected.flatMap(row => [row.latest_turn_id, row.result_turn_id])
    .filter((id): id is string => typeof id === 'string'))];
  const turns = turnIds.length ? sqlite.prepare(`
    SELECT * FROM orchestrator_lead_turns WHERE id IN (SELECT value FROM json_each(?))
  `).all(JSON.stringify(turnIds)) as TurnRow[] : [];
  const byId = new Map(turns.map(turn => [turn.id, turn]));
  const leads = selected.map(row => {
    const latest = row.latest_turn_id ? byId.get(row.latest_turn_id) : undefined;
    const latestTurn = latest ? turnReceipt(latest) : null;
    return { ...leadReceipt(row, row.result_turn_id ? byId.get(row.result_turn_id) : undefined),
      reason: latestTurn?.reason ?? null, latestTurn, queueDepth: row.queue_depth };
  });
  return { cursor, leads, ...(truncated ? { truncated: true } : {}) };
}

export function recoverInterruptedLeadTurns(): number {
  const sqlite = getSqlite();
  const stale = sqlite.prepare(`
    SELECT * FROM orchestrator_lead_turns WHERE status = 'running'
  `).all() as TurnRow[];
  let recovered = 0;
  for (const turn of stale) {
    if (leadTurnOwnerState(turn) !== 'dead') continue;
    const now = Date.now();
    sqlite.transaction(() => {
      const interrupted = sqlite.prepare(`
        UPDATE orchestrator_lead_turns
        SET status = 'interrupted', error = 'Lead process exited during this turn.', finished_at = ?,
            lease_heartbeat_at = ?
        WHERE id = ? AND status = 'running' AND owner_pid IS ?
          AND owner_identity_json IS ? AND lease_token IS ?
      `).run(now, now, turn.id, turn.owner_pid, turn.owner_identity_json, turn.lease_token);
      if (interrupted.changes !== 1) return;
      sqlite.prepare(`
        UPDATE orchestrator_leads
        SET status = 'blocked', result_status = 'blocked', current_turn_id = NULL,
            result_turn_id = ?, error = 'Previous lead turn was interrupted; send a new turn to recover.', updated_at = ?
        WHERE id = ? AND status != 'stopped' AND current_turn_id = ?
      `).run(turn.id, now, turn.lead_id, turn.id);
      appendLeadEvent(turn.lead_id, turn.id, 'recovery', 'blocked', 'Interrupted turn preserved; explicit send required.');
      recovered += 1;
    })();
  }
  return recovered;
}

export function getLeadStatus(leadIdRaw: string, afterCursor = 0, requestedTurnIdRaw?: string) {
  const leadId = cleanLeadString(leadIdRaw, 'leadId', 128);
  const requestedTurnId = requestedTurnIdRaw === undefined
    ? undefined
    : cleanLeadString(requestedTurnIdRaw, 'turnId', 128);
  recoverInterruptedLeadTurns();
  const lead = findLeadById(leadId);
  if (!lead) throw new LeadLifecycleError('Lead not found.', 'lead_not_found', 404);
  const sqlite = getSqlite();
  const latestTurn = sqlite.prepare(
    'SELECT * FROM orchestrator_lead_turns WHERE lead_id = ? ORDER BY ordinal DESC LIMIT 1',
  ).get(leadId) as TurnRow | undefined;
  const requestedRoot = requestedTurnId
    ? sqlite.prepare('SELECT * FROM orchestrator_lead_turns WHERE lead_id = ? AND id = ?')
      .get(leadId, requestedTurnId) as TurnRow | undefined
    : latestTurn;
  if (requestedTurnId && !requestedRoot) {
    throw new LeadLifecycleError('Lead turn not found.', 'lead_turn_not_found', 404);
  }
  const rootTurnId = requestedRoot ? (requestedRoot.root_turn_id ?? requestedRoot.id) : null;
  const requestedTurn = rootTurnId
    ? sqlite.prepare(`
      SELECT * FROM orchestrator_lead_turns
      WHERE lead_id = ? AND (id = ? OR root_turn_id = ?)
      ORDER BY ordinal DESC LIMIT 1
    `).get(leadId, rootTurnId, rootTurnId) as TurnRow | undefined
    : null;
  const queueDepth = (sqlite.prepare(
    `SELECT COUNT(*) AS count FROM orchestrator_lead_turns WHERE lead_id = ? AND status = 'queued'`,
  ).get(leadId) as { count: number }).count;
  const events = sqlite.prepare(`
    SELECT cursor, turn_id AS turnId, kind, status, detail, created_at AS createdAt
    FROM orchestrator_lead_events WHERE lead_id = ? AND cursor > ? ORDER BY cursor LIMIT 100
  `).all(leadId, Math.max(0, afterCursor)) as Array<Record<string, unknown>>;
  const cursor = events.length > 0 ? Number(events[events.length - 1].cursor) : Math.max(0, afterCursor);
  const resultTurn = lead.result_turn_id
    ? sqlite.prepare('SELECT * FROM orchestrator_lead_turns WHERE lead_id = ? AND id = ?')
      .get(leadId, lead.result_turn_id) as TurnRow | undefined
    : undefined;
  return {
    schema: 'o8/orchestrator.lead/v1',
    ok: true,
    lead: leadReceipt(lead, resultTurn),
    latestTurn: latestTurn ? turnReceipt(latestTurn) : null,
    requestedTurn: requestedTurn ? turnReceipt(requestedTurn) : null,
    queueDepth,
    cursor,
    events,
  };
}

export async function waitForLead(input: {
  leadId: string;
  turnId?: string;
  afterCursor?: number;
  waitMs?: number;
}) {
  const waitMs = Math.min(Math.max(input.waitMs ?? 0, 0), 30_000);
  const deadline = Date.now() + waitMs;
  let status = getLeadStatus(input.leadId, input.afterCursor ?? 0, input.turnId);
  const settled = () => status.requestedTurn
    ? TERMINAL.has(status.requestedTurn.status as LeadStatus) || status.requestedTurn.status === 'interrupted'
    : TERMINAL.has(status.lead.status);
  while (Date.now() < deadline && status.events.length === 0 && !settled()) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())));
    status = getLeadStatus(input.leadId, input.afterCursor ?? 0, input.turnId);
  }
  return status;
}
