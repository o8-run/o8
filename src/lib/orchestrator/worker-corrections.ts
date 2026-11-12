import { runtimeOwnerRequired } from '@/lib/runtime/owner-context';
import { isNativeCortexReader } from '@/lib/cortex/owner-process';
import { callSteerOwner } from '@/lib/orchestrator/operator-mission-service/steer-owner-client';
import { advanceCorrectionStop, correctionStopVersion } from '@/lib/db/worker-correction-fences';
import { getSqlite } from '@/lib/db';
import { addSessionRule } from '@/lib/db/session-rules-store';
import { relatedWorkerMembership } from '@/lib/mcp/worker-observation';
import { readOwnedRecoveryState } from '@/lib/runtimes/shared/owned-session/automatic-recovery';
import { holdPendingOwnedCorrections, withOwnedActionAdmission } from '@/lib/runtimes/shared/owned-session/action-admission';
import { steerPacket } from './operator-mission-service/steer';
import { performRuntimeAction } from '@/lib/runtime/actions';
import { findLaneByPacket } from '@/lib/lane/registry';
import { packetOperatorCorrectionHoldReason } from '@/lib/lane/packet-stop-hold';
import { assertSharedCheckoutOwner, readActiveSharedCheckoutTeam } from './shared-checkout-team';
import { validateComposerQueueTarget } from './composer-queue';
import { withSessionRuleMutation } from './session-merge-restriction';
import { withSessionRules } from './session-rules-prompt';
import type { ComposerQueueTarget } from './composer-queue-types';
import type { CorrectableWorker, WorkerCorrectionPayload, WorkerCorrectionReceipt } from './worker-correction-types';

interface CorrectionRow { id: string; repo_path: string; thread_id: string; payload_json: string; rule_id: string | null; created_at: number }
type Delivery = WorkerCorrectionReceipt['deliveries'][number];
type DeliveryRow = { surface_id: string; run_id: string; status: Delivery['status']; note: string };
function receipt(row: CorrectionRow): WorkerCorrectionReceipt {
  const deliveries = getSqlite().prepare('SELECT * FROM worker_correction_deliveries WHERE correction_id = ? ORDER BY surface_id').all(row.id) as DeliveryRow[];
  return { id: row.id, repoPath: row.repo_path, threadId: row.thread_id, payload: JSON.parse(row.payload_json),
    ruleId: row.rule_id, createdAt: row.created_at,
    deliveries: deliveries.map(item => ({ surfaceId: item.surface_id, runId: item.run_id, status: item.status, note: item.note })) };
}
export function readWorkerCorrection(id: string): WorkerCorrectionReceipt | null {
  const row = getSqlite().prepare('SELECT * FROM worker_corrections WHERE id = ?').get(id) as CorrectionRow | undefined;
  return row ? receipt(row) : null;
}
export function listWorkerCorrections(target: ComposerQueueTarget): WorkerCorrectionReceipt[] {
  return (getSqlite().prepare('SELECT * FROM worker_corrections WHERE repo_path = ? AND thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 20')
    .all(target.repoPath, target.threadId) as CorrectionRow[]).map(receipt);
}

function assertCurrentMember(target: ComposerQueueTarget, surfaceId: string) {
  const member = relatedWorkerMembership({ repoPath: target.repoPath, parentThreadId: target.threadId }).find(item => item.surfaceId === surfaceId);
  if (!member || member.membership !== 'active') throw new Error('Worker is no longer active in this conversation.');
  if (member.checkoutMode === 'shared') {
    assertSharedCheckoutOwner({ repoPath: target.repoPath, parentThreadId: target.threadId });
    const team = readActiveSharedCheckoutTeam(target.repoPath);
    if (!team?.members.some(item => item.surfaceId === surfaceId && item.state === 'running')) throw new Error('Worker ownership changed.');
  } else {
    const lane = member.packetId ? findLaneByPacket(member.packetId) : null;
    if (!lane || lane.sessionKey !== surfaceId || packetOperatorCorrectionHoldReason(member.packetId!)) throw new Error('Packet is held, closed, or bound to another worker.');
  }
  return member;
}

export async function listCorrectableWorkers(target: ComposerQueueTarget): Promise<CorrectableWorker[]> {
  const workers: CorrectableWorker[] = [];
  for (const member of relatedWorkerMembership({ repoPath: target.repoPath, parentThreadId: target.threadId })) {
    try { assertCurrentMember(target, member.surfaceId); } catch { continue; }
    // These stores enforce exact-run admission under their owned surface lock.
    if (!['codex', 'claude-code'].includes(member.runtime)) continue;
    const run = await readOwnedRecoveryState(member.surfaceId);
    if (!run.owned || !run.runId || !run.operatorCorrectionAllowed || run.interrupted) continue;
    const team = member.checkoutMode === 'shared' ? readActiveSharedCheckoutTeam(target.repoPath) : null;
    workers.push({ surfaceId: member.surfaceId, runId: run.runId, runtime: member.runtime,
      taskName: team?.members.find(item => item.surfaceId === member.surfaceId)?.taskName ?? member.packetId ?? member.surfaceId,
      running: run.outcome === 'running' });
  }
  return workers;
}

function payload(input: unknown): WorkerCorrectionPayload {
  const value = input as Partial<WorkerCorrectionPayload> | null;
  if (!value || !['send', 'pause-and-send', 'stop'].includes(value.mode ?? '')
    || typeof value.message !== 'string' || !value.message.trim() || value.message.length > 2000
    || typeof value.holdMerges !== 'boolean' || !Array.isArray(value.targets) || value.targets.length > 8
    || value.targets.some(item => !item || typeof item.surfaceId !== 'string' || !item.surfaceId || item.surfaceId.length > 240
      || typeof item.runId !== 'string' || !item.runId || item.runId.length > 160)
    || (!value.targets.length && !value.holdMerges)
    || new Set(value.targets.map(item => item.surfaceId)).size !== value.targets.length) throw new Error('Choose up to eight exact worker runs and a correction of at most 2000 characters.');
  return { message: value.message.trim(), mode: value.mode!, holdMerges: value.holdMerges,
    targets: value.targets.map(item => ({ surfaceId: item.surfaceId, runId: item.runId })).sort((a, b) => a.surfaceId.localeCompare(b.surfaceId)) };
}
function update(id: string, surfaceId: string, status: Delivery['status'], note: string): void {
  getSqlite().prepare(`UPDATE worker_correction_deliveries SET status = ?, note = ?, updated_at = ?
    WHERE correction_id = ? AND surface_id = ? AND status = 'sending'`).run(status, note, Date.now(), id, surfaceId);
}
export function holdWorkerCorrections(target: ComposerQueueTarget): void {
  getSqlite().transaction(() => {
    advanceCorrectionStop(`parent:${target.repoPath}\n${target.threadId}`);
    getSqlite().prepare(`UPDATE worker_correction_deliveries SET status = 'held', note = 'Parent stopped. Inspect the worker before resuming.', updated_at = ?
    WHERE status IN ('pending','sending') AND correction_id IN
    (SELECT id FROM worker_corrections WHERE repo_path = ? AND thread_id = ?)`).run(Date.now(), target.repoPath, target.threadId);
  })();
}

interface AdmissionChecks { state: () => void; code: () => void }

/** No automatic retry: an interrupted request can already have affected a worker. */
export async function correctWorkers(input: ComposerQueueTarget & { id: string; payload: unknown }, admissionChecks?: AdmissionChecks): Promise<WorkerCorrectionReceipt> {
  if (runtimeOwnerRequired() && !isNativeCortexReader()) {
    if (admissionChecks) throw new Error('Reviewed correction admission must be constructed by its owner.');
    return callSteerOwner({ kind: 'correct', input });
  }
  const target = validateComposerQueueTarget(input);
  if (typeof input.id !== 'string' || !/^[A-Za-z0-9_-]{8,120}$/.test(input.id)) throw new Error('A correction identity is required.');
  const correction = payload(input.payload);
  const serialized = JSON.stringify(correction);
  const prior = readWorkerCorrection(input.id);
  if (prior) {
    if (prior.repoPath !== target.repoPath || prior.threadId !== target.threadId || JSON.stringify(prior.payload) !== serialized) throw new Error('This correction identity belongs to another request.');
    return prior;
  }
  const fences = [`parent:${target.repoPath}\n${target.threadId}`, ...correction.targets.map(item => `worker:${item.surfaceId}`)]
    .map(scope => ({ scope, version: correctionStopVersion(scope) }));
  for (const selected of correction.targets) {
    assertCurrentMember(target, selected.surfaceId);
    const run = await readOwnedRecoveryState(selected.surfaceId);
    if (!run.owned || !run.operatorCorrectionAllowed || run.runId !== selected.runId || run.interrupted
      || !/^(codex-owned:|claude-code-owned:)/.test(selected.surfaceId)) throw new Error('A selected worker changed, stopped, or cannot accept a correction. Refresh its state.');
  }
  const created = await withSessionRuleMutation(target.threadId, () => {
    // Git may take seconds. Check it before opening the SQLite write transaction.
    admissionChecks?.code();
    return getSqlite().transaction(() => {
      if (readWorkerCorrection(input.id)) return false;
      admissionChecks?.state();
      if (fences.some(fence => correctionStopVersion(fence.scope) !== fence.version)) throw new Error('Parent or worker stopped during correction preparation. Nothing was admitted.');
      const rule = correction.holdMerges ? addSessionRule(target.threadId, correction.message, 'no_merge') : null;
      getSqlite().prepare('INSERT INTO worker_corrections VALUES (?, ?, ?, ?, ?, ?)')
        .run(input.id, target.repoPath, target.threadId, serialized, rule?.id ?? null, Date.now());
      for (const selected of correction.targets) getSqlite().prepare('INSERT INTO worker_correction_deliveries VALUES (?, ?, ?, ?, ?, ?)')
        .run(input.id, selected.surfaceId, selected.runId, 'pending', 'Awaiting delivery.', Date.now());
      return true;
    })();
  });
  if (!created) return correctWorkers(input, admissionChecks);
  for (const selected of correction.targets) {
    const claim = getSqlite().prepare(`UPDATE worker_correction_deliveries SET status = 'sending', note = 'Delivery in progress. An interrupted request needs inspection before retry.', updated_at = ?
      WHERE correction_id = ? AND surface_id = ? AND status = 'pending'`).run(Date.now(), input.id, selected.surfaceId);
    if (!claim.changes) continue;
    const check = () => {
      admissionChecks?.code();
      admissionChecks?.state();
      if (readWorkerCorrection(input.id)?.deliveries.find(item => item.surfaceId === selected.surfaceId)?.status !== 'sending') throw new Error('Correction was held before worker admission.');
      assertCurrentMember(target, selected.surfaceId);
    };
    try {
      check();
      const run = await readOwnedRecoveryState(selected.surfaceId);
      if (!run.owned || run.runId !== selected.runId || run.interrupted) throw new Error('Worker run changed or was stopped.');
      let interruptedByCorrection = false;
      if (correction.mode !== 'send' && run.outcome === 'running') {
        const stopped = await withOwnedActionAdmission({ correctionId: input.id, ...selected, allowInterrupted: false, check }, () => performRuntimeAction({ action: 'interrupt', surfaceId: selected.surfaceId, runId: selected.runId }));
        if (!stopped.ok || !stopped.aborted) { update(input.id, selected.surfaceId, 'unavailable', stopped.note); continue; }
        interruptedByCorrection = true;
      }
      if (correction.mode === 'stop') {
        await withOwnedActionAdmission({ correctionId: input.id, ...selected, allowInterrupted: interruptedByCorrection, check }, async () => {
          check(); holdPendingOwnedCorrections(selected.surfaceId);
        });
        update(input.id, selected.surfaceId, run.outcome === 'running' ? 'stopped' : 'held', run.outcome === 'running' ? 'Worker stopped. No continuation was sent.' : 'Pending corrections canceled. Worker was last observed idle; no live interruption was claimed.'); continue;
      }
      const result = await withOwnedActionAdmission({ correctionId: input.id, ...selected, allowInterrupted: interruptedByCorrection, check }, async () => {
        const member = assertCurrentMember(target, selected.surfaceId);
        const message = withSessionRules(correction.message, target.threadId);
        const clientMutationId = `${input.id}-${selected.surfaceId}`;
        if (member.checkoutMode === 'isolated' && member.packetId) {
          // Reuse the governed steer lifecycle and managed-run grant. A correction
          // is one immediate attempt; a busy refusal must never enqueue a later send.
          const delivered = await steerPacket({ packetId: member.packetId, message, clientMutationId,
            source: 'operator', immediate: true });
          return { ok: delivered.deliveryState === 'delivered', note: delivered.note };
        }
        return performRuntimeAction({ action: 'steer', surfaceId: selected.surfaceId, message,
          clientMutationId, steerSource: 'operator' });
      });
      update(input.id, selected.surfaceId, result.ok ? 'delivered' : 'unavailable', result.ok
        ? 'Runtime accepted a new turn on the same worker. Application of the correction is not yet acknowledged.' : result.note);
    } catch (error) { update(input.id, selected.surfaceId, 'unknown', error instanceof Error ? error.message : 'Delivery outcome unknown. Inspect this worker before retrying.'); }
  }
  return readWorkerCorrection(input.id)!;
}
