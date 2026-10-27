/**
 * Operator corrections ledger reader (#2219).
 *
 * A rejection reason lands on the approval's resolution record
 * (`approvals.resolution_json.note`, written by the approvals route) and a
 * steer message lands on the packet lane as a `steered_packet` event. This
 * module is the single read path that turns those persisted rows into
 * corrections the next worker on the packet, the repo context block, and the
 * Brain retriever consume.
 *
 * Standing (#2395): a rejection is operator-only (the approvals route refuses
 * every other principal), so it always carries operator standing. A steer can
 * come from the operator, the orchestrator, or the heal-bot, recorded in
 * `payload.source`. Only `source: 'operator'` carries operator standing; any
 * other or missing source is machine steering, labeled as such and ranked
 * below operator rows.
 */

import path from 'node:path';

import { getSqlite } from '@/lib/db';

export type CorrectionStanding = 'operator' | 'machine';

export interface OperatorCorrection {
  /** `approval:<id>` or `steer:<lane-event-id>` — unique across both sources. */
  id: string;
  kind: 'rejected' | 'steered';
  /** Source row id inside `table`. */
  rowId: string;
  table: 'approvals' | 'lane_events';
  packetId: string | null;
  repoPath: string | null;
  projectId: string | null;
  /** Approval title or lane label — what was being corrected. */
  title: string;
  reason: string;
  /** Steer source (`operator` / `orchestrator` / `heal-bot`) when known. */
  source: string | null;
  /** `operator` for rejections and operator-sourced steers; `machine` otherwise. */
  standing: CorrectionStanding;
  /** ISO timestamp of the rejection or steer. */
  at: string;
}

export interface ReadOperatorCorrectionsOptions {
  /** Only corrections recorded against this packet. */
  packetId?: string;
  /** Only corrections whose lane resolves to one of these repo paths. */
  repoPaths?: string[];
  /** Exact project identity; undefined is the operator's global inventory. */
  projectId?: string | null;
  /** Packet whose own corrections should be left out (already shown per-packet). */
  excludePacketId?: string;
  limit?: number;
  /** Exact inventory selection; applied before the contextual scan limit. */
  ids?: string[];
  /** Inventory errors must remain visible rather than becoming an empty list. */
  throwOnError?: boolean;
}

const DEFAULT_LIMIT = 5;
const MAX_SCAN = 200;

interface RejectionRow {
  id: string;
  title: string;
  packet_id: string | null;
  note: string | null;
  resolved_at: number | null;
  updated_at: number;
  repo_path: string | null;
  lane_packet_id: string | null;
  project_id: string | null;
}

interface SteerRow {
  id: string;
  payload_json: string;
  timestamp: string;
  packet_id: string | null;
  repo_path: string;
  label: string;
  project_id: string | null;
}

function resolvePathSafe(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    return path.resolve(value);
  } catch {
    return null;
  }
}

function parsePayload(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** Older databases acquire the exclusion ledger on the first confirmed forget. */
export function retainedCorrectionPredicate(idSql: string): string {
  return getSqlite().prepare("SELECT 1 FROM sqlite_master WHERE name = 'forgotten_operator_corrections'").get()
    ? `NOT EXISTS (SELECT 1 FROM forgotten_operator_corrections f WHERE f.id = ${idSql})`
    : '1';
}

function readRejections(packetId: string | undefined, scan: number, ids?: string[], projectId?: string | null): OperatorCorrection[] {
  const packetClause = packetId
    ? `AND (a.packet_id = @packetId
         OR a.lane_id IN (SELECT id FROM lanes WHERE packet_id = @packetId)
         OR json_extract(a.continuation_json, '$.laneId') IN (SELECT id FROM lanes WHERE packet_id = @packetId))`
    : '';
  const rows = getSqlite().prepare(`
    SELECT a.id, a.title, a.packet_id, a.resolved_at, a.updated_at,
           json_extract(a.resolution_json, '$.note') AS note,
           l.repo_path AS repo_path, l.packet_id AS lane_packet_id, a.project_id
    FROM approvals a
    LEFT JOIN lanes l ON l.id = COALESCE(
      a.lane_id,
      json_extract(a.continuation_json, '$.laneId'),
      (SELECT id FROM lanes WHERE a.packet_id IS NOT NULL AND packet_id = a.packet_id ORDER BY created_at DESC LIMIT 1)
    )
    WHERE a.status = 'rejected'
      AND json_valid(a.resolution_json)
      AND TRIM(COALESCE(json_extract(a.resolution_json, '$.note'), '')) != ''
      ${packetClause}
      AND ${retainedCorrectionPredicate("'approval:' || a.id")}
      AND (@ids IS NULL OR 'approval:' || a.id IN (SELECT value FROM json_each(@ids)))
      AND (@allProjects OR a.project_id IS @projectId)
    ORDER BY COALESCE(a.resolved_at, a.updated_at) DESC
    LIMIT @scan
  `).all({ packetId: packetId ?? null, scan, ids: ids ? JSON.stringify(ids) : null,
    allProjects: Number(projectId === undefined), projectId: projectId ?? null }) as RejectionRow[];

  return rows.map((row) => ({
    id: `approval:${row.id}`,
    kind: 'rejected' as const,
    rowId: row.id,
    table: 'approvals' as const,
    packetId: row.packet_id ?? row.lane_packet_id ?? null,
    repoPath: row.repo_path ?? null,
    projectId: row.project_id,
    title: row.title,
    reason: String(row.note).trim(),
    source: null,
    standing: 'operator' as const,
    at: new Date(row.resolved_at ?? row.updated_at).toISOString(),
  }));
}

function readSteers(packetId: string | undefined, scan: number, ids?: string[], projectId?: string | null): OperatorCorrection[] {
  const packetClause = packetId
    ? `AND (l.packet_id = @packetId OR json_extract(e.payload_json, '$.packetId') = @packetId)`
    : '';
  const rows = getSqlite().prepare(`
    SELECT e.id, e.payload_json, e.timestamp, l.packet_id, l.repo_path, l.label, l.project_id
    FROM lane_events e
    JOIN lanes l ON l.id = e.lane_id
    WHERE e.verb = 'steered_packet'
      AND json_valid(e.payload_json)
      ${packetClause}
      AND ${retainedCorrectionPredicate("'steer:' || e.id")}
      AND (@ids IS NULL OR 'steer:' || e.id IN (SELECT value FROM json_each(@ids)))
      AND (@allProjects OR l.project_id IS @projectId)
    ORDER BY e.timestamp DESC
    LIMIT @scan
  `).all({ packetId: packetId ?? null, scan, ids: ids ? JSON.stringify(ids) : null,
    allProjects: Number(projectId === undefined), projectId: projectId ?? null }) as SteerRow[];

  return rows.flatMap((row) => {
    const payload = parsePayload(row.payload_json);
    const message = typeof payload.message === 'string' ? payload.message.trim() : '';
    if (!message) return [];
    const source = typeof payload.source === 'string' ? payload.source.trim().toLowerCase() || null : null;
    return [{
      id: `steer:${row.id}`,
      kind: 'steered' as const,
      rowId: row.id,
      table: 'lane_events' as const,
      packetId: typeof payload.packetId === 'string' ? payload.packetId : row.packet_id,
      repoPath: row.repo_path,
      projectId: row.project_id,
      title: row.label,
      reason: message,
      source,
      standing: source === 'operator' ? 'operator' as const : 'machine' as const,
      at: row.timestamp,
    }];
  });
}

function standingRank(correction: OperatorCorrection): number {
  return correction.standing === 'operator' ? 0 : 1;
}

/**
 * Read rejection and steer reasons, operator standing first, then newest first. Never throws — a missing
 * table or malformed row degrades to "no corrections" so dispatch and Q&A
 * keep working.
 */
export function readOperatorCorrections(options: ReadOperatorCorrectionsOptions = {}): OperatorCorrection[] {
  const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
  const packetId = options.packetId?.trim() || undefined;
  const scopedPaths = options.repoPaths
    ? new Set(options.repoPaths.map(resolvePathSafe).filter((value): value is string => Boolean(value)))
    : null;
  const scan = Math.min(MAX_SCAN, Math.max(limit * 5, 20));
  try {
    return [...readRejections(packetId, scan, options.ids, options.projectId), ...readSteers(packetId, scan, options.ids, options.projectId)]
      .filter((correction) => !options.excludePacketId || correction.packetId !== options.excludePacketId)
      .filter((correction) => {
        if (!scopedPaths) return true;
        const resolved = resolvePathSafe(correction.repoPath);
        return resolved !== null && scopedPaths.has(resolved);
      })
      // Operator rows first so machine steering never crowds them out of the
      // limit; newest first within each standing.
      .sort((a, b) => standingRank(a) - standingRank(b) || b.at.localeCompare(a.at))
      .slice(0, limit);
  } catch (error) {
    if (options.throwOnError) throw error;
    console.warn('[operator-corrections] read failed:', error instanceof Error ? error.message : error);
    return [];
  }
}

function clamp(text: string, maxLen: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= maxLen ? flat : `${flat.slice(0, maxLen - 1)}…`;
}

/**
 * One line per correction: `[rejected 2026-09-16] <title>: <reason>`, or
 * `[machine steer via orchestrator 2026-09-16] ...` for a non-operator steer.
 */
export function formatCorrectionLine(correction: OperatorCorrection, maxReasonChars = 600): string {
  const day = correction.at.slice(0, 10);
  const label = correction.standing === 'machine'
    ? `machine steer via ${correction.source ?? 'unknown'}`
    : correction.kind;
  return `- [${label} ${day}] ${clamp(correction.title, 80)}: ${clamp(correction.reason, maxReasonChars)}`;
}

/**
 * Packet-prompt block for the next worker on the same packet; null when none.
 * Operator rulings and machine steering render under separate headings so a
 * machine nudge is never presented with operator standing.
 */
export function buildPacketCorrectionsSection(packetId: string, projectId?: string | null): string | null {
  const corrections = readOperatorCorrections({ packetId, projectId, limit: DEFAULT_LIMIT });
  if (corrections.length === 0) return null;
  const operator = corrections.filter((correction) => correction.standing === 'operator');
  const machine = corrections.filter((correction) => correction.standing === 'machine');
  const blocks: string[] = [];
  if (operator.length > 0) {
    blocks.push([
      'Operator corrections for this packet (an earlier attempt was rejected or steered; address each one):',
      ...operator.map((correction) => formatCorrectionLine(correction)),
    ].join('\n'));
  }
  if (machine.length > 0) {
    blocks.push([
      'Machine steering for this packet (sent by the orchestrator or heal-bot, not an operator ruling; operator corrections take precedence):',
      ...machine.map((correction) => formatCorrectionLine(correction)),
    ].join('\n'));
  }
  return blocks.join('\n\n');
}

/** Audit rows remain durable; callers deriving new prompt fragments must check recall standing. */
export function isCorrectionForgotten(id: string): boolean {
  const db = getSqlite();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'forgotten_operator_corrections'").get()) return false;
  return Boolean(db.prepare('SELECT 1 FROM forgotten_operator_corrections WHERE id = ?').get(id));
}
