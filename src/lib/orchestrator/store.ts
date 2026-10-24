import { normalizeReviewerPrSource } from '@/lib/orchestrator/reviewer-pr-source-types';
import { normalizeClaudeCodePacketPins, normalizeDecompositionMetadata, normalizePacketDispatcher, normalizePacketExecutionCarrier, normalizePacketLaunchContext, normalizePacketTaskContractFields, normalizePacketType, normalizePacketWorkspaceIdentity } from '@/lib/orchestrator/normalize/decomposition';
import { normalizeRuntimeStatusToOrchestratorStatus } from '@/lib/orchestrator/runtime-status';
import { runtimeTruthHasActiveWriter } from '@/lib/orchestrator/runtime-truth';
import { normalizePacketRecovery } from '@/lib/lane/recovery-info';
import { normalizePacketSpendCap, normalizePacketSpendTelemetry } from '@/lib/orchestrator/metered-spend';
import { normalizePacketContextTelemetry, reconcilePacketContextTelemetry } from '@/lib/orchestrator/packet-context-telemetry';
import { applyLanePendingStatus, preferRuntimeRecoveryMessage, type DomainLaneSummary } from '@/lib/orchestrator/domain-lane-summary';
import { normalizeQualitySearchPacketState } from '@/lib/orchestrator/quality-search';
import { normalizePacketStorageAdmission, normalizePacketStorageAdmissionEpoch } from '@/lib/orchestrator/packet-storage-admission-normalize';
import { normalizePacketAlignmentResolvedAt } from '@/lib/orchestrator/packet-alignment-normalize';
import { normalizeManualLaunchClaim } from '@/lib/orchestrator/manual-launch-claim';
import { normalizeLaneBinding } from '@/lib/orchestrator/lane-binding';
import { normalizeTerminalStatusEvidenceField } from '@/lib/terminal-status/normalize';
import { hydrateOrchestratorTurnPinEntry, installOrchestratorTurnPinFetchPatch, persistOrchestratorTurnPin, readCachedOrchestratorTurnPin, stageOrchestratorTurnPin } from '@/lib/orchestrator/turn-pins';
import {
  normalizeRequestedRuntime,
  normalizeWorkerIntent,
  normalizeWorkerProvider,
  resolveWorkerRouting,
} from '@/lib/agents/routing';
import type {
  OrchestratorLaneSnapshot,
  OrchestratorMissionState,
  OrchestratorPacket,
  OrchestratorPacketReview,
  OrchestratorPacketReviewFinding,
  PacketExplainerQuiz,
  OrchestratorQueueState,
  OrchestratorRuntime,
  OrchestratorRuntimeTruth,
  OrchestratorStateApiResponse, WorkerRouting,
} from '@/lib/orchestrator/types';
import { isDispatchableRuntime } from '@/lib/orchestrator/runtime-capabilities';
import {
  applyLaneCompletedRelease,
  clearUnprovenReleaseClaim,
  hasCanonicalReleaseEvidence,
} from '@/lib/orchestrator/packet-release-truth';
import { normalizeReleaseStatePayload } from '@/lib/orchestrator/release-state-payload';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
export type { DomainLaneSummary } from '@/lib/orchestrator/domain-lane-summary';
function normalizeRuntime(value: unknown): OrchestratorRuntime {
  return isDispatchableRuntime(value) || value === 'cloud' ? value : 'codex';
}
if (typeof window !== 'undefined') installOrchestratorTurnPinFetchPatch();
export const ORCHESTRATOR_STATE_EVENT = 'cortex:orchestrator-state-changed';
export const ORCHESTRATOR_MISSION_COMPLETED_EVENT = 'cortex:orchestrator-mission-completed';
export const ORCHESTRATOR_STATE_API_PATH = '/api/orchestrator/state';
export { hydrateOrchestratorTurnPinEntry, persistOrchestratorTurnPin, readCachedOrchestratorTurnPin, stageOrchestratorTurnPin };
const ORCHESTRATOR_ARCHIVE_API_PATH = '/api/orchestrator/archive';
const LEGACY_THOUGHTS_STORAGE_KEY = 'o8:thoughts:mission-control-v1';
const LEGACY_AUTO_COMPACT_STORAGE_PREFIX = 'o8:orchestrator:auto-compact:';
const ORCHESTRATOR_MODEL_STORAGE_PREFIX = 'o8:orchestrator:model:';
const ORCHESTRATOR_PRELUDE_STORAGE_PREFIX = 'o8:orchestrator:resume-prelude:';
const STALE_LANE_REASON = 'Previously bound workspace lane is missing. Re-launch to reattach.';
const MAX_RECOVERY_ATTEMPTS = 2;
// #1469 — human sentences for labels that park a lane awaiting_input; the real failure must reach the packet card.
function friendlyAwaitingInputReason(label: string | null | undefined): string | null {
  switch (label) {
    case 'rebase_conflict':
      return 'Rebase onto the base branch conflicted — resolve the conflict (see Inbox for the conflicting files), then retry.';
    case 'fetch_unreachable':
      return 'Could not fetch the base branch from origin — check the remote/network, then retry.';
    case 'worktree_refresh_failed':
      return 'Refreshing the worktree onto the current base failed — see lane events for the git output.';
    case 'silent_exit_verification_failed':
      return 'The worker exited and its salvaged work failed verification — operator review required.';
    case 'silent_exit_no_work':
      return 'The worker exited without producing any changes.';
    default:
      return null;
  }
}
// Mirrors MAX_LAUNCH_ATTEMPTS in scheduling.ts (duplicated across files like the
// recovery cap above) — the packet-scoped launch/attach retry ceiling.
const MAX_LAUNCH_ATTEMPTS = 5;
const RECOVERY_COOLDOWN_MS = 60_000;
let orchestratorMissionCache = createEmptyOrchestratorMissionState();
/**
 * Mission IDs that have already had a "Mission complete" card delivered.
 * Shared so the two delivery paths never double-card the same mission:
 *  - the chat-driven rotation path (showMissionThreadTransition) claims it
 *    immediately when it shows its card, and
 *  - the lifecycle-driven status feed (useOrchestratorStatusFeed) is the
 *    fallback for MCP-dispatched missions, which the chat path never sees.
 * Persisted to localStorage (#1475): a purely in-memory set is empty on every
 * boot, so a mission that completed inside the detector's 5-minute stale
 * window re-carded into the fresh transcript with a new timestamp — a false
 * "your dispatch caused merges" signal. Server-side callers (no window) keep
 * the in-memory set; the detector paths all run in the browser.
 */
const CARDED_MISSIONS_STORAGE_KEY = 'o8:carded-mission-ids:v1';
const CARDED_MISSIONS_MAX = 100;
let cardedMissionIds: Set<string> | null = null;
function loadCardedMissionIds(): Set<string> {
  if (cardedMissionIds) return cardedMissionIds;
  const ids = new Set<string>();
  if (typeof window !== 'undefined') {
    try {
      const parsed: unknown = JSON.parse(window.localStorage.getItem(CARDED_MISSIONS_STORAGE_KEY) ?? '[]');
      if (Array.isArray(parsed)) {
        for (const id of parsed) {
          if (typeof id === 'string' && id) ids.add(id);
        }
      }
    } catch { /* corrupt entry — start fresh */ }
  }
  cardedMissionIds = ids;
  return ids;
}

function persistCardedMissionIds(ids: Set<string>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CARDED_MISSIONS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch { /* quota — in-memory dedupe still holds for this session */ }
}

export function hasMissionBeenCarded(missionId: string | null | undefined): boolean {
  const id = missionId?.trim();
  return Boolean(id) && loadCardedMissionIds().has(id as string);
}

export function markMissionCarded(missionId: string | null | undefined): void {
  const id = missionId?.trim();
  if (!id) return;
  const ids = loadCardedMissionIds();
  if (ids.has(id)) return;
  ids.add(id);
  // Set iteration is insertion-ordered — trim oldest once over the cap.
  while (ids.size > CARDED_MISSIONS_MAX) {
    const oldest = ids.values().next().value;
    if (oldest === undefined) break;
    ids.delete(oldest);
  }
  persistCardedMissionIds(ids);
}

interface StoredOrchestratorPrelude {
  id: string;
  text: string;
}

export interface OrchestratorArchiveMatch {
  id: string;
  score: number;
  source: 'thread' | 'compaction';
  tabId: string | null;
  archivedAt: string | null;
  preview: string;
  entries: MobileTranscriptEntry[];
}

export interface OrchestratorMissionCompletedDetail {
  missionId: string; repoPath: string | null; summary: string;
  mergedCount: number; archivedCount: number;
  completedAt: string;
  /** Merged packets (id + title) so the detail modal can explain what shipped. */
  packets: Array<{ id: string; title: string; referenceLabel: string }>;
}

function nowIso() {
  return new Date().toISOString();
}

function isMissionTerminal(state: OrchestratorMissionState) {
  return state.packets.length > 0
    && state.packets.every((packet) => packet.releaseState === 'released' || Boolean(packet.archivedAt));
}

function buildMissionCompletedDetail(
  previous: OrchestratorMissionState,
  next: OrchestratorMissionState,
): OrchestratorMissionCompletedDetail | null {
  const missionId = next.missionId?.trim() ?? '';
  if (!missionId || missionId !== (previous.missionId?.trim() ?? '') || previous.packets.length === 0 || isMissionTerminal(previous) || !isMissionTerminal(next)) {
    return null;
  }

  const releasedPackets = next.packets.filter((packet) => packet.releaseState === 'released');
  const mergedCount = releasedPackets.length;
  const archivedCount = next.packets.filter((packet) => Boolean(packet.archivedAt)).length;
  const completedAt = next.packets.reduce((latest, packet) => {
    const candidate = packet.archivedAt ?? packet.lastEventAt ?? packet.review?.recordedAt ?? next.updatedAt;
    return candidate > latest ? candidate : latest;
  }, next.updatedAt);
  const packets = releasedPackets.map((packet) => ({
    id: packet.id,
    title: packet.title,
    referenceLabel: packet.referenceLabel,
  }));

  return { missionId, repoPath: next.repoPath ?? null, summary: next.summary, mergedCount, archivedCount, completedAt, packets };
}

function packetReferenceIndex(label?: string | null) {
  const match = label?.trim().match(/^P(\d+)$/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

export function nextPacketReferenceLabel(packets: Array<Pick<OrchestratorPacket, 'referenceLabel'>>) {
  const max = packets.reduce((current, packet) => {
    const index = packetReferenceIndex(packet.referenceLabel);
    return index && index > current ? index : current;
  }, 0);
  return `P${max + 1}`;
}

function normalizeQueueState(value: unknown, fallback: OrchestratorQueueState = 'draft'): OrchestratorQueueState {
  return value === 'held'
    ? 'held'
    : value === 'queued'
      ? 'queued'
      : fallback;
}

function normalizeReviewFinding(value: unknown): OrchestratorPacketReviewFinding | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const finding = value as Partial<OrchestratorPacketReviewFinding>;
  const file = typeof finding.file === 'string' ? finding.file.trim() : '';
  const description = typeof finding.description === 'string' ? finding.description.trim() : '';
  const severity = finding.severity;
  const resolution = finding.resolution;

  if (
    !file
    || !description
    || (severity !== 'info' && severity !== 'warning' && severity !== 'high')
    || (resolution !== 'fixed' && resolution !== 'accepted' && resolution !== 'deferred')
  ) {
    return null;
  }

  return {
    file,
    line: typeof finding.line === 'number' && Number.isFinite(finding.line) ? finding.line : null,
    severity,
    description,
    resolution,
    ...(typeof finding.fixSuggestion === 'string' && finding.fixSuggestion.trim() ? { fixSuggestion: finding.fixSuggestion.trim() } : {}),
  };
}
function normalizePacketReview(value: unknown): OrchestratorPacketReview | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const review = value as Partial<OrchestratorPacketReview>;
  const findings = Array.isArray(review.findings)
    ? review.findings
      .map((finding) => normalizeReviewFinding(finding))
      .filter((finding): finding is OrchestratorPacketReviewFinding => finding !== null)
    : [];

  return {
    approved: Boolean(review.approved),
    findings,
    recordedAt: typeof review.recordedAt === 'string' ? review.recordedAt : nowIso(),
    reviewedHeadSha: typeof review.reviewedHeadSha === 'string' ? review.reviewedHeadSha : null,
    summary: typeof review.summary === 'string' ? review.summary : '',
    auditApprovalId: typeof review.auditApprovalId === 'string' ? review.auditApprovalId : null,
  };
}

function normalizeAttemptCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function normalizeMaxAttempts(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 3;
}

function normalizeComparisonModels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const models = value.map((entry) => (typeof entry === 'string' ? entry.trim() : '')).filter(Boolean);
  return models.length > 0 ? models : undefined;
}

function normalizeWorkerRouting(value: unknown, runtime: OrchestratorRuntime, workerIntent: unknown): WorkerRouting {
  if (!value || typeof value !== 'object') {
    return resolveWorkerRouting({
      workerIntent,
      requestedRuntime: runtime,
      source: 'orchestrator-state',
    });
  }
  const routing = value as Partial<WorkerRouting>;
  const confidence = routing.confidence === 'high' || routing.confidence === 'medium' || routing.confidence === 'low'
    ? routing.confidence
    : undefined;
  return resolveWorkerRouting({
    workerIntent: routing.workerIntent ?? workerIntent,
    requestedProvider: normalizeWorkerProvider(routing.requestedProvider),
    requestedRuntime: normalizeRequestedRuntime(routing.requestedRuntime) ?? runtime,
    requestedModel: routing.requestedModel,
    // Carry requestedEffort through the round-trip so selectedEffort survives a
    // reload before launch (normalize re-derives via resolveWorkerRouting).
    requestedEffort: routing.requestedEffort,
    confidence,
    source: 'orchestrator-state',
  });
}
function normalizePacket(raw: unknown, index: number, existing: Array<Pick<OrchestratorPacket, 'referenceLabel'>>) {
  const packet = (raw && typeof raw === 'object' ? raw : {}) as Partial<OrchestratorPacket>;
  const referenceLabel = typeof packet.referenceLabel === 'string' && packet.referenceLabel.trim()
    ? packet.referenceLabel.trim()
    : nextPacketReferenceLabel(existing);
  const queueState = normalizeQueueState(packet.queueState, packet.status === 'queued' ? 'queued' : packet.status === 'running' || packet.status === 'awaiting_review' ? 'queued' : packet.status === 'blocked' ? 'held' : 'draft');
  const branchTarget = typeof packet.branchTarget === 'string' ? packet.branchTarget.trim() : '';
  const runtime = normalizeRuntime(packet.runtime);
  const workerIntent = normalizeWorkerIntent(packet.workerIntent);
  const workerRouting = normalizeWorkerRouting(packet.workerRouting, runtime, workerIntent);
  return {
    id: typeof packet.id === 'string' && packet.id.trim() ? packet.id.trim() : `pkt-${Date.now()}-${index + 1}`,
    referenceLabel, standingLaneId: typeof packet.standingLaneId === 'string' ? packet.standingLaneId : undefined,
    title: typeof packet.title === 'string' && packet.title.trim() ? packet.title : `Packet ${index + 1}`,
    summary: typeof packet.summary === 'string' ? packet.summary : '', origin: packet.origin === 'design-mode' ? 'design-mode' : undefined,
    ...normalizePacketWorkspaceIdentity(packet),
    branchTarget: branchTarget || (queueState === 'draft' ? '' : 'main'),
    runtime: workerRouting.selectedRuntime, model: typeof packet.model === 'string' && packet.model.trim() ? packet.model.trim() : null,
    dependencyLabels: Array.isArray(packet.dependencyLabels)
      ? packet.dependencyLabels.map((label) => String(label).trim()).filter(Boolean).slice(0, 8)
      : [],
    dependencyPacketIds: Array.isArray(packet.dependencyPacketIds)
      ? packet.dependencyPacketIds.map((id) => String(id).trim()).filter(Boolean)
      : [],
    queueState, holdIntent: packet.holdIntent === 'operator' || packet.holdIntent === 'explicit-dispatch' ? packet.holdIntent : queueState === 'held' && packet.status === 'draft' && !packet.blockedReason ? 'explicit-dispatch' : undefined,
    manualLaunchClaim: normalizeManualLaunchClaim(packet.manualLaunchClaim),
    releaseState: packet.releaseState === 'released' ? 'released' : 'pending',
    releaseStatePayload: normalizeReleaseStatePayload(packet.releaseStatePayload),
    status: packet.status === 'running'
      || packet.status === 'launching'
      || packet.status === 'awaiting_review'
      || packet.status === 'blocked'
      || packet.status === 'queued'
      || packet.status === 'idle'
      || packet.status === 'recovering'
      || packet.status === 'failed'
      || packet.status === 'released'
      || packet.status === 'archived'
      ? packet.status
      : queueState === 'queued'
        ? 'queued'
        : 'draft',
    attemptCount: normalizeAttemptCount(packet.attemptCount),
    maxAttempts: normalizeMaxAttempts(packet.maxAttempts),
    recoveryCount: normalizeAttemptCount(packet.recoveryCount),
    lastRecoveryAt: typeof packet.lastRecoveryAt === 'string' ? packet.lastRecoveryAt : null,
    // Packet-stored control counters MUST survive this normalize chokepoint;
    // omitted fields are silently dropped. Typecheck and lease-wait budgets
    // have event fallbacks, but persistence keeps the packet lifecycle honest;
    // stallRetries/operatorStopped live only here; dropping them resets their guards.
    typecheckAutoRetries: normalizeAttemptCount(packet.typecheckAutoRetries),
    leaseWaitAutoRetries: normalizeAttemptCount(packet.leaseWaitAutoRetries), uiLoopIterations: normalizeAttemptCount(packet.uiLoopIterations), uiLoopStartedAt: typeof packet.uiLoopStartedAt === 'string' && Number.isFinite(Date.parse(packet.uiLoopStartedAt)) ? packet.uiLoopStartedAt : undefined,
    stallRetries: normalizeAttemptCount(packet.stallRetries),
    zeroDiffRuntimeRetries: normalizeAttemptCount(packet.zeroDiffRuntimeRetries),
    launchAttempts: normalizeAttemptCount(packet.launchAttempts),
    preflightRefusals: normalizeAttemptCount(packet.preflightRefusals),
    operatorStopped: packet.operatorStopped === true ? true : undefined,
    spendCap: normalizePacketSpendCap(packet.spendCap), spendTelemetry: normalizePacketSpendTelemetry(packet.spendTelemetry),
    contextTelemetry: normalizePacketContextTelemetry(packet.contextTelemetry),
    huddle: typeof packet.huddle === 'boolean' ? packet.huddle : undefined,
    alignmentResolvedAt: normalizePacketAlignmentResolvedAt(packet.alignmentResolvedAt),
    blockedReason: typeof packet.blockedReason === 'string' ? packet.blockedReason : null, completionSummary: typeof packet.completionSummary === 'string' && packet.completionSummary.trim() ? packet.completionSummary.trim() : null, ...normalizeTerminalStatusEvidenceField(packet.statusEvidence),
    storageAdmission: normalizePacketStorageAdmission(packet.storageAdmission), storageAdmissionEpoch: normalizePacketStorageAdmissionEpoch(packet.storageAdmissionEpoch),
    recovery: normalizePacketRecovery(packet.recovery),
    lastEventAt: typeof packet.lastEventAt === 'string' ? packet.lastEventAt : null,
    lastEventLabel: typeof packet.lastEventLabel === 'string' ? packet.lastEventLabel : null,
    archivedAt: typeof packet.archivedAt === 'string' ? packet.archivedAt : null,
    review: normalizePacketReview(packet.review),
    lane: normalizeLaneBinding(packet.lane),
    packetType: normalizePacketType(packet.packetType),
    decomposition: normalizeDecompositionMetadata(packet.decomposition),
    comparisonModels: normalizeComparisonModels(packet.comparisonModels),
    comparisonGroupId: typeof packet.comparisonGroupId === 'string' && packet.comparisonGroupId.trim()
      ? packet.comparisonGroupId.trim()
      : null,
    comparisonIndex: typeof packet.comparisonIndex === 'number' && Number.isFinite(packet.comparisonIndex) && packet.comparisonIndex >= 0
      ? Math.floor(packet.comparisonIndex)
      : undefined,
    assignedModel: (typeof packet.assignedModel === 'string' && packet.assignedModel.trim()) || null, ...normalizeClaudeCodePacketPins(packet), executionCarrier: normalizePacketExecutionCarrier(packet.executionCarrier),
    qualitySearch: normalizeQualitySearchPacketState(packet.qualitySearch),
    tierEscalated: packet.tierEscalated === true ? true : undefined,
    predictedFiles: Array.isArray(packet.predictedFiles)
      ? packet.predictedFiles.map((file) => String(file).trim()).filter(Boolean).slice(0, 64)
      : undefined,
    workerIntent,
    useBrain: typeof packet.useBrain === 'boolean' ? packet.useBrain : undefined, mergeHold: packet.mergeHold === true ? true : undefined,
    workerRouting,
    // Nullable on purpose: an absent pin must stay null — normalizeRuntime()'s
    // 'codex' default would re-manufacture the #1460 always-truthy boot pin.
    dispatchRuntimePin:
      isDispatchableRuntime(packet.dispatchRuntimePin)
        ? packet.dispatchRuntimePin
        : null,
    // #1329 — originating orchestrator thread id lives only on the packet; drop
    // it here and a rerun/re-read would silently sever session-rule inheritance.
    orchestratorThreadId: typeof packet.orchestratorThreadId === 'string' && packet.orchestratorThreadId.trim() ? packet.orchestratorThreadId.trim() : undefined,
    orchestratorTurnId: typeof packet.orchestratorTurnId === 'string' && packet.orchestratorTurnId.trim() ? packet.orchestratorTurnId.trim() : undefined,
    reviewSource: normalizeReviewerPrSource(packet.reviewSource), repairSource: normalizeReviewerPrSource(packet.repairSource), dispatcher: normalizePacketDispatcher(packet.dispatcher), launchContext: normalizePacketLaunchContext(packet.launchContext),
    prompt: typeof packet.prompt === 'string' && packet.prompt.trim() ? packet.prompt : undefined,
    allowedFiles: Array.isArray(packet.allowedFiles)
      ? packet.allowedFiles.map((file) => String(file).trim()).filter(Boolean).slice(0, 64)
      : undefined,
    learnedRules: Array.isArray(packet.learnedRules)
      ? packet.learnedRules.map((rule) => String(rule).trim()).filter(Boolean).slice(0, 12)
      : undefined,
    issue: normalizePacketIssue(packet.issue),
    problemDossierId: typeof packet.problemDossierId === 'string' && packet.problemDossierId.trim() ? packet.problemDossierId.trim() : null,
    problemRemedyId: typeof packet.problemRemedyId === 'string' && packet.problemRemedyId.trim() ? packet.problemRemedyId.trim() : null,
    // #535 — readBudget + #536 — edgeCaseSites: preserved verbatim when valid,
    // stripped silently when malformed so existing callers never break.
    readBudget: normalizePacketReadBudget(packet.readBudget),
    edgeCaseSites: normalizePacketEdgeCaseSites(packet.edgeCaseSites),
    // #1490 — deviations + #1491 — explainer: preserved verbatim when valid,
    // stripped silently when malformed so existing callers never break.
    deviations: normalizePacketDeviations(packet.deviations), ...normalizePacketTaskContractFields(packet),
    explainer: normalizePacketExplainer(packet.explainer),
    // #1492 — buy-in doc: preserved verbatim when valid, stripped when malformed.
    buyinDoc: normalizePacketBuyinDoc(packet.buyinDoc),
  } satisfies OrchestratorPacket;
}
function normalizePacketBuyinDoc(value: unknown): OrchestratorPacket['buyinDoc'] {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as { status?: unknown; artifactId?: unknown; generatedAt?: unknown; error?: unknown };
  if (raw.status !== 'generating' && raw.status !== 'ready' && raw.status !== 'failed') {
    return undefined;
  }
  return {
    status: raw.status,
    artifactId: typeof raw.artifactId === 'string' && raw.artifactId.trim() ? raw.artifactId.trim() : null,
    generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : null,
    error: typeof raw.error === 'string' ? raw.error : null,
  };
}

/** Cap on the persisted/round-tripped deviations `raw` body — defense in depth
 *  against an oversized value arriving from persisted state, independent of the
 *  read cap in packet-deviations.ts. */
const MAX_DEVIATIONS_RAW = 64 * 1024;
const DEVIATIONS_TRUNCATION_MARKER = '\n\n[…deviations truncated]';

function normalizePacketDeviations(value: unknown): OrchestratorPacket['deviations'] {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as { raw?: unknown; entries?: unknown; capturedAt?: unknown };
  if (typeof raw.raw !== 'string' || typeof raw.capturedAt !== 'string') return undefined;
  const entries = Array.isArray(raw.entries)
    ? raw.entries.map((entry) => String(entry).trim()).filter(Boolean).slice(0, 64)
    : [];
  const rawBody = raw.raw.length > MAX_DEVIATIONS_RAW
    ? raw.raw.slice(0, MAX_DEVIATIONS_RAW) + DEVIATIONS_TRUNCATION_MARKER
    : raw.raw;
  return { raw: rawBody, entries, capturedAt: raw.capturedAt };
}

function normalizePacketExplainer(value: unknown): OrchestratorPacket['explainer'] {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as {
    status?: unknown;
    artifactId?: unknown;
    quiz?: unknown;
    generatedAt?: unknown;
    error?: unknown;
  };
  if (raw.status !== 'generating' && raw.status !== 'ready' && raw.status !== 'failed') {
    return undefined;
  }
  return {
    status: raw.status,
    artifactId: typeof raw.artifactId === 'string' && raw.artifactId.trim() ? raw.artifactId.trim() : null,
    quiz: normalizePacketExplainerQuiz(raw.quiz),
    changedFileCount: typeof (raw as { changedFileCount?: unknown }).changedFileCount === 'number'
      && Number.isFinite((raw as { changedFileCount: number }).changedFileCount)
      ? Math.max(0, Math.floor((raw as { changedFileCount: number }).changedFileCount))
      : null,
    generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : null,
    error: typeof raw.error === 'string' ? raw.error : null,
  };
}

function normalizePacketExplainerQuiz(value: unknown): PacketExplainerQuiz | null {
  if (!value || typeof value !== 'object') return null;
  const questions = Array.isArray((value as { questions?: unknown }).questions)
    ? (value as { questions: unknown[] }).questions
    : [];
  const normalized = questions
    .map((question, index) => {
      if (!question || typeof question !== 'object') return null;
      const q = question as { id?: unknown; prompt?: unknown; options?: unknown; answerIndex?: unknown };
      const prompt = typeof q.prompt === 'string' ? q.prompt.trim() : '';
      const options = Array.isArray(q.options)
        ? q.options.map((option) => String(option).trim()).filter(Boolean).slice(0, 8)
        : [];
      const answerIndex = typeof q.answerIndex === 'number' && Number.isInteger(q.answerIndex) ? q.answerIndex : -1;
      if (!prompt || options.length < 2 || answerIndex < 0 || answerIndex >= options.length) return null;
      return {
        id: typeof q.id === 'string' && q.id.trim() ? q.id.trim() : `q${index + 1}`,
        prompt,
        options,
        answerIndex,
      };
    })
    .filter((question): question is NonNullable<typeof question> => question !== null)
    .slice(0, 8);
  if (normalized.length === 0) return null;
  return { questions: normalized };
}

function normalizePacketReadBudget(value: unknown): OrchestratorPacket['readBudget'] {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as { minToolCalls?: unknown; requiredReads?: unknown; planBeforeWrite?: unknown };
  const minToolCalls = typeof raw.minToolCalls === 'number' && Number.isFinite(raw.minToolCalls) && raw.minToolCalls >= 0
    ? Math.floor(raw.minToolCalls)
    : null;
  const requiredReads = Array.isArray(raw.requiredReads)
    ? raw.requiredReads.map((entry) => String(entry).trim()).filter(Boolean).slice(0, 32)
    : null;
  if (minToolCalls === null || requiredReads === null) return undefined;
  return {
    minToolCalls,
    requiredReads,
    planBeforeWrite: Boolean(raw.planBeforeWrite),
  };
}

function normalizePacketEdgeCaseSites(value: unknown): OrchestratorPacket['edgeCaseSites'] {
  if (!Array.isArray(value)) return undefined;
  const allowedKinds = new Set(['conditional', 'error-handler', 'reconciliation', 'archive', 'loop-exit', 'other']);
  const normalized = value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const raw = entry as { location?: unknown; description?: unknown; kind?: unknown };
    const location = typeof raw.location === 'string' ? raw.location.trim() : '';
    const description = typeof raw.description === 'string' ? raw.description.trim() : '';
    if (!location || !description) return [];
    const kindCandidate = typeof raw.kind === 'string' ? raw.kind.trim() : '';
    const kind = allowedKinds.has(kindCandidate) ? (kindCandidate as NonNullable<OrchestratorPacket['edgeCaseSites']>[number]['kind']) : undefined;
    return [kind ? { location, description, kind } : { location, description }];
  });
  return normalized.length > 0 ? normalized.slice(0, 16) : undefined;
}

function normalizePacketIssue(value: unknown): OrchestratorPacket['issue'] {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as { number?: unknown; body?: unknown; url?: unknown };
  const number = typeof raw.number === 'number' && Number.isFinite(raw.number) ? raw.number : undefined;
  const body = typeof raw.body === 'string' ? raw.body : undefined;
  const url = typeof raw.url === 'string' && raw.url.trim() ? raw.url.trim() : undefined;
  if (number === undefined && !body && !url) return undefined;
  const result: NonNullable<OrchestratorPacket['issue']> = {};
  if (number !== undefined) result.number = number;
  if (body !== undefined) result.body = body;
  if (url !== undefined) result.url = url;
  return result;
}

function normalizeLookupValue(value: string) {
  return value.trim().toLowerCase();
}

function comparisonSourcePacketId(packetId: string) {
  const match = packetId.match(/^(.*)-cmp-(\d+)$/);
  return match?.[1] ? match[1] : null;
}

function normalizeRepoStorageKey(repoPath: string | null | undefined) {
  return (repoPath ?? '').trim().replace(/\/+$/, '');
}

function normalizeThreadStorageKey(threadId: string | null | undefined) {
  const trimmed = threadId?.trim() ?? '';
  return trimmed.startsWith('thoughts-') ? trimmed.replace(/[^a-zA-Z0-9_-]/g, '_') : '';
}

function orchestratorPreludeStorageKey(repoPath: string, threadId?: string | null) {
  const threadKey = normalizeThreadStorageKey(threadId);
  return `${ORCHESTRATOR_PRELUDE_STORAGE_PREFIX}${normalizeRepoStorageKey(repoPath)}${threadKey ? `:${threadKey}` : ''}`;
}

function readPreludeQueue(repoPath: string, threadId?: string | null) {
  if (typeof window === 'undefined') return [] as StoredOrchestratorPrelude[];
  const raw = window.localStorage.getItem(orchestratorPreludeStorageKey(repoPath, threadId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as StoredOrchestratorPrelude[];
    return Array.isArray(parsed)
      ? parsed.filter((item) => typeof item?.id === 'string' && typeof item?.text === 'string' && item.text.trim())
      : [];
  } catch {
    return [];
  }
}

function writePreludeQueue(repoPath: string, items: StoredOrchestratorPrelude[], threadId?: string | null) {
  if (typeof window === 'undefined') return;
  const key = orchestratorPreludeStorageKey(repoPath, threadId);
  if (items.length === 0) {
    window.localStorage.removeItem(key);
    return;
  }
  window.localStorage.setItem(key, JSON.stringify(items));
}

function resolvePacketDependencies(packets: OrchestratorPacket[]) {
  const lookup = new Map<string, string>();
  packets.forEach((packet) => {
    const sourcePacketId = packet.comparisonGroupId ? comparisonSourcePacketId(packet.id) : null;
    const canonicalId = sourcePacketId ?? packet.id;
    lookup.set(normalizeLookupValue(packet.referenceLabel), canonicalId);
    lookup.set(normalizeLookupValue(packet.id), packet.id);
    if (sourcePacketId) {
      lookup.set(normalizeLookupValue(sourcePacketId), sourcePacketId);
    }
    lookup.set(normalizeLookupValue(packet.title), canonicalId);
  });

  return packets.map((packet) => ({
    ...packet,
    dependencyPacketIds: [
      ...packet.dependencyPacketIds.map((dependencyId) => lookup.get(normalizeLookupValue(dependencyId)) ?? dependencyId),
      ...packet.dependencyLabels.map((label) => lookup.get(normalizeLookupValue(label)) ?? null),
    ].filter((value, index, current): value is string => Boolean(value) && current.indexOf(value) === index),
  }));
}

export function createEmptyOrchestratorMissionState(): OrchestratorMissionState {
  return {
    version: 2,
    missionId: '',
    prompt: '',
    summary: '',
    repoPath: null,
    runtime: 'codex',
    constraints: '',
    packets: [],
    activeComparisonGroups: [],
    updatedAt: nowIso(),
  };
}

export function queueOrchestratorSessionPrelude(
  repoPath: string | null | undefined,
  text: string,
  mode: 'append' | 'replace' = 'append',
  threadId?: string | null,
) {
  const normalizedRepoPath = normalizeRepoStorageKey(repoPath);
  const trimmed = text.trim();
  if (!normalizedRepoPath || typeof window === 'undefined') return;
  const nextItem = {
    id: `prelude-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    text: trimmed,
  } satisfies StoredOrchestratorPrelude;
  const queue = mode === 'replace' ? [nextItem] : [...readPreludeQueue(normalizedRepoPath, threadId), nextItem];
  writePreludeQueue(normalizedRepoPath, queue, threadId);
}

export function hasQueuedOrchestratorSessionPrelude(repoPath: string | null | undefined, threadId?: string | null) {
  const normalizedRepoPath = normalizeRepoStorageKey(repoPath);
  if (!normalizedRepoPath || typeof window === 'undefined') return false;
  if (readPreludeQueue(normalizedRepoPath, threadId).length > 0) return true;
  if (threadId && readPreludeQueue(normalizedRepoPath).length > 0) return true;
  return Boolean(window.localStorage.getItem(`${LEGACY_AUTO_COMPACT_STORAGE_PREFIX}${normalizedRepoPath}`));
}

export function clearQueuedOrchestratorSessionPrelude(repoPath: string | null | undefined, threadId?: string | null) {
  const normalizedRepoPath = normalizeRepoStorageKey(repoPath);
  if (!normalizedRepoPath || typeof window === 'undefined') return;
  writePreludeQueue(normalizedRepoPath, [], threadId);
  if (threadId) writePreludeQueue(normalizedRepoPath, []);
  window.localStorage.removeItem(`${LEGACY_AUTO_COMPACT_STORAGE_PREFIX}${normalizedRepoPath}`);
}

export function consumeOrchestratorSessionPrelude(repoPath: string | null | undefined, threadId?: string | null) {
  const normalizedRepoPath = normalizeRepoStorageKey(repoPath);
  if (!normalizedRepoPath || typeof window === 'undefined') return null;

  const queue = [
    ...readPreludeQueue(normalizedRepoPath, threadId),
    ...(threadId ? readPreludeQueue(normalizedRepoPath) : []),
  ];
  writePreludeQueue(normalizedRepoPath, [], threadId);
  if (threadId) writePreludeQueue(normalizedRepoPath, []);

  const legacyKey = `${LEGACY_AUTO_COMPACT_STORAGE_PREFIX}${normalizedRepoPath}`;
  const legacyPrelude = window.localStorage.getItem(legacyKey);
  if (legacyPrelude) {
    window.localStorage.removeItem(legacyKey);
  }

  const parts = [
    ...queue.map((item) => item.text.trim()).filter(Boolean),
    legacyPrelude?.trim() ?? '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join('\n\n---\n\n') : null;
}

export function readStoredOrchestratorModel(repoPath: string | null | undefined) {
  const normalizedRepoPath = normalizeRepoStorageKey(repoPath);
  if (!normalizedRepoPath || typeof window === 'undefined') return null;
  const stored = window.localStorage.getItem(`${ORCHESTRATOR_MODEL_STORAGE_PREFIX}${normalizedRepoPath}`)?.trim();
  return stored ?? null;
}

export function writeStoredOrchestratorModel(repoPath: string | null | undefined, model: string) {
  const normalizedRepoPath = normalizeRepoStorageKey(repoPath);
  const trimmed = model.trim();
  if (!normalizedRepoPath || typeof window === 'undefined') return;
  window.localStorage.setItem(`${ORCHESTRATOR_MODEL_STORAGE_PREFIX}${normalizedRepoPath}`, trimmed);
}

export async function searchOrchestratorArchive(
  repoPath: string | null | undefined,
  query: string,
  limit = 5,
): Promise<OrchestratorArchiveMatch[]> {
  const normalizedRepoPath = normalizeRepoStorageKey(repoPath);
  const trimmedQuery = query.trim();
  if (!normalizedRepoPath || !trimmedQuery) return [];

  try {
    const searchParams = new URLSearchParams({
      repoPath: normalizedRepoPath,
      q: trimmedQuery,
      limit: String(limit),
    });
    const response = await fetch(`${ORCHESTRATOR_ARCHIVE_API_PATH}?${searchParams.toString()}`, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
    });
    if (!response.ok) return [];
    const payload = await response.json() as { matches?: OrchestratorArchiveMatch[] };
    return Array.isArray(payload.matches) ? payload.matches : [];
  } catch {
    return [];
  }
}

export function normalizeOrchestratorMissionState(raw: unknown): OrchestratorMissionState {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Partial<OrchestratorMissionState>;
  const normalizedPackets = (Array.isArray(value.packets) ? value.packets : []).reduce<OrchestratorPacket[]>((current, packet, index) => {
    current.push(normalizePacket(packet, index, current));
    return current;
  }, []);
  return {
    version: 2,
    missionId: typeof value.missionId === 'string' ? value.missionId : '',
    prompt: typeof value.prompt === 'string' ? value.prompt : '',
    summary: typeof value.summary === 'string' ? value.summary : '',
    repoPath: typeof value.repoPath === 'string' ? value.repoPath : null,
    runtime: normalizeRuntime(value.runtime),
    constraints: typeof value.constraints === 'string' ? value.constraints : '',
    creationMutationId: typeof value.creationMutationId === 'string' ? value.creationMutationId : null,
    creationReceipt: value.creationReceipt && typeof value.creationReceipt === 'object' ? value.creationReceipt : null,
    packets: resolvePacketDependencies(normalizedPackets),
    activeComparisonGroups: Array.isArray(value.activeComparisonGroups)
      ? value.activeComparisonGroups
        .map((groupId) => (typeof groupId === 'string' ? groupId.trim() : ''))
        .filter((groupId, index, current) => Boolean(groupId) && current.indexOf(groupId) === index)
      : [],
    lifecycleHold: value.lifecycleHold?.reason === 'operator_stop' && typeof value.lifecycleHold.source === 'string' && typeof value.lifecycleHold.startedAt === 'string' && Number.isSafeInteger(value.lifecycleHold.ownerPid) && typeof value.lifecycleHold.leaseExpiresAt === 'string' ? { source: value.lifecycleHold.source, reason: 'operator_stop', startedAt: value.lifecycleHold.startedAt, ownerPid: value.lifecycleHold.ownerPid!, leaseExpiresAt: value.lifecycleHold.leaseExpiresAt } : null,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : nowIso(),
  };
}
export function readOrchestratorMissionState(): OrchestratorMissionState {
  return orchestratorMissionCache;
}

function broadcastOrchestratorMissionState(state: OrchestratorMissionState) {
  const previous = orchestratorMissionCache;
  orchestratorMissionCache = normalizeOrchestratorMissionState(state);
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(ORCHESTRATOR_STATE_EVENT, {
    detail: { state: orchestratorMissionCache },
  }));
  const completed = buildMissionCompletedDetail(previous, orchestratorMissionCache);
  if (completed) window.dispatchEvent(new CustomEvent<OrchestratorMissionCompletedDetail>(ORCHESTRATOR_MISSION_COMPLETED_EVENT, { detail: completed }));
}

export async function loadOrchestratorMissionState(): Promise<OrchestratorMissionState> {
  if (typeof window === 'undefined') return orchestratorMissionCache;
  try {
    const response = await fetch(ORCHESTRATOR_STATE_API_PATH, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
    });
    if (response.ok) {
      const payload = await response.json() as Partial<OrchestratorStateApiResponse>;
      const next = normalizeOrchestratorMissionState(payload.mission ?? createEmptyOrchestratorMissionState());
      broadcastOrchestratorMissionState(next);
      return next;
    }
  } catch {
    // fall through to legacy migration / cache
  }

  try {
    const legacy = window.localStorage.getItem(LEGACY_THOUGHTS_STORAGE_KEY);
    if (legacy) {
      const migrated = normalizeOrchestratorMissionState(JSON.parse(legacy));
      await persistOrchestratorMissionState(migrated);
      return migrated;
    }
  } catch {
    // ignore malformed legacy state
  }

  return orchestratorMissionCache;
}

// The server never deletes a packet the snapshot merely omits (#2351).
export async function persistOrchestratorMissionState(
  state: OrchestratorMissionState,
  removedPacketIds: readonly string[] = [],
) {
  if (typeof window === 'undefined') return;
  const normalized = normalizeOrchestratorMissionState({
    ...state,
    updatedAt: nowIso(),
  });
  broadcastOrchestratorMissionState(normalized);
  try {
    const response = await fetch(ORCHESTRATOR_STATE_API_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mission: normalized, removedPacketIds }),
    });
    if (response.ok) {
      const payload = await response.json() as Partial<OrchestratorStateApiResponse>;
      const next = normalizeOrchestratorMissionState(payload.mission ?? normalized);
      broadcastOrchestratorMissionState(next);
      return next;
    }
  } catch {
    // keep local cache if server write fails
  }
  return normalized;
}

export function updateOrchestratorMissionState(
  updater: OrchestratorMissionState | ((current: OrchestratorMissionState) => OrchestratorMissionState),
) {
  const next = normalizeOrchestratorMissionState(
    typeof updater === 'function' ? updater(orchestratorMissionCache) : updater,
  );
  broadcastOrchestratorMissionState(next);
  return next;
}

export function subscribeOrchestratorMissionState(listener: (state: OrchestratorMissionState) => void) {
  if (typeof window === 'undefined') return () => {};

  const handleCustom = (event: Event) => {
    const detail = (event as CustomEvent<{ state?: OrchestratorMissionState }>).detail;
    listener(normalizeOrchestratorMissionState(detail?.state ?? orchestratorMissionCache));
  };

  window.addEventListener(ORCHESTRATOR_STATE_EVENT, handleCustom as EventListener);

  return () => {
    window.removeEventListener(ORCHESTRATOR_STATE_EVENT, handleCustom as EventListener);
  };
}

export function subscribeOrchestratorMissionCompleted(listener: (detail: OrchestratorMissionCompletedDetail) => void) {
  if (typeof window === 'undefined') return () => {};

  const handleCustom = (event: Event) => {
    listener((event as CustomEvent<OrchestratorMissionCompletedDetail>).detail);
  };

  window.addEventListener(ORCHESTRATOR_MISSION_COMPLETED_EVENT, handleCustom as EventListener);

  return () => {
    window.removeEventListener(ORCHESTRATOR_MISSION_COMPLETED_EVENT, handleCustom as EventListener);
  };
}

export function packetReleaseBlockedBy(packet: OrchestratorPacket, packets: OrchestratorPacket[]) {
  const packetById = new Map(packets.map((entry) => [entry.id, entry]));
  return packet.dependencyPacketIds
    .map((dependencyId) => {
      const exactMatch = packetById.get(dependencyId) ?? null;
      if (exactMatch) {
        return exactMatch.releaseState !== 'released' ? exactMatch : null;
      }

      const comparisonVariants = packets.filter((candidate) => candidate.id.startsWith(`${dependencyId}-cmp-`));
      if (comparisonVariants.length === 0) {
        return null;
      }
      if (comparisonVariants.some((candidate) => candidate.releaseState === 'released')) {
        return null;
      }
      return comparisonVariants.find((candidate) => !candidate.archivedAt && candidate.status !== 'archived')
        ?? comparisonVariants.find((candidate) => candidate.releaseState !== 'released')
        ?? null;
    })
    .find((dependency): dependency is OrchestratorPacket => dependency !== null && dependency.releaseState !== 'released')
    ?? null;
}

export function reconcileOrchestratorMissionState(
  state: OrchestratorMissionState,
  inputs: {
    laneSnapshots: OrchestratorLaneSnapshot[];
    runtimeTruth: OrchestratorRuntimeTruth[];
    domainLanes?: DomainLaneSummary[];
  },
) {
  const normalized = normalizeOrchestratorMissionState(state);
  const packets = resolvePacketDependencies(normalized.packets);
  const laneByTab = new Map(inputs.laneSnapshots.map((snapshot) => [`${snapshot.tileId}:${snapshot.tabId}`, snapshot] as const));
  const laneBySession = new Map(inputs.laneSnapshots.flatMap((snapshot) => snapshot.sessionKey ? [[snapshot.sessionKey, snapshot] as const] : []));
  const laneByPacketId = new Map(inputs.laneSnapshots.flatMap((snapshot) => snapshot.packetId ? [[snapshot.packetId, snapshot] as const] : []));
  const runtimeTruthBySession = new Map(inputs.runtimeTruth.map((truth) => [truth.sessionKey, truth] as const));
  // ── Lane domain model (passed from server-side caller) ──
  const domainLaneByPacketId: Map<string, DomainLaneSummary> | null =
    inputs.domainLanes && inputs.domainLanes.length > 0
      ? new Map(inputs.domainLanes.map((domainLane) => [domainLane.packetId, domainLane]))
      : null;
  const reconciledPackets = packets.map((packet) => { if (packet.standingLaneId) return packet;
    const dependency = packetReleaseBlockedBy(packet, packets);
    const laneMatch = packet.lane
      ? laneByTab.get(`${packet.lane.tileId}:${packet.lane.tabId}`)
        ?? (packet.lane.sessionKey ? laneBySession.get(packet.lane.sessionKey) : undefined)
        ?? laneByPacketId.get(packet.id)
      : laneByPacketId.get(packet.id);
    const domainLane = domainLaneByPacketId?.get(packet.id) ?? null;
    const runtimeSessionKey = laneMatch?.sessionKey ?? domainLane?.sessionKey ?? packet.lane?.sessionKey ?? null;
    const runtime = runtimeSessionKey ? runtimeTruthBySession.get(runtimeSessionKey) : undefined;
    const laneId = domainLane?.laneId ?? packet.lane?.laneId ?? null;
    const next: OrchestratorPacket = {
      ...packet,
      recovery: domainLane?.recovery ?? packet.recovery ?? null,
      contextTelemetry: reconcilePacketContextTelemetry(packet.contextTelemetry, domainLane?.contextObservation),
      lane: laneMatch
        ? {
            tileId: laneMatch.tileId,
            tabId: laneMatch.tabId,
            repoPath: laneMatch.repoPath,
            runtime: laneMatch.runtime,
            sessionKey: laneMatch.sessionKey ?? domainLane?.sessionKey ?? null,
            laneId,
            lastHeartbeatAt: laneMatch.lastActivityAt,
            lastEventAt: runtime?.lastEventAt ?? packet.lane?.lastEventAt ?? laneMatch.lastActivityAt ?? null,
            lastEventLabel: runtime?.currentTask ?? runtime?.workflowStageLabel ?? packet.lane?.lastEventLabel ?? null,
            mergeMode: domainLane?.mergeMode ?? packet.lane?.mergeMode,
            mergeModeNote: domainLane?.mergeModeNote ?? packet.lane?.mergeModeNote ?? null,
          }
        : packet.lane?.laneId
          ? {
              ...packet.lane,
              laneId,
              sessionKey: domainLane?.sessionKey ?? packet.lane?.sessionKey ?? null,
              mergeMode: domainLane?.mergeMode ?? packet.lane?.mergeMode,
              mergeModeNote: domainLane?.mergeModeNote ?? packet.lane?.mergeModeNote ?? null,
            }
          : null,
      lastEventAt: runtime?.lastEventAt ?? packet.lastEventAt ?? packet.lane?.lastHeartbeatAt ?? null,
      lastEventLabel: runtime?.currentTask ?? runtime?.workflowStageLabel ?? packet.lastEventLabel ?? packet.lane?.lastEventLabel ?? null,
      blockedReason: packet.storageAdmission?.state === 'held' ? packet.blockedReason ?? `Dispatch held by storage admission (${packet.storageAdmission.reason}).` : null,
    };

    if (packet.archivedAt || packet.status === 'archived') {
      next.status = 'archived'; next.queueState = 'held';
      next.blockedReason = null;
      return next;
    }

    if (packet.releaseState === 'released' && hasCanonicalReleaseEvidence(packet)) {
      next.status = 'released';
      next.blockedReason = null;
      return {
        ...next,
        lane: laneMatch ? next.lane : null,
      };
    }
    clearUnprovenReleaseClaim(next);

    // A preflight refusal has no lane to carry awaiting_human. Hold the packet
    // blocked while the durable supervisor incident carries the human question.
    if ((packet.preflightRefusals ?? 0) >= Math.max(1, packet.maxAttempts ?? 3)) {
      next.status = 'blocked';
      next.queueState = packet.queueState;
      next.blockedReason = packet.blockedReason
        ?? `Dispatch preflight refused ${packet.preflightRefusals}/${packet.maxAttempts ?? 3} attempts. Manual reset required.`;
      return next;
    }

    if (packet.status === 'failed' && (!domainLane || domainLane.status === 'failed')) {
      next.status = 'failed';
      next.blockedReason = preferRuntimeRecoveryMessage(packet.blockedReason, domainLane?.failureMessage) ?? null;
      return next;
    }

    if (packet.queueState === 'held') {
      next.status = 'blocked';
      next.blockedReason = packet.blockedReason ?? (packet.holdIntent === 'explicit-dispatch' ? 'Awaiting explicit dispatch' : 'Held by operator');
      return next;
    }

    if (dependency) {
      next.status = 'blocked';
      next.blockedReason = `Waiting on ${dependency.referenceLabel} to be explicitly released`;
      return next;
    }

    // ── Lane domain model status takes priority when available ──
    if (domainLane) {
      const ds = domainLane.status;
      if (ds === 'reviewing' && runtimeTruthHasActiveWriter(runtime)) { next.status = 'running'; return next; }
      if (ds === 'reviewing') { next.status = 'awaiting_review'; return next; }
      if (applyLanePendingStatus(next, domainLane)) return next;
      if (ds === 'completed') { applyLaneCompletedRelease(next); return next; }
      if (ds === 'archived') { next.status = 'archived'; next.queueState = 'held'; return next; }
      if (ds === 'recovering') { next.status = 'recovering'; next.blockedReason = domainLane.lastEventLabel ?? 'Lane recovering'; return next; }
      if (ds === 'failed') {
        next.status = 'failed';
        next.blockedReason = preferRuntimeRecoveryMessage(packet.blockedReason, domainLane.failureMessage) ?? (domainLane.lastEventLabel === 'zero_diff_failed' ? 'no_changes_produced' : domainLane.lastEventLabel);
        return next;
      }
      if (ds === 'running') { next.status = 'running'; return next; }
      if (ds === 'launching') { next.status = 'launching'; return next; }
      if (ds === 'awaiting_input') {
        next.status = 'blocked'; if (domainLane.authRecoveryRequired) next.queueState = 'held';
        // #1469 — preserve the REAL reason. The dag fold-back and the
        // rebase-conflict path both set a truthful blockedReason (conflicting
        // files, fetch failure) before the lane parks awaiting_input;
        // hardcoding the generic string here clobbered it, leaving the
        // operator staring at 'Awaiting operator input' while the actual
        // error lived only in next-server.log. Mirrors the
        // awaiting_orchestrator branch below.
        next.blockedReason = preferRuntimeRecoveryMessage(packet.blockedReason, domainLane.failureMessage)
          ?? friendlyAwaitingInputReason(domainLane.lastEventLabel)
          ?? 'Awaiting operator input';
        return next;
      }
      if (ds === 'awaiting_orchestrator' || ds === 'awaiting_human') { next.status = 'blocked'; next.blockedReason = packet.blockedReason ?? (domainLane.lastEventLabel === 'canonical_merge_ancestry_failed' ? domainLane.lastEventLabel : next.recovery?.message) ?? domainLane.lastEventLabel ?? (ds === 'awaiting_human' ? 'Awaiting human' : 'Awaiting orchestrator'); return next; }
      if (ds === 'paused' && domainLane.sessionKey) { next.status = 'idle'; return next; }
      if (ds === 'paused' && !domainLane.sessionKey) {
        if ((packet.recoveryCount ?? 0) >= MAX_RECOVERY_ATTEMPTS) {
          next.status = 'failed';
          next.blockedReason = `Recovery failed after ${packet.recoveryCount} attempts. Manual reset required.`;
          return next;
        }
        const lastRecovery = packet.lastRecoveryAt ? Date.now() - new Date(packet.lastRecoveryAt).getTime() : Infinity;
        if (lastRecovery < RECOVERY_COOLDOWN_MS) {
          next.status = 'recovering';
          next.blockedReason = 'Recovery cooldown — waiting before next attempt.';
          return next;
        }
        // A paused, session-less lane that is NOT in an active recovery cooldown
        // is dormant/abandoned (a reset or supervisor-auto-escalate leftover), not
        // live. Synthesize 'idle' so it's hidden from the live SwarmStatusCard
        // instead of pulsing "Recovering" forever; the lane reaper archives it.
        // Genuine recovery still surfaces via the cooldown branch above. (#1282)
        next.status = 'idle';
        return next;
      }
    }

    if (laneMatch) {
      const truthStatus = normalizeRuntimeStatusToOrchestratorStatus(runtime?.status, {
        waitingAsRunning: true,
        fallbackStatus: null,
      });
      if (truthStatus === 'awaiting_review') {
        next.status = 'awaiting_review';
        return next;
      }
      if (truthStatus === 'blocked') {
        next.status = 'blocked';
        next.blockedReason = runtime?.currentTask ?? `Runtime reported ${runtime?.status ?? 'blocked'}`;
        return next;
      }
      // Only trust 'running' if the agent is actually in the fleet snapshot
      if (runtime && (truthStatus === 'running' || laneMatch.status === 'running')) {
        next.status = 'running';
        return next;
      }
      // Agent not in fleet but lane claims running → stale cache, mark idle
      if (!runtime && laneMatch.status === 'running') {
        next.status = 'idle';
        return next;
      }
      if (laneMatch.sessionKey) {
        next.status = 'idle';
      } else if ((packet.launchAttempts ?? 0) >= MAX_LAUNCH_ATTEMPTS) {
        // Packet-scoped launch cap → terminal. The 90s launch-timeout net below
        // was defeated by the fast relaunch resetting the clock every ~5-10s
        // (the 4,119× launching<->idle thrash); a COUNT bound is the fix (proven
        // via LaunchHandshake.tla — a delay/timeout can't stop it, only a bound).
        next.status = 'failed';
        next.blockedReason = `Launch failed after ${packet.launchAttempts} attempts. Manual reset required.`;
      } else {
        // Launch timeout: if launching > 90s without a session, mark recovering
        const lastActivity = packet.lane?.lastHeartbeatAt ?? packet.lastEventAt ?? null;
        const launchAge = lastActivity ? Date.now() - new Date(lastActivity).getTime() : 0;
        if (launchAge > 90_000) {
          if ((packet.recoveryCount ?? 0) >= MAX_RECOVERY_ATTEMPTS) {
            next.status = 'failed';
            next.blockedReason = `Launch recovery failed after ${packet.recoveryCount} attempts. Manual reset required.`;
          } else {
            next.status = 'recovering';
            next.blockedReason = 'Launch timed out — session never attached. Re-launch to retry.';
          }
        } else {
          next.status = 'launching';
        }
      }
      return next;
    }

    // #455 — Only mark recovering if the lane binding has a real laneId.
    // A blank laneId means resetPacket cleared the binding but the lane object
    // hasn't been nulled yet (defensive against partial resets).
    if (packet.lane && packet.lane.laneId && !laneMatch && !domainLane) {
      if ((packet.recoveryCount ?? 0) >= MAX_RECOVERY_ATTEMPTS) {
        next.status = 'failed';
        next.blockedReason = `Recovery failed after ${packet.recoveryCount} attempts. Manual reset required.`;
        return { ...next, lane: null };
      }
      next.status = 'recovering';
      next.blockedReason = STALE_LANE_REASON;
      return {
        ...next,
        lane: null,
      };
    }

    if (!packet.lane && packet.blockedReason === STALE_LANE_REASON) {
      if ((packet.recoveryCount ?? 0) >= MAX_RECOVERY_ATTEMPTS) {
        next.status = 'failed';
        next.blockedReason = `Recovery failed after ${packet.recoveryCount} attempts. Manual reset required.`;
        return next;
      }
      next.status = 'recovering';
      next.blockedReason = STALE_LANE_REASON;
      return next;
    }

    next.status = packet.queueState === 'queued' ? 'queued' : 'draft';
    return next;
  });

  const nextState = normalizeOrchestratorMissionState({
    ...normalized,
    packets: reconciledPackets,
  });
  // Compare only SEMANTIC fields. The raw heartbeat timestamps
  // (`lane.lastHeartbeatAt`, `lane.lastEventAt`, top-level `lastEventAt`) advance
  // on every agent inventory tick — including within a single render commit — so
  // including them here made `changed` perpetually true, which minted a fresh
  // `updatedAt` (nowIso) on every reconcile and drove the dashboard reconcile
  // effect into a `Maximum update depth exceeded` storm; display metadata must not drive writes.
  // `lastEventLabel` stays because it changes only when the agent makes real progress.
  const stripVolatile = (packets: OrchestratorMissionState['packets']) =>
    packets.map((p) => ({
      ...p,
      lastEventAt: null,
      lane: p.lane ? { ...p.lane, lastHeartbeatAt: null, lastEventAt: null } : p.lane,
    }));
  const changed = JSON.stringify({
    missionId: normalized.missionId,
    prompt: normalized.prompt,
    summary: normalized.summary,
    repoPath: normalized.repoPath,
    runtime: normalized.runtime,
    constraints: normalized.constraints,
    packets: stripVolatile(normalized.packets),
  }) !== JSON.stringify({
    missionId: nextState.missionId,
    prompt: nextState.prompt,
    summary: nextState.summary,
    repoPath: nextState.repoPath,
    runtime: nextState.runtime,
    constraints: nextState.constraints,
    packets: stripVolatile(nextState.packets),
  });

  return changed ? { ...nextState, updatedAt: nowIso() } : normalized;
}
