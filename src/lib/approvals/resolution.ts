import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';

import {
  approvalEvents as approvalEventsTable,
  approvals as approvalsTable,
  getDb,
} from '@/lib/db';
import type {
  ApprovalActor,
  ApprovalAuditEvent,
  ApprovalRecord,
} from '@/lib/approvals/types';
import { parseApprovalMetadataJson } from '@/lib/approvals/referee-metadata';

type ApprovalRow = typeof approvalsTable.$inferSelect;
type ApprovalDb = NonNullable<ReturnType<typeof getDb>>;
type ApprovalTransaction = Parameters<Parameters<ApprovalDb['transaction']>[0]>[0];
type ApprovalWriteDb = ApprovalDb | ApprovalTransaction;

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function readApproval(id: string): ApprovalRecord | null {
  const db = getDb();
  if (!db) throw new Error('[approval-resolution] SQLite database is unavailable');
  const row = db.select().from(approvalsTable).where(eq(approvalsTable.id, id)).get() as ApprovalRow | undefined;
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.projectId ?? null,
    source: row.source,
    runtime: row.runtime,
    agent: row.agent,
    sessionKey: row.sessionKey,
    title: row.title,
    description: row.description,
    summary: row.summary,
    toolName: row.toolName ?? undefined,
    args: parseJson<ApprovalRecord['args']>(row.argsJson, undefined),
    command: row.command ?? undefined,
    editable: row.editable ?? undefined,
    diff: parseJson<ApprovalRecord['diff']>(row.diffJson, undefined),
    gateResult: parseJson<ApprovalRecord['gateResult']>(row.gateResultJson, undefined),
    conflictReport: parseJson<ApprovalRecord['conflictReport']>(row.conflictReportJson, undefined),
    risk: row.risk,
    ...parseApprovalMetadataJson(row.metadataJson),
    policyRuleId: row.policyRuleId ?? undefined,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    resolvedAt: row.resolvedAt ?? undefined,
    resolution: parseJson<ApprovalRecord['resolution']>(row.resolutionJson, undefined),
    audit: parseJson<ApprovalAuditEvent[]>(row.auditJson, []),
    fingerprint: row.fingerprint,
    continuation: parseJson<ApprovalRecord['continuation']>(row.continuationJson, undefined),
  };
}

function approvalEvent(
  type: ApprovalAuditEvent['type'],
  actor: ApprovalActor,
  note?: string,
  timestamp = Date.now(),
): ApprovalAuditEvent {
  return { type, actor, timestamp, note: note?.trim() || undefined };
}

function insertResolutionEvent(
  db: ApprovalWriteDb,
  approvalId: string,
  event: ApprovalAuditEvent,
) {
  db.insert(approvalEventsTable).values({
    id: `evt-${approvalId}-${event.timestamp}-${randomUUID()}`,
    approvalId,
    eventType: event.type,
    actor: event.actor,
    note: event.note ?? null,
    detailsJson: JSON.stringify({
      ...(event.approvedFromCard ? { approvedFromCard: event.approvedFromCard } : {}),
      ...(event.terminalAdapter ? { terminalAdapter: event.terminalAdapter } : {}),
    }),
    timestamp: event.timestamp,
  }).run();
}

export interface ApprovalResolutionClaim {
  approval: ApprovalRecord | null;
  claimed: boolean;
  claimId?: string;
}

/** Atomically move one exact pending approval to a terminal decision. */
export function claimApprovalResolution(
  id: string,
  action: 'approve' | 'reject',
  actor: ApprovalActor,
  note?: string,
  expectedUpdatedAt?: number,
  approvedFromCard?: ApprovalAuditEvent['approvedFromCard'],
  terminalAdapter?: ApprovalAuditEvent['terminalAdapter'],
  subjectStillCurrent?: () => boolean,
): ApprovalResolutionClaim {
  const existing = readApproval(id);
  if (!existing || existing.status !== 'pending') {
    return { approval: existing, claimed: false };
  }
  if (expectedUpdatedAt !== undefined && existing.updatedAt !== expectedUpdatedAt) {
    return { approval: existing, claimed: false };
  }
  const db = getDb();
  if (!db) throw new Error('[approval-resolution] SQLite database is unavailable');

  const resolvedAt = Date.now();
  const nextStatus = action === 'approve' ? 'approved' : 'rejected';
  const claimId = randomUUID();
  const event = approvalEvent(
    action === 'approve' ? 'approved' : 'rejected',
    actor,
    note,
    resolvedAt,
  );
  if (approvedFromCard && action === 'approve') event.approvedFromCard = approvedFromCard;
  if (terminalAdapter) event.terminalAdapter = terminalAdapter;
  const resolution: NonNullable<ApprovalRecord['resolution']> = {
    action: nextStatus,
    actor,
    note: note?.trim() || undefined,
    claimId,
    continuationStatus: action === 'approve' && (existing.continuation || existing.toolName === 'edit_file')
      ? 'pending'
      : undefined,
  };
  const next: ApprovalRecord = {
    ...existing,
    status: nextStatus,
    updatedAt: resolvedAt,
    resolvedAt,
    resolution,
    audit: [...existing.audit, event],
  };
  const claimed = db.transaction((tx) => {
    if (subjectStillCurrent && !subjectStillCurrent()) return false;
    const result = tx
      .update(approvalsTable)
      .set({
        status: nextStatus,
        updatedAt: resolvedAt,
        resolvedAt,
        resolutionJson: JSON.stringify(resolution),
        auditJson: JSON.stringify(next.audit),
      })
      .where(and(
        eq(approvalsTable.id, id),
        eq(approvalsTable.status, 'pending'),
        eq(approvalsTable.updatedAt, existing.updatedAt),
      ))
      .run();
    if ((result.changes ?? 0) !== 1) return false;
    insertResolutionEvent(tx, id, event);
    return true;
  });
  if (!claimed) {
    return { approval: readApproval(id), claimed: false };
  }
  return { approval: next, claimed: true, claimId };
}

export function finalizeApprovalContinuation(
  id: string,
  claimId: string,
  status: 'completed' | 'failed' | 'outcome_unknown',
  note?: string,
) {
  const existing = readApproval(id);
  if (!existing || existing.resolution?.claimId !== claimId) return existing;
  const db = getDb();
  if (!db) throw new Error('[approval-resolution] SQLite database is unavailable');
  const event = approvalEvent(
    status === 'completed'
      ? 'continuation_completed'
      : status === 'failed'
        ? 'continuation_failed'
        : 'continuation_outcome_unknown',
    'system',
    note,
  );
  const resolution = { ...existing.resolution, continuationStatus: status };
  const audit = [...existing.audit, event];
  const updatedAt = Date.now();
  const updated = db.transaction((tx) => {
    const result = tx.update(approvalsTable).set({
      updatedAt,
      resolutionJson: JSON.stringify(resolution),
      auditJson: JSON.stringify(audit),
    }).where(and(
      eq(approvalsTable.id, id),
      eq(approvalsTable.resolutionJson, JSON.stringify(existing.resolution)),
    )).run();
    if ((result.changes ?? 0) !== 1) return false;
    insertResolutionEvent(tx, id, event);
    return true;
  });
  return updated ? { ...existing, updatedAt, resolution, audit } : readApproval(id);
}

export function resolveApproval(
  id: string,
  action: 'approve' | 'reject',
  actor: ApprovalActor,
  note?: string,
) {
  return claimApprovalResolution(id, action, actor, note).approval;
}

/** Re-open only the resolution claim that failed before executing its action. */
export function reopenApprovalAfterEvidenceDrift(id: string, claimId: string, note: string) {
  const existing = readApproval(id);
  if (
    !existing
    || existing.status !== 'approved'
    || existing.resolution?.claimId !== claimId
  ) return existing;
  const db = getDb();
  if (!db) throw new Error('[approval-resolution] SQLite database is unavailable');

  const event = approvalEvent('resume_failed', 'system', note);
  const updatedAt = Date.now();
  const audit = [...existing.audit, event];
  const reopened = db.transaction((tx) => {
    const result = tx
      .update(approvalsTable)
      .set({
        status: 'pending',
        updatedAt,
        resolvedAt: null,
        resolutionJson: null,
        auditJson: JSON.stringify(audit),
      })
      .where(and(
        eq(approvalsTable.id, id),
        eq(approvalsTable.status, 'approved'),
        eq(approvalsTable.updatedAt, existing.updatedAt),
        eq(approvalsTable.resolutionJson, JSON.stringify(existing.resolution)),
      ))
      .run();
    if ((result.changes ?? 0) !== 1) return false;
    insertResolutionEvent(tx, id, event);
    return true;
  });
  if (!reopened) return readApproval(id);
  return {
    ...existing,
    status: 'pending' as const,
    updatedAt,
    resolvedAt: undefined,
    resolution: undefined,
    audit,
  };
}
