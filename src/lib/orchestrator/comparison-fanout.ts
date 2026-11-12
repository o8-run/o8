import { randomUUID } from 'node:crypto';

import { resolveWorkerRouting } from '@/lib/agents/routing';
import { normalizeOrchestratorMissionState } from '@/lib/orchestrator/store';
import { QUALITY_SEARCH_ROLES } from '@/lib/orchestrator/quality-search';
import { getRuntimeCapability, isDispatchableRuntime } from '@/lib/orchestrator/runtime-capabilities';
import type { OrchestratorMissionState, OrchestratorPacket, OrchestratorRuntime } from '@/lib/orchestrator/types';
import { releaseAbandonedMissionLifecycleHold } from '@/lib/orchestrator/mission-lifecycle-hold';

/**
 * Best-of-N fan-out.
 *
 * A mission-state transform kept in its own leaf module. It resolves each
 * candidate's actual runtime/model through the shared routing module so a
 * pinned effort/request survives fan-out intact, without dragging in the
 * dispatch-heavy `scheduling.ts` graph. `runDispatchTick` calls it at the top
 * of every tick; the operator arms it by passing `comparisonModels` to
 * `create_mission`, which stamps the seed packet.
 */

function buildComparisonGroupId(qualitySearch: boolean) {
  return `${qualitySearch ? 'quality' : 'cmp'}-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

export interface ComparisonCandidateTarget {
  runtime: OrchestratorRuntime;
  /** The model this candidate will actually launch (runtime default for a runtime choice). */
  model: string | null;
  /** The caller's explicit model identity when the candidate named a model (not a runtime). */
  explicitModel: string | null;
}

/**
 * Interpret one `comparisonModels` entry. The operator may race models (raced on
 * the seed runtime) or whole runtimes ("mix runtimes to compare them"); the
 * candidate's actual runtime/model — not just display metadata — must reflect
 * which one was named so the pinned effort is judged against what launches.
 */
export function resolveComparisonCandidateTarget(
  seedRuntime: OrchestratorRuntime,
  candidate: string,
): ComparisonCandidateTarget {
  const trimmed = candidate.trim();
  if (isDispatchableRuntime(trimmed)) {
    return {
      runtime: trimmed,
      model: getRuntimeCapability(trimmed).defaultModel ?? null,
      explicitModel: null,
    };
  }
  return { runtime: seedRuntime, model: trimmed, explicitModel: trimmed };
}

/**
 * Split every seed packet carrying `comparisonModels` into N sibling candidates —
 * one per model, each with its own id/branch suffix (`-cmp-<i>`), a shared
 * `comparisonGroupId`, `comparisonIndex`, and `assignedModel` set — so each
 * dispatches into its own worktree/lane. The seed's `comparisonModels` is consumed
 * (cleared on the siblings) so the fan-out is idempotent. Returns the SAME state
 * reference when nothing fans out (no churn).
 */
export function fanOutComparisonPackets(state: OrchestratorMissionState): OrchestratorMissionState {
  state = releaseAbandonedMissionLifecycleHold(state);
  if (state.lifecycleHold) return state;
  const activeComparisonGroups = new Set(state.activeComparisonGroups ?? []);
  const nextPackets: OrchestratorPacket[] = [];
  let changed = false;

  for (const packet of state.packets) {
    const qualitySearchSeed = packet.qualitySearch?.version === 1
      && packet.qualitySearch.role === null
      && Boolean(packet.taskContract)
      && !packet.comparisonGroupId;
    const configuredModels = (packet.comparisonModels ?? [])
      .map((model) => model.trim())
      .filter(Boolean);
    const qualitySearchModel = packet.workerRouting?.selectedModel
      ?? packet.assignedModel
      ?? packet.runtime;
    const comparisonModels = qualitySearchSeed
      ? [qualitySearchModel, qualitySearchModel]
      : configuredModels;
    const shouldFanOut = comparisonModels.length > 0 && !packet.comparisonGroupId;

    if (!shouldFanOut) {
      nextPackets.push(packet);
      continue;
    }

    changed = true;
    const comparisonGroupId = buildComparisonGroupId(qualitySearchSeed);
    activeComparisonGroups.add(comparisonGroupId);
    console.log(
      `[best-of-n] Fanning out ${packet.id} into ${comparisonModels.length} comparison lane${comparisonModels.length === 1 ? '' : 's'} (${comparisonModels.join(', ')})`,
    );

    comparisonModels.forEach((model, index) => {
      const qualitySearchRole = qualitySearchSeed ? QUALITY_SEARCH_ROLES[index] : undefined;
      const target = resolveComparisonCandidateTarget(packet.runtime, model);
      // Resolve the candidate's OWN runtime/model/effort so the pinned request
      // reaches dispatch intact (the scheduler prefers requestedModel over the
      // display-only assignedModel).
      const workerRouting = resolveWorkerRouting({
        workerIntent: packet.workerIntent,
        requestedProvider: packet.workerRouting?.requestedProvider,
        requestedRuntime: target.runtime === packet.runtime ? packet.workerRouting?.runtimeSubstitution?.requestedRuntime ?? target.runtime : target.runtime,
        requestedModel: target.model,
        requestedEffort: packet.workerRouting?.requestedEffort,
        confidence: packet.workerRouting?.confidence,
        source: 'comparison-fanout',
      });
      nextPackets.push({
        ...packet,
        id: `${packet.id}-cmp-${index}`,
        title: qualitySearchRole
          ? `${packet.title} (${qualitySearchRole === 'minimal_complete' ? 'smallest complete' : 'robustness'})`
          : `${packet.title} (${model})`,
        branchTarget: `${packet.branchTarget}-cmp-${index}`,
        // Preserve staging. Explicit dispatch re-arms the seed before this
        // transform, at which point candidates inherit its queued state.
        queueState: packet.queueState,
        releaseState: 'pending',
        status: packet.status,
        blockedReason: null,
        lastEventAt: null,
        lastEventLabel: null,
        archivedAt: null,
        review: null,
        lane: null,
        comparisonModels: undefined,
        comparisonGroupId,
        comparisonIndex: index,
        runtime: workerRouting.selectedRuntime,
        workerIntent: workerRouting.workerIntent,
        workerRouting,
        dispatchRuntimePin: workerRouting.requestedRuntime ?? workerRouting.selectedRuntime,
        assignedModel: model,
        // `claudeCodeModel` is the Claude launch carrier and wins over the
        // generic `model` argument at the lane boundary. A candidate must
        // replace the seed carrier model with its own selected model, while
        // retaining the carrier choice. Other runtimes must not inherit a
        // Claude carrier pin from a seed packet.
        ...(workerRouting.selectedRuntime === 'claude-code'
          ? {
              claudeCodeModel: workerRouting.selectedModel,
              claudeCodeCarrier: packet.claudeCodeCarrier ?? null,
            }
          : {
              claudeCodeModel: null,
              claudeCodeCarrier: null,
            }),
        ...(qualitySearchRole
          ? {
              qualitySearch: {
                version: 1 as const,
                role: qualitySearchRole,
                repairAttempts: packet.qualitySearch?.repairAttempts ?? 0,
              },
            }
          : {}),
      });
    });
  }

  if (!changed) {
    return state;
  }

  return normalizeOrchestratorMissionState({
    ...state,
    packets: nextPackets,
    activeComparisonGroups: [...activeComparisonGroups],
    updatedAt: new Date().toISOString(),
  });
}
