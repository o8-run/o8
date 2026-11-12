/**
 * Plan Dispatch
 *
 * When an operator approves a plan approval, this module creates orchestrator
 * packets from the plan's tasks and writes them to the control plane.
 * The headless loop then dispatches Codex agents for each packet.
 */

import 'server-only';

import { randomUUID } from 'node:crypto';
import type { PlanApprovalContinuation } from '@/lib/approvals/types';
import type { OrchestratorPacket, OrchestratorRuntime } from '@/lib/orchestrator/types';

const LOG_PREFIX = '[plan-dispatch]';

function buildPacketFromTask(
  task: { title: string; body: string },
  index: number,
  repoPath: string,
  runtime: OrchestratorRuntime,
  issueNumber: number,
): OrchestratorPacket {
  const now = new Date().toISOString();
  return {
    id: `pkt-${randomUUID()}`,
    referenceLabel: `P${index + 1}`,
    title: `#${issueNumber}: ${task.title}`,
    summary: task.body,
    workspaceTargetPath: repoPath,
    branchTarget: '',
    runtime,
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'queued',
    attemptCount: 0,
    maxAttempts: 3,
    blockedReason: null,
    lastEventAt: now,
    lastEventLabel: 'plan_approved',
    archivedAt: null,
    review: null,
    lane: null,
    dispatchRuntimePin: runtime,
  };
}

export async function dispatchApprovedPlan(
  plan: PlanApprovalContinuation,
): Promise<{ ok: boolean; missionId: string; packetCount: number; note: string }> {
  const { withLockedState } = await import('@/lib/orchestrator/control-plane');
  const { runHeadlessSprintTick } = await import('@/lib/orchestrator/headless-loop');
  const { releaseAbandonedMissionLifecycleHold } = await import('@/lib/orchestrator/mission-lifecycle-hold');

  const missionId = `intake-${plan.issueNumber}-${Date.now().toString(36)}`;
  let packetCount = 0;

  // Read-modify-write under the control-plane lock (#460) — a raw write here
  // races the headless loop and concurrent approvals (last writer wins,
  // silently dropping packets). The returned state is what gets persisted.
  const { state, result: held } = await withLockedState((current) => {
    // An operator stop acts only on the packets it captured, then clears its
    // hold, so packets added meanwhile would launch after the stop. Refuse
    // until the stop finishes; an expired hold no longer blocks.
    if (releaseAbandonedMissionLifecycleHold(current).lifecycleHold) return { held: true };
    // Never replace packets that are already in the current mission: append to
    // it, keeping its identity and settings. Only an empty control plane gets a
    // fresh intake mission, and that mission carries no creation receipt or
    // comparison groups from whatever was there before.
    const appending = current.packets.length > 0;
    // Continue after the highest existing P-label: packets can be deleted, so the
    // count can fall below a label that is still in use.
    const firstLabel = current.packets.reduce((highest, packet) => {
      const match = /^P(\d+)$/.exec(packet.referenceLabel ?? '');
      return match ? Math.max(highest, Number(match[1])) : highest;
    }, 0);
    const packets = plan.tasks.map((task, index) =>
      buildPacketFromTask(task, firstLabel + index, plan.repoPath, plan.runtime, plan.issueNumber),
    );
    packetCount = packets.length;
    if (appending) {
      return { ...current, packets: [...current.packets, ...packets], updatedAt: new Date().toISOString() };
    }
    console.log(`${LOG_PREFIX} Creating mission ${missionId} with ${packets.length} packet(s) for issue #${plan.issueNumber}`);
    return {
      ...current,
      version: 2 as const,
      missionId,
      prompt: `GitHub intake: issue #${plan.issueNumber} — ${plan.issueTitle}`,
      summary: `Intake mission for #${plan.issueNumber}: ${plan.issueTitle}`,
      repoPath: plan.repoPath,
      runtime: plan.runtime,
      constraints: plan.constraints || current.constraints || '',
      creationMutationId: null,
      creationReceipt: null,
      activeComparisonGroups: [],
      lifecycleHold: null,
      packets,
      updatedAt: new Date().toISOString(),
    };
  });
  const committedMissionId = state.missionId || missionId;
  if (held && 'held' in held) {
    const note = `Not dispatched: a mission stop is in progress. Approve the plan for issue #${plan.issueNumber} again after it finishes.`;
    console.log(`${LOG_PREFIX} ${note}`);
    return { ok: false, missionId: committedMissionId, packetCount: 0, note };
  }

  // Trigger the headless loop to pick up the new packets
  void runHeadlessSprintTick().catch((error) => {
    console.error(`${LOG_PREFIX} Headless tick failed after plan dispatch: ${error instanceof Error ? error.message : String(error)}`);
  });

  const note = `Dispatched ${packetCount} packet${packetCount === 1 ? '' : 's'} for issue #${plan.issueNumber}.`;
  console.log(`${LOG_PREFIX} ${note}`);
  return { ok: true, missionId: committedMissionId, packetCount, note };
}
