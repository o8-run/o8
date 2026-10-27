import { isCorrectionForgotten } from '@/lib/cortex/operator-corrections';
import { outcomeMemoryFingerprint } from '@/lib/cortex/outcome-identity';
import { completionOutcomeId } from '@/lib/cortex/outcome-exclusion';
import { readMemoryRevision } from '@/lib/cortex/memory-revision';
import { asc, eq } from 'drizzle-orm';
import { listApprovalsForContext } from '@/lib/approvals/store';
import type { ApprovalAuditEvent, OrchestratorReviewFinding } from '@/lib/approvals/types';
import { getDb, laneEvents, sessionOutcomes, usageLogs } from '@/lib/db';
import { getLaneSpokenDiffFacts } from '@/lib/lane/lane-diff-facts';
import { findLaneByPacket, findLatestLaneByPacket } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import type { CloseUnmergedDisposition } from '@/lib/orchestrator/close-unmerged';
import type { AgentSummary } from '@/lib/fleet/types';
import { extractReviewFindings, extractReviewPatterns } from '@/lib/orchestrator/review-lessons';
import { closeOutcomeRows, completionTimestamp, outcomeFromPacketSelfReview } from '@/lib/orchestrator/context-relay-outcome';
import {
  buildMissingPacketSelfReview,
  parsePacketSelfReview,
  stripPacketSelfReview,
} from '@/lib/orchestrator/self-review';
import { stripPacketTaskContract } from '@/lib/orchestrator/packet-task-contract';
import {
  findFirstTaskContractCapture,
} from '@/lib/orchestrator/task-contract-cost';
import { persistTaskContractCapture } from '@/lib/orchestrator/persist-task-contract-capture';
import type { OrchestratorRuntime, PacketContext } from '@/lib/orchestrator/types';
import {
  beginCompletionHandoffCapture,
  finishCompletionHandoffCapture,
  packetCompletionContextStore,
  readPacketCompletionContext,
} from '@/lib/orchestrator/completion-handoff';
import {
  isDispatchableRuntime,
  isOrchestratorRuntime,
  runtimeFromOwnedSessionKey,
} from '@/lib/orchestrator/runtime-capabilities';
import { getRuntimeInventorySnapshot } from '@/lib/runtime/inventory';
import { getRuntime } from '@/lib/runtimes/registry';
import type { RuntimeId, RuntimeTranscriptEntry } from '@/lib/runtimes/types';
import { getActiveProjectScopeForRepoSync } from '@/lib/repos/projects';
import { truncateText } from '@/lib/util/text';
import { syncTranscriptSearchDocument } from '@/lib/search/transcripts';
import { derivePacketAttemptIndex } from '@/lib/orchestrator/cost-attribution';
import { capturePacketCapacitySnapshot } from '@/lib/orchestrator/capacity-snapshots';
import {
  isReviewFinding,
  readLatestPersistedReview,
} from '@/lib/orchestrator/context-relay-review';
export { readPacketCompletionContext } from '@/lib/orchestrator/completion-handoff';

const TRANSCRIPT_CAPTURE_LIMIT = 5_000;
const SUMMARY_LIMIT = 1_200;
const NOTE_LIMIT = 320;
const NOTE_PATTERN = /\b(blocker|blocked|blocking|note|notes|remaining|next step|todo|unable|could not|can't|cannot|failed|failure|error|waiting)\b/i;
type PacketReviewContext = NonNullable<PacketContext['review']>;

function inferRuntimeId(sessionKey: string): RuntimeId | null {
  const ownedRuntime = runtimeFromOwnedSessionKey(sessionKey);
  if (ownedRuntime) return ownedRuntime;
  const separatorIndex = sessionKey.indexOf(':');
  const prefix = separatorIndex > 0 ? sessionKey.slice(0, separatorIndex).trim() : '';
  return isOrchestratorRuntime(prefix) ? prefix : null;
}

function normalizeSummaryText(text: string, max: number): string {
  const withoutCode = text.replace(/```[\s\S]*?```/g, '[code omitted]');
  const normalized = withoutCode
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');

  return truncateText(normalized, max);
}

function pushUniqueSection(target: string[], value?: string) {
  const normalized = value?.trim();
  if (!normalized || target.includes(normalized)) {
    return;
  }
  target.push(normalized);
}

function pushUniqueString(target: string[], seen: Set<string>, value?: string) {
  const normalized = value?.trim();
  if (!normalized) {
    return;
  }

  const key = normalized.toLowerCase();
  if (seen.has(key)) {
    return;
  }

  seen.add(key);
  target.push(normalized);
}

function pushUniqueFinding(
  target: OrchestratorReviewFinding[],
  seen: Set<string>,
  finding: OrchestratorReviewFinding,
) {
  const description = finding.description.trim();
  const file = finding.file.trim() || 'unknown';
  if (!description) {
    return;
  }

  const key = `${file.toLowerCase()}:${finding.line ?? ''}:${description.toLowerCase()}`;
  if (seen.has(key)) {
    return;
  }

  seen.add(key);
  target.push({
    file,
    line: typeof finding.line === 'number' && Number.isFinite(finding.line) && finding.line > 0
      ? Math.floor(finding.line)
      : undefined,
    severity: finding.severity,
    description,
    resolution: finding.resolution,
    fixSuggestion: finding.fixSuggestion?.trim() || undefined,
  });
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function findLastAssistantEntry(entries: RuntimeTranscriptEntry[]): RuntimeTranscriptEntry | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.role !== 'assistant' || !entry.text.trim()) {
      continue;
    }
    return entry;
  }
  return null;
}

function findRecentNote(entries: RuntimeTranscriptEntry[], excludedEntryId?: string | null): string {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.id === excludedEntryId) {
      continue;
    }
    if (entry.role !== 'assistant' && entry.role !== 'system') {
      continue;
    }
    const text = entry.text.trim();
    if (!text || !NOTE_PATTERN.test(text)) {
      continue;
    }
    return normalizeSummaryText(text, NOTE_LIMIT);
  }
  return '';
}

function findLatestSelfReview(entries: RuntimeTranscriptEntry[]): PacketContext['selfReview'] {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.role === 'user') break; // A later steer requires a new receipt.
    if (entry.role !== 'assistant' || !entry.text.trim()) {
      continue;
    }

    const selfReview = parsePacketSelfReview(entry.text);
    if (selfReview) {
      return selfReview;
    }
  }

  return buildMissingPacketSelfReview();
}

function buildChangedFileList(entries: RuntimeTranscriptEntry[], runtimeChangedFiles: Array<{ path: string }>): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  const transcriptFiles = entries
    .map((entry) => entry.filePath)
    .filter((value): value is string => Boolean(value?.trim()));

  for (const filePath of runtimeChangedFiles.map((file) => file.path).concat(transcriptFiles)) {
    const normalized = filePath.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    files.push(normalized);
  }

  return files.sort((left, right) => left.localeCompare(right));
}

function buildPacketSummary(input: {
  lifecycleSummary?: string;
  assistantSummary?: string;
  note?: string;
  changedFiles: string[];
}): string {
  const sections: string[] = [];
  pushUniqueSection(sections, input.lifecycleSummary);
  pushUniqueSection(sections, input.assistantSummary);

  if (sections.length === 0) {
    if (input.changedFiles.length > 0) {
      sections.push(`Updated ${input.changedFiles.length} file${input.changedFiles.length === 1 ? '' : 's'} during the completed run.`);
    } else {
      sections.push('Completed the run without a recoverable assistant summary.');
    }
  }

  if (input.note) {
    pushUniqueSection(sections, `Notes: ${input.note}`);
  }

  return sections.join('\n\n');
}

async function findAgentSummary(sessionKey: string): Promise<AgentSummary | null> {
  const snapshot = await getRuntimeInventorySnapshot({ fresh: true });
  return snapshot.agents.find((agent) => agent.sessionKey === sessionKey) ?? null;
}

function toPacketReviewContext(review: {
  findings: OrchestratorReviewFinding[];
  reviewer?: string;
  approved: boolean;
  diffSha?: string;
}): PacketReviewContext {
  const reviewer = review.reviewer?.trim();
  const diffSha = review.diffSha?.trim();
  return {
    reviewer: reviewer || undefined,
    approved: review.approved,
    diffSha: diffSha || undefined,
    findings: review.findings.map((finding) => ({
      file: finding.file.trim(),
      line: typeof finding.line === 'number' && Number.isFinite(finding.line) && finding.line > 0
        ? Math.floor(finding.line)
        : undefined,
      severity: finding.severity,
      description: finding.description.trim(),
      resolution: finding.resolution,
      fixSuggestion: finding.fixSuggestion?.trim() || undefined,
    })),
    reviewedAt: new Date().toISOString(),
  };
}

function buildConflictZonesFromFindings(findings: OrchestratorReviewFinding[]) {
  const zones: string[] = [];
  const seen = new Set<string>();

  for (const finding of findings) {
    const file = finding.file.trim();
    if (!file) {
      continue;
    }

    const zone = typeof finding.line === 'number' ? `${file} (line ${finding.line})` : file;
    pushUniqueString(zones, seen, zone);
  }

  return zones;
}

function buildPacketReviewContextFromEvent(event: ApprovalAuditEvent): PacketReviewContext | null {
  if (event.type !== 'orchestrator_review') {
    return null;
  }

  const findings = Array.isArray(event.findings)
    ? event.findings.filter(isReviewFinding)
    : extractReviewFindings(event.note ?? '');
  const approved = typeof event.approved === 'boolean' ? event.approved : false;

  return {
    reviewer: event.reviewer?.trim() || undefined,
    approved,
    diffSha: event.diffSha?.trim() || undefined,
    findings,
    reviewedAt: new Date(event.timestamp).toISOString(),
  };
}

function extractApprovalReviewContext(
  auditEvents: ApprovalAuditEvent[],
  changedFiles: string[],
): Pick<PacketContext, 'review' | 'reviewFindings' | 'patterns' | 'conflictZones'> {
  const reviewFindings: OrchestratorReviewFinding[] = [];
  const findingKeys = new Set<string>();
  const patterns: string[] = [];
  const patternKeys = new Set<string>();
  const conflictZones: string[] = [];
  const conflictZoneKeys = new Set<string>();
  let latestReview: PacketReviewContext | null = null;
  let latestReviewTimestamp = Number.NEGATIVE_INFINITY;

  for (const event of auditEvents) {
    if (event.type !== 'orchestrator_review') {
      continue;
    }

    const reviewContext = buildPacketReviewContextFromEvent(event);
    if (reviewContext && event.timestamp >= latestReviewTimestamp) {
      latestReview = reviewContext;
      latestReviewTimestamp = event.timestamp;
    }

    const findings = Array.isArray(event.findings)
      ? event.findings.filter(isReviewFinding)
      : extractReviewFindings(event.note ?? '');
    for (const finding of findings) {
      pushUniqueFinding(reviewFindings, findingKeys, finding);
    }

    const derivedPatterns = isStringArray(event.patterns)
      ? event.patterns
      : extractReviewPatterns(event.note ?? '', findings);
    for (const pattern of derivedPatterns) {
      pushUniqueString(patterns, patternKeys, pattern);
    }

    for (const zone of isStringArray(event.conflictZones) ? event.conflictZones : []) {
      pushUniqueString(conflictZones, conflictZoneKeys, zone);
    }
  }

  if (conflictZones.length === 0) {
    for (const filePath of changedFiles) {
      pushUniqueString(conflictZones, conflictZoneKeys, filePath);
    }
  }

  return {
    review: latestReview ?? undefined,
    reviewFindings: reviewFindings.length > 0 ? reviewFindings : latestReview?.findings,
    patterns: patterns.length > 0 ? patterns : undefined,
    conflictZones: conflictZones.length > 0 ? conflictZones : undefined,
  };
}

export async function recordPacketReviewContext(
  packetId: string,
  review: {
    findings: OrchestratorReviewFinding[];
    reviewer?: string;
    approved: boolean;
    diffSha?: string;
  },
): Promise<PacketContext | null> {
  const normalizedPacketId = packetId.trim();
  if (!normalizedPacketId) {
    return null;
  }

  const reviewContext = toPacketReviewContext(review);
  const patterns = extractReviewPatterns(
    reviewContext.findings.map((finding) => finding.description).join('\n'),
    reviewContext.findings,
  );
  const conflictZones = buildConflictZonesFromFindings(reviewContext.findings);
  const existing = await readPacketCompletionContext(normalizedPacketId);
  const lane = existing ? null : findLaneByPacket(normalizedPacketId);
  const projectId = existing?.projectId
    ?? lane?.projectId ?? getActiveProjectScopeForRepoSync(lane?.repoPath ?? null).projectId;
  const nextContext: PacketContext = existing
    ? {
        ...existing,
        projectId,
        review: reviewContext,
        reviewFindings: reviewContext.findings,
        patterns,
        conflictZones: conflictZones.length > 0 ? conflictZones : existing.conflictZones,
      }
    : {
        packetId: normalizedPacketId,
        projectId,
        sessionKey: lane?.sessionKey || (lane ? `lane:${lane.id}` : `packet:${normalizedPacketId}`),
        summary: 'Review recorded before packet completion context was captured.',
        changedFiles: [],
        reviewFindings: reviewContext.findings,
        patterns,
        conflictZones,
        completedAt: new Date().toISOString(),
        model: lane?.runtime ?? 'unknown',
        review: reviewContext,
      };

  packetCompletionContextStore.set(normalizedPacketId, nextContext);

  return nextContext;
}

export async function capturePacketCompletionContext(packetId: string, sessionKey: string, options: { fallbackSummary?: string } = {}): Promise<PacketContext> {
  const memoryRevision = readMemoryRevision();
  const normalizedPacketId = packetId.trim();
  const normalizedSessionKey = sessionKey.trim();
  const runtimeId = inferRuntimeId(normalizedSessionKey);
  const runtime = runtimeId ? getRuntime(runtimeId) : undefined;
  const lane = findLaneByPacket(normalizedPacketId) ?? findLatestLaneByPacket(normalizedPacketId);
  const handoffCapture = await beginCompletionHandoffCapture(lane, normalizedSessionKey);
  const projectId = lane?.projectId ?? getActiveProjectScopeForRepoSync(lane?.repoPath ?? null).projectId;

  const [transcriptResult, changedFilesResult, agentResult, telemetryResult, spokenDiffResult] = await Promise.allSettled([
    runtime?.readTranscript(normalizedSessionKey, undefined, TRANSCRIPT_CAPTURE_LIMIT) ?? Promise.resolve([]),
    runtime?.getChangedFiles(normalizedSessionKey) ?? Promise.resolve([]),
    findAgentSummary(normalizedSessionKey),
    runtime?.getTelemetry?.(normalizedSessionKey) ?? Promise.resolve(undefined),
    Promise.resolve().then(() => (
      lane ? getLaneSpokenDiffFacts(lane) : undefined
    )),
  ]);

  const transcript = transcriptResult.status === 'fulfilled' ? transcriptResult.value : [];
  const changedFiles = buildChangedFileList(
    transcript,
    changedFilesResult.status === 'fulfilled' ? changedFilesResult.value : [],
  );
  const agent = agentResult.status === 'fulfilled' ? agentResult.value : null;
  const telemetry = telemetryResult.status === 'fulfilled' ? telemetryResult.value : undefined;
  const lastAssistantEntry = findLastAssistantEntry(transcript);
  const assistantSummary = normalizeSummaryText(stripPacketTaskContract(stripPacketSelfReview(lastAssistantEntry?.text ?? '')), SUMMARY_LIMIT);
  const fallbackSummary = normalizeSummaryText(options.fallbackSummary ?? '', SUMMARY_LIMIT);
  const selfReview = findLatestSelfReview(transcript);
  const taskContractCapture = findFirstTaskContractCapture(transcript);
  const taskContract = taskContractCapture?.contract;
  const matchingApprovals = listApprovalsForContext({
    packetId: normalizedPacketId,
    laneId: lane?.id ?? undefined,
    sessionKey: normalizedSessionKey,
  });
  const approvalReviewContext = extractApprovalReviewContext(
    matchingApprovals.filter(approval => !isCorrectionForgotten(`approval:${approval.id}`)).flatMap((approval) => approval.audit),
    changedFiles,
  );
  const context: PacketContext = {
    packetId: normalizedPacketId,
    projectId,
    sessionKey: normalizedSessionKey,
    ...(spokenDiffResult.status === 'fulfilled' && spokenDiffResult.value
      ? {
          headSha: spokenDiffResult.value.headSha,
          diffFingerprint: spokenDiffResult.value.fingerprint,
        }
      : {}),
    summary: fallbackSummary
      ? assistantSummary || fallbackSummary
      : buildPacketSummary({
          lifecycleSummary: normalizeSummaryText(agent?.runtimeSurface?.lifecycle?.summary ?? '', SUMMARY_LIMIT),
          assistantSummary,
          note: findRecentNote(transcript, lastAssistantEntry?.id ?? null),
          changedFiles,
        }),
    changedFiles,
    selfReview,
    ...(taskContract ? { taskContract } : {}),
    completedAt: completionTimestamp(transcript, handoffCapture?.provider.finishedAt,
      agent?.runtimeSurface?.lifecycle?.lastRunFinishedAt),
    model: telemetry?.model?.trim()
      || agent?.model?.trim()
      || lane?.model?.trim()
      || 'unknown',
    ...approvalReviewContext,
  };

  context.sourceOutcomeId = completionOutcomeId(context);
  if (lane?.repoPath) context.sourceOutcomeFingerprint = outcomeMemoryFingerprint({ ...context, repoPath: lane.repoPath });
  context.memoryRevision = memoryRevision;
  await finishCompletionHandoffCapture(context, handoffCapture);
  await persistTaskContractCapture({ packetId: normalizedPacketId, sessionKey: normalizedSessionKey, contract: taskContract, lane, runtime: runtimeId, transcript, capture: taskContractCapture, telemetry });

  // #984 Stage 1 — index the transcript once, at packet completion. Cmd+K
  // reads this durable FTS document and never scans runtime files per keystroke.
  try {
    syncTranscriptSearchDocument({
      packetId: normalizedPacketId,
      laneId: lane?.id ?? null,
      sessionKey: normalizedSessionKey,
      title: lane?.label?.trim() || `Packet ${normalizedPacketId}`,
      repoPath: lane?.repoPath ?? null,
      runtime: runtimeId,
      entries: transcript,
      completedAt: context.completedAt,
    });
  } catch (error) {
    console.warn('[transcript-search-write] failed for', normalizedPacketId, error);
  }

  // #1108 — Persist to the session_outcomes ledger; the implicit brain reads it.
  // Fire-and-forget. #2447: a NEW row starts the detached, record-only report
  // claim check; it runs after the outcome is written and never blocks it.
  void persistSessionOutcome(context, lane, runtimeId).then(async (inserted) => {
    if (!inserted || !lane) return;
    const { startReportClaimCheck } = await import('@/lib/lane/report-claim-check');
    startReportClaimCheck({ lane, packetId: normalizedPacketId, transcript });
  }).catch((err) => {
    console.warn('[session-outcome-write] failed for', normalizedPacketId, err);
  });

  return context;
}

/**
 * Insert one `session_outcomes` row per captured completion (mergedClean NULL
 * until merge). Idempotent: id = packetId + sessionKey + completedAt, so
 * identical re-captures collapse via onConflictDoNothing. True on a new row.
 */
// Runtimes the ledger tracks: a subset of RuntimeId ('remote-customer' etc. are not scored).
type LedgerRuntime = OrchestratorRuntime;
const LANE_START_STATUSES: ReadonlySet<string> = new Set(['launching', 'running']);

function isLedgerRuntime(r: string | null): r is LedgerRuntime {
  return isDispatchableRuntime(r);
}

type OutcomeStartDerivation = {
  startedAt: string;
  durationMs: number | null;
  source: 'derived-start' | 'fallback';
  detail: string;
};

function parseLaneEventPayload(payloadJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(payloadJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Bad historical event payloads should only disable start derivation.
  }
  return {};
}

function parseIsoMs(value: string): number | null {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function fallbackOutcomeStart(completedAt: string, detail: string): OutcomeStartDerivation {
  return {
    startedAt: completedAt,
    durationMs: null,
    source: 'fallback',
    detail,
  };
}

function deriveOutcomeStartFromLaneEvents(
  db: NonNullable<ReturnType<typeof getDb>>,
  lane: Lane,
  completedAt: string,
): OutcomeStartDerivation {
  try {
    const rows = db
      .select({
        verb: laneEvents.verb,
        payloadJson: laneEvents.payloadJson,
        timestamp: laneEvents.timestamp,
      })
      .from(laneEvents)
      .where(eq(laneEvents.laneId, lane.id))
      .orderBy(asc(laneEvents.timestamp))
      .all();
    const startRow = rows.find((row) => {
      if (row.verb === 'open_lane') {
        return true;
      }
      if (row.verb !== 'status_change') {
        return false;
      }
      const status = parseLaneEventPayload(row.payloadJson).status;
      return typeof status === 'string' && LANE_START_STATUSES.has(status);
    });

    if (!startRow) {
      return fallbackOutcomeStart(completedAt, 'no lane start event');
    }

    const startedMs = parseIsoMs(startRow.timestamp);
    const completedMs = parseIsoMs(completedAt);
    if (startedMs === null || completedMs === null || startedMs >= completedMs) {
      return fallbackOutcomeStart(completedAt, `invalid start window from ${startRow.verb}`);
    }

    return {
      startedAt: startRow.timestamp,
      durationMs: Math.round(completedMs - startedMs),
      source: 'derived-start',
      detail: startRow.verb,
    };
  } catch (err) {
    return fallbackOutcomeStart(completedAt, `lane start lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function persistSessionOutcome(
  context: PacketContext,
  lane: Lane | null,
  runtimeId: RuntimeId | null,
): Promise<boolean> {
  // We need a ledger-tracked runtime + a repoPath to write a useful row. Skip
  // silently if either is missing — captures that lack them (ad-hoc scratch
  // runs, customer runtimes) weren't going to feed any downstream brain
  // consumer anyway.
  if (!isLedgerRuntime(runtimeId) || !lane?.repoPath) return false;
  // #2492 — the end capacity snapshot shells out per runtime (seconds). Detach
  // it so the ledger insert, and the #2447 chain on its result, never wait on it.
  void capturePacketCapacitySnapshot(lane, 'end').catch((err) => {
    console.warn('[capacity-snapshot] end snapshot failed for', context.packetId, err);
  });
  const db = getDb();
  if (!db) return false;

  // Share the deterministic identity with every read-time recall guard.
  const completedAt = context.completedAt;
  const id = completionOutcomeId(context);
  const start = deriveOutcomeStartFromLaneEvents(db, lane, completedAt);
  console.log(
    `[context-relay] ${start.source} packet=${context.packetId} lane=${lane.id} startedAt=${start.startedAt} completedAt=${completedAt} durationMs=${start.durationMs ?? 'null'} detail=${start.detail}`,
  );

  // Outcome derivation remains coarse at capture time, but a present failed
  // receipt must not be promoted to success. Merge later stamps mergedClean.
  const outcome = outcomeFromPacketSelfReview(context.selfReview);
  const usage = db.select({
    inputTokens: usageLogs.inputTokens,
    outputTokens: usageLogs.outputTokens,
    costUsd: usageLogs.costUsd,
  }).from(usageLogs).where(eq(usageLogs.packetId, context.packetId)).all();
  const totalTokens = usage.reduce(
    (sum, row) => sum + Math.max(0, row.inputTokens) + Math.max(0, row.outputTokens),
    0,
  );
  const costUsd = Number(usage.reduce((sum, row) => sum + Math.max(0, row.costUsd), 0).toFixed(6));
  const attempts = derivePacketAttemptIndex({ packetId: context.packetId, laneId: lane.id });
  const latestReview = readLatestPersistedReview(context, lane) ?? context.review;

  try {
    const insert = await db.insert(sessionOutcomes).values({
      id,
      memoryFingerprint: context.sourceOutcomeFingerprint,
      projectId: context.projectId ?? null,
      repoPath: lane.repoPath,
      branch: lane.branch ?? null,
      runtime: runtimeId,
      sessionKey: context.sessionKey,
      laneId: lane.id,
      packetId: context.packetId,
      outcome,
      summary: (context.summary || '(no summary)').slice(0, 4000),
      changedFilesJson: JSON.stringify((context.changedFiles ?? []).slice(0, 50)),
      model: context.model ?? null,
      startedAt: start.startedAt,
      completedAt,
      durationMs: start.durationMs,
      totalTokens,
      costUsd,
      attempts,
      reviewApproved: latestReview?.approved ?? false,
      reviewFindingsCount: latestReview?.findings.length ?? 0,
      // mergedClean stays NULL until markOutcomeMerged() stamps it at merge.
    }).onConflictDoNothing();
    // Cached "what shipped" Q&A answers are now stale (lazy import: cold-start graph).
    try {
      const { invalidateAnswerCache } = await import('@/lib/cortex/qa/ask');
      invalidateAnswerCache();
    } catch {
      // Best-effort — never let cache invalidation break the capture flow.
    }
    return insert.changes > 0;
  } catch (err) {
    // Swallow — never let a ledger write break the capture flow.
    console.warn('[session-outcome-write] insert failed:', err);
    return false;
  }
}

/**
 * Stamp `merged_clean` on the session_outcomes row(s) for a successfully-
 * reconciled packet/lane. Best-effort + fire-and-forget by the caller — never
 * block a merge over a ledger write.
 *
 * Looks up by laneId and packetId when available. Updates every matching row
 * in case a retry produced two captures for the same
 * packet (deterministic id collapses most cases, but be defensive).
 */
export async function markOutcomeMerged({
  laneId,
  packetId,
  mergedClean = true,
}: {
  laneId?: string | null;
  packetId?: string | null;
  mergedClean?: boolean;
}): Promise<void> {
  const db = getDb();
  if (!db) return;
  const trimmedLane = laneId?.trim() || null;
  const trimmedPacket = packetId?.trim() || null;
  if (!trimmedLane && !trimmedPacket) return;

  try {
    if (trimmedLane) {
      await db.update(sessionOutcomes)
        .set({ mergedClean })
        .where(eq(sessionOutcomes.laneId, trimmedLane));
    }
    if (trimmedPacket) {
      await db.update(sessionOutcomes)
        .set({ mergedClean })
        .where(eq(sessionOutcomes.packetId, trimmedPacket));
    }
  } catch (err) {
    console.warn('[session-outcome-merge] mergedClean update failed:', err);
  }
}

/**
 * Replace the provisional worker-completion result with the operator's final
 * disposition when work is intentionally closed without merging.
 */
export async function markOutcomeClosedUnmerged({
  laneId,
  packetId,
  disposition,
  lane,
  summary,
}: {
  laneId?: string | null;
  packetId?: string | null;
  disposition: CloseUnmergedDisposition;
  lane?: (Pick<Lane, 'id' | 'repoPath' | 'branch' | 'runtime' | 'sessionKey' | 'createdAt'> & { projectId?: string | null }) | null;
  summary?: string | null;
}): Promise<void> {
  const db = getDb();
  if (!db) return;
  const trimmedLane = laneId?.trim() || null;
  const trimmedPacket = packetId?.trim() || null;
  if (!trimmedLane && !trimmedPacket) return;

  try {
    const completedAt = new Date().toISOString();
    const outcomeSummary = summary?.trim() || 'Closed unmerged by the operator.';
    const changes = closeOutcomeRows({ laneId: trimmedLane, packetId: trimmedPacket,
      outcome: disposition, summary: outcomeSummary, completedAt });
    if (changes === 0 && lane) {
      const projectId = 'projectId' in lane ? lane.projectId ?? null : getActiveProjectScopeForRepoSync(lane.repoPath).projectId;
      const outcomeId = `outcome-close-${trimmedPacket ?? trimmedLane}-${completedAt.slice(0, 19)}`;
      await db.insert(sessionOutcomes).values({
        id: outcomeId,
        projectId,
        memoryFingerprint: outcomeMemoryFingerprint({ projectId, repoPath: lane.repoPath, packetId: trimmedPacket, sessionKey: lane.sessionKey, summary: outcomeSummary }),
        repoPath: lane.repoPath,
        branch: lane.branch,
        runtime: lane.runtime,
        sessionKey: lane.sessionKey,
        laneId: trimmedLane ?? lane.id,
        packetId: trimmedPacket,
        outcome: disposition,
        summary: outcomeSummary,
        startedAt: lane.createdAt,
        completedAt,
        mergedClean: false,
      }).onConflictDoNothing();
    }
    try {
      const { invalidateAnswerCache } = await import('@/lib/cortex/qa/ask');
      invalidateAnswerCache();
    } catch {
      // Best-effort — a ledger close must not fail because the cache is unavailable.
    }
  } catch (err) {
    console.warn('[session-outcome-close-unmerged] update failed:', err);
  }
}
