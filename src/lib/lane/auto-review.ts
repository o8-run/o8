/**
 * Auto-review trigger for the orchestrator loop.
 *
 * When a lane transitions to 'reviewing' (agent finished), this module
 * enqueues a durable review job in SQLite. A bounded drain pool processes the
 * queue, sending review prompts through dedicated reviewer sessions.
 *
 * This is the connecting tissue between agent completion and human approval.
 * (#456) — Persistent queue survives process restarts. No more lost reviews.
 */

import { manualReviewRequested } from './review-mode';
import { randomUUID } from 'node:crypto';
import { laneGitSync } from '@/lib/lane/lane-git';
import { isSafeGitRef } from '@/lib/git/refs';
import { capturePacketCompletionContext, readPacketCompletionContext } from '@/lib/orchestrator/context-relay';
import { readPacketDeviations, type PacketDeviations } from '@/lib/orchestrator/packet-deviations';
import type { PacketSelfReview, PacketTaskContract } from '@/lib/orchestrator/types';
import { buildAutoReviewPromptV1 } from '@/lib/prompts/v1';
import { runMergeGate, formatMergeGateForReview, type MergeGateResult } from './merge-gate';
import { extractAddedLines, getLaneDiffFacts, parseDiffStat, type AddedDiffLine } from './lane-diff-facts';
import { buildAdversarialReviewProtocol, classifyReviewRisk } from './review-risk';
import { resolveLaneReviewScreenshotReference, type LaneReviewScreenshotReference } from './review-screenshot';
import {
  REVIEW_CONCURRENCY_LIMIT,
  activateReviewSlot,
  activeLaneReviewExists,
  activeReviewClaimCount,
  isLaneAutoReviewActive,
  nextAvailableReviewSlot,
  releaseReviewSlot,
  releaseStaleLaneReviewClaims,
  reviewerSessionThreadId,
} from './review-concurrency';
import { buildBlindSecondPassPrompt, findPendingSecondPassApproval, parseSecondPassVerdict } from './blind-second-pass-review';
import { appendCodexAutoReviewVerdictInstructions, recordCodexAutoReviewVerdict } from './codex-auto-review-verdict';
import { runReviewerTurnWithQuotaFallback } from './review-quota-fallback';
import { enqueueLaneReview } from './review-queue';
import {
  laneReviewHeadSha,
  normalizeAttemptHeadSha,
  reclaimAbandonedReviewAttempts,
} from './review-attempt-head';
import {
  claimNextReview,
  isReviewClaimCurrent,
  runReviewRecoveryPass,
  type QueuedReview,
} from './review-drain-recovery';
import {
  markReviewCompleted,
  markReviewDeferred,
  markReviewFailed,
  markReviewSkipped,
} from './review-queue-settlement';
import {
  cancelAutoReviewForLane,
  clearReviewAttemptCancellation,
  isReviewAttemptCancelled,
} from './review-cancellation';
import { dispatchSecondPassMerge } from './second-pass-merge-dispatch';
import { drainPacketExplainerQueue, enqueuePacketExplainer, startPacketExplainerQueueDrain } from './packet-explainer-queue';
import { resolvePacketTaskContractGate } from './task-contract-gate';
import type { Lane } from './types';

const DRAIN_INTERVAL_MS = 10_000;
const REVIEW_DIFF_LINES = {
  'fast-track': 120,
  standard: 200,
  'deep-dive': 320,
} as const;

let drainTimer: ReturnType<typeof setInterval> | null = null;
let stopExplainerDrain: (() => void) | null = null;

export { isLaneAutoReviewActive, cancelAutoReviewForLane };

/**
 * Called when a lane transitions to 'reviewing' during reconciliation.
 * Enqueues a durable review job — does not block the caller.
 */
export function triggerAutoReview(lane: Lane): void {
  enqueueLaneReview(lane);
}

/**
 * Start the review queue drain loop. Call once per server process.
 */
export function startReviewQueueDrain(): () => void {
  if (manualReviewRequested()) return () => {};
  if (drainTimer) return () => { /* already running */ };

  // At boot no claim from the prior process is live; reclaim with a receipt.
  try {
    reclaimAbandonedReviewAttempts({ leaseMs: 0, cancelInMemory: false });
  } catch {
    // DB may not be ready yet — drain loop will handle it
  }

  drainTimer = setInterval(() => {
    void drainReviewQueue().catch((err) => {
      console.error('[auto-review] Drain error:', err);
    });
  }, DRAIN_INTERVAL_MS);
  stopExplainerDrain = startPacketExplainerQueueDrain();

  console.log(`[auto-review] Started review queue drain (${DRAIN_INTERVAL_MS}ms interval)`);

  // Run immediately
  void drainReviewQueue().catch(() => {});

  return () => {
    if (drainTimer) {
      clearInterval(drainTimer);
      drainTimer = null;
      stopExplainerDrain?.();
      stopExplainerDrain = null;
      console.log('[auto-review] Stopped review queue drain');
    }
  };
}

type ReviewDepth = keyof typeof REVIEW_DIFF_LINES;

/** Structured settlement prevents an early return from looking completed. */
type AutoReviewOutcome =
  | { kind: 'reviewed' }
  | { kind: 'deferred'; reason: string }
  | { kind: 'skipped'; reason: string };

const skipped = (reason: string): AutoReviewOutcome => ({ kind: 'skipped', reason });
const deferred = (reason: string): AutoReviewOutcome => ({ kind: 'deferred', reason });

function requeueIfReviewHeadMoved(review: QueuedReview, lane: Lane): boolean {
  const reviewedHeadSha = normalizeAttemptHeadSha(review.head_sha);
  const currentHeadSha = laneReviewHeadSha(lane);
  if (!reviewedHeadSha || !currentHeadSha || reviewedHeadSha === currentHeadSha) return false;
  enqueueLaneReview(lane, { headSha: currentHeadSha });
  console.warn(
    `[auto-review] Review ${review.id} superseded: HEAD moved from ${reviewedHeadSha} to ${currentHeadSha}`,
  );
  return true;
}

/**
 * Run one drain tick. Exported so real-path tests can drive the production
 * queue path deterministically instead of waiting on the interval.
 */
async function processClaimedReview(slot: number, review: QueuedReview): Promise<'continue' | 'pause'> {
  try {
    const outcome = await performAutoReview(review, slot);
    if (outcome.kind === 'deferred') {
      markReviewDeferred({
        reviewId: review.id,
        claimOwner: review.claim_owner,
        laneId: review.lane_id,
        reason: outcome.reason,
      });
      return 'pause';
    } else if (outcome.kind === 'skipped') {
      markReviewSkipped({
        reviewId: review.id,
        claimOwner: review.claim_owner,
        laneId: review.lane_id,
        reason: outcome.reason,
      });
      return 'continue';
    } else {
      markReviewCompleted({ reviewId: review.id, claimOwner: review.claim_owner });
      return 'continue';
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (isReviewAttemptCancelled(review.id, review.claim_owner)) {
      markReviewSkipped({
        reviewId: review.id,
        claimOwner: review.claim_owner,
        laneId: review.lane_id,
        reason: `Review attempt cancelled mid-flight: ${errorMsg}`,
      });
      return 'continue';
    }
    markReviewFailed({
      reviewId: review.id,
      claimOwner: review.claim_owner,
      laneId: review.lane_id,
      error: errorMsg,
      attempts: review.attempts + 1,
    });
    console.error(`[auto-review] Review ${review.id} failed (attempt ${review.attempts + 1}): ${errorMsg}`);
    return 'pause';
  } finally {
    releaseReviewSlot(slot, review);
    clearReviewAttemptCancellation(review.id, review.claim_owner);
    void drainPacketExplainerQueue().catch(() => {});
  }
}

async function drainAvailableReviewSlot(): Promise<void> {
  while (true) {
    const slot = nextAvailableReviewSlot();
    if (slot === null) return;

    const review = claimNextReview();
    if (!review) return;

    // A successor waits behind the lane's current claim. Reclaimed generations
    // are cancelled and owner-scoped, so their stale continuations cannot write.
    if (activeLaneReviewExists(review.lane_id)) {
      markReviewDeferred({
        reviewId: review.id,
        claimOwner: review.claim_owner,
        laneId: review.lane_id,
        reason: 'Lane already being reviewed',
      });
      return;
    }

    activateReviewSlot(slot, review);
    const disposition = await processClaimedReview(slot, review);
    if (disposition === 'pause') return;
  }
}

export async function drainReviewQueue(): Promise<void> {
  if (manualReviewRequested()) return;
  // Recovery stays ahead of capacity checks so an abandoned turn cannot pin a
  // slot or disable the path that reclaims and replaces it.
  await runReviewRecoveryPass();

  // A reclaimed lane can advance while its aborted session keeps its slot.
  releaseStaleLaneReviewClaims(isReviewClaimCurrent);

  const available = REVIEW_CONCURRENCY_LIMIT - activeReviewClaimCount();
  if (available <= 0) return;
  await Promise.all(Array.from({ length: available }, () => drainAvailableReviewSlot()));
}

// ── Review Execution ──

/**
 * Derive review depth from self-review confidence.
 * (#482) — Fast-track removed. Agent self-review is informational only;
 * mechanical checks + LLM review are the real gates. Agents confidently
 * reported "passed: true, confidence: high" on broken code in Round 1.
 */
function deriveReviewDepth(selfReview?: PacketSelfReview): ReviewDepth {
  if (!selfReview?.passed || selfReview.confidence === 'low') {
    return 'deep-dive';
  }

  // Never fast-track — mechanical checks are the real gate
  return 'standard';
}

function formatSelfReview(selfReview: PacketSelfReview | undefined, depth: ReviewDepth): string {
  if (!selfReview) {
    return [
      '## Agent self-review',
      '',
      'Structured self-review: missing',
      'Review depth: deep-dive',
      'Reason: no machine-readable self-review verdict was captured in the completion context.',
    ].join('\n');
  }

  const issues = selfReview.issuesFound && selfReview.issuesFound.length > 0
    ? selfReview.issuesFound.map((issue) => `- ${issue}`).join('\n')
    : '- none recorded';
  const evidence = selfReview.evidence && selfReview.evidence.length > 0
    ? selfReview.evidence.map((entry) => `- ${entry}`).join('\n')
    : '- none recorded';

  return [
    '## Agent self-review',
    '',
    `Passed: ${selfReview.passed ? 'yes' : 'no'}`,
    `Confidence: ${selfReview.confidence}`,
    `Review depth: ${depth}`,
    `Summary: ${selfReview.summary}`,
    `Outcome: ${selfReview.outcome ?? 'not stated'}`,
    `Decision: ${selfReview.decision ?? 'legacy self-review; infer independently'}`,
    `Residual: ${selfReview.residual ?? 'not stated'}`,
    `Recurrence protection: ${selfReview.recurrenceProtection ?? 'not stated'}`,
    'Claimed evidence:',
    evidence,
    'Issues found and fixed during self-review:',
    issues,
  ].join('\n');
}

interface ReviewDiffSummary {
  summary: string;
  changedFiles: string[];
  addedLines: string[];
  addedDiffLines: AddedDiffLine[];
  cwd: string;
}

function getDiffSummary(lane: Lane, depth: ReviewDepth, comparisonRef?: string): ReviewDiffSummary {
  const cwd = lane.worktreePath || lane.repoPath;
  const maxDiffLines = REVIEW_DIFF_LINES[depth];
  try {
    const facts = getLaneDiffFacts(lane, comparisonRef);
    const safeBase = comparisonRef && isSafeGitRef(comparisonRef)
      ? comparisonRef
      : isSafeGitRef(lane.baseBranch) ? lane.baseBranch : null;
    let stat = '';
    try {
      stat = laneGitSync(cwd, lane.repoPath, ['diff', '--stat', safeBase ? `${safeBase}...HEAD` : 'HEAD~1'], { timeout: 10_000 }).trim();
    } catch {
      try {
        stat = laneGitSync(cwd, lane.repoPath, ['diff', '--stat', 'HEAD~1'], { timeout: 10_000 }).trim();
      } catch { /* no commits yet */ }
    }

    let diff = '';
    try {
      const rawDiff = laneGitSync(cwd, lane.repoPath, ['diff', safeBase ? `${safeBase}...HEAD` : 'HEAD~1', '--no-color', '-U2'], { timeout: 10_000 });
      diff = rawDiff.split('\n').slice(0, maxDiffLines).join('\n').trim();
    } catch {
      try {
        const rawDiff = laneGitSync(cwd, lane.repoPath, ['diff', 'HEAD~1', '--no-color', '-U2'], { timeout: 10_000 });
        diff = rawDiff.split('\n').slice(0, maxDiffLines).join('\n').trim();
      } catch { /* no commits yet */ }
    }

    if (!stat && !diff) {
      return { summary: 'No changes detected in the worktree.', changedFiles: facts.changedFiles, addedLines: facts.addedLines, addedDiffLines: facts.addedDiffLines, cwd };
    }
    return {
      summary: `## Diff summary\n\n\`\`\`\n${stat}\n\`\`\`\n\n## Changes\n\n\`\`\`diff\n${diff}\n\`\`\``,
      changedFiles: facts.changedFiles,
      addedLines: facts.addedLines,
      addedDiffLines: facts.addedDiffLines,
      cwd,
    };
  } catch {
    return {
      summary: 'Unable to generate diff — the worktree may not have commits yet.',
      changedFiles: [],
      addedLines: [],
      addedDiffLines: [],
      cwd,
    };
  }
}

// ── Mechanical Checks (#482) ──
// Automated diff stats + security pattern scan that runs before LLM review.
// Findings are prepended to the review prompt so the orchestrator sees them.

interface MechanicalFinding {
  severity: 'high' | 'warning';
  label: string;
  detail: string;
}

const SECURITY_PATTERNS: Array<{ pattern: RegExp; label: string; severity: 'high' | 'warning' }> = [
  { pattern: /execSync\s*\(.*\$\{/, label: 'execSync with template literal', severity: 'high' },
  { pattern: /execSync\s*\(.*\+\s*/, label: 'execSync with string concatenation', severity: 'high' },
  { pattern: /\bexec\s*\(.*\$\{/, label: 'exec with template literal', severity: 'high' },
  { pattern: /child_process.*\bsh\s+-c\b/, label: 'sh -c shell execution', severity: 'high' },
  { pattern: /\beval\s*\(/, label: 'eval() usage', severity: 'high' },
  { pattern: /new\s+Function\s*\(/, label: 'new Function() constructor', severity: 'high' },
  { pattern: /dangerouslySetInnerHTML/, label: 'dangerouslySetInnerHTML', severity: 'warning' },
  { pattern: /path\.join\s*\([^)]*(?:req\.|params\.|query\.|body\.)/, label: 'path.join on user input without bounds check', severity: 'high' },
  { pattern: /\.innerHTML\s*=/, label: 'direct innerHTML assignment', severity: 'warning' },
];

function runMechanicalChecks(lane: Lane, comparisonRef?: string): { findings: MechanicalFinding[]; summary: string } {
  const cwd = lane.worktreePath || lane.repoPath;
  const safeBase = comparisonRef && isSafeGitRef(comparisonRef)
    ? comparisonRef
    : isSafeGitRef(lane.baseBranch) ? lane.baseBranch : null;
  const findings: MechanicalFinding[] = [];

  // ── Diff stats check ──
  let stat = '';
  try {
    stat = laneGitSync(cwd, lane.repoPath, ['diff', '--stat', safeBase ? `${safeBase}...HEAD` : 'HEAD~1'], { timeout: 10_000 }).trim();
  } catch {
    try {
      stat = laneGitSync(cwd, lane.repoPath, ['diff', '--stat', 'HEAD~1'], { timeout: 10_000 }).trim();
    } catch { /* no commits */ }
  }

  if (stat) {
    const fileStats = parseDiffStat(stat);
    for (const fs of fileStats) {
      const total = fs.insertions + fs.deletions;
      if (total === 0) continue;
      const deleteRatio = fs.deletions / total;
      if (fs.deletions > 50 && deleteRatio > 0.5) {
        findings.push({
          severity: 'high',
          label: 'Possible file rewrite',
          detail: `${fs.file}: ${fs.deletions} deletions (${Math.round(deleteRatio * 100)}% of changes). Agent may have rewritten instead of surgically editing.`,
        });
      } else if (fs.deletions > 20 && deleteRatio > 0.3) {
        findings.push({
          severity: 'warning',
          label: 'High deletion ratio',
          detail: `${fs.file}: ${fs.deletions} deletions (${Math.round(deleteRatio * 100)}% of changes). Verify deletions were intentional.`,
        });
      }
    }
  }

  // ── Security pattern scan ──
  let rawDiff = '';
  try {
    rawDiff = laneGitSync(cwd, lane.repoPath, ['diff', safeBase ? `${safeBase}...HEAD` : 'HEAD~1', '--no-color'], { timeout: 10_000, maxBuffer: 10 * 1024 * 1024 });
  } catch {
    try {
      rawDiff = laneGitSync(cwd, lane.repoPath, ['diff', 'HEAD~1', '--no-color'], { timeout: 10_000, maxBuffer: 10 * 1024 * 1024 });
    } catch { /* no commits */ }
  }

  if (rawDiff) {
    // Only scan added lines (lines starting with +, excluding +++ headers)
    const addedLines = extractAddedLines(rawDiff);

    for (const { pattern, label, severity } of SECURITY_PATTERNS) {
      for (const line of addedLines) {
        if (pattern.test(line)) {
          findings.push({
            severity,
            label,
            detail: `New code matches security pattern: ${line.slice(1).trim().slice(0, 120)}`,
          });
          break; // One finding per pattern is enough
        }
      }
    }
  }

  if (findings.length === 0) {
    return { findings, summary: '' };
  }

  const highCount = findings.filter((f) => f.severity === 'high').length;
  const warnCount = findings.filter((f) => f.severity === 'warning').length;
  const lines = [
    '## Mechanical checks (automated)',
    '',
    `Found ${findings.length} issue${findings.length === 1 ? '' : 's'}: ${highCount} high, ${warnCount} warning.`,
    '',
    ...findings.map((f) => `- **[${f.severity.toUpperCase()}]** ${f.label}: ${f.detail}`),
    '',
    'These checks are automated and may have false positives. Evaluate each finding independently.',
  ];

  console.log(`[auto-review] Mechanical checks for lane ${lane.id}: ${highCount} high, ${warnCount} warning`);

  return { findings, summary: lines.join('\n') };
}

function buildReviewPrompt(
  lane: Lane,
  diffSummary: string,
  changedFiles: string[],
  addedLines: AddedDiffLine[],
  selfReview: PacketSelfReview | undefined,
  depth: ReviewDepth,
  mechanicalChecksSummary?: string,
  mergeGateResult?: MergeGateResult,
  reviewScreenshot?: LaneReviewScreenshotReference | null,
  reviewWorktreePath?: string,
  deviations?: PacketDeviations | null,
  taskContract?: PacketTaskContract | null,
  taskContractRequired = false,
): string {
  const mergeGateSection = mergeGateResult ? formatMergeGateForReview(mergeGateResult) : null;
  const reviewRisk = classifyReviewRisk(changedFiles, addedLines);
  const adversarialReviewProtocol = buildAdversarialReviewProtocol(reviewRisk.tier);
  const worktreePath = reviewWorktreePath || lane.worktreePath || lane.repoPath;
  return buildAutoReviewPromptV1({
    lane: {
      id: lane.id,
      label: lane.label,
      branch: lane.branch,
      packetId: lane.packetId,
    },
    depth,
    worktreePath,
    diffSummary,
    selfReviewSection: formatSelfReview(selfReview, depth),
    deviationsEntries: deviations?.entries ?? [],
    mergeGateSection,
    mechanicalChecksSummary,
    reviewScreenshot,
    adversarialReviewProtocol,
    taskContract,
    taskContractRequired,
  });
}

async function performAutoReview(review: QueuedReview, reviewerSlot: number): Promise<AutoReviewOutcome> {
  const { getLane, getLatestLaneReviewScreenshot } = await import('@/lib/lane/registry');
  const lane = getLane(review.lane_id);
  if (!lane) {
    throw new Error(`Lane ${review.lane_id} not found`);
  }

  if (lane.status !== 'reviewing') {
    console.log(`[auto-review] Lane ${lane.id} is no longer reviewing (${lane.status}) — skipping`);
    return skipped(`Lane is no longer reviewing (${lane.status}).`);
  }
  if (isReviewAttemptCancelled(review.id, review.claim_owner)) {
    console.log(`[auto-review] Review ${review.id} was cancelled before it started — skipping`);
    return skipped('This review attempt was cancelled before it started.');
  }
  if (requeueIfReviewHeadMoved(review, lane)) {
    return skipped('HEAD moved before this review turn started; a successor review was queued.');
  }

  let completionContext = null;
  if (lane.packetId && lane.sessionKey) {
    try {
      await capturePacketCompletionContext(lane.packetId, lane.sessionKey);
      completionContext = await readPacketCompletionContext(lane.packetId);
    } catch (error) {
      console.warn(`[auto-review] Failed to refresh completion context for lane ${lane.id}:`, error);
      completionContext = await readPacketCompletionContext(lane.packetId);
    }
  } else if (lane.packetId) {
    completionContext = await readPacketCompletionContext(lane.packetId);
  }

  // #1490 — capture worker deviations from the worktree notes file and stamp
  // them onto the packet so the review surfaces + the auto-reviewer both see
  // where the worker went off-plan. Null (no notes file / no heading) persists
  // as null so the surfaces render the asserted "No deviations reported" line.
  let deviations: PacketDeviations | null = null;
  let enforceCoverage = false;
  let taskContract: PacketTaskContract | null = completionContext?.taskContract ?? null;
  if (lane.packetId) {
    try {
      deviations = readPacketDeviations(lane.worktreePath || lane.repoPath, lane.packetId);
      ({ taskContract, enforceCoverage } = await resolvePacketTaskContractGate({ lane, completionContext, deviations }));
    } catch (error) {
      console.warn(`[auto-review] Failed to capture deviations for lane ${lane.id}:`, error);
    }
  }

  const depth = deriveReviewDepth(completionContext?.selfReview);
  const mergeGateResult = await runMergeGate(lane, completionContext?.selfReview);
  const comparisonRef = mergeGateResult.diffBase?.mergeBase
    ?? mergeGateResult.diffBase?.comparisonRef;
  const mechanicalChecks = runMechanicalChecks(lane, comparisonRef);
  const diffSummary = getDiffSummary(lane, depth, comparisonRef);
  const reviewRisk = classifyReviewRisk(diffSummary.changedFiles, diffSummary.addedDiffLines);
  const { appendEvent } = await import('@/lib/lane/registry');
  appendEvent(lane.id, 'review_risk_classified', 'system', {
    tier: reviewRisk.tier,
    reasons: reviewRisk.reasons,
    responsibleFiles: reviewRisk.responsibleFiles,
  });
  let reviewScreenshot: LaneReviewScreenshotReference | null = null;
  if (lane.runtime === 'codex') {
    try {
      reviewScreenshot = await resolveLaneReviewScreenshotReference(
        lane.id,
        getLatestLaneReviewScreenshot(lane.id),
      );
    } catch (error) {
      console.warn(`[auto-review] Failed to prepare review screenshot for lane ${lane.id}:`, error);
    }
  }
  const reviewPrompt = buildReviewPrompt(
    lane,
    diffSummary.summary,
    diffSummary.changedFiles,
    diffSummary.addedDiffLines,
    completionContext?.selfReview,
    depth,
    mechanicalChecks.summary || undefined,
    mergeGateResult,
    reviewScreenshot,
    diffSummary.cwd,
    deviations,
    taskContract,
    enforceCoverage,
  );

  if (isReviewAttemptCancelled(review.id, review.claim_owner)) {
    console.log(`[auto-review] Review ${review.id} was cancelled while preparing — skipping`);
    return skipped('This review attempt was cancelled while its prompt was being prepared.');
  }
  if (requeueIfReviewHeadMoved(review, lane)) {
    return skipped('HEAD moved while this review prompt was being prepared; a successor review was queued.');
  }

  // Dual-path routing (epic #1044): the `inAppOrchestratorEnabled` toggle is
  // now a runtime selector, not an on/off gate.
  //   - toggle OFF (default) → Codex GPT-6 Astra xhigh runs the review through
  //     the connected Codex subscription.
  //   - toggle ON              → the resident Claude Code harness runs the
  //     review with the model source selected in Settings > Models.
  // Both backends can call `submit_review` and `approve_and_merge`. Fail-closed
  // approval is enforced by the durable review gate (`requiresSecondPass`),
  // not by backend capability asymmetry.
  // Backend selected via the orchestrator-backend registry (#1075). Behavior
  // is byte-identical to the prior dual-path branch — see registry.ts.
  // #reviewer-split (2026-07-07): reviews resolve their OWN backend so the
  // accuracy-critical review can run on Claude while the bulk orchestrator
  // stays on Codex. 'follow' (default) = pre-split behavior.
  const reviewTurn = await runReviewerTurnWithQuotaFallback({
    laneId: lane.id,
    repoPath: lane.repoPath,
    threadId: `auto-review-${lane.id}-${review.id}`,
    sessionThreadId: reviewerSessionThreadId(reviewerSlot, 'primary'),
    surface: 'auto-review',
    expectedHeadSha: review.head_sha,
    prompt: (backendId) => backendId === 'codex'
      ? appendCodexAutoReviewVerdictInstructions(reviewPrompt)
      : reviewPrompt,
    onEvent: (turnBackend, event) => {
      if (event.type === 'text') {
        console.log(`[auto-review] ${turnBackend.label}: ${event.text.slice(0, 100)}`);
      } else if (event.type === 'tool_use') {
        console.log(`[auto-review] ${turnBackend.label} called tool: ${event.name}`);
      } else if (event.type === 'error') {
        console.error(`[auto-review] ${turnBackend.label} error: ${event.error}`);
      }
    },
  });
  if (isReviewAttemptCancelled(review.id, review.claim_owner)) {
    console.log(`[auto-review] Review ${review.id} was cancelled during the turn — discarding the result`);
    return skipped('This review attempt was cancelled while the reviewer turn was running.');
  }
  if (requeueIfReviewHeadMoved(review, lane)) {
    return skipped('HEAD moved while this review turn was running; its verdict was discarded.');
  }
  if (reviewTurn.unavailableReason === 'session_busy') {
    return deferred('Reviewer session busy');
  }
  if (!reviewTurn.ok) {
    throw new Error(`Review turn failed: ${reviewTurn.errors.join('; ').slice(0, 500)}`);
  }

  if (reviewTurn.backend === 'codex') {
    const recorded = await recordCodexAutoReviewVerdict({
      lane,
      rawText: reviewTurn.text,
      requiresSecondPass: reviewRisk.tier === 'high',
      reviewTurnId: reviewTurn.reviewTurnId,
      expectedHeadSha: review.head_sha,
      // Retry prose once; two parse failures leave the packet unjudged.
      retry: {
        reviewPrompt,
        threadId: `auto-review-${lane.id}-${review.id}-verdict-retry`,
        sessionThreadId: reviewerSessionThreadId(reviewerSlot, 'verdict-retry'),
      },
    });
    if (requeueIfReviewHeadMoved(review, lane)) return skipped('HEAD moved during verdict retry; successor queued.');
    if (recorded?.reviewUnavailable) {
      console.warn(`[auto-review] Codex review unavailable for lane ${lane.id} (${recorded.verdict.parseWarning}); existing verdict left untouched`);
    } else if (recorded?.verdict.parseWarning) {
      console.warn(`[auto-review] Codex verdict for lane ${lane.id} needed parser fallback: ${recorded.verdict.parseWarning}`);
    }
  }

  // The current review row stays in_progress through any blind pass, so the
  // independent explainer queue cannot claim capacity until correctness settles.
  if (lane.packetId) {
    try {
      await enqueuePacketExplainer({
        lane,
        packetId: lane.packetId,
        packetTitle: lane.label || lane.branch,
        packetSummary: completionContext?.summary ?? '',
        diffSummary: diffSummary.summary,
        changedFileCount: diffSummary.changedFiles.length,
        deviationsRaw: deviations?.raw ?? null,
        reviewContext: mechanicalChecks.summary || '',
      });
    } catch (error) {
      console.warn(`[auto-review] Failed to enqueue explainer for lane ${lane.id}:`, error);
    }
  }

  if (reviewRisk.tier !== 'high') {
    console.log(`[auto-review] Review complete for lane ${lane.id}`);
    return { kind: 'reviewed' };
  }

  const pendingSecondPass = await findPendingSecondPassApproval(lane);
  if (!pendingSecondPass) {
    console.log(`[auto-review] High-risk lane ${lane.id} has no current-head approval awaiting second pass`);
    console.log(`[auto-review] Review complete for lane ${lane.id}`);
    return { kind: 'reviewed' };
  }

  const blindPrompt = buildBlindSecondPassPrompt(
    lane,
    diffSummary,
    reviewRisk.reasons,
    taskContract,
    enforceCoverage,
  );
  const secondPassThreadId = `thoughts-second-pass-${lane.id}-${randomUUID().slice(0, 8)}`;
  let secondPassText = '';
  const secondPassErrors: string[] = [];

  console.log(`[auto-review] Sending blind second-pass review for lane ${lane.id}`);
  const secondPassTurn = await runReviewerTurnWithQuotaFallback({
    laneId: lane.id,
    repoPath: lane.repoPath,
    threadId: secondPassThreadId,
    sessionThreadId: reviewerSessionThreadId(reviewerSlot, 'blind'),
    surface: 'merge-gate-review',
    expectedHeadSha: pendingSecondPass.reviewedHeadSha,
    prompt: blindPrompt,
    onEvent: (turnBackend, event) => {
      if (event.type === 'text') {
        console.log(`[auto-review] ${turnBackend.label} second-pass: ${event.text.slice(0, 100)}`);
      } else if (event.type === 'tool_use') {
        console.log(`[auto-review] ${turnBackend.label} second-pass called tool: ${event.name}`);
      } else if (event.type === 'error') {
        console.error(`[auto-review] ${turnBackend.label} second-pass error: ${event.error}`);
      }
    },
  });
  if (secondPassTurn.unavailableReason === 'session_busy') {
    return deferred('Blind second-pass reviewer session busy');
  }
  secondPassText = secondPassTurn.text;
  secondPassErrors.push(...secondPassTurn.errors);

  const [{ normalizeHeadSha, readHeadSha }, { createApproval, markSecondPassAgreed }] = await Promise.all([
    import('@/lib/lane/head-sha-lock'),
    import('@/lib/approvals/store'),
  ]);
  let currentHeadSha: string | undefined;
  try {
    currentHeadSha = normalizeHeadSha(await readHeadSha(lane.worktreePath || lane.repoPath, lane.repoPath));
  } catch (error) {
    console.warn(`[auto-review] Failed to re-read HEAD after second pass for lane ${lane.id}:`, error);
    return { kind: 'reviewed' };
  }
  if (currentHeadSha !== pendingSecondPass.reviewedHeadSha) {
    console.warn(`[auto-review] Second pass refused to stamp lane ${lane.id}: HEAD moved from ${pendingSecondPass.reviewedHeadSha} to ${currentHeadSha ?? '(unknown)'}`);
    return { kind: 'reviewed' };
  }

  const verdict = secondPassErrors.length > 0
    ? { verdict: 'inconclusive' as const, reason: `turn error: ${secondPassErrors.join('; ').slice(0, 500)}` }
    : parseSecondPassVerdict(secondPassText);

  if (verdict.verdict === 'agree') {
    // Agreement and dispatch are ONE recorded transition (#1856). The attempt
    // event lands before the dispatch, so a merge that never happens leaves a
    // reason behind instead of parking the lane in a live-looking state.
    markSecondPassAgreed(pendingSecondPass.approval.id);
    await dispatchSecondPassMerge({
      lane,
      approvalId: pendingSecondPass.approval.id,
      reviewedHeadSha: pendingSecondPass.reviewedHeadSha,
      trigger: 'second_pass_agreed',
    });
    console.log(`[auto-review] Review complete for lane ${lane.id}`);
    return { kind: 'reviewed' };
  }

  const finding = verdict.verdict === 'disagree' ? verdict.finding : verdict.reason;
  createApproval({
    projectId: lane.projectId,
    source: 'runtime',
    runtime: lane.runtime,
    agent: lane.label || lane.branch,
    sessionKey: lane.sessionKey || `lane:${lane.id}`,
    title: verdict.verdict === 'disagree' ? 'Second-pass reviewer disagreed' : 'Second-pass reviewer inconclusive',
    description: `Blind second-pass review did not agree at HEAD ${pendingSecondPass.reviewedHeadSha}. Merge remains blocked until an operator reviews the finding.`,
    summary: finding,
    toolName: 'orchestrator_second_pass',
    args: {
      approvalId: pendingSecondPass.approval.id,
      laneId: lane.id,
      packetId: lane.packetId,
      reviewedHeadSha: pendingSecondPass.reviewedHeadSha,
      verdict: verdict.verdict,
      finding,
    },
    editable: false,
    risk: 'high',
    metadata: {
      Lane: lane.id,
      Branch: lane.branch,
      Base: lane.baseBranch,
      Runtime: lane.runtime,
      ...(lane.packetId ? { Packet: lane.packetId } : {}),
      'Reviewed HEAD': pendingSecondPass.reviewedHeadSha,
    },
  });
  console.warn(`[auto-review] Second pass blocked lane ${lane.id}: ${finding}`);
  console.log(`[auto-review] Review complete for lane ${lane.id}`);
  return { kind: 'reviewed' };
}
