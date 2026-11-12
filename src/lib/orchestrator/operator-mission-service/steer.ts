import { runtimeOwnerRequired } from '@/lib/runtime/owner-context';
import { isNativeCortexReader } from '@/lib/cortex/owner-process';
import { callSteerOwner } from './steer-owner-client';
/**
 * steerPacket — nudge a packet's warm session with a follow-up message.
 *
 * Admission, queue claims and runtime delivery share the WS process in native mode.
 * Callers send data before constructing any reviewed-run or spawn predicates.
 *
 * Layer 3 of the merge-failure escalation chain (CLAUDE.md): cheaper than a
 * fresh redispatch because it reuses the warm Codex thread.
 */

import { findLaneByPacket, setLaneStatus } from '@/lib/lane/registry';
import type { Lane, LaneEvent } from '@/lib/lane/types';
import { recordLaneEvent } from '@/lib/lane/events';
import { correctionStopVersion } from '@/lib/db/worker-correction-fences';
import { withOwnedActionGuard } from '@/lib/runtimes/shared/owned-session/action-admission';
import { packetSteerHoldReason } from '@/lib/lane/packet-stop-hold';
import { rebindLaneSessionIfChanged } from '@/lib/lane/session-rebind';
import {
  findMissionRegistryEntryByPacketId,
  withMissionRegistryState,
} from '@/lib/orchestrator/mission-registry';
import { resolvePacketAlignment } from '@/lib/orchestrator/alignment-access';
import { withLockedState } from '@/lib/orchestrator/control-plane';
import { withMissionHandoffBarrier } from '@/lib/orchestrator/lifecycle-mutation-lock';
import { performRuntimeAction } from '@/lib/runtime/actions';
import { currentMissionState } from './shared';
import { deliverSteerEvent, operatorSteerFailure, SteerDeferredError, steerCanWait } from './steer-queue';
import { continueOwnedCodexSession, getOwnedCodexRuntimeTail, getOwnedCodexTelemetrySources } from '@/lib/codex/owned';

export interface SteerPacketInput {
  packetId: string;
  message: string;
  source?: string;
  clientMutationId?: string;
  /** Exact-run corrections must not become deferred sends. */
  immediate?: boolean;
}

export interface SteerPacketResult {
  packetId: string;
  laneId: string;
  note: string;
  deliveryState?: 'queued' | 'delivered';
}

export const NO_STEERABLE_SESSION = 'Packet has no steerable session — use rerun_with_feedback instead.';
const STARTUP_FAILURE_PROBE_MS = 2_000;

export type SteerPacketFailurePhase = 'pre_effect' | 'terminal' | 'outcome_unknown';

export class SteerPacketUnavailableError extends Error {
  constructor(message: string, readonly phase: SteerPacketFailurePhase = 'pre_effect') {
    super(message);
    this.name = 'SteerPacketUnavailableError';
  }

  get code(): 'steer_unavailable' | 'steer_outcome_unknown' {
    return this.phase === 'outcome_unknown' ? 'steer_outcome_unknown' : 'steer_unavailable';
  }
}

export function isPostEffectSteerFailure(error: unknown): error is SteerPacketUnavailableError {
  return error instanceof SteerPacketUnavailableError && error.phase !== 'pre_effect';
}

export function findSteerablePacketLane(packetId: string): (Lane & { sessionKey: string }) | null {
  const lane = findLaneByPacket(packetId);
  return lane?.sessionKey ? lane as Lane & { sessionKey: string } : null;
}

export function isNoSteerableSessionError(error: unknown): boolean {
  return error instanceof SteerPacketUnavailableError && error.message === NO_STEERABLE_SESSION;
}

function outcomeUnknownSteerError(error: unknown): SteerPacketUnavailableError {
  const detail = operatorSteerFailure(error instanceof Error ? error.message : String(error));
  return new SteerPacketUnavailableError(
    `${detail} The steer may already have been accepted; inspect the session before sending it again.`,
    'outcome_unknown',
  );
}

function normalizeSource(source: string | undefined): string {
  const normalized = source?.trim().toLowerCase();
  if (normalized === 'operator' || normalized === 'heal-bot' || normalized === 'orchestrator') {
    return normalized;
  }
  return 'orchestrator';
}

function stderrPathForStdout(stdoutPath: string): string {
  return stdoutPath.endsWith('.jsonl')
    ? stdoutPath.replace(/\.jsonl$/, '.stderr.log')
    : `${stdoutPath}.stderr.log`;
}

async function readStartupFailureHead(surfaceId: string, sinceMs: number): Promise<string | null> {
  const isClaude = surfaceId.startsWith('claude-code-owned:');
  if (!isClaude && !surfaceId.startsWith('codex-owned:')) return null;
  await new Promise((resolve) => setTimeout(resolve, STARTUP_FAILURE_PROBE_MS));
  const claude = isClaude ? await import('@/lib/claude-code/owned') : null;
  const sources = await (claude?.getOwnedClaudeCodeTelemetrySources ?? getOwnedCodexTelemetrySources)(surfaceId);
  const stdoutPath = sources?.stdoutPaths[sources.stdoutPaths.length - 1];
  if (!stdoutPath) return null;
  const { readFile } = await import('node:fs/promises');
  const stderr = await readFile(stderrPathForStdout(stdoutPath), 'utf8').catch(() => '');
  const tail = await (claude?.getOwnedClaudeCodeRuntimeTail ?? getOwnedCodexRuntimeTail)(surfaceId).catch(() => null);
  const lifecycle = tail?.surface.lifecycle;
  // Only a run STARTED BY THIS STEER counts — a previous resume's failure must
  // not flag a fresh, healthy steer (caught by the #1415 regression test).
  const lastRunStartedMs = lifecycle?.lastRunStartedAt ? Date.parse(lifecycle.lastRunStartedAt) : NaN;
  const startedByThisSteer = Number.isFinite(lastRunStartedMs) && lastRunStartedMs >= sinceMs - 1_000;
  if (startedByThisSteer && lifecycle?.availability !== 'running'
    && lifecycle?.lastRunMode === 'resume' && lifecycle.lastOutcome === 'failed') {
    return (stderr.trim() || lifecycle.summary || 'owned worker continuation failed')
      .replace(/\s+/g, ' ')
      .slice(0, 500);
  }
  return null;
}

async function resumeExitedOwnedCodexSession(surfaceId: string, message: string) {
  if (!surfaceId.startsWith('codex-owned:')) {
    return null;
  }

  // #1524 — no telemetry pre-gate: it returned null for archived sessions,
  // silently killing the fallback in exactly the death scenarios steer exists
  // to recover from. The store's resume now handles every case itself (cold
  // restore from archive included) and throws a specific reason when it truly
  // cannot — surface that reason instead of the generic steer failure.
  try {
    return await continueOwnedCodexSession(surfaceId, message);
  } catch (error) {
    return { ok: false, note: error instanceof Error ? error.message : String(error) };
  }
}

async function markAlignmentResolved(packetId: string): Promise<void> {
  await withMissionHandoffBarrier(async () => {
    let currentMissionId = '';
    const { result: foundCurrent } = await withLockedState((current) => {
      currentMissionId = current.missionId?.trim() ?? '';
      const packet = current.packets.find((candidate) => candidate.id === packetId);
      if (!packet) return false;
      if (resolvePacketAlignment(packet).armed) {
        packet.alignmentResolvedAt = new Date().toISOString();
      }
      return true;
    });
    if (foundCurrent) return;

    const entry = findMissionRegistryEntryByPacketId(packetId, {
      includeArchived: true,
      excludeMissionId: currentMissionId || undefined,
    });
    if (!entry) return;
    await withMissionRegistryState(entry.id, (state) => {
      const packet = state.packets.find((candidate) => candidate.id === packetId);
      if (packet && resolvePacketAlignment(packet).armed) {
        packet.alignmentResolvedAt = new Date().toISOString();
      }
      return { state, result: undefined };
    });
  });
}

export async function steerPacket(input: SteerPacketInput): Promise<SteerPacketResult> {
  if (runtimeOwnerRequired() && !isNativeCortexReader()) return callSteerOwner({ kind: 'steer', input });
  const { packetId, message, source, clientMutationId, immediate } = input;
  const lane = findSteerablePacketLane(packetId);
  if (!lane) {
    const current = currentMissionState();
    const packetExists = current.packets.some((packet) => packet.id === packetId)
      || Boolean(findMissionRegistryEntryByPacketId(packetId, {
        includeArchived: true,
        excludeMissionId: current.missionId,
      }));
    if (!packetExists) {
      throw new Error(`Packet ${packetId} not found.`);
    }
    throw new SteerPacketUnavailableError(NO_STEERABLE_SESSION);
  }

  const steerSource = normalizeSource(source);
  const holdReason = packetSteerHoldReason(packetId);
  if (holdReason) {
    throw new SteerPacketUnavailableError(`Packet cannot be steered while ${holdReason}.`);
  }
  try {
    const steerEvent = recordLaneEvent(lane.id, 'steered_packet', 'orchestrator', {
      packetId, source: steerSource, message, clientMutationId,
      sessionKey: lane.sessionKey, deliveryState: immediate ? 'immediate' : 'queued',
      stopVersion: correctionStopVersion(`worker:${lane.sessionKey}`),
    });
    return await deliverQueuedPacketSteer(steerEvent);
  } catch (error) {
    if (error instanceof SteerPacketUnavailableError) throw error;
    throw outcomeUnknownSteerError(error);
  }
}

export async function deliverQueuedPacketSteer(steerEvent: LaneEvent): Promise<SteerPacketResult> {
  if (runtimeOwnerRequired() && !isNativeCortexReader()) return callSteerOwner({ kind: 'deliver', eventId: steerEvent.id });
  let admittedRunId: string | undefined;
  const check = () => {
    const { packetId, sessionKey, stopVersion } = steerEvent.payload;
    const lane = findSteerablePacketLane(String(packetId));
    if (!lane || lane.id !== steerEvent.laneId || lane.sessionKey !== sessionKey
      || packetSteerHoldReason(String(packetId))
      || correctionStopVersion(`worker:${sessionKey}`) !== stopVersion) {
      throw new SteerPacketUnavailableError(
        'The packet was stopped, closed, or changed workers. Inspect it before sending a new message.', 'terminal',
      );
    }
  };
  return deliverSteerEvent(steerEvent, async (deliveryAttemptId) => withOwnedActionGuard((session, preparedRunId) => {
    check();
    if (preparedRunId && session?.surfaceId === steerEvent.payload.sessionKey) admittedRunId = preparedRunId;
  }, async () => {
    check();
    const { packetId, message, clientMutationId, sessionKey } = steerEvent.payload as {
      packetId: string; message: string; clientMutationId?: string; sessionKey: string;
    };
    const lane = findSteerablePacketLane(packetId);
    if (!lane || lane.sessionKey !== sessionKey) throw new SteerPacketUnavailableError(NO_STEERABLE_SESSION, 'terminal');
    const steerStartedMs = Date.now();
    try {
      let result;
      try {
        result = await performRuntimeAction({
          action: 'steer',
          surfaceId: lane.sessionKey,
          clientMutationId,
          message,
          auditSteer: false,
        });
      } catch (error) {
        if (steerCanWait(error instanceof Error ? error.message : '')) throw new SteerDeferredError();
        throw error;
      }
      let steeredNote = 'Steered packet via warm session.';
      if (!result.ok || result.status === 'unavailable') {
        if (result.reason === 'surface_not_ready' || steerCanWait(result.note ?? '')) throw new SteerDeferredError();
        const canTryOwnedResumeFallback = lane.sessionKey.startsWith('codex-owned:')
          && /cannot accept|not found|surface/i.test(result.note);
        // Adversarial F14 — re-check the lane right before spawning the fallback
        // process: the operator may have archived it during the (multi-second)
        // steer attempt, and only the lane STATUS write was protected — not the
        // process spawn. A lane that went terminal mid-steer must not get a
        // fresh runtime editing its worktree.
        const freshLane = canTryOwnedResumeFallback ? findLaneByPacket(packetId) : null;
        const laneStillLive = freshLane?.id === lane.id
          && freshLane.sessionKey === lane.sessionKey
          && !packetSteerHoldReason(packetId);
        const resumed = canTryOwnedResumeFallback && laneStillLive
          ? await resumeExitedOwnedCodexSession(lane.sessionKey, message)
          : canTryOwnedResumeFallback
            ? { ok: false, note: 'Lane went terminal while the steer was in flight — not resuming a dead lane\'s session.' }
            : null;
        if (!resumed?.ok) {
          const refusal = resumed?.note || result.note || NO_STEERABLE_SESSION;
          if (steerCanWait(refusal)) throw new SteerDeferredError();
          throw new SteerPacketUnavailableError(
            operatorSteerFailure(refusal),
            'terminal',
          );
        }
        // #1524 — the store's note distinguishes warm resume from cold
        // (restored-from-archive) resume; pass it through so cost expectations
        // stay honest for the orchestrator that chose layer 3 over layer 4.
        steeredNote = resumed.note || 'Steered packet via session resume.';
      } else {
        rebindLaneSessionIfChanged(lane.id, lane.sessionKey, result.sessionKey, 'orchestrator');
      }

      const startupFailure = await readStartupFailureHead(lane.sessionKey, steerStartedMs);
      if (startupFailure) {
        throw new SteerPacketUnavailableError(operatorSteerFailure(`Steer failed to start: ${startupFailure}`), 'terminal');
      }

      // Huddle/advisor alignment is a one-time turn. Only consume it after the
      // warm resume (or cold owned-session fallback) has actually started; an
      // unavailable steer must leave the alignment prompt armed for recovery.
      await markAlignmentResolved(packetId);

      const acceptedHoldReason = packetSteerHoldReason(packetId);
      if (acceptedHoldReason) {
        throw new SteerPacketUnavailableError(
          `Packet became ${acceptedHoldReason} while the steer was in flight.`, 'terminal',
        );
      }
      const acceptedSessionKey = result.ok && result.sessionKey ? result.sessionKey : lane.sessionKey;
      const acceptedLane = findLaneByPacket(packetId);
      if (acceptedLane?.id !== lane.id || acceptedLane.sessionKey !== acceptedSessionKey) {
        throw new SteerPacketUnavailableError('Packet session changed while the steer was in flight.', 'terminal');
      }
      const updated = setLaneStatus(lane.id, 'running', 'orchestrator', 'steered_packet');
      if (!updated || updated.status !== 'running') {
        throw new SteerPacketUnavailableError(NO_STEERABLE_SESSION, 'terminal');
      }
      recordLaneEvent(lane.id, 'steer_run_admitted', 'orchestrator', {
        packetId, sessionKey: updated.sessionKey, clientMutationId, steerEventId: steerEvent.id, deliveryAttemptId,
        ownedRunId: admittedRunId ?? result.runId,
      });

      return { packetId, laneId: lane.id, note: steeredNote };
    } catch (error) {
      if (error instanceof SteerPacketUnavailableError || error instanceof SteerDeferredError) throw error;
      throw outcomeUnknownSteerError(error);
    }
  }));
}
