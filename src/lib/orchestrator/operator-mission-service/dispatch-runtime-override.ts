import { validateRequestedRuntime, resolveWorkerRouting } from '@/lib/agents/routing';
import { EffortPinRejectionError, isHonoredEffortPin, resolveEffortPin } from '@/lib/orchestrator/effort-pin';
import {
  getRuntimeCapability,
} from '@/lib/orchestrator/runtime-capabilities';
import type { OrchestratorMissionState, OrchestratorPacket, OrchestratorRuntime } from '@/lib/orchestrator/types';
import { rearmHeldPacketsForExplicitDispatch } from './dispatch-result';

export { summarizeDispatchMission } from './dispatch-result';

function canApplyRuntimeOverride(packet: OrchestratorPacket): boolean {
  if (packet.queueState !== 'queued' || packet.lane) return false;
  if (packet.archivedAt || packet.releaseState === 'released' || packet.operatorStopped) return false;
  return packet.status !== 'archived'
    && packet.status !== 'failed'
    && packet.status !== 'launching'
    && packet.status !== 'running'
    && packet.status !== 'awaiting_review';
}

/**
 * Rearm reset packets and durably stamp an explicit per-dispatch runtime.
 *
 * Validation (including the held→queued rearm projection) runs BEFORE anything
 * mutates `state`: a rejected override must leave every queue/status/blocked and
 * routing field exactly as persisted.
 */
export function preparePacketsForExplicitDispatch(
  state: OrchestratorMissionState,
  runtime?: OrchestratorRuntime,
): void {
  const requestedRuntime = validateRequestedRuntime(runtime);
  if (requestedRuntime === null) {
    rearmHeldPacketsForExplicitDispatch(state);
    return;
  }
  runtime = requestedRuntime;

  // Project the post-rearm state on a clone so an unhonorable destination cannot
  // leave a half-rewritten mission behind.
  const projected = structuredClone(state);
  rearmHeldPacketsForExplicitDispatch(projected);
  const updates: Array<{ packetId: string; workerRouting: ReturnType<typeof resolveWorkerRouting> }> = [];
  for (const packet of projected.packets) {
    if (!canApplyRuntimeOverride(packet)) continue;
    const workerRouting = resolveWorkerRouting({
      workerIntent: packet.workerIntent,
      requestedProvider: packet.workerRouting?.requestedProvider,
      requestedRuntime: runtime,
      requestedModel: packet.workerRouting?.requestedModel ?? packet.assignedModel,
      requestedEffort: packet.workerRouting?.requestedEffort,
      confidence: packet.workerRouting?.confidence,
      source: 'dispatch-mission-override',
    });
    if (isHonoredEffortPin(packet.workerRouting)) {
      const pin = resolveEffortPin({
        requestedEffort: packet.workerRouting?.requestedEffort,
        runtime: workerRouting.selectedRuntime,
        explicitModel: packet.workerRouting?.requestedModel ?? packet.assignedModel,
        model: workerRouting.selectedModel ?? getRuntimeCapability(workerRouting.selectedRuntime).defaultModel ?? null,
        modelDisposition: workerRouting.modelDisposition,
      });
      if (!pin.ok) {
        throw new EffortPinRejectionError(
          pin.code,
          `Cannot override mission runtime to "${runtime}": ${pin.message}`,
        );
      }
    }
    updates.push({ packetId: packet.id, workerRouting });
  }

  // Validation passed: commit the rearm + routing to the real state.
  rearmHeldPacketsForExplicitDispatch(state);
  state.runtime = runtime;
  const packetById = new Map(state.packets.map((packet) => [packet.id, packet] as const));
  for (const { packetId, workerRouting } of updates) {
    const packet = packetById.get(packetId);
    if (!packet) continue;
    packet.runtime = workerRouting.selectedRuntime;
    packet.assignedModel = workerRouting.selectedModel;
    packet.workerIntent = workerRouting.workerIntent;
    packet.workerRouting = workerRouting;
    packet.dispatchRuntimePin = runtime;
  }
}
