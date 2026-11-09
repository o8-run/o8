/**
 * Silent-exit detector.
 *
 * #613 — codex / claude-code sessions occasionally die between
 * "typecheck done" and "git commit" without ever emitting the
 * completion-reported event that normally triggers
 * `autoCommitCompletionWorktree()` in ws-server.ts.
 *
 * Without this detector, a lane can sit in `running` or `reviewing`
 * forever with 3 uncommitted files in the worktree and no way for the
 * supervisor to know the agent is gone.
 *
 * Every 30s this module:
 *   1. Loads active lanes (status in `running`, `reviewing`, `awaiting_input`).
 *   2. For each lane with an attached session key, asks the owning runtime
 *      whether the underlying process / tmux session is still alive.
 *   3. If the session is gone AND the lane hasn't seen an event in 60s
 *      AND we haven't already processed the silent exit (idempotency via
 *      `lastEventLabel` prefix `silent_exit_`):
 *        a. Read `git status --porcelain` + commit count vs baseBranch.
 *        b. Dirty worktree → `autoCommitCompletionWorktree()` + `runCompletionVerification()`.
 *        c. Verification passes → mark lane `reviewing`, enqueue
 *           `silent_exit_but_work_present` (informational).
 *        d. Verification fails → mark lane `awaiting_input`, enqueue
 *           `silent_exit_verification_failed` (human review).
 *        e. Clean read-only packet + zero commits → settle its latest finding
 *           receipt, then complete it or hold it for missing evidence.
 *        f. Other clean worktree + zero commits → mark lane `awaiting_input`,
 *           enqueue `silent_exit_no_work` (agent spawned but never built anything).
 *        g. Clean worktree + has commits → mark lane `reviewing`, enqueue
 *           `silent_exit_but_work_present` (lower priority — work exists).
 *
 * The detector is idempotent: once a silent_exit_* label sits on the lane,
 * subsequent ticks skip it. The lane status transition to `reviewing` /
 * `awaiting_input` also removes it from this detector's active-lane filter
 * anyway, but the label guard is belt-and-suspenders.
 */

import { createCompletionTurnGuard } from './completion-turn';
import { completionHandoffTurnCheck } from '@/lib/orchestrator/completion-handoff';
import { acceptSilentExitCompletion } from './silent-exit-completion';
import { execFile } from '@/lib/providers/child-process';
import { promisify } from 'node:util';

import {
  getLane,
  getLaneEvents,
  listActiveLanes,
  setLaneStatus,
} from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import {
  CODEX_AUTH_RECOVERY_LANE_LABEL,
  findCurrentAuthExit,
} from '@/lib/lane/current-auth-exit';
import { probeLaneSessionAlive } from '@/lib/lane/owned-session-liveness';
import { commitCrashedWorkerWork } from '@/lib/lane/salvage';
import { archiveDeadLanes } from '@/lib/lane/dead-lane-archiver';
import { runCompletionVerification } from '@/lib/supervisor/completion-verification';
import { resolvePacketDiffBase } from '@/lib/diff/base-resolution';
import {
  enqueueSupervisorInboxItem,
  type SupervisorInboxKind,
  type SupervisorInboxPayload,
} from '@/lib/supervisor/heal-bot';

// Re-exported so callers/tests keep importing the dead-label policy from the
// detector surface; the canonical definition now lives in the unified archiver
// (src/lib/lane/dead-lane-archiver.ts).
export { DEAD_LANE_EVENT_LABELS } from '@/lib/lane/dead-lane-archiver';

const execFileAsync = promisify(execFile);

const SILENT_EXIT_TICK_MS = 30_000;
const LANE_INACTIVITY_GRACE_MS = 300_000;
// #1293 — short grace before we PROBE a lane's session. The long grace above
// only matters when liveness is UNCERTAIN (don't yank a possibly-still-thinking
// agent). A DEFINITIVELY-dead owned session (process gone) should be salvaged as
// soon as it's been quiet briefly — otherwise a committed silent-exit sits
// `running` for 5 minutes. This also removes the salvage asymmetry: a candidate
// that committed its work emits more-recent lane events than one that didn't, so
// under a single long grace the committed one crossed the threshold much later.
const SILENT_EXIT_DEAD_GRACE_MS = 45_000;
const GIT_COMMAND_TIMEOUT_MS = 15_000;
const GIT_COMMAND_MAX_BUFFER = 10 * 1024 * 1024;

// Pipeline root fix (2026-07-03): `reviewing` is NOT interesting to this
// detector. A lane in `reviewing` has finished its work — its worker process
// being dead is the NORMAL state, not a silent exit. Probing reviewing lanes
// made this detector re-triage clean `agent_completed` completions ~60s later
// and overwrite them with `silent_exit_work_present`, which fed the terminal
// archiver and buried review-ready work (observed live, wave-1B). Silent-exit
// detection is for lanes whose process death is UNEXPECTED: running work and
// input waits only.
export const INTERESTING_LANE_STATUSES = new Set<Lane['status']>([
  'running',
  'awaiting_input',
]);

const SILENT_EXIT_EVENT_PREFIX = 'silent_exit_';
// The owned-session liveness probe (`probeLaneSessionAlive`) + its owned/codex-
// continuity internals now live in the shared `@/lib/lane/owned-session-liveness`
// module, used by both this detector and the lane zombie reaper — one policy, one
// place. See `probeSessionAlive` below for the thin delegation.

let detectorTimer: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

interface WorktreeState {
  hasUncommittedWork: boolean;
  porcelain: string;
  commitsAhead: number;
  diffStat: string;
  lastCommit: string;
}

type MergedWorkCheck = { alreadyMerged: boolean; headSha: string | null; comparisonRef: string | null; warning: string | null };

/**
 * Per-runtime liveness verdict — now the shared `probeLaneSessionAlive`
 * (owned/codex-continuity/claude-cwd logic lives in
 * `@/lib/lane/owned-session-liveness`, single-sourced with the reaper). Returns
 * true when confident the session is alive, false when clearly gone, and
 * `undefined` when we cannot tell (the detector conservatively bails out then).
 */
const probeSessionAlive = probeLaneSessionAlive;

async function readCommitCount(cwd: string, baseBranch: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-list', '--count', `${baseBranch}..HEAD`],
      { windowsHide: true, cwd, timeout: GIT_COMMAND_TIMEOUT_MS, maxBuffer: GIT_COMMAND_MAX_BUFFER },
    );
    const parsed = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

async function readPorcelain(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain'],
      { windowsHide: true, cwd, timeout: GIT_COMMAND_TIMEOUT_MS, maxBuffer: GIT_COMMAND_MAX_BUFFER },
    );
    return stdout.trim();
  } catch {
    return '';
  }
}

async function readDiffStat(cwd: string, baseBranch: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['diff', '--stat', `${baseBranch}...HEAD`],
      { windowsHide: true, cwd, timeout: GIT_COMMAND_TIMEOUT_MS, maxBuffer: GIT_COMMAND_MAX_BUFFER },
    );
    return stdout.trim() || 'No diff stat available.';
  } catch {
    return 'No diff stat available.';
  }
}

async function readLastCommit(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['log', '-1', '--format=%H %s'],
      { windowsHide: true, cwd, timeout: GIT_COMMAND_TIMEOUT_MS, maxBuffer: GIT_COMMAND_MAX_BUFFER },
    );
    return stdout.trim() || 'No commits yet.';
  } catch {
    return 'Unavailable.';
  }
}

async function readLastCommitSubject(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['log', '-1', '--format=%s'],
      { windowsHide: true, cwd, timeout: GIT_COMMAND_TIMEOUT_MS, maxBuffer: GIT_COMMAND_MAX_BUFFER },
    );
    return stdout.trim();
  } catch {
    return '';
  }
}

async function readHeadSha(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', 'HEAD'],
      { windowsHide: true, cwd, timeout: GIT_COMMAND_TIMEOUT_MS, maxBuffer: GIT_COMMAND_MAX_BUFFER },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function isAncestor(cwd: string, ancestor: string, ref: string): Promise<boolean> {
  try {
    await execFileAsync(
      'git',
      ['merge-base', '--is-ancestor', ancestor, ref],
      { windowsHide: true, cwd, timeout: GIT_COMMAND_TIMEOUT_MS, maxBuffer: GIT_COMMAND_MAX_BUFFER },
    );
    return true;
  } catch {
    return false;
  }
}

async function checkAlreadyMergedWork(cwd: string, baseBranch: string): Promise<MergedWorkCheck> {
  const headSha = await readHeadSha(cwd);
  if (!headSha) {
    return {
      alreadyMerged: false,
      headSha: null,
      comparisonRef: null,
      warning: 'Could not resolve worktree HEAD before silent-exit merge ancestry check.',
    };
  }

  try {
    const base = await resolvePacketDiffBase(cwd, baseBranch, headSha);
    if (base.usedFallback) {
      return {
        alreadyMerged: false,
        headSha,
        comparisonRef: base.comparisonRef,
        warning: base.warning ?? `Could not refresh ${base.requestedRef}; promoted using local ${base.comparisonRef}.`,
      };
    }
    return {
      alreadyMerged: await isAncestor(cwd, headSha, base.comparisonRef),
      headSha,
      comparisonRef: base.comparisonRef,
      warning: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      alreadyMerged: false,
      headSha,
      comparisonRef: null,
      warning: `Silent-exit merge ancestry check failed: ${message}`,
    };
  }
}

async function collectWorktreeState(cwd: string, baseBranch: string): Promise<WorktreeState> {
  const [porcelain, commitsAhead, diffStat, lastCommit] = await Promise.all([
    readPorcelain(cwd),
    readCommitCount(cwd, baseBranch),
    readDiffStat(cwd, baseBranch),
    readLastCommit(cwd),
  ]);
  return {
    porcelain,
    hasUncommittedWork: porcelain.length > 0,
    commitsAhead,
    diffStat,
    lastCommit,
  };
}

function buildInboxPayload(
  lane: Lane,
  state: WorktreeState,
  note: string,
  error?: string,
): SupervisorInboxPayload {
  return {
    laneId: lane.id,
    worktreePath: lane.worktreePath ?? lane.repoPath,
    sessionKey: lane.sessionKey ?? null,
    surfaceId: lane.sessionKey ?? null,
    baseBranch: lane.baseBranch,
    packetTitle: lane.label,
    packetReferenceLabel: null,
    verificationKind: null,
    attempts: null,
    error: error ?? note,
    diffStat: state.diffStat,
    lastCommit: state.lastCommit,
    transcriptTail: 'Session exited silently — no transcript tail available.',
    note,
    retryError: null,
  };
}

function appendAncestryWarning(
  payload: SupervisorInboxPayload,
  check: MergedWorkCheck,
): SupervisorInboxPayload {
  if (!check.warning) return payload;
  const nextPayload = { ...payload };
  const fields = nextPayload as SupervisorInboxPayload & Record<string, unknown>;
  fields.silentExitBaseWarning = check.warning;
  fields.comparisonRef = check.comparisonRef;
  fields.headSha = check.headSha;
  return nextPayload;
}

async function markAlreadyMergedWork(lane: Lane, check: MergedWorkCheck, guard: ReturnType<typeof createCompletionTurnGuard>): Promise<void> {
  await acceptSilentExitCompletion(lane, await guard.wait(() => readLastCommitSubject(lane.worktreePath || lane.repoPath)),
    'completed', 'silent_exit_already_merged', guard, check.headSha);
  const { appendEvent } = await import('@/lib/lane/registry');
  appendEvent(lane.id, 'silent_exit_already_merged', 'system', {
    headSha: check.headSha,
    comparisonRef: check.comparisonRef,
  });
}

function enqueueSilentExitInbox(
  lane: Lane,
  kind: SupervisorInboxKind,
  payload: SupervisorInboxPayload,
): void {
  const inboxId = enqueueSupervisorInboxItem({
    repoPath: lane.repoPath,
    packetId: lane.packetId ?? null,
    kind,
    payload,
  });
  console.log(`[silent-exit] Enqueued inbox item ${inboxId} for lane ${lane.id} (${kind})`);
}

/**
 * #1500 — a verification-failed silent exit must leave a learning behind, or
 * every respawn goes out with the identical brief and trips the identical
 * wall. Persists the violation output as a packet-keyed attempt learning
 * (readable by buildPacketPrompt regardless of worktree churn) and bumps the
 * packet's attemptCount under lock so these failures spend the same bounded
 * retry budget the ralph loop enforces — five blind identical retries can no
 * longer be free.
 */
async function recordVerificationFailureLearning(
  lane: Lane,
  cwd: string,
  verification: { kind: string; output: string },
): Promise<void> {
  const packetId = lane.packetId?.trim() ?? '';
  try {
    const { buildAttemptLearningFromFailure, persistAttemptLearnings } = await import('@/lib/orchestrator/attempt-log');
    let attemptNumber = 1;
    if (packetId) {
      const { withLockedState } = await import('@/lib/orchestrator/control-plane');
      await withLockedState((state) => {
        const packet = state.packets.find((candidate) => candidate.id === packetId);
        if (!packet) return;
        packet.attemptCount = (packet.attemptCount ?? 0) + 1;
        attemptNumber = packet.attemptCount;
      });
    }
    await persistAttemptLearnings(
      cwd,
      packetId,
      attemptNumber,
      buildAttemptLearningFromFailure(verification.output),
    );
  } catch (error) {
    console.warn(`[silent-exit] Failed to record verification-failure learning for lane ${lane.id}:`, error);
  }
}

/**
 * Triage a single lane whose session has gone away silently. Returns true
 * when we took any action so the caller can log the outcome.
 */
async function triageSilentExit(lane: Lane): Promise<boolean> {
  const guard = createCompletionTurnGuard(lane, { checkCurrent: completionHandoffTurnCheck(lane).check });
  if (findCurrentAuthExit(lane, getLaneEvents(lane.id, 200))) {
    if (lane.status !== 'awaiting_input' || lane.lastEventLabel !== CODEX_AUTH_RECOVERY_LANE_LABEL) {
      setLaneStatus(lane.id, 'awaiting_input', 'system', CODEX_AUTH_RECOVERY_LANE_LABEL);
    }
    return true;
  }
  const cwd = lane.worktreePath?.trim() || lane.repoPath;
  if (!cwd) {
    console.warn(`[silent-exit] Lane ${lane.id} has no worktree path — skipping triage.`);
    return false;
  }

  const state = await collectWorktreeState(cwd, lane.baseBranch);

  if (state.hasUncommittedWork) {
    try {
      const committed = await commitCrashedWorkerWork(cwd, lane.repoPath, lane.label, lane.branch);
      if (committed) {
        console.log(`[silent-exit] Auto-committed salvaged work in ${cwd} for lane ${lane.id}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[silent-exit] Auto-commit failed for lane ${lane.id}: ${message}`);
      setLaneStatus(lane.id, 'awaiting_input', 'system', 'silent_exit_autocommit_failed');
      enqueueSilentExitInbox(
        lane,
        'silent_exit_verification_failed',
        buildInboxPayload(
          lane,
          state,
          'Session exited silently with dirty worktree. Auto-commit attempt failed; operator triage required.',
          `autoCommitCompletionWorktree failed: ${message}`,
        ),
      );
      return true;
    }

    const verification = await runCompletionVerification(cwd, lane.baseBranch, lane.repoPath);
    if (!verification.ok) {
      console.warn(
        `[silent-exit] Lane ${lane.id} post-silent-exit ${verification.kind} failed`,
      );
      await recordVerificationFailureLearning(lane, cwd, verification);
      setLaneStatus(lane.id, 'awaiting_input', 'system', 'silent_exit_verification_failed');
      const postState = await collectWorktreeState(cwd, lane.baseBranch);
      enqueueSilentExitInbox(
        lane,
        'silent_exit_verification_failed',
        buildInboxPayload(
          lane,
          postState,
          `Session exited silently. Work was auto-committed but post-completion ${verification.kind} failed — operator triage required.`,
          verification.output || 'Verification reported a failure with no output.',
        ),
      );
      return true;
    }

    const postState = await collectWorktreeState(cwd, lane.baseBranch);
    const mergedCheck = await checkAlreadyMergedWork(cwd, lane.baseBranch);
    if (mergedCheck.alreadyMerged) {
      await markAlreadyMergedWork(lane, mergedCheck, guard);
      return true;
    }

    await acceptSilentExitCompletion(lane, await guard.wait(() => readLastCommitSubject(cwd)),
      'reviewing', 'silent_exit_work_present', guard);
    enqueueSilentExitInbox(
      lane,
      'silent_exit_but_work_present',
      appendAncestryWarning(
        buildInboxPayload(
          lane,
          postState,
          'Session exited silently before reporting completion, but work was salvaged and typecheck + rule-check passed. Lane moved to reviewing.',
        ),
        mergedCheck,
      ),
    );
    return true;
  }

  // Clean worktree branch.
  if (state.commitsAhead === 0) {
    const {
      captureSettledReadOnlyCompletionContext,
      completeReadOnlyZeroDiffLane,
      isReadOnlyPacketLane,
    } = await import('@/lib/orchestrator/read-only-completion');
    if (isReadOnlyPacketLane(lane)) {
      const packetId = lane.packetId!.trim();
      let context = null;
      if (lane.sessionKey) {
        try {
          const { capturePacketCompletionContext } = await import('@/lib/orchestrator/context-relay');
          context = await captureSettledReadOnlyCompletionContext(
            () => guard.wait(() => capturePacketCompletionContext(packetId, lane.sessionKey!)),
          );
        } catch (error) {
          console.error(`[silent-exit] Failed to capture read-only completion context for packet ${packetId}:`, error);
        }
      }
      guard.check();
      const completion = await completeReadOnlyZeroDiffLane(lane, context);
      if (completion.completed || completion.blocked) return true;
      return false;
    }
    const { parkHuddleReadyZeroDiffLane } = await import('@/lib/orchestrator/huddle-zero-diff');
    const huddlePark = await parkHuddleReadyZeroDiffLane(lane);
    if (huddlePark.parked) {
      console.log(`[silent-exit] Lane ${lane.id} completed its huddle turn with no changes; parked for orchestrator.`);
      return true;
    }
    if (huddlePark.operatorBlocked) {
      console.log(`[silent-exit] Lane ${lane.id} already carries operator blocker ${huddlePark.lane?.lastEventLabel ?? 'worker_blocked'}; preserving it.`);
      return true;
    }
    setLaneStatus(lane.id, 'awaiting_input', 'system', 'silent_exit_no_work');
    enqueueSilentExitInbox(
      lane,
      'silent_exit_no_work',
      buildInboxPayload(
        lane,
        state,
        'Session exited silently with zero commits ahead of the base branch. No work was produced — agent likely failed before editing any files.',
      ),
    );
    return true;
  }

  // Clean worktree, has commits — normal completion never fired, but the
  // work is safely in the branch. Promote to review so the orchestrator
  // loop can pick it up.
  const mergedCheck = await checkAlreadyMergedWork(cwd, lane.baseBranch);
  if (mergedCheck.alreadyMerged) {
    await markAlreadyMergedWork(lane, mergedCheck, guard);
    return true;
  }

  await acceptSilentExitCompletion(lane, await guard.wait(() => readLastCommitSubject(cwd)),
    'reviewing', 'silent_exit_work_present', guard);
  enqueueSilentExitInbox(
    lane,
    'silent_exit_but_work_present',
    appendAncestryWarning(
      buildInboxPayload(
        lane,
        state,
        `Session exited silently, but ${state.commitsAhead} commit(s) are already pushed to the lane branch. Promoted to reviewing.`,
      ),
      mergedCheck,
    ),
  );
  return true;
}

// The terminally-dead-lane archiver moved to the unified, policy-table-driven
// `archiveDeadLanes` (src/lib/lane/dead-lane-archiver.ts) — one archiver shared
// with the reaper. The dead-label policy (`DEAD_LANE_EVENT_LABELS`) is re-exported
// from this module's top for callers/tests that still import it here.

async function silentExitTick(): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    const now = Date.now();
    // Cloud jobs have no local process or in-progress checkout. Their durable
    // queue owns lease recovery and completion; local salvage cannot judge them.
    const lanes = listActiveLanes().filter((lane) => lane.runtime !== 'cloud' && INTERESTING_LANE_STATUSES.has(lane.status));

    for (const lane of lanes) {
      if (!lane.sessionKey) continue;
      if (lane.lastEventLabel?.startsWith(SILENT_EXIT_EVENT_PREFIX)) continue;

      const lastEventMs = lane.lastEventAt ? new Date(lane.lastEventAt).getTime() : 0;
      const inactiveMs = Number.isFinite(lastEventMs) ? now - lastEventMs : 0;
      // Short grace before probing so a dead session doesn't sit for the full
      // 5-min window. The probe below gives the real verdict.
      if (inactiveMs < SILENT_EXIT_DEAD_GRACE_MS) {
        continue;
      }

      const alive = await probeSessionAlive(lane);
      if (alive === true) continue; // still alive — leave it
      // alive === undefined means we can't tell (e.g. a discovered/operator
      // session); keep the conservative long grace before acting. alive === false
      // is a definitively-dead owned session — salvage now.
      if (alive === undefined && inactiveMs < LANE_INACTIVITY_GRACE_MS) continue;

      // Re-read lane state to guard against concurrent updates between the
      // initial listActiveLanes() and our decision to act. If someone else
      // (heal-bot, supervisor) advanced the lane while we were probing, we
      // bail out rather than stomp their work.
      const refreshed = getLane(lane.id);
      if (!refreshed) continue;
      if (refreshed.runtime === 'cloud') continue;
      if (!INTERESTING_LANE_STATUSES.has(refreshed.status)) continue;
      if (refreshed.lastEventLabel?.startsWith(SILENT_EXIT_EVENT_PREFIX)) continue;

      try {
        await triageSilentExit(refreshed);
      } catch (error) {
        console.error(`[silent-exit] Triage failed for lane ${refreshed.id}:`, error);
      }
    }

    // #23 — sweep lanes already declared dead + stale into 'archived' so they
    // don't sit orange forever when their work landed out-of-band. Silent-exit is
    // the fast 30s first responder; it runs the ARCHIVE half of the shared policy
    // (the reaper owns the wedge-then-archive sweep on its 5-min backstop).
    await archiveDeadLanes(now);
  } finally {
    tickInFlight = false;
  }
}

export function isSilentExitDetectorEnabled(): boolean {
  const raw = process.env.O8_SILENT_EXIT_DETECTOR_ENABLED;
  if (raw === undefined || raw === null) return true;
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return true;
  return !(normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'no');
}

export function startSilentExitDetector(): () => void {
  if (detectorTimer) {
    return () => {
      if (detectorTimer) {
        clearInterval(detectorTimer);
        detectorTimer = null;
      }
    };
  }

  detectorTimer = setInterval(() => {
    void silentExitTick().catch((error) => {
      console.error('[silent-exit] Tick failed:', error);
    });
  }, SILENT_EXIT_TICK_MS);
  if (detectorTimer.unref) detectorTimer.unref();

  console.log(`[silent-exit] Detector started (${SILENT_EXIT_TICK_MS}ms interval)`);

  // Fire-and-forget initial tick so we don't wait a full interval on boot.
  void silentExitTick().catch((error) => {
    console.error('[silent-exit] Initial tick failed:', error);
  });

  return () => {
    if (!detectorTimer) return;
    clearInterval(detectorTimer);
    detectorTimer = null;
    console.log('[silent-exit] Detector stopped');
  };
}

/**
 * Exposed for unit-like scripts (scripts/silent-exit-smoke.ts).
 * Runs a single triage pass for the given lane directly and returns whether
 * we took action. Call paths other than the recurring detector should
 * prefer this to avoid racing with `detectorTimer`.
 */
export async function runSilentExitTriageForLane(laneId: string): Promise<boolean> {
  const lane = getLane(laneId);
  if (!lane) return false;
  return triageSilentExit(lane);
}

/**
 * Testing hook — exposes the internal tick so scripts can exercise the full
 * detection path (including the grace / liveness gates) without running the
 * timer loop.
 */
export async function runSilentExitTickForTesting(): Promise<void> {
  await silentExitTick();
}
