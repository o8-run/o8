import 'server-only';

import { createHash } from 'node:crypto';

import { getSqlite } from '@/lib/db';
import { ensureProblemDossierSchema } from '@/lib/db/v83-runtime-tables-migration';
import type { SupervisorInboxKind } from '@/lib/supervisor/inbox';
import {
  isEligibleProblemSignal,
  problemExposureDenominator,
  problemImpactBand,
  type ProblemExposureDenominator,
} from './source-policy';

export const PROBLEM_DOSSIER_SCHEMA = 'o8/problem-dossier/v1' as const;
export const DEFAULT_RECURRENCE_THRESHOLD = 3;

export type ProblemDossierStatus =
  | 'candidate'
  | 'accepted'
  | 'investigating'
  | 'remedy_active'
  | 'provisionally_resolved'
  | 'verified_closed'
  | 'reopened'
  | 'suppressed';

export type ProblemImpactBand = 'low' | 'moderate' | 'high' | 'critical';
export type ProblemEvidenceConfidence = 'low' | 'medium' | 'high';

export interface ProblemClosureContract {
  kind: 'supervisor_incident_absence';
  sourceKind: SupervisorInboxKind;
  baseline: {
    occurrenceCount: number;
    distinctAttempts: number;
    recordedAt: string;
  };
  exposureDenominator: ProblemExposureDenominator;
  requiredComparableExposures: number;
}

export interface ProblemEvidenceReference {
  id: string;
  dossierId: string;
  sourceType: 'supervisor_inbox';
  sourceId: string;
  sourceKind: SupervisorInboxKind;
  packetId: string;
  observedAt: string;
}

export interface ProblemDossierEvent {
  id: string;
  dossierId: string;
  eventType: string;
  actor: 'operator' | 'system';
  note: string | null;
  fromStatus: ProblemDossierStatus | null;
  toStatus: ProblemDossierStatus | null;
  at: string;
}

export interface ProblemDossier {
  schema: typeof PROBLEM_DOSSIER_SCHEMA;
  id: string;
  fingerprint: string;
  projectId: string;
  repoPath: string;
  painStatement: string;
  firstObservedAt: string;
  lastObservedAt: string;
  occurrenceCount: number;
  observedDurationMs: number;
  comparableExposureCount: number;
  impactBand: ProblemImpactBand;
  evidenceConfidence: ProblemEvidenceConfidence;
  status: ProblemDossierStatus;
  closureContract: ProblemClosureContract;
  suppressedAt: string | null;
  cooldownUntil: string | null;
  acceptedAt: string | null;
  linkedTaskId: string | null;
  provisionalResolvedAt: string | null;
  verifiedClosedAt: string | null;
  reopenedAt: string | null;
  operatorStoppedAt: string | null;
  suppressionReason: string | null;
  recurrenceProposalId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  evidence: ProblemEvidenceReference[];
  history: ProblemDossierEvent[];
}

interface ProblemDossierRow {
  id: string;
  fingerprint: string;
  project_id: string;
  repo_path: string;
  pain_statement: string;
  first_observed_at: string;
  last_observed_at: string;
  occurrence_count: number;
  comparable_exposure_count: number;
  impact_band: ProblemImpactBand;
  evidence_confidence: ProblemEvidenceConfidence;
  status: ProblemDossierStatus;
  closure_contract_json: string;
  suppressed_at: string | null;
  cooldown_until: string | null;
  accepted_at: string | null;
  linked_task_id: string | null;
  provisional_resolved_at: string | null;
  verified_closed_at: string | null;
  reopened_at: string | null;
  operator_stopped_at: string | null;
  suppression_reason: string | null;
  recurrence_proposal_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface ProblemEvidenceRow {
  id: string;
  dossier_id: string;
  source_type: 'supervisor_inbox';
  source_id: string;
  source_kind: SupervisorInboxKind;
  packet_id: string;
  observed_at: string;
}

interface ProblemEventRow {
  id: string;
  dossier_id: string;
  event_type: string;
  actor: 'operator' | 'system';
  note: string | null;
  from_status: ProblemDossierStatus | null;
  to_status: ProblemDossierStatus | null;
  at: string;
}

interface ProblemRemedyRow {
  id: string;
  dossier_id: string;
  sequence: number;
  task_id: string | null;
  mission_id: string | null;
  packet_id: string | null;
  lane_id: string | null;
  approval_id: string | null;
  review_id: string | null;
  release_ref: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface ProblemRemedy {
  id: string;
  dossierId: string;
  sequence: number;
  taskId: string | null;
  missionId: string | null;
  packetId: string | null;
  laneId: string | null;
  approvalId: string | null;
  reviewId: string | null;
  releaseRef: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface SupervisorInboxEvidenceRow {
  id: string;
  project_id: string;
  repo_path: string;
  packet_id: string;
  kind: SupervisorInboxKind;
  payload: string;
  created_at: string;
  last_seen_at: string | null;
}

interface SupervisorProblemSignal {
  id: string;
  projectId: string;
  repoPath: string;
  packetId: string;
  kind: SupervisorInboxKind;
  payload: Record<string, unknown>;
  createdAt: string;
  lastSeenAt: string;
  errorExcerpt: string;
}

const initializedDatabases = new WeakSet<object>();

function ensureProblemDossierTables(): void {
  const sqlite = getSqlite();
  if (initializedDatabases.has(sqlite)) return;
  ensureProblemDossierSchema(sqlite);
  initializedDatabases.add(sqlite);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stableHash(value: string, length = 24): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function normalizeIncidentText(value: string, repoPath: string): string {
  return value
    .replaceAll(repoPath, '<repo>')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '<uuid>')
    .replace(/\b(?:pkt|lane|session)-[a-z0-9_-]+\b/gi, '<id>')
    .replace(/:(\d+):(\d+)\b/g, ':<line>:<column>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function incidentText(item: SupervisorProblemSignal): string {
  return item.errorExcerpt
    || stringValue(item.payload.summary)
    || stringValue(item.payload.note)
    || item.kind.replaceAll('_', ' ');
}

export function fingerprintSupervisorProblem(item: SupervisorProblemSignal): string {
  const stage = stringValue(item.payload.stage)?.toLowerCase() ?? '';
  const verificationKind = stringValue(item.payload.verificationKind)?.toLowerCase() ?? '';
  const normalized = normalizeIncidentText(incidentText(item), item.repoPath);
  return [item.projectId, item.repoPath, item.kind, stage, verificationKind, stableHash(normalized)].join('\u0000');
}

function painStatementFor(item: SupervisorProblemSignal): string {
  const label = item.kind.replaceAll('_', ' ');
  const detail = incidentText(item).replace(/\s+/g, ' ').trim();
  return `${label}: ${detail}`.slice(0, 280);
}

function closureContractFor(input: {
  kind: SupervisorInboxKind;
  occurrenceCount: number;
  distinctAttempts: number;
  recordedAt: string;
}): ProblemClosureContract {
  return {
    kind: 'supervisor_incident_absence',
    sourceKind: input.kind,
    baseline: {
      occurrenceCount: input.occurrenceCount,
      distinctAttempts: input.distinctAttempts,
      recordedAt: input.recordedAt,
    },
    exposureDenominator: problemExposureDenominator(input.kind),
    requiredComparableExposures: 3,
  };
}

function parseClosureContract(raw: string, row: ProblemDossierRow): ProblemClosureContract {
  const parsed = JSON.parse(raw) as Partial<ProblemClosureContract>;
  return {
    kind: 'supervisor_incident_absence',
    sourceKind: parsed.sourceKind ?? 'verification_failed',
    baseline: parsed.baseline ?? {
      occurrenceCount: row.occurrence_count,
      distinctAttempts: row.occurrence_count,
      recordedAt: row.created_at,
    },
    exposureDenominator: parsed.exposureDenominator
      ?? problemExposureDenominator(parsed.sourceKind ?? 'verification_failed'),
    requiredComparableExposures: parsed.requiredComparableExposures ?? 3,
  };
}

function evidenceForDossier(dossierId: string): ProblemEvidenceReference[] {
  const rows = getSqlite().prepare(`
    SELECT id, dossier_id, source_type, source_id, source_kind, packet_id, observed_at
    FROM problem_evidence
    WHERE dossier_id = ?
    ORDER BY datetime(observed_at), id
  `).all(dossierId) as ProblemEvidenceRow[];

  return rows.map((row) => ({
    id: row.id,
    dossierId: row.dossier_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceKind: row.source_kind,
    packetId: row.packet_id,
    observedAt: row.observed_at,
  }));
}

function historyForDossier(dossierId: string): ProblemDossierEvent[] {
  const rows = getSqlite().prepare(`
    SELECT id, dossier_id, event_type, actor, note, from_status, to_status, at
    FROM problem_events
    WHERE dossier_id = ?
    ORDER BY datetime(at), id
  `).all(dossierId) as ProblemEventRow[];
  return rows.map((row) => ({
    id: row.id,
    dossierId: row.dossier_id,
    eventType: row.event_type,
    actor: row.actor,
    note: row.note,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    at: row.at,
  }));
}

export function appendProblemDossierEvent(input: {
  dossierId: string;
  eventType: string;
  actor: 'operator' | 'system';
  note?: string | null;
  fromStatus?: ProblemDossierStatus | null;
  toStatus?: ProblemDossierStatus | null;
  at: string;
}): ProblemDossierEvent {
  ensureProblemDossierTables();
  const id = `problem-event-${stableHash([
    input.dossierId,
    input.eventType,
    input.actor,
    input.at,
    input.note ?? '',
  ].join('\u0000'))}`;
  getSqlite().prepare(`
    INSERT OR IGNORE INTO problem_events (
      id, dossier_id, event_type, actor, note, from_status, to_status, at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.dossierId,
    input.eventType,
    input.actor,
    input.note ?? null,
    input.fromStatus ?? null,
    input.toStatus ?? null,
    input.at,
  );
  return {
    id,
    dossierId: input.dossierId,
    eventType: input.eventType,
    actor: input.actor,
    note: input.note ?? null,
    fromStatus: input.fromStatus ?? null,
    toStatus: input.toStatus ?? null,
    at: input.at,
  };
}

function mapDossier(row: ProblemDossierRow): ProblemDossier {
  const firstObservedAt = Date.parse(row.first_observed_at);
  const lastObservedAt = Date.parse(row.last_observed_at);
  return {
    schema: PROBLEM_DOSSIER_SCHEMA,
    id: row.id,
    fingerprint: row.fingerprint,
    projectId: row.project_id,
    repoPath: row.repo_path,
    painStatement: row.pain_statement,
    firstObservedAt: row.first_observed_at,
    lastObservedAt: row.last_observed_at,
    occurrenceCount: row.occurrence_count,
    observedDurationMs: Number.isFinite(firstObservedAt) && Number.isFinite(lastObservedAt)
      ? Math.max(0, lastObservedAt - firstObservedAt)
      : 0,
    comparableExposureCount: row.comparable_exposure_count,
    impactBand: row.impact_band,
    evidenceConfidence: row.evidence_confidence,
    status: row.status,
    closureContract: parseClosureContract(row.closure_contract_json, row),
    suppressedAt: row.suppressed_at,
    cooldownUntil: row.cooldown_until,
    acceptedAt: row.accepted_at,
    linkedTaskId: row.linked_task_id,
    provisionalResolvedAt: row.provisional_resolved_at,
    verifiedClosedAt: row.verified_closed_at,
    reopenedAt: row.reopened_at,
    operatorStoppedAt: row.operator_stopped_at,
    suppressionReason: row.suppression_reason,
    recurrenceProposalId: row.recurrence_proposal_id,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    evidence: evidenceForDossier(row.id),
    history: historyForDossier(row.id),
  };
}

export function getProblemDossier(id: string): ProblemDossier | null {
  ensureProblemDossierTables();
  const row = getSqlite().prepare(`
    SELECT * FROM problem_dossiers WHERE id = ?
  `).get(id) as ProblemDossierRow | undefined;
  return row ? mapDossier(row) : null;
}

export function listProblemDossiers(options: {
  projectId?: string | null;
  includeSuppressed?: boolean;
} = {}): ProblemDossier[] {
  ensureProblemDossierTables();
  const where: string[] = [];
  const params: string[] = [];
  if (options.projectId) {
    where.push('project_id = ?');
    params.push(options.projectId);
  }
  if (!options.includeSuppressed) where.push("status != 'suppressed'");
  const rows = getSqlite().prepare(`
    SELECT *
    FROM problem_dossiers
    ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY datetime(last_observed_at) DESC, id
  `).all(...params) as ProblemDossierRow[];
  return rows.map(mapDossier);
}

function mapRemedy(row: ProblemRemedyRow): ProblemRemedy {
  return {
    id: row.id,
    dossierId: row.dossier_id,
    sequence: row.sequence,
    taskId: row.task_id,
    missionId: row.mission_id,
    packetId: row.packet_id,
    laneId: row.lane_id,
    approvalId: row.approval_id,
    reviewId: row.review_id,
    releaseRef: row.release_ref,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listProblemRemedies(dossierId: string): ProblemRemedy[] {
  ensureProblemDossierTables();
  return (getSqlite().prepare(`
    SELECT * FROM problem_remedies WHERE dossier_id = ? ORDER BY sequence
  `).all(dossierId) as ProblemRemedyRow[]).map(mapRemedy);
}

export function problemDossierIdsForSupervisorSources(sourceIds: string[]): Map<string, string> {
  ensureProblemDossierTables();
  if (sourceIds.length === 0) return new Map();
  const placeholders = sourceIds.map(() => '?').join(', ');
  const rows = getSqlite().prepare(`
    SELECT source_id, dossier_id FROM problem_evidence
    WHERE source_type = 'supervisor_inbox' AND source_id IN (${placeholders})
  `).all(...sourceIds) as Array<{ source_id: string; dossier_id: string }>;
  return new Map(rows.map((row) => [row.source_id, row.dossier_id]));
}

export interface ProblemSensorResult {
  observedSignals: number;
  qualifyingGroups: number;
  createdDossierIds: string[];
  updatedDossierIds: string[];
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function firstMeaningfulLine(value: string | null): string {
  return value
    ?.split('\n')
    .map((line) => line.trim())
    .find((line) => line && line !== '```')
    ?? 'Operator review required.';
}

function signalFromRow(row: SupervisorInboxEvidenceRow): SupervisorProblemSignal {
  const payload = parsePayload(row.payload);
  return {
    id: row.id,
    projectId: row.project_id,
    repoPath: row.repo_path,
    packetId: row.packet_id,
    kind: row.kind,
    payload,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at ?? row.created_at,
    errorExcerpt: firstMeaningfulLine(
      stringValue(payload.errorExcerpt)
      ?? stringValue(payload.errorMessage)
      ?? stringValue(payload.retryHandoffError)
      ?? stringValue(payload.summary)
      ?? stringValue(payload.verificationOutput)
      ?? stringValue(payload.error)
      ?? stringValue(payload.note),
    ),
  };
}

export function syncRecurringSupervisorProblems(options: {
  threshold?: number;
  now?: Date;
} = {}): ProblemSensorResult {
  ensureProblemDossierTables();
  const threshold = Math.max(2, Math.trunc(options.threshold ?? DEFAULT_RECURRENCE_THRESHOLD));
  const now = (options.now ?? new Date()).toISOString();
  const items = (getSqlite().prepare(`
    SELECT id, project_id, repo_path, packet_id, kind, payload, created_at, last_seen_at
    FROM supervisor_inbox
    WHERE packet_id IS NOT NULL AND packet_id != ''
      AND kind IN ('verification_failed', 'bounded_retry_exhausted', 'packet_no_changes')
  `).all() as SupervisorInboxEvidenceRow[])
    .map(signalFromRow)
    .filter(isEligibleProblemSignal);
  const groups = new Map<string, SupervisorProblemSignal[]>();

  for (const item of items) {
    const fingerprint = fingerprintSupervisorProblem(item);
    const group = groups.get(fingerprint) ?? [];
    group.push(item);
    groups.set(fingerprint, group);
  }

  const createdDossierIds: string[] = [];
  const updatedDossierIds: string[] = [];
  const sqlite = getSqlite();
  const syncGroup = sqlite.transaction((fingerprint: string, group: SupervisorProblemSignal[]) => {
    const distinctPackets = new Set(group.map((item) => item.packetId));
    if (distinctPackets.size < threshold) return;

    const sorted = [...group].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const first = sorted[0];
    const last = sorted.reduce((latest, item) => (
      item.lastSeenAt > latest.lastSeenAt ? item : latest
    ));
    const dossierId = `problem-${stableHash(fingerprint, 20)}`;
    const inserted = sqlite.prepare(`
      INSERT INTO problem_dossiers (
        id, fingerprint, project_id, repo_path, pain_statement,
        first_observed_at, last_observed_at, occurrence_count,
        comparable_exposure_count, impact_band, evidence_confidence,
        status, closure_contract_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 'high', 'candidate', ?, ?, ?)
      ON CONFLICT(fingerprint) DO NOTHING
    `).run(
      dossierId, fingerprint, first.projectId, first.repoPath, painStatementFor(first),
      first.createdAt, last.lastSeenAt, problemImpactBand(first.kind),
      JSON.stringify(closureContractFor({
        kind: first.kind,
        occurrenceCount: sorted.length,
        distinctAttempts: distinctPackets.size,
        recordedAt: now,
      })),
      now, now,
    );

    if (inserted.changes === 1) {
      createdDossierIds.push(dossierId);
      appendProblemDossierEvent({
        dossierId,
        eventType: 'candidate_promoted',
        actor: 'system',
        note: `Recurring evidence crossed the ${threshold}-packet threshold.`,
        fromStatus: null,
        toStatus: 'candidate',
        at: now,
      });
    } else {
      updatedDossierIds.push(dossierId);
    }

    const resolvedDossierId = dossierId;
    const insertEvidence = sqlite.prepare(`
      INSERT OR IGNORE INTO problem_evidence (
        id, dossier_id, source_type, source_id, source_kind, packet_id, observed_at
      ) VALUES (?, ?, 'supervisor_inbox', ?, ?, ?, ?)
    `);
    for (const item of sorted) {
      insertEvidence.run(
        `evidence-${stableHash(`supervisor_inbox\u0000${item.id}`, 20)}`,
        resolvedDossierId,
        item.id,
        item.kind,
        item.packetId,
        item.lastSeenAt,
      );
    }

    const counts = sqlite.prepare(`
      SELECT COUNT(*) AS occurrences,
             MIN(observed_at) AS first_observed_at,
             MAX(observed_at) AS last_observed_at
      FROM problem_evidence
      WHERE dossier_id = ?
    `).get(resolvedDossierId) as {
      occurrences: number;
      first_observed_at: string;
      last_observed_at: string;
    };
    sqlite.prepare(`
      UPDATE problem_dossiers
      SET first_observed_at = ?,
          last_observed_at = ?,
          occurrence_count = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      counts.first_observed_at,
      counts.last_observed_at,
      counts.occurrences,
      now,
      resolvedDossierId,
    );

    const lifecycle = sqlite.prepare(`
      SELECT status, provisional_resolved_at, verified_closed_at, operator_stopped_at
      FROM problem_dossiers WHERE id = ?
    `).get(resolvedDossierId) as Pick<ProblemDossierRow,
      'status' | 'provisional_resolved_at' | 'verified_closed_at' | 'operator_stopped_at'>;
    const closureBoundary = lifecycle.provisional_resolved_at ?? lifecycle.verified_closed_at;
    if (
      closureBoundary
      && counts.last_observed_at > closureBoundary
      && !lifecycle.operator_stopped_at
      && (lifecycle.status === 'provisionally_resolved' || lifecycle.status === 'verified_closed')
    ) {
      sqlite.prepare(`
        UPDATE problem_dossiers
        SET status = 'reopened', reopened_at = ?, provisional_resolved_at = NULL,
            verified_closed_at = NULL,
            comparable_exposure_count = 0, recurrence_proposal_id = NULL, updated_at = ?
        WHERE id = ?
      `).run(counts.last_observed_at, now, resolvedDossierId);
      appendProblemDossierEvent({
        dossierId: resolvedDossierId,
        eventType: 'recurrence_reopened',
        actor: 'system',
        note: 'Matching pain returned after the remedy entered closure verification.',
        fromStatus: lifecycle.status,
        toStatus: 'reopened',
        at: counts.last_observed_at,
      });
    }
  });

  let qualifyingGroups = 0;
  for (const [fingerprint, group] of groups) {
    if (new Set(group.map((item) => item.packetId)).size < threshold) continue;
    qualifyingGroups += 1;
    syncGroup(fingerprint, group);
  }

  return {
    observedSignals: items.length,
    qualifyingGroups,
    createdDossierIds,
    updatedDossierIds,
  };
}
