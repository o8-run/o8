import 'server-only';

import { createHash } from 'node:crypto';

import { proposeObservation } from '@/lib/cortex/proposals';
import { getSqlite } from '@/lib/db';
import { findLatestLaneByPacket } from '@/lib/lane/registry';
import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { findMissionRegistryEntryByPacketId } from '@/lib/orchestrator/mission-registry';
import { stopPacket } from '@/lib/orchestrator/stop-packet';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { createTask } from '@/lib/tasks/actions';
import {
  appendProblemDossierEvent,
  getProblemDossier,
  listProblemDossiers,
  listProblemRemedies,
  syncRecurringSupervisorProblems,
  type ProblemDossier,
  type ProblemDossierStatus,
  type ProblemRemedy,
} from './dossiers';
import { isRecordedArchiveEnding } from './source-policy';

export interface ProblemDossierActionResult {
  ok: boolean;
  dossier: ProblemDossier;
  remedies: ProblemRemedy[];
  note: string;
}

function nowIso(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

function stableHash(value: string, length = 20): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function requireDossier(id: string): ProblemDossier {
  const dossier = getProblemDossier(id);
  if (!dossier) throw new Error(`Problem dossier not found: ${id}`);
  return dossier;
}

function resultFor(dossierId: string, note: string): ProblemDossierActionResult {
  return {
    ok: true,
    dossier: requireDossier(dossierId),
    remedies: listProblemRemedies(dossierId),
    note,
  };
}

function activeRemedy(dossierId: string): ProblemRemedy | null {
  const activeStatuses = new Set(['preparing', 'task_creation_failed', 'accepted', 'investigating', 'active']);
  return listProblemRemedies(dossierId)
    .findLast((remedy) => activeStatuses.has(remedy.status)) ?? null;
}

function reserveRemedy(dossier: ProblemDossier, at: string): ProblemRemedy {
  const sqlite = getSqlite();
  const reserve = sqlite.transaction(() => {
    const existing = activeRemedy(dossier.id);
    if (existing) return existing.id;
    const row = sqlite.prepare(`
      SELECT COALESCE(MAX(sequence), 0) AS sequence
      FROM problem_remedies
      WHERE dossier_id = ?
    `).get(dossier.id) as { sequence: number };
    const sequence = row.sequence + 1;
    const remedyId = `remedy-${stableHash(`${dossier.id}\u0000${sequence}`)}`;
    sqlite.prepare(`
      INSERT OR IGNORE INTO problem_remedies (
        id, dossier_id, sequence, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'preparing', ?, ?)
    `).run(remedyId, dossier.id, sequence, at, at);
    const reserved = sqlite.prepare(`
      SELECT id FROM problem_remedies WHERE dossier_id = ? AND sequence = ?
    `).get(dossier.id, sequence) as { id: string } | undefined;
    return reserved?.id ?? remedyId;
  });
  const remedyId = reserve();
  const remedy = listProblemRemedies(dossier.id).find((candidate) => candidate.id === remedyId);
  if (!remedy) throw new Error(`Problem remedy reservation disappeared: ${remedyId}`);
  return remedy;
}

export async function acceptProblemDossier(
  dossierId: string,
  options: { now?: Date } = {},
): Promise<ProblemDossierActionResult> {
  const dossier = requireDossier(dossierId);
  if (dossier.operatorStoppedAt) {
    throw new Error('This problem is operator-stopped. Resume it before accepting a remedy.');
  }
  if (dossier.status === 'suppressed') {
    throw new Error('This problem is suppressed. Resume it before accepting a remedy.');
  }
  if (dossier.status === 'verified_closed') {
    throw new Error('This problem is already verified closed. New evidence will reopen the same dossier.');
  }

  const at = nowIso(options.now);
  const remedy = reserveRemedy(dossier, at);
  if (remedy.taskId) {
    return resultFor(dossier.id, 'The existing remedy task remains linked to this problem.');
  }

  try {
    const task = await createTask({
      title: `Remedy recurring problem: ${dossier.painStatement}`.slice(0, 180),
      summary: [
        dossier.painStatement,
        '',
        `Observed ${dossier.occurrenceCount} times across distinct packet evidence.`,
        `Closure requires ${dossier.closureContract.requiredComparableExposures} comparable clean exposures after the remedy is released.`,
        `Problem dossier: ${dossier.id}`,
      ].join('\n'),
      projectId: dossier.projectId,
      repoPath: dossier.repoPath,
      problemDossierId: dossier.id,
      problemRemedyId: remedy.id,
      actor: 'user',
    });
    const accepted = getSqlite().transaction(() => {
      const linked = getSqlite().prepare(`
        UPDATE problem_dossiers
        SET status = 'accepted', accepted_at = COALESCE(accepted_at, ?),
            linked_task_id = ?, last_error = NULL, updated_at = ?
        WHERE id = ? AND operator_stopped_at IS NULL AND status != 'suppressed'
          AND COALESCE(linked_task_id, '') = COALESCE(?, '')
      `).run(at, task.taskId, at, dossier.id, dossier.linkedTaskId);
      if (linked.changes === 0) return false;
      getSqlite().prepare(`
        UPDATE problem_remedies
        SET task_id = ?, packet_id = ?, status = 'accepted', updated_at = ?
        WHERE id = ? AND task_id IS NULL
      `).run(task.taskId, task.packetId, at, remedy.id);
      appendProblemDossierEvent({
        dossierId: dossier.id,
        eventType: 'remedy_accepted',
        actor: 'operator',
        note: `Created linked task ${task.taskId}.`,
        fromStatus: dossier.status,
        toStatus: 'accepted',
        at,
      });
      return true;
    })();
    if (!accepted) {
      const current = requireDossier(dossier.id);
      if (current.linkedTaskId === task.taskId) {
        return resultFor(dossier.id, 'The existing remedy task remains linked to this problem.');
      }
      if (current.operatorStoppedAt || current.status === 'suppressed') {
        getSqlite().prepare(`
          UPDATE problem_remedies
          SET task_id = ?, packet_id = ?, status = 'stopped', updated_at = ?
          WHERE id = ?
        `).run(task.taskId, task.packetId, at, remedy.id);
        await stopPacket(task.taskId);
        throw new Error('This problem was stopped before its remedy task could be linked.');
      }
      throw new Error('The dossier changed while its remedy task was being created.');
    }
    return resultFor(dossier.id, 'Remedy accepted and linked to one ordinary task.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stopped = requireDossier(dossier.id).operatorStoppedAt !== null;
    getSqlite().transaction(() => {
      getSqlite().prepare(`
        UPDATE problem_remedies SET status = ?, updated_at = ? WHERE id = ?
      `).run(stopped ? 'stopped' : 'task_creation_failed', at, remedy.id);
      getSqlite().prepare(`
        UPDATE problem_dossiers SET last_error = ?, updated_at = ? WHERE id = ?
      `).run(stopped ? null : message, at, dossier.id);
    })();
    throw error;
  }
}

export function suppressProblemDossier(
  dossierId: string,
  options: { reason?: string | null; cooldownDays?: number; now?: Date } = {},
): ProblemDossierActionResult {
  const dossier = requireDossier(dossierId);
  if (dossier.linkedTaskId && !['candidate', 'suppressed', 'verified_closed'].includes(dossier.status)) {
    throw new Error('This problem has active remedy work. Use Stop to halt it before suppressing.');
  }
  const atDate = options.now ?? new Date();
  const days = Math.max(1, Math.min(365, Math.trunc(options.cooldownDays ?? 7)));
  const cooldownUntil = new Date(atDate.getTime() + days * 86_400_000).toISOString();
  getSqlite().prepare(`
    UPDATE problem_dossiers
    SET status = 'suppressed', suppressed_at = ?, cooldown_until = ?,
        suppression_reason = ?, updated_at = ?
    WHERE id = ?
  `).run(atDate.toISOString(), cooldownUntil, options.reason?.trim() || null, atDate.toISOString(), dossier.id);
  appendProblemDossierEvent({
    dossierId: dossier.id,
    eventType: 'suppressed',
    actor: 'operator',
    note: options.reason?.trim() || `Cooldown until ${cooldownUntil}.`,
    fromStatus: dossier.status,
    toStatus: 'suppressed',
    at: atDate.toISOString(),
  });
  return resultFor(dossier.id, `Problem suppressed until ${cooldownUntil}. Evidence will continue accumulating.`);
}

export async function stopProblemDossier(
  dossierId: string,
  options: { reason?: string | null; now?: Date } = {},
): Promise<ProblemDossierActionResult> {
  const dossier = requireDossier(dossierId);
  const at = nowIso(options.now);
  getSqlite().prepare(`
    UPDATE problem_dossiers
    SET status = 'suppressed', operator_stopped_at = COALESCE(operator_stopped_at, ?),
        suppressed_at = COALESCE(suppressed_at, ?), cooldown_until = NULL,
        suppression_reason = ?, updated_at = ?
    WHERE id = ?
  `).run(at, at, options.reason?.trim() || 'Stopped by operator.', at, dossier.id);
  appendProblemDossierEvent({
    dossierId: dossier.id,
    eventType: 'operator_stopped',
    actor: 'operator',
    note: options.reason?.trim() || 'Stopped by operator.',
    fromStatus: dossier.status,
    toStatus: 'suppressed',
    at,
  });

  const linked = dossier.linkedTaskId ? resolveLinkedTask(dossier.linkedTaskId) : null;
  const hasActiveWorker = linked?.lane
    ? ['launching', 'running', 'paused', 'awaiting_input', 'awaiting_orchestrator', 'awaiting_human', 'recovering', 'reviewing', 'merging']
      .includes(linked.lane.status)
    : linked?.packet
      ? ['launching', 'running', 'recovering', 'awaiting_review'].includes(linked.packet.status)
      : false;
  const linkedTaskNeedsHold = linked?.packet?.releaseState !== 'released' && Boolean(linked?.packet);
  if (dossier.linkedTaskId && (hasActiveWorker || linkedTaskNeedsHold)) {
    try {
      const stopped = await stopPacket(dossier.linkedTaskId);
      if (!stopped.ok || !stopped.killConfirmed) {
        const note = stopped.note || 'The linked worker could not be confirmed stopped.';
        getSqlite().prepare(`
          UPDATE problem_dossiers SET last_error = ?, updated_at = ? WHERE id = ?
        `).run(note, at, dossier.id);
        return { ...resultFor(dossier.id, note), ok: false };
      }
    } catch (error) {
      const note = error instanceof Error ? error.message : String(error);
      getSqlite().prepare(`
        UPDATE problem_dossiers SET last_error = ?, updated_at = ? WHERE id = ?
      `).run(note, at, dossier.id);
      return { ...resultFor(dossier.id, note), ok: false };
    }
  }

  return resultFor(dossier.id, 'Problem stopped. New evidence remains attached, but no remedy will restart until Resume.');
}

export function resumeProblemDossier(
  dossierId: string,
  options: { now?: Date } = {},
): ProblemDossierActionResult {
  const dossier = requireDossier(dossierId);
  const at = nowIso(options.now);
  const nextStatus: ProblemDossierStatus = dossier.acceptedAt ? 'reopened' : 'candidate';
  getSqlite().prepare(`
    UPDATE problem_dossiers
    SET status = ?, operator_stopped_at = NULL, suppressed_at = NULL,
        cooldown_until = NULL, suppression_reason = NULL, last_error = NULL, updated_at = ?
    WHERE id = ?
  `).run(nextStatus, at, dossier.id);
  appendProblemDossierEvent({
    dossierId: dossier.id,
    eventType: 'operator_resumed',
    actor: 'operator',
    note: 'Resumed by operator.',
    fromStatus: dossier.status,
    toStatus: nextStatus,
    at,
  });
  return resultFor(dossier.id, 'Problem resumed. Existing evidence and remedy history were preserved.');
}

function comparableExposureCount(dossier: ProblemDossier): number {
  if (!dossier.provisionalResolvedAt) return 0;
  if (dossier.closureContract.exposureDenominator === 'distinct_archived_lanes_with_recorded_endings') {
    const rows = getSqlite().prepare(`
      SELECT packet_id, outcome, outcome_note
      FROM lanes
      WHERE repo_path = ?
        AND COALESCE(project_id, '') = COALESCE(?, '')
        AND packet_id IS NOT NULL
        AND packet_id != ?
        AND status = 'archived'
        AND datetime(COALESCE(last_event_at, updated_at)) > datetime(?)
    `).all(
      dossier.repoPath,
      dossier.projectId,
      dossier.linkedTaskId ?? '',
      dossier.provisionalResolvedAt,
    ) as Array<{ packet_id: string; outcome: string | null; outcome_note: string | null }>;
    return new Set(rows
      .filter((row) => isRecordedArchiveEnding(row.outcome, row.outcome_note))
      .map((row) => row.packet_id)).size;
  }
  const row = getSqlite().prepare(`
    SELECT COUNT(DISTINCT packet_id) AS count
    FROM lanes
    WHERE repo_path = ?
      AND COALESCE(project_id, '') = COALESCE(?, '')
      AND packet_id IS NOT NULL
      AND packet_id != ?
      AND datetime(COALESCE(last_event_at, updated_at)) > datetime(?)
      AND outcome = 'merged'
  `).get(
    dossier.repoPath,
    dossier.projectId,
    dossier.linkedTaskId ?? '',
    dossier.provisionalResolvedAt,
  ) as { count: number };
  return row.count;
}

function proposeClosureLearning(dossier: ProblemDossier): string | null {
  if (!dossier.linkedTaskId) return null;
  try {
    return proposeObservation({
      packetId: dossier.linkedTaskId,
      proposed_by: dossier.id,
      kind: 'pattern',
      scope: 'repo',
      text: `A recurring problem was verified closed after ${dossier.comparableExposureCount} clean exposures. Preserve the remedy and regression coverage for: ${dossier.painStatement}`,
    }).id;
  } catch (error) {
    console.warn('[problem-dossiers] Failed to propose verified closure learning:', error);
    return null;
  }
}

export interface ProblemReconcileResult {
  scanned: number;
  updatedDossierIds: string[];
  verifiedClosedDossierIds: string[];
}

interface LinkedTaskTruth {
  missionId: string | null;
  packet: OrchestratorPacket | null;
  lane: ReturnType<typeof findLatestLaneByPacket>;
}

/**
 * Stored-mission lookups by packet, valid while the missions table is unchanged.
 * Each lookup scans every stored mission's text; the reconcile repeats it for
 * every linked dossier each minute, almost always with the same answer.
 */
let registryLookups: { stamp: string; byPacket: Map<string, ReturnType<typeof findMissionRegistryEntryByPacketId>> } | null = null;

function missionsStamp(): string {
  // Every mission write sets updated_at; the total catches a change to any row.
  const row = getSqlite().prepare('SELECT COUNT(*) AS rows, MAX(updated_at) AS latest, TOTAL(updated_at) AS total FROM missions')
    .get() as { rows: number; latest: number | null; total: number };
  return `${row.rows}:${row.latest}:${row.total}`;
}

function storedMissionForPacket(packetId: string) {
  const stamp = missionsStamp();
  if (registryLookups?.stamp !== stamp) registryLookups = { stamp, byPacket: new Map() };
  if (!registryLookups.byPacket.has(packetId)) {
    registryLookups.byPacket.set(packetId, findMissionRegistryEntryByPacketId(packetId, { includeArchived: true }));
  }
  return registryLookups.byPacket.get(packetId) ?? null;
}

function resolveLinkedTask(packetId: string): LinkedTaskTruth {
  const current = readOrchestratorControlPlaneState();
  const currentPacket = current.packets.find((packet) => packet.id === packetId) ?? null;
  if (currentPacket) {
    return { missionId: current.missionId || null, packet: currentPacket, lane: findLatestLaneByPacket(packetId) };
  }
  const registry = storedMissionForPacket(packetId);
  return {
    missionId: registry?.mission.missionId ?? null,
    packet: registry?.mission.packets.find((packet) => packet.id === packetId) ?? null,
    lane: findLatestLaneByPacket(packetId),
  };
}

function remedyLinks(truth: LinkedTaskTruth) {
  const packet = truth.packet;
  const reviewId = packet?.review?.recordedAt
    ? `review:${packet.id}:${packet.review.recordedAt}`
    : null;
  const releaseRef = packet?.releaseStatePayload?.mergeCommit
    ?? packet?.releaseStatePayload?.source
    ?? truth.lane?.outcome
    ?? null;
  return {
    missionId: truth.missionId,
    packetId: packet?.id ?? truth.lane?.packetId ?? null,
    laneId: truth.lane?.id ?? packet?.lane?.laneId ?? null,
    approvalId: packet?.review?.auditApprovalId ?? null,
    reviewId,
    releaseRef,
  };
}

export async function reconcileProblemDossiers(options: {
  now?: Date;
  projectId?: string | null;
} = {}): Promise<ProblemReconcileResult> {
  const at = nowIso(options.now);
  syncRecurringSupervisorProblems({ now: options.now });
  getSqlite().prepare(`
    UPDATE problem_dossiers
    SET status = CASE WHEN accepted_at IS NULL THEN 'candidate' ELSE 'reopened' END,
        suppressed_at = NULL, cooldown_until = NULL, suppression_reason = NULL, updated_at = ?
    WHERE status = 'suppressed'
      AND operator_stopped_at IS NULL
      AND cooldown_until IS NOT NULL
      AND datetime(cooldown_until) <= datetime(?)
  `).run(at, at);

  const dossiers = listProblemDossiers({ projectId: options.projectId, includeSuppressed: true });
  const updatedDossierIds: string[] = [];
  const verifiedClosedDossierIds: string[] = [];

  for (const dossier of dossiers) {
    if (dossier.status === 'suppressed' || dossier.operatorStoppedAt) continue;
    const linked = dossier.linkedTaskId ? resolveLinkedTask(dossier.linkedTaskId) : null;
    const packet = linked?.packet ?? null;
    const lane = linked?.lane ?? null;
    let nextStatus = dossier.status;
    let provisionalAt = dossier.provisionalResolvedAt;
    let lastError = dossier.lastError;
    const lifecycleEligible = ['accepted', 'investigating', 'remedy_active', 'provisionally_resolved']
      .includes(dossier.status);
    if (packet && lifecycleEligible) {
      if (packet.releaseState === 'released' && packet.review?.approved === true) {
        nextStatus = 'provisionally_resolved';
        provisionalAt ??= packet.releaseStatePayload?.releasedAt ?? packet.lastEventAt ?? at;
        if (dossier.lastObservedAt > provisionalAt) {
          nextStatus = 'reopened';
          provisionalAt = null;
        }
      } else if (
        ['running', 'launching', 'awaiting_review'].includes(packet.status)
        || (lane && ['running', 'launching', 'reviewing', 'merging'].includes(lane.status))
      ) {
        nextStatus = 'remedy_active';
      } else {
        nextStatus = 'investigating';
        lastError = packet.status === 'failed' || packet.status === 'blocked'
          ? packet.blockedReason ?? packet.lastEventLabel ?? 'The remedy task needs operator attention.'
          : null;
      }
    }

    const exposures = provisionalAt
      ? comparableExposureCount({ ...dossier, provisionalResolvedAt: provisionalAt })
      : 0;
    if (
      nextStatus === 'provisionally_resolved'
      && exposures >= dossier.closureContract.requiredComparableExposures
    ) {
      nextStatus = 'verified_closed';
    }

    const changed = nextStatus !== dossier.status
      || provisionalAt !== dossier.provisionalResolvedAt
      || exposures !== dossier.comparableExposureCount
      || lastError !== dossier.lastError;
    if (linked && dossier.linkedTaskId) {
      const links = remedyLinks(linked);
      getSqlite().prepare(`
        UPDATE problem_remedies
        SET mission_id = ?, packet_id = ?, lane_id = ?, approval_id = ?,
            review_id = ?, release_ref = ?, updated_at = ?
        WHERE dossier_id = ? AND task_id = ?
      `).run(
        links.missionId,
        links.packetId,
        links.laneId,
        links.approvalId,
        links.reviewId,
        links.releaseRef,
        at,
        dossier.id,
        dossier.linkedTaskId,
      );
    }
    if (!changed) continue;
    getSqlite().prepare(`
      UPDATE problem_dossiers
      SET status = ?, provisional_resolved_at = ?, comparable_exposure_count = ?,
          verified_closed_at = CASE WHEN ? = 'verified_closed' THEN COALESCE(verified_closed_at, ?) ELSE NULL END,
          last_error = ?, updated_at = ?
      WHERE id = ?
    `).run(nextStatus, provisionalAt, exposures, nextStatus, at, lastError, at, dossier.id);
    getSqlite().prepare(`
      UPDATE problem_remedies
      SET status = ?, updated_at = ?
      WHERE dossier_id = ? AND task_id = ?
    `).run(
      nextStatus === 'verified_closed'
        ? 'verified'
        : nextStatus === 'provisionally_resolved'
          ? 'provisional'
          : nextStatus === 'reopened'
            ? 'recurred'
            : packet?.status === 'failed' || packet?.status === 'blocked'
              ? 'failed'
              : 'active',
      at,
      dossier.id,
      dossier.linkedTaskId,
    );
    if (nextStatus !== dossier.status) {
      appendProblemDossierEvent({
        dossierId: dossier.id,
        eventType: nextStatus === 'verified_closed' ? 'verified_closed' : 'state_reconciled',
        actor: 'system',
        note: nextStatus === 'verified_closed'
          ? `Closure contract passed after ${exposures} clean exposures.`
          : `Linked remedy task moved the dossier to ${nextStatus}.`,
        fromStatus: dossier.status,
        toStatus: nextStatus,
        at,
      });
    }
    updatedDossierIds.push(dossier.id);

    if (nextStatus === 'verified_closed' && !dossier.recurrenceProposalId) {
      const closed = requireDossier(dossier.id);
      const proposalId = proposeClosureLearning(closed);
      if (proposalId) {
        getSqlite().prepare(`
          UPDATE problem_dossiers SET recurrence_proposal_id = ?, updated_at = ? WHERE id = ?
        `).run(proposalId, at, dossier.id);
      }
      verifiedClosedDossierIds.push(dossier.id);
    }
  }

  return { scanned: dossiers.length, updatedDossierIds, verifiedClosedDossierIds };
}
