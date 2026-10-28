import { hasForgottenPacketOutcome } from '@/lib/cortex/outcome-exclusion';
import { buildHistoricalMissionStatus } from './historical-status';
import { readLaneTerminalReason } from '@/lib/lane/terminal-reason';
import { missionDispatchQueue } from './dispatch-queue';
import { resolveSealedMissionContract } from '@/lib/orchestrator/sealed-task-contract';
import { captureMissionProject, resolveCapturedMissionProject } from '@/lib/orchestrator/mission-project-context';
import { aggregateMissionCost, laneSessionHistoryForMission } from '@/lib/orchestrator/cost-aggregator';
import { projectMissionFunnel } from '@/lib/orchestrator/mission-funnel';
import { resolveWorkerRouting } from '@/lib/agents/routing';
import { reconcileOrchestratorControlPlaneState, withLockedState, writeOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { buildDagMetadata, buildDependencyGraph } from '@/lib/orchestrator/dag';
import { applyPacketScopePolicy, buildRemainingLaunchBudget, computePredictedFiles, runDispatchTick } from '@/lib/orchestrator/dispatch';
import { fanOutComparisonPackets } from '@/lib/orchestrator/comparison-fanout';
import { findLatestLaneByPacket, getLaneEvents, listLanes } from '@/lib/lane/registry';
import { assertOrchestratorRepoPath } from '@/lib/lane/repo-preflight';
import { recoveryInfoFromLaneEvents } from '@/lib/lane/recovery-info';
import { getOperatorDefaultsSync, resolveBranchPrefixSync } from '@/lib/operator/defaults';
import { currentLaneMergePolicy } from '@/lib/lane/dogfood-guard';
import { listArtifacts, toArtifactRef } from '@/lib/artifacts/store';
import { normalizeOrchestratorMissionState } from '@/lib/orchestrator/store';
import { archiveMissionsExcept, getMissionRecord, recordMission } from '@/lib/db/missions-store';
import {
  persistMissionRegistryStateIfVersion,
  readMissionRegistryEntry,
  withMissionRegistryState,
} from '@/lib/orchestrator/mission-registry';
import { readPacketCompletionContext } from '@/lib/orchestrator/context-relay';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { bindWorkerLaunchParent } from '@/lib/orchestrator/worker-launch-context';
import { assertQualitySearchMissionCompatibility, resolveTaskContractRequired } from '@/lib/orchestrator/task-contract-required';
import { withMissionHandoffBarrier } from '@/lib/orchestrator/lifecycle-mutation-lock';
import { assertExecutionCarrierCompatible, isExecutionCarrierId } from '@/lib/runtimes/shared/execution-carrier';
import { releaseAbandonedMissionLifecycleHold } from '@/lib/orchestrator/mission-lifecycle-hold';
import { getTopRulesForPacket, readRepoScopedRules } from '@/lib/dispatch/rules-store';
import { prepareMissionBranches } from './branch-cleanup';
import {
  cancelSupersededMissionPackets,
  cancelSupersededRegistryMissions,
} from './mission-supersession';
import {
  activityLabel,
  latestIsoTimestamp,
  readTranscriptActivityBySession,
} from './mission-status-transcript';
import { recordOutgoingMissionSnapshot } from './mission-handoff';
import { logBranchPreparation, logDispatchRoutingRecommendations } from './mission-routing-log';
import { preparePacketsForExplicitDispatch, summarizeDispatchMission } from './dispatch-runtime-override';
import { captureCurrentDispatchRegistry, publishCurrentDispatchRegistry } from './dispatch-registry-publication';
import { resolveRuntimePresetModel } from './runtime-preset-routing';
import {
  buildMissionId,
  buildMissionPrompt,
  buildMissionSummary,
  buildPacketId,
  buildPacketSummary,
  branchTargetForMissionIssue,
  currentMissionState,
  ensureRepoPath,
  extractIssueDependencies,
  isInlineIssue,
  log,
  missionAgentKeys,
  normalizeLoadedIssue,
} from './shared';
import type { CreateMissionInput, DispatchMissionInput, MissionStatusInput } from './types';

const INLINE_BRANCH_MAX_LENGTH = 60;
export const MISSION_CREATE_LOCK_WAIT_MS = 30_000;

export class MissionNotFoundError extends Error {
  constructor(missionId?: string) {
    super(missionId
      ? `Mission ${missionId} was not found.`
      : 'No active mission was found. Create or select a mission first.');
    this.name = 'MissionNotFoundError';
  }
}

export function resolveMissionDispatchTarget(missionId?: string): string {
  const requestedMissionId = missionId?.trim();
  const current = currentMissionState();
  const currentMissionId = current.missionId?.trim() ?? '';

  if (!requestedMissionId) {
    if (!currentMissionId) throw new MissionNotFoundError();
    return currentMissionId;
  }

  if (requestedMissionId === currentMissionId) {
    return requestedMissionId;
  }

  const registryEntry = readMissionRegistryEntry(requestedMissionId, { includeArchived: true });
  if (!registryEntry) {
    throw new MissionNotFoundError(requestedMissionId);
  }
  return requestedMissionId;
}

export async function createMission(input: CreateMissionInput) {
  const sealedContract = resolveSealedMissionContract(input, input.issues?.length === 1 && isInlineIssue(input.issues[0])) ?? input.qualitySearch?.taskContract;
  const repoPath = ensureRepoPath(input.repoPath);
  const projectContext = await captureMissionProject(repoPath, input.projectId);
  if (!Array.isArray(input.issues) || input.issues.length === 0) {
    throw new Error('At least one loaded issue is required.');
  }
  assertQualitySearchMissionCompatibility(input);
  const qualitySearchRuntime = input.issues[0]?.runtime ?? input.runtime;
  if (input.qualitySearch && qualitySearchRuntime !== 'codex' && qualitySearchRuntime !== 'claude-code') {
    throw new Error('Quality search is not supported by the selected worker runtime yet.');
  }

  const loadedIssues = input.issues.map((issue, index) => normalizeLoadedIssue(issue, index));
  const duplicateIssueNumber = loadedIssues.find((issue, index) => (
    loadedIssues.findIndex((candidate) => candidate.number === issue.number) !== index
  ));
  if (duplicateIssueNumber) {
    throw new Error(`Duplicate issue number detected: #${duplicateIssueNumber.number}.`);
  }

  const availableIssueNumbers = new Set(loadedIssues.map((issue) => issue.number));
  const explicitDependencies = loadedIssues.map((issue) => (
    extractIssueDependencies(issue.body, availableIssueNumbers).filter((dependency) => dependency !== issue.number)
  ));
  const hasExplicitDependencies = explicitDependencies.some((dependencies) => dependencies.length > 0);

  const missionId = buildMissionId();
  const packetIds = loadedIssues.map(() => buildPacketId());
  // #453 — Use "inline-N" labels for ad-hoc tasks, "P{N}" for GitHub issues
  const hasInlineIssues = loadedIssues.some(isInlineIssue);
  const referenceLabels = loadedIssues.map((issue, index) =>
    isInlineIssue(issue) ? `inline-${index + 1}` : `P${index + 1}`,
  );
  const packetIdByIssueNumber = new Map(loadedIssues.map((issue, index) => [issue.number, packetIds[index] as string]));
  const referenceLabelByIssueNumber = new Map(loadedIssues.map((issue, index) => [issue.number, referenceLabels[index] as string]));
  const branchPrefix = resolveBranchPrefixSync();
  const branchTargets = loadedIssues.map((issue) => branchTargetForMissionIssue(issue, branchPrefix, INLINE_BRANCH_MAX_LENGTH));
  const priorState = currentMissionState();
  const workerRouting = resolveWorkerRouting({
    workerIntent: input.workerIntent,
    requestedProvider: input.requestedProvider,
    requestedRuntime: input.requestedRuntime ?? input.runtime,
    requestedModel: resolveRuntimePresetModel(input.runtimePreset, input.requestedRuntime ?? input.runtime, input.requestedModel, input.claudeCodeCarrier),
    requestedEffort: input.requestedEffort,
    source: 'mission-create',
  });
  const executionCarrier = input.executionCarrier === undefined
    ? getOperatorDefaultsSync().values.workerExecutionCarrier
    : input.executionCarrier;
  if (executionCarrier !== null && !isExecutionCarrierId(executionCarrier)) {
    throw new Error('executionCarrier must be "ori" or null.');
  }
  const packetRoutings = loadedIssues.map((issue) => issue.runtime
    ? resolveWorkerRouting({
        workerIntent: input.workerIntent,
        requestedProvider: input.requestedProvider,
        requestedRuntime: issue.runtime,
        requestedModel: resolveRuntimePresetModel(input.runtimePreset, issue.runtime, input.requestedModel, input.claudeCodeCarrier),
        requestedEffort: input.requestedEffort,
        source: 'mission-create-packet',
      })
    : workerRouting);
  if (executionCarrier) {
    for (const routing of packetRoutings) assertExecutionCarrierCompatible(executionCarrier, routing.selectedRuntime);
  }
  const branchPreparation = await prepareMissionBranches({
    repoPath,
    candidates: loadedIssues.map((issue, index) => ({
      issue,
      branchTarget: branchTargets[index]!,
    })),
    previousPackets: priorState.packets,
    existingBranchPolicy: input.existingBranchPolicy,
  });

  const dispatcher = input.dispatcher
    ?? (typeof input.orchestratorThreadId === 'string' && input.orchestratorThreadId.trim()
      ? { surface: 'orchestrator' as const, id: input.orchestratorThreadId.trim() }
      : { surface: 'operator' as const, id: 'desktop' });
  const launchContext = bindWorkerLaunchParent(input.launchContext, {
    threadId: input.orchestratorThreadId,
  });
  const packetDrafts = loadedIssues.map((issue, index) => {
    const dependencyNumbers = explicitDependencies[index].length > 0
      ? explicitDependencies[index]
      : !hasExplicitDependencies && input.sequential && index > 0
        ? [loadedIssues[index - 1]!.number]
        : [];

    // Per-issue runtime — a mission can mix Codex + Gemini packets (the swarm
    // "split coding/thinking" path). When the issue pins its own runtime, route
    // that packet through it; otherwise inherit the mission-level routing.
    const packetRouting = packetRoutings[index]!;

    // #453/#inline-branch-hardening — Inline tasks carry their unique issue
    // number in the branch to avoid same-title mission collisions.
    const branchTarget = branchTargets[index]!;
    const inlineLabel = hasInlineIssues ? referenceLabels[index] : undefined;
    const packetSummary = buildPacketSummary(issue, input.constraints, repoPath, inlineLabel);

    // #615 — Snapshot learned-rules + issue body for the details popover.
    const packetType = issue.title.trim().split(/\s+/)[0]?.toLowerCase() || 'feat';
    let learnedRules: string[] = [];
    try {
      const seen = new Set<string>();
      learnedRules = [
        ...readRepoScopedRules(repoPath).map((ruleText) => ({ ruleText, source: 'file' as const })),
        ...getTopRulesForPacket({ repoPath, packetType, limit: 5 }),
      ].flatMap((rule) => {
        const text = rule.ruleText.trim();
        const normalized = text.toLowerCase();
        if (!text || seen.has(normalized)) return [];
        seen.add(normalized);
        return [text];
      });
    } catch {
      learnedRules = [];
    }

    const issueMeta = isInlineIssue(issue)
      ? (issue.body?.trim() ? { number: issue.number, body: issue.body } : undefined)
      : {
          number: issue.number,
          ...(issue.body?.trim() ? { body: issue.body } : {}),
          ...(issue.url?.trim() ? { url: issue.url } : {}),
        };

    return {
      id: packetIds[index]!,
      referenceLabel: referenceLabels[index]!,
      title: issue.title,
      summary: packetSummary,
      ...(input.origin === 'design-mode'
        ? { origin: input.origin, uiLoopIterations: 0, uiLoopStartedAt: new Date().toISOString() }
        : {}),
      workspaceTargetPath: repoPath,
      ...(projectContext ? { projectId: projectContext.id } : {}),
      branchTarget,
      runtime: packetRouting.selectedRuntime,
      dependencyLabels: dependencyNumbers.map((dependency) => referenceLabelByIssueNumber.get(dependency) ?? `#${dependency}`),
      dependencyPacketIds: dependencyNumbers.map((dependency) => packetIdByIssueNumber.get(dependency) ?? '').filter(Boolean),
      // Creation is a staging operation. The headless scheduler only consumes
      // queued packets, so an explicit dispatch is required to arm this packet.
      queueState: input.dispatchOnCreate ? 'queued' : 'held',
      releaseState: 'pending',
      status: input.dispatchOnCreate ? 'queued' : 'draft',
      blockedReason: null,
      lastEventAt: null,
      lastEventLabel: null,
      archivedAt: null,
      review: null,
      lane: null,
      assignedModel: packetRouting.selectedModel,
      ...(packetRouting.selectedRuntime === 'claude-code' ? { claudeCodeModel: input.claudeCodeModel?.trim() || null, claudeCodeCarrier: input.claudeCodeCarrier ?? null } : {}),
      ...(executionCarrier ? { executionCarrier } : {}),
      workerIntent: packetRouting.workerIntent,
      workerRouting: packetRouting,
      dispatchRuntimePin: packetRouting.requestedRuntime ?? packetRouting.selectedRuntime,
      prompt: [issue.title, packetSummary].map((part) => part.trim()).filter(Boolean).join('\n\n'),
      ...(learnedRules.length > 0 ? { learnedRules } : {}),
      ...(issueMeta ? { issue: issueMeta } : {}),
      ...(typeof input.useBrain === 'boolean' ? { useBrain: input.useBrain } : {}),
      ...(input.holdMerges === true ? { mergeHold: true } : {}),
      ...(typeof input.huddle === 'boolean' ? { huddle: input.huddle } : {}),
      taskContractRequired: resolveTaskContractRequired({
        runtime: packetRouting.selectedRuntime,
        missionOptOut: input.taskContract === 'off',
        explicit: Boolean(sealedContract),
      }),
      taskContractSource: sealedContract ? 'explicit' : 'default',
      ...(sealedContract ? { taskContract: sealedContract } : {}),
      ...(input.qualitySearch ? { qualitySearch: { version: 1 as const, role: null, repairAttempts: 0 } } : {}),
      // #1329 — carry the dispatching orchestrator thread id so the worker
      // inherits that thread's session rules via `buildPacketPrompt`.
      ...(typeof input.orchestratorThreadId === 'string' && input.orchestratorThreadId.trim()
        ? { orchestratorThreadId: input.orchestratorThreadId.trim() }
        : {}),
      ...(typeof input.orchestratorTurnId === 'string' && input.orchestratorTurnId.trim()
        ? { orchestratorTurnId: input.orchestratorTurnId.trim() }
        : {}),
      dispatcher,
      ...(launchContext ? { launchContext } : {}),
      // Best-of-N: stamp the seed packet so fanOutComparisonPackets (scheduling.ts)
      // splits it into N sibling candidates, one per model, each its own worktree.
      ...(input.comparisonModels && input.comparisonModels.length > 0
        ? { comparisonModels: input.comparisonModels }
        : {}),
    } satisfies OrchestratorPacket;
  });
  const packets = packetDrafts.map((packet) => applyPacketScopePolicy(packet, computePredictedFiles(packet)));
  const missionBase = normalizeOrchestratorMissionState({
    version: 2,
    missionId,
    prompt: buildMissionPrompt(loadedIssues, repoPath, input.constraints),
    summary: buildMissionSummary(loadedIssues, repoPath),
    repoPath,
    runtime: workerRouting.selectedRuntime,
    constraints: input.constraints,
    creationMutationId: input.clientMutationId?.trim() || null,
    packets,
    updatedAt: new Date().toISOString(),
  });
  const waves = new Map(buildDependencyGraph(missionBase.packets).map((node) => [node.packetId, node.wave] as const));
  const creationReceipt = {
    missionId,
    packets: missionBase.packets.map((packet) => ({ id: packet.id, title: packet.title, wave: waves.get(packet.id) ?? 1 })),
    branchPreparation: branchPreparation.filter((decision) => decision.action !== 'none'),
  };
  const mission = normalizeOrchestratorMissionState({ ...missionBase, creationReceipt });
  const supersedingThreadId = input.orchestratorThreadId?.trim() ?? '';
  const supersededAt = new Date().toISOString();

  const persisted = await withMissionHandoffBarrier(async () => {
    const { state, result: outgoing } = await withLockedState(
      async (current) => {
        if (supersedingThreadId) {
          cancelSupersededMissionPackets(current, {
            threadId: supersedingThreadId,
            successorMissionId: missionId,
            cancelledAt: supersededAt,
          });
          // Keep the current control-plane lock while older registry rows are
          // cancelled. A current or non-current dispatch must finish first and
          // count as in-flight, or observe the durable cancellation before it
          // can create a lane. This closes the switch-then-cancel launch gap.
          await cancelSupersededRegistryMissions({
            threadId: supersedingThreadId,
            successorMissionId: missionId,
            cancelledAt: supersededAt,
          });
        }
        // Replace the mission under the control-plane lock so a concurrent
        // headless tick cannot restore a stale mission after createMission returns.
        if (current.missionId && current.missionId !== missionId) {
          const registryEntry = readMissionRegistryEntry(current.missionId, { includeArchived: true });
          const snapshot = structuredClone(current);
          if (!registryEntry) {
            // The outgoing current file is authoritative even when an earlier
            // best-effort mission insert failed. Insert its exact snapshot
            // before swapping the file so its live packets remain addressable.
            // Any insert failure aborts the switch while the old current file
            // is still intact.
            recordOutgoingMissionSnapshot(snapshot);
          }
          Object.assign(current, mission);
          return registryEntry
            ? { mission: snapshot, registryVersion: registryEntry.updatedAt }
            : null;
        }
        Object.assign(current, mission);
        return null;
      },
      { waitTimeoutMs: MISSION_CREATE_LOCK_WAIT_MS },
    );
    if (outgoing) {
      const persistedOutgoing = await persistMissionRegistryStateIfVersion(
        outgoing.mission,
        outgoing.registryVersion,
      );
      if (!persistedOutgoing) {
        log(`Outgoing mission ${outgoing.mission.missionId} advanced during mission switch; its newer registry state was preserved.`);
      }
    }
    return state;
  });
  log(`Created mission ${missionId} with ${persisted.packets.length} packets.`);
  logBranchPreparation(branchPreparation, missionId);

  // Archive this mission in SQLite so get_mission_status can serve queries
  // for it later, even after a subsequent createMission overwrites the
  // file-based "current" mission. Lane/packet status is reconstructed live
  // via the lanes table. Non-fatal — file path still works on failure.
  try {
    const totalWaves = Math.max(1, ...Array.from(waves.values()));
    recordMission({
      id: missionId,
      repoPath,
      runtime: workerRouting.selectedRuntime,
      prompt: persisted.prompt,
      summary: persisted.summary,
      constraints: input.constraints,
      packetMeta: persisted.packets.map((packet) => ({
        id: packet.id,
        title: packet.title,
        referenceLabel: packet.referenceLabel,
      })),
      missionState: persisted,
      totalWaves,
    });
    archiveMissionsExcept(missionId);
  } catch (error) {
    log(`Failed to archive mission ${missionId} to SQLite (file path still works): ${error instanceof Error ? error.message : String(error)}`);
  }

  // #747 — Per-packet routing recommendation snapshot. Logs the runtime the
  // recommender would have picked next to the operator's actual choice. We
  // never override the user's selection — this is observability so we can see
  // whether the heuristic agrees with current operator behavior.
  await logDispatchRoutingRecommendations(persisted.packets, missionId).catch((error) => {
    console.warn(
      '[dispatch-routing] recommendation logging failed:',
      error instanceof Error ? error.message : error,
    );
  });

  return persisted.creationReceipt ?? creationReceipt;
}

export async function dispatchMission(input: DispatchMissionInput) {
  const before = currentMissionState();
  const requestedMissionId = resolveMissionDispatchTarget(input.missionId);
  const currentMissionId = before.missionId?.trim() ?? '';
  const target = requestedMissionId && requestedMissionId !== currentMissionId
    ? readMissionRegistryEntry(requestedMissionId, { includeArchived: true })?.mission
    : before;
  for (const packet of target?.packets ?? []) {
    if (packet.projectId && !packet.lane && !packet.archivedAt && !packet.operatorStopped
      && packet.releaseState !== 'released' && ['queued', 'held'].includes(packet.queueState)) {
      await resolveCapturedMissionProject(packet.workspaceTargetPath!, packet.projectId);
    }
  }

  if (requestedMissionId && requestedMissionId !== currentMissionId) {
    const { result: beforeDispatch } = await withMissionRegistryState(requestedMissionId, async (stored) => {
      assertOrchestratorRepoPath(stored.repoPath);
      const registryBefore = releaseAbandonedMissionLifecycleHold(
        reconcileOrchestratorControlPlaneState(stored),
        { allowOwnerTakeover: true },
      );
      const beforeDispatch = structuredClone(registryBefore);
      if (!registryBefore.lifecycleHold) preparePacketsForExplicitDispatch(registryBefore, input.runtime);
      return { state: fanOutComparisonPackets(registryBefore), result: beforeDispatch };
    });
    const { result, state: finalState } = await withMissionRegistryState(requestedMissionId, async (durableReady) => {
      const afterDispatch = await runDispatchTick(durableReady, { launchBudget: buildRemainingLaunchBudget() });
      return { state: afterDispatch, result: summarizeDispatchMission(beforeDispatch, afterDispatch) };
    });
    const packetIds = new Set(finalState.packets.map((packet) => packet.id));
    const dag = buildDagMetadata(finalState.packets);
    log(`Dispatched mission ${finalState.missionId || requestedMissionId} with ${result.dispatched} packet launches.`);

    return {
      ...result,
      waves: dag.totalWaves,
      activeAgents: missionAgentKeys(packetIds),
    };
  }

  // Use locked state to prevent race with headless loop tick
  const { result, state: finalState } = await withLockedState(async (current) => {
    assertOrchestratorRepoPath(current.repoPath);
    const registryBaseline = captureCurrentDispatchRegistry(current);
    const beforeDispatch = structuredClone(current);
    // #23 — an EXPLICIT dispatch re-arms any packet a prior reset_packet left in
    // 'held'. Held packets are skipped by the supervisor's automatic dispatch tick
    // (so reset doesn't boomerang); an explicit dispatch_mission is the operator
    // opting back in, so promote held -> queued here before dispatching.
    Object.assign(current, releaseAbandonedMissionLifecycleHold(current, { allowOwnerTakeover: true }));
    if (!current.lifecycleHold) preparePacketsForExplicitDispatch(current, input.runtime);
    const dispatchReady = fanOutComparisonPackets(current);
    if (dispatchReady !== current) Object.assign(current, dispatchReady);
    // Workers can register managed runs as soon as their process starts. Publish
    // explicit re-arming before launch, including when comparison fan-out is a no-op.
    writeOrchestratorControlPlaneState(dispatchReady);
    const afterDispatch = await runDispatchTick(dispatchReady, { launchBudget: buildRemainingLaunchBudget() });
    // #1293 — make withLockedState's end-of-lock reconcile+write use the
    // post-dispatch state, not the unmutated pre-callback `current`. Without this
    // a best-of-N seed survives the dispatch (its candidate lanes don't map back
    // to the seed id under reconcile) and re-fans on the next headless tick.
    Object.assign(current, afterDispatch);
    writeOrchestratorControlPlaneState(afterDispatch);

    return { ...summarizeDispatchMission(beforeDispatch, afterDispatch),
      registryPublication: await publishCurrentDispatchRegistry(afterDispatch, registryBaseline) };
  });

  const packetIds = new Set(finalState.packets.map((packet) => packet.id));
  const dag = buildDagMetadata(finalState.packets);

  log(`Dispatched mission ${finalState.missionId || 'current'} with ${result.dispatched} packet launches.`);

  return {
    ...result,
    waves: dag.totalWaves,
    activeAgents: missionAgentKeys(packetIds),
  };
}

export async function getMissionStatus(input: MissionStatusInput) {
  const currentState = currentMissionState();
  const requestedMissionId = input.missionId?.trim();
  const currentMissionId = (currentState.missionId ?? '').trim();
  if (!requestedMissionId && !currentMissionId) throw new MissionNotFoundError();
  const isCurrent = !requestedMissionId || requestedMissionId === currentMissionId;
  let state = currentState;

  if (!isCurrent) {
    const registryEntry = readMissionRegistryEntry(requestedMissionId, { includeArchived: true });
    if (registryEntry) {
      state = reconcileOrchestratorControlPlaneState(registryEntry.mission);
    } else {
      const record = getMissionRecord(requestedMissionId);
      if (!record) {
        throw new MissionNotFoundError(requestedMissionId);
      }
      const historical = buildHistoricalMissionStatus(record);
      const funnel = input.includeTiming && record.missionState
        ? await projectMissionFunnel(record.missionState)
        : undefined;
      return { ...historical, ...(input.includeTiming ? { funnel: funnel ?? null } : {}) };
    }
  }

  const graph = buildDependencyGraph(state.packets);
  const queueById = new Map(missionDispatchQueue(state).map((entry) => [entry.packetId, entry]));
  const dag = buildDagMetadata(state.packets);
  const packetById = new Map(state.packets.map((packet) => [packet.id, packet] as const));
  const laneByPacketId = new Map(state.packets.map((packet) => [packet.id, findLatestLaneByPacket(packet.id)] as const));
  const sessionKeys = state.packets.flatMap((packet) => {
    const lane = laneByPacketId.get(packet.id);
    const sessionKey = lane ? lane.sessionKey : packet.lane?.sessionKey ?? null;
    return sessionKey ? [sessionKey] : [];
  });
  const transcriptActivityBySession = await readTranscriptActivityBySession(sessionKeys);
  const completionContextByPacketId = new Map(await Promise.all(state.packets.map(async (packet) => (
    [packet.id, await readPacketCompletionContext(packet.id)] as const
  ))));
  const mergePolicy = currentLaneMergePolicy();
  const agents = state.packets
    .map((packet) => {
      const lane = laneByPacketId.get(packet.id);
      if (!lane) {
        return null;
      }
      const activity = lane.sessionKey ? transcriptActivityBySession.get(lane.sessionKey) : undefined;
      const lastTranscriptAt = activity?.lastTranscriptAt ?? null;
      const lastLifecycleEventAt = lane.lastEventAt;
      const lastActivityAt = latestIsoTimestamp(lastLifecycleEventAt, lastTranscriptAt);

      return {
        packetId: packet.id,
        laneId: lane.id,
        sessionKey: lane.sessionKey,
        label: lane.label,
        runtime: lane.runtime, model: lane.model,
        status: lane.status,
        branch: lane.branch,
        repoPath: lane.worktreePath ?? lane.repoPath,
        lastEventAt: lastActivityAt ?? lastLifecycleEventAt,
        lastLifecycleEventAt,
        lastTranscriptAt,
        lastActivityAt,
        lastActivityLabel: activityLabel(lastActivityAt, lastTranscriptAt, lane.lastEventLabel),
        transcriptUnsupportedReason: activity?.transcriptUnsupportedReason ?? null,
        lastEventLabel: lane.lastEventLabel,
        terminalReason: readLaneTerminalReason(lane),
        mergeMode: mergePolicy.mode,
        mergeModeNote: mergePolicy.note,
      };
    })
    .filter((agent): agent is NonNullable<typeof agent> => agent !== null);

  const blockers = graph
    .map((node) => {
      const packet = packetById.get(node.packetId);
      return {
        packetId: node.packetId,
        blockedBy: node.blockedBy,
        reason: queueById.get(node.packetId)?.detail ?? packet?.blockedReason ?? null,
      };
    })
    .filter((blocker) => blocker.blockedBy.length > 0 || blocker.reason);

  const cost = input.includeCost
    ? await aggregateMissionCost(state, laneSessionHistoryForMission(state, listLanes().map((lane) => ({
        ...lane,
        historicalPacketId: (() => {
          const opened = getLaneEvents(lane.id, 5_000).find((event) => event.verb === 'open_lane');
          return typeof opened?.payload.packetId === 'string' ? opened.payload.packetId : null;
        })(),
        sessionHistory: getLaneEvents(lane.id, 5_000)
          .filter((event) => (
            (event.verb === 'open_lane' || event.verb === 'attach_session')
            && typeof event.payload.sessionKey === 'string'
          ))
          .map((event) => ({
            sessionKey: String(event.payload.sessionKey),
            runtime: lane.runtime,
            createdAt: event.timestamp,
          })),
      }))))
    : undefined;
  const funnel = input.includeTiming ? await projectMissionFunnel(state) : undefined;

  return {
    missionId: state.missionId || '',
    prompt: state.prompt,
    summary: state.summary,
    repoPath: state.repoPath ?? null,
    runtime: state.runtime ?? 'codex',
    constraints: state.constraints ?? '',
    currentWave: dag.currentWave,
    totalWaves: dag.totalWaves,
    packets: graph.map((node) => {
      const packet = packetById.get(node.packetId)!;
      const lane = laneByPacketId.get(node.packetId);
      const recovery = packet.releaseState === 'released' || (lane?.status === 'completed' && lane.outcome === 'merged') ? null : packet.recovery ?? (lane ? recoveryInfoFromLaneEvents(getLaneEvents(lane.id, 100)) : null);
      const laneSessionKey = lane ? lane.sessionKey : packet.lane?.sessionKey ?? null;
      const activity = laneSessionKey ? transcriptActivityBySession.get(laneSessionKey) : undefined;
      const lastTranscriptAt = activity?.lastTranscriptAt ?? null;
      const laneLastEventAt = lane?.lastEventAt ?? packet.lane?.lastEventAt ?? null;
      const lastActivityAt = latestIsoTimestamp(laneLastEventAt, lastTranscriptAt);
      const storedCompletionContext = completionContextByPacketId.get(packet.id);
      const completionContext = storedCompletionContext?.sessionKey === laneSessionKey
        ? storedCompletionContext
        : null;
      return {
        id: packet.id,
        referenceLabel: packet.referenceLabel,
        title: packet.title,
        wave: node.wave,
        status: packet.status, runtime: lane?.runtime ?? packet.runtime, model: lane?.model ?? packet.lane?.model ?? packet.model ?? packet.workerRouting?.selectedModel ?? packet.assignedModel ?? null,
        queueState: packet.status === 'blocked' && lane && ['awaiting_input', 'awaiting_orchestrator', 'awaiting_human'].includes(lane.status) ? 'held' : packet.queueState,
        releaseState: packet.releaseState,
        blockedBy: node.blockedBy,
        blockedReason: queueById.get(packet.id)?.detail ?? packet.blockedReason ?? null,
        dispatchQueue: queueById.get(packet.id) ?? null,
        terminalReason: readLaneTerminalReason(lane),
        summary: (!hasForgottenPacketOutcome(packet.id) ? packet.completionSummary?.trim() : null)
          || completionContext?.selfReview?.outcome?.trim()
          || completionContext?.summary?.trim()
          || null,
        storageAdmission: packet.storageAdmission ?? null,
        spendCap: packet.spendCap ?? null, spendTelemetry: packet.spendTelemetry ?? null,
        recovery,
        lane: lane ? {
          laneId: lane.id,
          sessionKey: lane.sessionKey,
          runtime: lane.runtime, model: lane.model,
          status: lane.status,
          branch: lane.branch,
          repoPath: lane.worktreePath ?? lane.repoPath,
          lastEventAt: lastActivityAt ?? lane.lastEventAt,
          lastLifecycleEventAt: lane.lastEventAt,
          lastTranscriptAt,
          lastActivityAt,
          lastActivityLabel: activityLabel(lastActivityAt, lastTranscriptAt, lane.lastEventLabel),
          transcriptUnsupportedReason: activity?.transcriptUnsupportedReason ?? null,
          lastEventLabel: lane.lastEventLabel,
          terminalReason: readLaneTerminalReason(lane),
          mergeMode: mergePolicy.mode,
          mergeModeNote: mergePolicy.note,
        } : packet.lane ? {
          ...packet.lane,
          lastEventAt: lastActivityAt ?? packet.lane.lastEventAt ?? null,
          lastLifecycleEventAt: packet.lane.lastEventAt ?? null,
          lastTranscriptAt,
          lastActivityAt,
          lastActivityLabel: activityLabel(lastActivityAt, lastTranscriptAt, packet.lane.lastEventLabel),
          transcriptUnsupportedReason: activity?.transcriptUnsupportedReason ?? null,
          mergeMode: mergePolicy.mode,
          mergeModeNote: mergePolicy.note,
        } : null,
        review: packet.review ? {
          approved: packet.review.approved,
          findingsCount: packet.review.findings.length,
          summary: packet.review.summary,
          recordedAt: packet.review.recordedAt,
          reviewedHeadSha: packet.review.reviewedHeadSha ?? null,
          auditApprovalId: packet.review.auditApprovalId ?? null,
        } : null,
        artifacts: listArtifacts({ packetId: packet.id })
          .filter((artifact) => artifact.kind !== 'receipt')
          .map(toArtifactRef),
      };
    }),
    agents,
    blockers,
    ...(funnel ? { funnel } : {}),
    ...(cost ? { cost } : {}),
  };
}
