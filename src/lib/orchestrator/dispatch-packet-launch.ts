import { resolveCapturedMissionProject } from '@/lib/orchestrator/mission-project-context';
import 'server-only';

import { resolveClaudeCodeWorkerSelection, selectedClaudeCodeWorkerModelSync } from '@/lib/claude-code/worker-profile';
import { EffortPinRejectionError, isHonoredEffortPin, resolveAdapterEffort, resolveRuntimeEffortPin } from '@/lib/orchestrator/effort-pin';
import { listSessionRuleTexts } from '@/lib/db/session-rules-store';
import { dispatch as dispatchLaneCommand } from '@/lib/lane/commands';
import { recordLaneEvent } from '@/lib/lane/events';
import { getLane, setLaneStatus } from '@/lib/lane/registry';
import {
  getOperatorDefaultsSync,
  resolveDefaultWorkerEffortSync,
  resolveOpencodeWorkerModelSync,
  resolveThreecodeWorkerModelSync,
} from '@/lib/operator/defaults';
import { resolveSubscriptionProfileRouting } from '@/lib/operator/subscription-profile';
import { recordRoleRoutingReceiptSafely } from '@/lib/operator/role-routing-ledger';
import type { RoleId, RoleRouteChoice } from '@/lib/operator/role-routing';
import type { PacketSpendCap } from './metered-spend';
import { getProjectContext } from '@/lib/projects/context';
import { appendMobileOrchestratorTurnWorker } from '@/lib/mobile/orchestrator-turn-receipt';
import { resolveDefaultBranch } from '@/lib/repos/registry';
import { assertRuntimeDispatchable } from '@/lib/runtimes/shared/auth-detect';
import { assertExecutionCarrierDispatchable, type ExecutionCarrierPreflightEvidence } from '@/lib/runtimes/shared/execution-carrier-preflight';
import { executionCarrierDefinition } from '@/lib/runtimes/shared/execution-carrier';
import type {
  OrchestratorPacket,
  OrchestratorRuntime,
  WorkerRouting,
} from './types';
import { getRuntimeCapability } from './runtime-capabilities';
import { bindWorkerLaunchParent } from './worker-launch-context';
import { buildPacketPrompt } from './packet-prompt';
import { withIdempotency } from './idempotency-store';
import {
  PacketStorageAdmissionError,
  type PacketStorageAdmissionCoordinator,
  type PacketStorageAdmissionReceipt,
} from './storage-admission';
import { findExactCommittedLaunch } from './storage-admission-generation';
import { readOrchestratorControlPlaneState } from './control-plane';
import { resolvePacketCreationBase } from '@/lib/lane/packet-creation-base';
import { manualLaunchClaimIsLive } from './manual-launch-claim';

export interface LaunchPacketResult {
  laneId: string;
  sessionKey: string | null;
  workerRouting: WorkerRouting;
  storageAdmission: PacketStorageAdmissionReceipt;
  spendCap?: PacketSpendCap;
  dependencyMaterializationMode: 'native' | 'image' | null;
}

function resolvePacketSpendCap(packet: OrchestratorPacket, runtime: OrchestratorRuntime): PacketSpendCap | undefined {
  if (packet.spendCap) return packet.spendCap;
  if (runtime !== 'claude-code') return undefined;
  const selection = resolveClaudeCodeWorkerSelection({ carrier: packet.claudeCodeCarrier, model: packet.claudeCodeModel });
  if (selection.source !== 'openrouter') return undefined;
  const defaults = getOperatorDefaultsSync().values;
  return {
    carrier: 'openrouter',
    costUsd: defaults.meteredPacketCostCapUsd,
    inputTokens: defaults.meteredPacketInputTokenCap,
  };
}

function operatorWorkerModelFor(runtime: OrchestratorRuntime): string | null {
  if (runtime === 'claude-code') {
    try {
      return selectedClaudeCodeWorkerModelSync();
    } catch {
      return null;
    }
  }
  if (runtime === '3code') {
    try {
      return resolveThreecodeWorkerModelSync();
    } catch {
      return null;
    }
  }
  if (runtime !== 'opencode') return null;
  try {
    return resolveOpencodeWorkerModelSync();
  } catch {
    return null;
  }
}

function resolveLaunchWorkerRouting(workerRouting: WorkerRouting): WorkerRouting {
  const defaults = getOperatorDefaultsSync().values;
  const profileRouting = resolveSubscriptionProfileRouting({
    profile: defaults.subscriptionProfile,
    requestedRuntime: workerRouting.selectedRuntime,
    requestedModel: workerRouting.selectedModel,
    defaultDispatchModel: defaults.defaultDispatchModel,
  });
  const configuredModel = profileRouting.ok ? profileRouting.requestedModel : null;
  const selectedModel = configuredModel
    ?? operatorWorkerModelFor(workerRouting.selectedRuntime)
    ?? getRuntimeCapability(workerRouting.selectedRuntime).defaultModel
    ?? null;
  const defaultEffort = resolveDefaultWorkerEffortSync(
    workerRouting.selectedRuntime,
    workerRouting.requestedEffort === 'adaptive' ? 'adaptive' : workerRouting.selectedEffort,
    selectedModel,
  );
  const concreteEffort = defaultEffort === 'adaptive' ? undefined : defaultEffort;
  const selectedEffort = concreteEffort
    ? resolveAdapterEffort(workerRouting.selectedRuntime, selectedModel, concreteEffort) as typeof concreteEffort
    : null;

  return {
    ...workerRouting,
    requestedModel: workerRouting.requestedModel ?? selectedModel,
    requestedEffort: workerRouting.requestedEffort ?? selectedEffort,
    selectedModel,
    selectedEffort,
    reason: `${workerRouting.reason} Launch resolved model ${selectedModel ?? 'runtime default'} and effort ${selectedEffort ?? 'runtime default'}.`,
    decidedAt: new Date().toISOString(),
  };
}

function workerRouteChoice(
  routing: WorkerRouting,
  selected: boolean,
): RoleRouteChoice {
  const runtime = selected ? routing.selectedRuntime : routing.requestedRuntime;
  const model = selected ? routing.selectedModel : routing.requestedModel;
  const effort = selected ? routing.selectedEffort : routing.requestedEffort;
  const label = runtime
    ? [getRuntimeCapability(runtime).label, model, effort].filter(Boolean).join(' · ')
    : 'Runtime default';
  return {
    backend: null,
    runtime,
    model,
    effort,
    label,
  };
}

function recordPacketRouting(input: {
  packet: OrchestratorPacket;
  requested: WorkerRouting;
  effective: WorkerRouting | null;
  receiptKey: string;
  contextId?: string | null;
  status: 'selected' | 'fallback' | 'refused' | 'failed';
  reason: string;
  fallbackReason?: string | null;
}) {
  const role: RoleId = input.packet.status === 'recovering' ? 'recovery' : 'build';
  recordRoleRoutingReceiptSafely({
    receiptKey: input.receiptKey,
    role,
    repoPath: input.packet.workspaceTargetPath,
    contextType: 'packet',
    contextId: input.contextId ?? input.packet.id,
    requested: workerRouteChoice(input.requested, false),
    effective: input.effective ? workerRouteChoice(input.effective, true) : null,
    sources: {
      backend: 'derived',
      runtime: 'request-time',
      model: input.requested.requestedModel ? 'request-time' : 'runtime-default',
      effort: input.requested.requestedEffort ? 'request-time' : 'runtime-default',
    },
    reason: input.reason,
    fallbackReason: input.fallbackReason ?? null,
    status: input.status,
  });
}

function carrierAuditReason(packet: OrchestratorPacket, routing: WorkerRouting, reason: string): string {
  return packet.executionCarrier
    ? `${reason} Effective runtime: ${getRuntimeCapability(routing.selectedRuntime).label} via ${executionCarrierDefinition(packet.executionCarrier).label}; auth source: execution-carrier.`
    : reason;
}

function appendTurnWorkerSafely(
  packet: OrchestratorPacket,
  routing: WorkerRouting,
  launchedModel?: string | null,
): void {
  if (!packet.orchestratorThreadId || !packet.orchestratorTurnId) return;
  const model = launchedModel
    ?? routing.selectedModel
    ?? getRuntimeCapability(routing.selectedRuntime).defaultModel;
  if (!model) return;
  try {
    appendMobileOrchestratorTurnWorker({
      tabId: packet.orchestratorThreadId,
      messageId: packet.orchestratorTurnId,
      worker: { packetId: packet.id, runtime: routing.selectedRuntime, model },
    });
  } catch (error) {
    console.warn('[turn-receipt] failed to append launched worker', packet.id, error);
  }
}

export async function launchPacketWithStorageAdmission(input: {
  packet: OrchestratorPacket;
  allPackets: OrchestratorPacket[];
  workerRouting: WorkerRouting;
  storageAdmission: PacketStorageAdmissionCoordinator;
}): Promise<LaunchPacketResult> {
  const { packet, allPackets, storageAdmission } = input;
  const workerRouting = resolveLaunchWorkerRouting(input.workerRouting);
  // A concrete persisted pin that was actually honored at creation must still be
  // honored at the launch boundary. If a runtime change since creation
  // (recovery, a re-routed lane) would drop or coerce it, fail clearly BEFORE any
  // worktree/lane/provider work. Deliberate no-op pins (runtime without a
  // reasoning surface) keep their legacy behavior.
  if (isHonoredEffortPin(packet.workerRouting) || workerRouting.selectedRuntime === 'muse' && workerRouting.requestedEffort) {
    const pin = await resolveRuntimeEffortPin({
      requestedEffort: workerRouting.selectedRuntime === 'muse' ? workerRouting.requestedEffort : packet.workerRouting?.requestedEffort,
      runtime: workerRouting.selectedRuntime,
      explicitModel: input.workerRouting.requestedModel,
      model: workerRouting.selectedModel,
      modelDisposition: workerRouting.modelDisposition,
    }, { cwd: packet.workspaceTargetPath ?? undefined, packetId: packet.id });
    if (!pin.ok) {
      throw new EffortPinRejectionError(pin.code, `Refusing to launch packet ${packet.id}: ${pin.message}`);
    }
  }
  const spendCap = resolvePacketSpendCap(packet, workerRouting.selectedRuntime);
  const launchContext = bindWorkerLaunchParent(packet.launchContext, {
    threadId: packet.orchestratorThreadId,
  });
  const projectContext = packet.projectId
    ? await resolveCapturedMissionProject(packet.workspaceTargetPath!, packet.projectId)
    : await getProjectContext({ repoPath: packet.workspaceTargetPath });
  let baseBranch = await resolveDefaultBranch(packet.workspaceTargetPath!);
  let carrierPreflight: ExecutionCarrierPreflightEvidence | null = null;
  try {
    if (packet.executionCarrier) {
      carrierPreflight = await assertExecutionCarrierDispatchable(workerRouting.selectedRuntime, packet.executionCarrier);
    } else {
      await assertRuntimeDispatchable(
        workerRouting.selectedRuntime,
        workerRouting.selectedModel,
        packet.workspaceTargetPath,
        // Retry / rerun relaunches a persisted packet, whose pinned carrier can differ
        // from the stored worker profile the auth snapshot was computed against.
        { claudeCodeCarrier: packet.claudeCodeCarrier ?? null },
      );
    }
  } catch (error) {
    recordPacketRouting({
      packet,
      requested: input.workerRouting,
      effective: null,
      receiptKey: `packet:${packet.id}:preflight:${workerRouting.decidedAt}`,
      status: 'refused',
      reason: error instanceof Error ? error.message : 'The selected runtime failed dispatch preflight.',
    });
    throw error;
  }
  const creationInput = {
    repoPath: packet.workspaceTargetPath!, packetId: packet.id, branch: packet.branchTarget,
    baseBranch, runtime: workerRouting.selectedRuntime,
  };
  const creationBase = storageAdmission.prepareCreationBase
    ? await storageAdmission.prepareCreationBase(packet, creationInput)
    : await resolvePacketCreationBase(creationInput);
  baseBranch = creationBase.baseBranch;
  const admissionLease = await storageAdmission.reserveForLaunch(packet, 0, {
    creationBaseCommit: creationBase.baseCommit,
  });
  // A Hold can land while preflight or storage admission is awaiting I/O. The
  // reservation makes later Holds refuse; this read catches Holds that won
  // before the reservation existed, before any lane or session is opened.
  const currentPacket = readOrchestratorControlPlaneState().packets.find((candidate) => candidate.id === packet.id);
  if ((currentPacket?.queueState === 'held' && currentPacket.holdIntent === 'operator')
    || manualLaunchClaimIsLive(currentPacket?.manualLaunchClaim)) {
    const receipt = await storageAdmission.settleFailedLaunch(packet, admissionLease);
    throw new PacketStorageAdmissionError('Dispatch cancelled because this packet is held or opening a manual lane.', receipt);
  }
  const launchGeneration = admissionLease.receipt.ownerGeneration;
  if (
    admissionLease.receipt.state === 'committed'
    || admissionLease.reservation.state === 'committed'
  ) {
    const lane = await findExactCommittedLaunch(packet, launchGeneration, workerRouting);
    if (!lane) {
      throw new PacketStorageAdmissionError(
        'Dispatch held because a committed launch could not be reconstructed from its exact active lane.',
        {
          ...admissionLease.receipt,
          state: 'held',
          reason: 'launch_effect_unknown',
        },
      );
    }
    const result = {
      laneId: lane.id,
      sessionKey: lane.sessionKey,
      workerRouting,
      storageAdmission: admissionLease.receipt,
      spendCap,
      dependencyMaterializationMode: packet.lane?.dependencyMaterializationMode ?? null,
    };
    const fallback = Boolean(
      (input.workerRouting.requestedRuntime && input.workerRouting.requestedRuntime !== workerRouting.selectedRuntime)
      || (input.workerRouting.requestedModel && input.workerRouting.requestedModel !== workerRouting.selectedModel),
    );
    recordPacketRouting({
      packet,
      requested: input.workerRouting,
      effective: workerRouting,
      receiptKey: `packet-storage-launch:${admissionLease.receipt.reservationId}`,
      contextId: packet.id,
      status: fallback ? 'fallback' : 'selected',
      reason: carrierAuditReason(packet, workerRouting, workerRouting.reason),
      fallbackReason: fallback ? workerRouting.reason : null,
    });
    appendTurnWorkerSafely(packet, workerRouting, lane.model);
    return result;
  }
  const claimKey = `packet-storage-launch:${admissionLease.receipt.reservationId}`;
  const outcome = await withIdempotency<LaunchPacketResult>({
    key: claimKey,
    verb: 'packet_storage_launch',
    scopeId: packet.id,
    reconcileUnresolved: async () => {
      const lane = await findExactCommittedLaunch(packet, launchGeneration, workerRouting);
      if (!lane) return null;
      const result = {
        laneId: lane.id,
        sessionKey: lane.sessionKey,
        workerRouting,
        storageAdmission: await storageAdmission.commitAfterLaunch(admissionLease),
        spendCap,
        dependencyMaterializationMode: packet.lane?.dependencyMaterializationMode ?? null,
      };
      appendTurnWorkerSafely(packet, workerRouting, lane.model);
      return result;
    },
  }, async () => {
    let laneResult: Awaited<ReturnType<typeof dispatchLaneCommand>>;
    let launchResult: Awaited<ReturnType<typeof dispatchLaneCommand>>;
    let openedLaneId: string | null = null;
    try {
      laneResult = await dispatchLaneCommand({
        verb: 'open_lane',
        packetId: packet.id,
        repoPath: packet.workspaceTargetPath!,
        projectId: projectContext.runtimeProjectId,
        branch: packet.branchTarget,
        baseBranch,
        runtime: workerRouting.selectedRuntime,
        label: packet.title,
        actor: 'orchestrator',
      }, { packetCreationBase: creationBase });
      if (!laneResult.ok || !laneResult.laneId) throw new Error(laneResult.note || 'Unable to open lane.');
      openedLaneId = laneResult.laneId;
      const launchingLane = setLaneStatus(
        laneResult.laneId,
        'launching',
        'orchestrator',
        'launching_session',
      );
      if (!launchingLane || launchingLane.status !== 'launching') {
        throw new Error('Unable to reserve the lane for launch before provisioning.');
      }
      recordLaneEvent(laneResult.laneId, 'update', 'orchestrator', {
        storageAdmissionOwnerGeneration: launchGeneration,
        storageAdmissionReservationId: admissionLease.receipt.reservationId,
      });
      if (carrierPreflight) {
        recordLaneEvent(laneResult.laneId, 'execution_carrier_preflight', 'orchestrator', {
          runtime: carrierPreflight.runtime,
          runtimeBinary: carrierPreflight.runtimeBinaryName,
          runtimeBinarySource: carrierPreflight.runtimeCli.source,
          executionCarrier: carrierPreflight.executionCarrier,
          carrierBinary: carrierPreflight.carrierBinaryName,
          carrierBinarySource: carrierPreflight.carrierCli.source,
          authSource: carrierPreflight.authSource,
          authenticated: carrierPreflight.authenticated,
        });
      }
      launchResult = await dispatchLaneCommand({
        verb: 'launch_session',
        laneId: laneResult.laneId,
        prompt: await buildPacketPrompt(
          packet,
          allPackets,
          laneResult.lane?.baseBranch ?? baseBranch,
          laneResult.lane?.worktreePath ?? null,
        ),
        model: workerRouting.selectedModel ?? undefined,
        claudeCodeModel: packet.claudeCodeModel ?? undefined,
        claudeCodeCarrier: packet.claudeCodeCarrier ?? undefined,
        executionCarrier: packet.executionCarrier ?? undefined,
        spendCap,
        effort: workerRouting.requestedEffort === 'adaptive' ? 'adaptive' : workerRouting.selectedEffort ?? undefined,
        clientMutationId: `packet-launch:${packet.id}:${launchGeneration}`,
        storageAdmissionReservationId: admissionLease.receipt.reservationId,
        launchContext,
        actor: 'orchestrator',
      });
      if (!launchResult.ok) throw new Error(launchResult.note || 'Unable to launch session.');
    } catch (error) {
      if (openedLaneId && getLane(openedLaneId)?.status === 'launching') {
        setLaneStatus(openedLaneId, 'failed', 'system', 'launch_preparation_failed');
      }
      const receipt = await storageAdmission.settleFailedLaunch(packet, admissionLease);
      throw new PacketStorageAdmissionError(
        error instanceof Error ? error.message : 'Unable to launch session.',
        receipt,
      );
    }

    const storageReceipt = await storageAdmission.commitAfterLaunch(admissionLease);
    if (packet.orchestratorThreadId) {
      try {
        const rules = listSessionRuleTexts(packet.orchestratorThreadId);
        if (rules.length > 0) {
          recordLaneEvent(laneResult.laneId, 'rules_applied', 'orchestrator', {
            threadId: packet.orchestratorThreadId,
            ruleCount: rules.length,
            rules,
          });
        }
      } catch (error) {
        console.warn('[session-rules] failed to record rules_applied event', error);
      }
    }
    appendTurnWorkerSafely(packet, workerRouting, launchResult.lane?.model);
    return {
      laneId: laneResult.laneId,
      sessionKey: launchResult.lane?.sessionKey ?? null,
      workerRouting,
      storageAdmission: storageReceipt,
      spendCap,
      dependencyMaterializationMode: launchResult.dependencyMaterializationMode ?? null,
    };
  });
  if (!outcome.inProgress) {
    const fallback = Boolean(
      (input.workerRouting.requestedRuntime && input.workerRouting.requestedRuntime !== outcome.result.workerRouting.selectedRuntime)
      || (input.workerRouting.requestedModel && input.workerRouting.requestedModel !== outcome.result.workerRouting.selectedModel),
    );
    recordPacketRouting({
      packet,
      requested: input.workerRouting,
      effective: outcome.result.workerRouting,
      receiptKey: claimKey,
      contextId: packet.id,
      status: fallback ? 'fallback' : 'selected',
      reason: carrierAuditReason(packet, outcome.result.workerRouting, outcome.result.workerRouting.reason),
      fallbackReason: fallback ? outcome.result.workerRouting.reason : null,
    });
    return outcome.result;
  }
  throw new PacketStorageAdmissionError(
    outcome.unresolved
      ? 'Dispatch held because the prior launch owner ended before its result was reconciled.'
      : 'Dispatch held because this exact packet generation is already launching.',
    {
      ...admissionLease.receipt,
      state: 'held',
      reason: outcome.unresolved ? 'launch_effect_unknown' : 'launch_in_progress',
    },
  );
}
