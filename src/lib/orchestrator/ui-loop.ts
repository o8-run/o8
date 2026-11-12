import 'server-only';

import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { withLockedState } from '@/lib/orchestrator/control-plane';
import { withMissionHandoffBarrier } from '@/lib/orchestrator/lifecycle-mutation-lock';
import { recordLaneEvent } from '@/lib/lane/events';
import { readLaneReviewDiff } from '@/lib/lane/review-source';
import { getLane, getLaneEvents, setLaneStatus } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import { getResourceLeaseStore } from '@/lib/leases/resource-lease-default-store';
import { observeResourceLeaseParticipant } from '@/lib/leases/resource-lease-participant';
import type { ResourceLeaseParticipant } from '@/lib/leases/resource-lease-types';
import { getOperatorDefaultsSync } from '@/lib/operator/defaults';
import {
  findMissionRegistryEntryByPacketId,
  listMissionRegistryEntries,
  withMissionRegistryState,
} from '@/lib/orchestrator/mission-registry';
import { packetTerminalState } from '@/lib/orchestrator/packet-state';
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';
import {
  findSteerablePacketLane,
  isNoSteerableSessionError,
  steerPacket,
} from '@/lib/orchestrator/operator-mission-service/steer';
import { currentMissionState } from '@/lib/orchestrator/operator-mission-service/shared';
import { summarizeLaneReviewDiff } from '@/lib/review/lane-diff';
import { enqueueInboxItem } from '@/lib/supervisor/inbox';
import { waitForPreviewReady } from '@/lib/orchestrator/ui-loop-preview';
import {
  captureUiLoopAfterScreenshot,
  persistUiLoopBeforeScreenshot,
  recordUiLoopProof,
  type UiLoopProofCaptureContext,
} from '@/lib/orchestrator/ui-loop-proof';
import type { LaneReviewScreenshotReference } from '@/lib/lane/review-screenshot';

const MAX_UI_LOOP_QUEUE_SIZE = 3;
const UI_LOOP_LEASE_POLL_MS = 100;
const UI_LOOP_SETTLE_TIMEOUT_MS = 10 * 60_000;
const UI_LOOP_SETTLE_FAST_WINDOW_MS = 10_000;
const UI_LOOP_SETTLE_FAST_POLL_MS = 100;
const UI_LOOP_SETTLE_SLOW_POLL_MS = 1_000;

let uiLoopSettleTimeoutOverrideForTest: number | null = null;

export function setUiLoopSettleTimeoutForTest(timeoutMs: number | null): void {
  if (timeoutMs !== null && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) {
    throw new Error('UI-loop settle timeout override must be a positive integer.');
  }
  uiLoopSettleTimeoutOverrideForTest = timeoutMs;
}

export interface WarmUiLoopPacket {
  packetId: string;
  laneId: string;
  lastActivityAt: string;
  label: string;
}

export type UiLoopBudgetReason = 'iterations' | 'time' | 'diff_bytes' | 'diff_files';

export interface UiLoopBudgetValues {
  iterations: number;
  maxIterations: number;
  elapsedMs: number;
  maxElapsedMs: number;
  diffMeasured: boolean;
  diffBytes: number;
  maxDiffBytes: number;
  diffFiles: number;
  maxDiffFiles: number;
}

export type UiLoopSteerResult =
  | {
      kind: 'steered';
      packet: WarmUiLoopPacket;
      imageForwarded: boolean;
    }
  | {
      kind: 'fallback';
      reason: 'NO_WARM_UI_LOOP_PACKET' | 'NO_STEERABLE_SESSION';
    }
  | {
      queued: true;
      position: number;
      packet: WarmUiLoopPacket;
    }
  | {
      rejected: 'queue_full';
      packet: WarmUiLoopPacket;
    }
  | {
      blocked: UiLoopBudgetReason;
      values: UiLoopBudgetValues;
      packet: WarmUiLoopPacket;
    };

interface UiLoopSteerInput {
  repoPath: string;
  text: string;
  previewImageDataUri?: string;
  previewUrl?: string;
  readySelector?: string;
  readyText?: string;
  element?: string;
  elementRect?: { top: number; left: number; width: number; height: number };
  elementFilePath?: string;
}

interface WarmUiLoopCandidate {
  mission: OrchestratorMissionState;
  packet: OrchestratorPacket;
  lane: Lane & { sessionKey: string };
  publicPacket: WarmUiLoopPacket;
}

interface UiLoopQueueState {
  pending: UiLoopSteerInput[];
}

const queueByRepo = new Map<string, UiLoopQueueState>();
const leaseClaims = new Map<string, string>();
const unmeasuredDiffLogs = new Set<string>();

function normalizeRepoPath(repoPath: string): string {
  return resolve(repoPath.trim());
}

function leaseResource(repoPath: string): string {
  return `ui-loop:${normalizeRepoPath(repoPath)}`;
}

function activityAt(
  mission: OrchestratorMissionState,
  packet: OrchestratorPacket,
  lane: Lane,
): string {
  const candidates = [lane.lastEventAt, lane.updatedAt, packet.lastEventAt, mission.updatedAt]
    .filter((value): value is string => Boolean(value))
    .map((value) => ({ value, time: Date.parse(value) }))
    .filter((candidate) => Number.isFinite(candidate.time))
    .sort((left, right) => right.time - left.time);
  return candidates[0]?.value ?? new Date(0).toISOString();
}

function packetLabel(packet: OrchestratorPacket, laneLabel: string): string {
  const issueNumber = packet.issue?.url && typeof packet.issue.number === 'number'
    ? packet.issue.number
    : null;
  return issueNumber ? `#${issueNumber}` : laneLabel.trim() || packet.referenceLabel || packet.id;
}

function publicPacket(
  mission: OrchestratorMissionState,
  packet: OrchestratorPacket,
  lane: Lane,
): WarmUiLoopPacket {
  return {
    packetId: packet.id,
    laneId: lane.id,
    lastActivityAt: activityAt(mission, packet, lane),
    label: packetLabel(packet, lane.label),
  };
}

function findWarmUiLoopCandidate(repoPath: string): WarmUiLoopCandidate | null {
  const targetRepoPath = normalizeRepoPath(repoPath);
  const current = currentMissionState();
  const missions = [
    current,
    ...listMissionRegistryEntries({
      includeArchived: false,
      excludeMissionId: current.missionId,
    }).map((entry) => entry.mission),
  ];
  const candidates = new Map<string, WarmUiLoopCandidate>();

  for (const mission of missions) {
    for (const packet of mission.packets) {
      const packetRepoPath = packet.workspaceTargetPath ?? mission.repoPath;
      if (!packetRepoPath || normalizeRepoPath(packetRepoPath) !== targetRepoPath) continue;
      if (packet.origin !== 'design-mode' || packetTerminalState(packet)) continue;
      const lane = findSteerablePacketLane(packet.id);
      if (!lane) continue;
      const candidate = {
        mission,
        packet,
        lane,
        publicPacket: publicPacket(mission, packet, lane),
      } satisfies WarmUiLoopCandidate;
      const previous = candidates.get(packet.id);
      if (!previous
        || Date.parse(candidate.publicPacket.lastActivityAt) > Date.parse(previous.publicPacket.lastActivityAt)) {
        candidates.set(packet.id, candidate);
      }
    }
  }

  return Array.from(candidates.values())
    .sort((left, right) => Date.parse(right.publicPacket.lastActivityAt)
      - Date.parse(left.publicPacket.lastActivityAt))[0]
    ?? null;
}

export function findWarmUiLoopPacket(repoPath: string): WarmUiLoopPacket | null {
  return findWarmUiLoopCandidate(repoPath)?.publicPacket ?? null;
}

function elementSummary(text: string): string {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const element = lines.find((line) => line.startsWith('Element:'));
  const selector = lines.find((line) => line.startsWith('Selector:'));
  return [element, selector].filter(Boolean).join(' · ').slice(0, 300)
    || lines[0]?.slice(0, 300)
    || 'Design Mode element edit';
}

async function mutateUiLoopPacket<T>(
  packetId: string,
  mutate: (packet: OrchestratorPacket) => T,
): Promise<T | null> {
  return withMissionHandoffBarrier(async () => {
    let currentMissionId = '';
    const { result } = await withLockedState((state) => {
      currentMissionId = state.missionId?.trim() ?? '';
      const packet = state.packets.find((candidate) => candidate.id === packetId);
      return packet ? { matched: true as const, value: mutate(packet) } : { matched: false as const };
    });
    if (result.matched) return result.value;

    const entry = findMissionRegistryEntryByPacketId(packetId, {
      includeArchived: true,
      excludeMissionId: currentMissionId || undefined,
    });
    if (!entry) return null;
    const { result: registryResult } = await withMissionRegistryState(entry.id, (state) => {
      const packet = state.packets.find((candidate) => candidate.id === packetId);
      return {
        state,
        result: packet ? { matched: true as const, value: mutate(packet) } : { matched: false as const },
      };
    });
    return registryResult.matched ? registryResult.value : null;
  });
}

async function leaseParticipant(
  resource: string,
  packet: WarmUiLoopPacket,
): Promise<ResourceLeaseParticipant> {
  const claimKey = `${resource}\n${packet.packetId}`;
  let claimToken = leaseClaims.get(claimKey);
  if (!claimToken) {
    claimToken = randomBytes(32).toString('base64url');
    leaseClaims.set(claimKey, claimToken);
  }
  return observeResourceLeaseParticipant({
    owner: {
      id: packet.packetId,
      label: `UI loop ${packet.packetId}`.slice(0, 128),
      pid: process.pid,
    },
    actor: 'orchestrator',
    claimToken,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function unmeasuredDiff(
  candidate: WarmUiLoopCandidate,
  code: unknown,
): { diffMeasured: false; diffBytes: 0; diffFiles: 0 } {
  if (!unmeasuredDiffLogs.has(candidate.lane.id)) {
    unmeasuredDiffLogs.add(candidate.lane.id);
    console.debug('[ui-loop] Diff unavailable; treating the diff budget as unmeasured.', {
      laneId: candidate.lane.id,
      packetId: candidate.packet.id,
      code,
      diffMeasured: false,
      diffBytes: 0,
      diffFiles: 0,
    });
  }
  return { diffMeasured: false, diffBytes: 0, diffFiles: 0 };
}

async function measureDiff(candidate: WarmUiLoopCandidate): Promise<{
  diffMeasured: boolean;
  diffBytes: number;
  diffFiles: number;
}> {
  try {
    const review = await readLaneReviewDiff(candidate.lane);
    if (!review.full) return unmeasuredDiff(candidate, 'empty_diff');
    return {
      diffMeasured: true,
      diffBytes: Buffer.byteLength(review.full, 'utf8'),
      diffFiles: summarizeLaneReviewDiff(review.full).files.length,
    };
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : 'diff_unavailable';
    return unmeasuredDiff(candidate, code);
  }
}

async function budgetValues(candidate: WarmUiLoopCandidate): Promise<{
  reason: UiLoopBudgetReason | null;
  values: UiLoopBudgetValues;
  timeDeadlineAt: number;
}> {
  const now = Date.now();
  const defaults = getOperatorDefaultsSync().values;
  const storedStartedMs = candidate.packet.uiLoopStartedAt
    ? Date.parse(candidate.packet.uiLoopStartedAt)
    : Number.NaN;
  const startedAt = Number.isFinite(storedStartedMs)
    ? candidate.packet.uiLoopStartedAt!
    : new Date(now).toISOString();
  if (!Number.isFinite(storedStartedMs)) {
    await mutateUiLoopPacket(candidate.packet.id, (packet) => {
      packet.uiLoopStartedAt ??= startedAt;
    });
  }

  const diff = await measureDiff(candidate);
  const values: UiLoopBudgetValues = {
    iterations: candidate.packet.uiLoopIterations ?? 0,
    maxIterations: defaults.uiLoopMaxIterations,
    elapsedMs: Math.max(0, now - Date.parse(startedAt)),
    maxElapsedMs: defaults.uiLoopMaxMinutes * 60_000,
    diffMeasured: diff.diffMeasured,
    diffBytes: diff.diffBytes,
    maxDiffBytes: defaults.uiLoopMaxDiffBytes,
    diffFiles: diff.diffFiles,
    maxDiffFiles: defaults.uiLoopMaxDiffFiles,
  };
  const reason = values.iterations >= values.maxIterations
    ? 'iterations'
    : values.elapsedMs >= values.maxElapsedMs
      ? 'time'
      : values.diffMeasured && values.diffBytes > values.maxDiffBytes
        ? 'diff_bytes'
        : values.diffMeasured && values.diffFiles > values.maxDiffFiles
          ? 'diff_files'
          : null;
  return {
    reason,
    values,
    timeDeadlineAt: Date.parse(startedAt) + values.maxElapsedMs,
  };
}

async function blockForBudget(
  candidate: WarmUiLoopCandidate,
  reason: UiLoopBudgetReason,
  values: UiLoopBudgetValues,
): Promise<UiLoopSteerResult> {
  const blockedReason = `ui_loop_budget_exhausted:${reason}`;
  const event = recordLaneEvent(candidate.lane.id, 'ui_loop_budget_exhausted', 'orchestrator', {
    reason,
    iterations: values.iterations,
    elapsedMs: values.elapsedMs,
    diffMeasured: values.diffMeasured,
    diffBytes: values.diffBytes,
    diffFiles: values.diffFiles,
  });
  setLaneStatus(candidate.lane.id, 'awaiting_human', 'orchestrator', blockedReason);
  await mutateUiLoopPacket(candidate.packet.id, (packet) => {
    packet.status = 'blocked';
    packet.queueState = 'held';
    packet.blockedReason = blockedReason;
    packet.lastEventAt = event.timestamp;
    packet.lastEventLabel = 'ui_loop_budget_exhausted';
  });
  const note = `UI loop hit its ${reason} budget — continue, reset, or hand back.`;
  enqueueInboxItem({
    repoPath: candidate.lane.repoPath,
    packetId: candidate.packet.id,
    kind: 'bounded_retry_exhausted',
    status: 'human_required',
    payload: {
      laneId: candidate.lane.id,
      laneLabel: candidate.lane.label,
      worktreePath: candidate.lane.worktreePath,
      sessionKey: candidate.lane.sessionKey,
      blockedReason,
      budget: { reason, ...values },
      question: note,
      note,
    },
  });
  return { blocked: reason, values, packet: candidate.publicPacket };
}

function laneTurnSettled(laneId: string, packetId: string, startedAt: number): boolean {
  const lane = getLane(laneId);
  if (!lane || lane.packetId !== packetId || !lane.sessionKey) return true;
  if (lane.status === 'reviewing'
    || lane.status === 'merging'
    || lane.status === 'failed'
    || lane.status === 'completed'
    || lane.status === 'archived'
    || lane.status === 'awaiting_human') {
    return true;
  }
  return getLaneEvents(laneId, 100).some((event) => {
    if (event.verb !== 'agent_report' || Date.parse(event.timestamp) < startedAt) return false;
    return event.payload.event === 'progress' || event.payload.event === 'done';
  });
}

async function waitForTurnSettle(
  laneId: string,
  packetId: string,
  startedAt: number,
  deadlineAt: number,
): Promise<{ settled: boolean; waitedMs: number }> {
  for (;;) {
    if (laneTurnSettled(laneId, packetId, startedAt)) {
      return { settled: true, waitedMs: Math.max(0, Date.now() - startedAt) };
    }
    const now = Date.now();
    if (now >= deadlineAt) {
      return { settled: false, waitedMs: Math.max(0, now - startedAt) };
    }
    const pollMs = now - startedAt < UI_LOOP_SETTLE_FAST_WINDOW_MS
      ? UI_LOOP_SETTLE_FAST_POLL_MS
      : UI_LOOP_SETTLE_SLOW_POLL_MS;
    await sleep(Math.min(pollMs, deadlineAt - now));
  }
}

function completeActiveRequest(repoKey: string): void {
  const state = queueByRepo.get(repoKey);
  if (!state) return;
  const next = state.pending.shift();
  if (!next) {
    queueByRepo.delete(repoKey);
    return;
  }
  queueMicrotask(() => {
    void startActiveRequest(repoKey, next).catch((error) => {
      console.error('[ui-loop] queued steer failed:', error);
    });
  });
}

async function releaseLeaseAndDrain(
  repoKey: string,
  resource: string,
  participant: ResourceLeaseParticipant,
): Promise<void> {
  try {
    await getResourceLeaseStore().release({ resource, participant });
  } finally {
    completeActiveRequest(repoKey);
  }
}

async function releaseAfterTurnSettle(
  repoKey: string,
  resource: string,
  participant: ResourceLeaseParticipant,
  laneId: string,
  packetId: string,
  startedAt: number,
  deadlineAt: number,
  preview: {
    proofId: string;
    url?: string;
    readySelector?: string;
    readyText?: string;
    before: LaneReviewScreenshotReference | null;
    capture: UiLoopProofCaptureContext | null;
  },
): Promise<void> {
  try {
    const result = await waitForTurnSettle(laneId, packetId, startedAt, deadlineAt);
    if (!result.settled) {
      recordLaneEvent(laneId, 'ui_loop_turn_unsettled', 'orchestrator', {
        packetId,
        laneId,
        waitedMs: result.waitedMs,
      });
    } else {
      const readiness = await waitForPreviewReady({
        packetId,
        laneId,
        url: preview.url,
        readySelector: preview.readySelector,
        readyText: preview.readyText,
        timeoutMs: getOperatorDefaultsSync().values.uiLoopPreviewTimeoutMs,
      });
      if (readiness.state === 'ready' && readiness.previewUrl && preview.before && preview.capture) {
        const after = await captureUiLoopAfterScreenshot({ laneId, proofId: preview.proofId, capture: preview.capture });
        if (after) {
          recordUiLoopProof({
            packetId,
            laneId,
            proofId: preview.proofId,
            before: preview.before,
            after,
            previewUrl: readiness.previewUrl,
            elapsedMs: readiness.elapsedMs,
            capture: preview.capture,
          });
        }
      }
    }
  } finally {
    await releaseLeaseAndDrain(repoKey, resource, participant);
  }
}

async function steerWithLease(
  repoKey: string,
  input: UiLoopSteerInput,
  expectedPacketId: string,
  resource: string,
  participant: ResourceLeaseParticipant,
): Promise<UiLoopSteerResult> {
  let releaseImmediately = true;
  try {
    const candidate = findWarmUiLoopCandidate(input.repoPath);
    if (!candidate || candidate.packet.id !== expectedPacketId) {
      return { kind: 'fallback', reason: 'NO_WARM_UI_LOOP_PACKET' };
    }
    const budget = await budgetValues(candidate);
    if (budget.reason) return await blockForBudget(candidate, budget.reason, budget.values);

    const text = input.text.trim();
    const message = input.previewImageDataUri
      ? `${text}\n\nScreenshot note: warm-session steer cannot attach the element crop, so use the element, selector, accessibility, and style context above.`
      : text;
    const turnStartedAt = Date.now();
    const proofId = `${candidate.lane.id}:${turnStartedAt}`;
    const capture = input.readySelector && input.element
      ? {
          selector: input.readySelector,
          element: input.element,
          ...(input.elementRect ? { rect: input.elementRect } : {}),
          ...(input.elementFilePath ? { filePath: input.elementFilePath } : {}),
        }
      : null;
    const before = await persistUiLoopBeforeScreenshot({
      laneId: candidate.lane.id,
      proofId,
      dataUri: input.previewImageDataUri,
      rect: input.elementRect,
    });
    const settleDeadlineAt = Math.min(
      budget.timeDeadlineAt,
      turnStartedAt + (uiLoopSettleTimeoutOverrideForTest ?? UI_LOOP_SETTLE_TIMEOUT_MS),
    );
    try {
      const result = await steerPacket({
        packetId: candidate.packet.id,
        message,
        source: 'operator',
      });
      const iterations = await mutateUiLoopPacket(result.packetId, (packet) => {
        packet.uiLoopStartedAt ??= new Date(turnStartedAt).toISOString();
        packet.uiLoopIterations = (packet.uiLoopIterations ?? 0) + 1;
        return packet.uiLoopIterations;
      });
      if (iterations === null) throw new Error(`Packet ${result.packetId} disappeared after steering.`);
      recordLaneEvent(result.laneId, 'ui_loop_steered', 'orchestrator', {
        packetId: result.packetId,
        elementSummary: elementSummary(text),
      });
      releaseImmediately = false;
      void releaseAfterTurnSettle(
        repoKey,
        resource,
        participant,
        result.laneId,
        result.packetId,
        turnStartedAt,
        settleDeadlineAt,
        {
          proofId,
          url: input.previewUrl,
          readySelector: input.readySelector,
          readyText: input.readyText,
          before,
          capture,
        },
      ).catch((error) => {
        console.error('[ui-loop] failed to release settled writer lease:', error);
      });
      return {
        kind: 'steered',
        packet: { ...candidate.publicPacket, laneId: result.laneId },
        imageForwarded: false,
      };
    } catch (error) {
      if (isNoSteerableSessionError(error)) {
        return { kind: 'fallback', reason: 'NO_STEERABLE_SESSION' };
      }
      throw error;
    }
  } finally {
    if (releaseImmediately) await releaseLeaseAndDrain(repoKey, resource, participant);
  }
}

async function waitForLeasePromotion(
  repoKey: string,
  input: UiLoopSteerInput,
  packet: WarmUiLoopPacket,
  resource: string,
  participant: ResourceLeaseParticipant,
  waiterId: string,
): Promise<void> {
  try {
    for (;;) {
      const candidate = findWarmUiLoopCandidate(input.repoPath);
      if (!candidate || candidate.packet.id !== packet.packetId) {
        await getResourceLeaseStore().timeoutWait({ resource, participant, waiterId });
        completeActiveRequest(repoKey);
        return;
      }
      const acquired = await getResourceLeaseStore().acquire({
        resource,
        participant,
        wait: true,
        waiterId,
      });
      if (acquired.state === 'acquired') {
        await steerWithLease(repoKey, input, packet.packetId, resource, participant);
        return;
      }
      if (acquired.state === 'refused') {
        await getResourceLeaseStore().timeoutWait({ resource, participant, waiterId });
        completeActiveRequest(repoKey);
        return;
      }
      await sleep(UI_LOOP_LEASE_POLL_MS);
    }
  } catch (error) {
    await getResourceLeaseStore().timeoutWait({ resource, participant, waiterId }).catch(() => {});
    completeActiveRequest(repoKey);
    console.error('[ui-loop] writer lease wait failed:', error);
  }
}

async function startActiveRequest(
  repoKey: string,
  input: UiLoopSteerInput,
): Promise<UiLoopSteerResult> {
  let lifecycleOwnsDrain = false;
  try {
    const candidate = findWarmUiLoopCandidate(input.repoPath);
    if (!candidate) {
      completeActiveRequest(repoKey);
      return { kind: 'fallback', reason: 'NO_WARM_UI_LOOP_PACKET' };
    }
    const resource = leaseResource(input.repoPath);
    const participant = await leaseParticipant(resource, candidate.publicPacket);
    const waiterId = `ui-loop:${candidate.packet.id}:${randomUUID()}`;
    const acquired = await getResourceLeaseStore().acquire({
      resource,
      participant,
      wait: true,
      waiterId,
    });
    if (acquired.state === 'acquired') {
      lifecycleOwnsDrain = true;
      return await steerWithLease(
        repoKey,
        input,
        candidate.packet.id,
        resource,
        participant,
      );
    }
    if (acquired.state === 'queued') {
      lifecycleOwnsDrain = true;
      void waitForLeasePromotion(
        repoKey,
        input,
        candidate.publicPacket,
        resource,
        participant,
        waiterId,
      );
      return {
        queued: true,
        position: acquired.waiter.position,
        packet: candidate.publicPacket,
      };
    }
    throw new Error(`UI-loop writer lease refused: ${acquired.reason}.`);
  } catch (error) {
    if (!lifecycleOwnsDrain) completeActiveRequest(repoKey);
    throw error;
  }
}

export async function steerWarmUiLoop(input: UiLoopSteerInput): Promise<UiLoopSteerResult> {
  const repoKey = normalizeRepoPath(input.repoPath);
  const candidate = findWarmUiLoopCandidate(input.repoPath);
  if (!candidate) return { kind: 'fallback', reason: 'NO_WARM_UI_LOOP_PACKET' };

  const existing = queueByRepo.get(repoKey);
  if (existing) {
    if (existing.pending.length >= MAX_UI_LOOP_QUEUE_SIZE - 1) {
      return { rejected: 'queue_full', packet: candidate.publicPacket };
    }
    existing.pending.push(input);
    return {
      queued: true,
      position: existing.pending.length,
      packet: candidate.publicPacket,
    };
  }

  queueByRepo.set(repoKey, { pending: [] });
  return startActiveRequest(repoKey, input);
}
