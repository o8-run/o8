import { EffortPinRejectionError, resolveEffortPin } from '@/lib/orchestrator/effort-pin';
import { ensureMcpConfig } from './claude-orchestrator-mcp-config';
import { orchestratorProcessPolicyCurrent, withOrchestratorPromptPolicy, sessions, getWarmState, clearIdleTimer, killOrchestratorProc, reapIdleForCapacity, settleOrchestratorTurn, handleClaudeJsonLine, spawnOrchestratorProc } from './orchestrator-resident-process';
export { getWarmState, attachOrchestratorProcHandlers } from './orchestrator-resident-process';
/**
 * Resident Claude Code stream-json orchestrator. Each o8 chat owns one process,
 * Claude session, and carrier config directory; only stateless transport/auth is
 * shared. The process is warm across turns and resumes its Claude session after
 * config-driven recycling. Native, OpenRouter, and Codex-subscription carriers
 * all use this full interactive harness path; `-p` remains forbidden.
 */

import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listActiveLanesWithSessions } from '@/lib/lane/registry';
import {
  readOrchestratorBackendSessionId,
  writeOrchestratorBackendSessionId,
} from '@/lib/mobile/orchestrator-thread-history';
import {
  createToolCallTracker,
  type OrchestratorEvent,
} from '@/lib/lane/orchestrator-stream-events';
import { type ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { getRuntime, type RuntimeSession } from '@/lib/runtimes';
import { buildToolRegistry } from '@/lib/mcp/tool-spine/build';
import { toClaudeJson } from '@/lib/mcp/tool-spine/emit-claude';
import type { ToolProfile } from '@/lib/mcp/tool-spine/registry';
import { DEFAULT_CLAUDE_ORCHESTRATOR_MODEL, resolveClaudeOrchestratorModel } from './orchestrator-model-guard';
import { assertOrchestratorRepoPath } from '@/lib/lane/repo-preflight';
import { buildOrchestratorSystemPrompt } from '@/lib/lane/orchestrator-system-prompt';
import { fingerprintMcpConfig } from '@/lib/lane/orchestrator-mcp-fingerprint';
import { claudeModelSupportsFast, type OrchestratorServiceTier } from '@/lib/orchestrator/service-tier';
import { procConfigMatches, firstProcConfigDivergence } from './orchestrator-session-state';
import type {
  OrchestratorActiveTurn,
  OrchestratorProcConfig,
} from './orchestrator-session-state';
export { detectPermissionRequest } from './orchestrator-session-predicates';
import {
  orchestratorPromptFingerprint,
  withCurrentOrchestratorPrompt,
} from '@/lib/lane/orchestrator-prompt-ledger';
import {
  launchesWorker,
  runTurnWithFalseDispatchRetry,
  type FalseDispatchAttemptResult,
} from '@/lib/lane/orchestrator-false-dispatch';
import {
  consumeResetSignal,
  ensureRegisteredSession,
  getRegisteredSession,
  normalizeRepoPath,
  normalizeThoughtsThreadId,
  orchestratorDataDir,
  PREEMPT_SETTLE_MS,
  PROCESS_TIMEOUT_MS,
  requestRegisteredSessionReset,
  sessionNameForRepo,
  waitForSessionIdle,
  writeResetSignal,
} from './orchestrator-session-core';
import {
  crashSurvivableOrchestratorEnabled,
  createOrchestratorTurnRecordForFiles,
  fileSize,
  isPidAlive,
  isRehydratedTurnAlive,
  listActiveOrchestratorTurns,
  readJsonlLines,
  tailJsonlFile,
  type OrchestratorCrashSurvivalMeta,
  type OrchestratorTurnRecord,
} from './orchestrator-crash-survival';
import {
  nativeClaudeHarnessCarrier,
  resolveClaudeHarnessCarrier,
  type ClaudeHarnessCarrier,
} from './claude-harness-carrier';
// ── Types ──
export interface OrchestratorSession {
  sessionName: string;
  repoPath: string;
  /** UI/history thread id (thoughts-*), when this session belongs to a persisted chat. */
  threadId: string | null;
  /** Claude Code session ID for --resume continuity */
  claudeSessionId: string | null;
  status: 'ready' | 'busy' | 'dead';
  /** Currently-running child process (null when idle) */
  proc: ChildProcess | null;
  createdAt: number;
}

// ── Constants ──

const ORCHESTRATOR_STATE_DIR = orchestratorDataDir('orchestrator');


const LOG_PREFIX = '[orchestrator-rehydrate]';
/**
 * #457 — Kill the claude process if it doesn't finish within this window.
 *
 * Set to 8 minutes (was 90s). Review turns on Opus 4.7 that read multiple
 * agent transcripts, diff worktrees, run typecheck, and write a VERDICT block
 * legitimately take 3-5 minutes. The old 90s budget SIGKILLed review turns
 * mid-stream, which is what produced the "narrate-and-exit" failure mode —
 * the model would narrate a plan, start running tools, and get killed before
 * it could emit the final summary. Bumping this is the root fix.
 */
// Bumped 480_000 → 1_800_000 (8min → 30min) on 2026-05-23 after Opus 4.7
// hit the wall mid-investigation on #1113 — 83 tool calls deep into the
// tile-system exploration when the kill fired. The narrate-and-exit failure
// mode noted above is now mostly closed at this budget; architectural work
// fits comfortably.
//
// Bumped 1_800_000 → 14_400_000 (30min → 4hr) on 2026-06-17 — the 30min
// watchdog was SIGKILLing legitimate long turns where the orchestrator does
// deep direct work (a single turn doing an 11-file execFileSync hardening
// sweep blew past 30min and got killed mid-stream). This is a HANG watchdog,
// not a work budget: it clears the instant a turn closes normally (see the
// clearTimeout in the 'close'/'error' handlers), so a turn still alive at 4hr
// is wedged, not productive. The operator actively watches turns and can
// interrupt manually — this only reaps unattended hangs.

/**
 * Steer-Now / preempt settle window. A follow-up send fired while a turn is
 * still in flight (Steer-Now, or the steer-queue auto-fire) arrives ~immediately
 * after the interrupt SIGTERMs the prior subprocess — but `session.status` only
 * leaves 'busy' when `proc.on('close')` fires (~1-2s later, SIGKILL fallback at
 * 2s). Waiting that window out lets the dying turn settle so the new message is
 * accepted instead of being dropped with a hard "busy" rejection.
 */
let startupRehydrationPromise: Promise<void> | null = null;
let startupRehydrationComplete = false;
function writeOrchestratorResetSignal(repoPath: string, threadId?: string | null): void {
  writeResetSignal(ORCHESTRATOR_STATE_DIR, repoPath, threadId);
}

function consumeOrchestratorResetSignal(repoPath: string, threadId?: string | null): boolean {
  return consumeResetSignal(ORCHESTRATOR_STATE_DIR, repoPath, threadId);
}

function extractClaudeSessionId(sessionKey: string): string | null {
  return sessionKey.startsWith('claude-code:')
    ? sessionKey.slice('claude-code:'.length) || null
    : null;
}

function compareRehydrationCandidates(left: RuntimeSession, right: RuntimeSession) {
  const rank = (session: RuntimeSession) => {
    if (session.status === 'idle') return 0;
    if (session.status === 'reviewing') return 1;
    if (session.status === 'waiting') return 2;
    if (session.status === 'running') return 3;
    return 4;
  };

  const rankDelta = rank(left) - rank(right);
  if (rankDelta !== 0) {
    return rankDelta;
  }

  return right.lastActivityAt.getTime() - left.lastActivityAt.getTime();
}

function buildRehydratedSession(repoPath: string, claudeSessionId: string, createdAt: number): OrchestratorSession {
  return {
    sessionName: orchestratorSessionName(repoPath),
    repoPath,
    threadId: null,
    claudeSessionId,
    status: 'ready',
    proc: null,
    createdAt,
  };
}

interface OrchestratorRehydrateOptions {
  onReboundEvent?: (record: OrchestratorTurnRecord, event: OrchestratorEvent) => void;
}

function rehydrateInflightClaudeTurn(record: OrchestratorTurnRecord, options: OrchestratorRehydrateOptions): boolean {
  if (record.backend !== 'claude') return false;
  const sessionName = record.sessionName || orchestratorSessionName(record.repoPath, record.threadId);
  let session = sessions.get(sessionName);
  if (!session) {
    session = {
      sessionName,
      repoPath: normalizeRepoPath(record.repoPath),
      threadId: normalizeThoughtsThreadId(record.threadId),
      claudeSessionId: readOrchestratorBackendSessionId(normalizeThoughtsThreadId(record.threadId), 'claude'),
      status: 'busy',
      proc: null,
      createdAt: record.startedAt,
    };
    sessions.set(sessionName, session);
  } else {
    session.status = 'busy';
  }

  const w = getWarmState(sessionName);
  const events: OrchestratorEvent[] = [];
  let resolved = false;
  const emit = (event: OrchestratorEvent) => {
    events.push(event);
    options.onReboundEvent?.(record, event);
  };
  const timeout = setTimeout(() => {}, PROCESS_TIMEOUT_MS);
  const turn: OrchestratorActiveTurn = {
    onEvent: emit,
    captureEvent: emit,
    resolve: () => { resolved = true; },
    reject: () => {},
    timeout,
    abortSignal: null,
    abortListener: null,
    settled: false,
    toolTracker: createToolCallTracker(),
    turnSessionId: session.claudeSessionId,
    cost: null,
    lastAssistantText: '',
    sawToolUseAfterText: false,
    launchAgentCallCount: 0,
    crashRecord: record,
    stopCrashTail: null,
    promptFingerprint: null,
  };
  turn.captureEvent = (event) => {
    emit(event);
    if (event.type === 'text') turn.lastAssistantText += event.text;
  };
  w.activeTurn = turn;

  const replay = readJsonlLines(record.stdoutPath, record.stdoutOffset ?? 0).lines;
  for (const line of replay) {
    if (!handleClaudeJsonLine(session, w, line)) break;
  }

  if (resolved || turn.settled) {
    return true;
  }

  if (!isRehydratedTurnAlive(record, PROCESS_TIMEOUT_MS)) {
    settleOrchestratorTurn(session, w, null);
    return true;
  }

  turn.stopCrashTail = tailJsonlFile({
    filePath: record.stdoutPath,
    fromOffset: fileSize(record.stdoutPath),
    alive: () => isRehydratedTurnAlive(record, PROCESS_TIMEOUT_MS) && !turn.settled,
    onLine: (line) => handleClaudeJsonLine(session!, w, line),
    onEnd: () => {
      if (!turn.settled) settleOrchestratorTurn(session!, w, null);
    },
  });
  console.log(`${LOG_PREFIX} Re-bound in-flight Claude orchestrator turn ${record.id} pid=${record.pid}`);
  return true;
}

export async function rehydrateOrchestratorSessions(options: OrchestratorRehydrateOptions = {}): Promise<void> {
  if (startupRehydrationComplete) {
    return;
  }
  if (startupRehydrationPromise) {
    return startupRehydrationPromise;
  }

  startupRehydrationPromise = (async () => {
    const activeLanes = listActiveLanesWithSessions();
    let reboundInflightTurns = 0;
    for (const record of listActiveOrchestratorTurns()) {
      try {
        if (rehydrateInflightClaudeTurn(record, options)) reboundInflightTurns += 1;
      } catch (error) {
        console.warn(`${LOG_PREFIX} Failed to rehydrate in-flight turn ${record.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (activeLanes.length === 0) {
      startupRehydrationComplete = true;
      return;
    }

    const runtimeIds = [...new Set(['claude-code', ...activeLanes.map((lane) => lane.runtime)])];
    const discoveredByRuntime = new Map<string, RuntimeSession[]>();

    for (const runtimeId of runtimeIds) {
      const runtime = getRuntime(runtimeId);
      if (!runtime?.capabilities.discover) {
        continue;
      }

      try {
        discoveredByRuntime.set(runtimeId, await runtime.discoverSessions());
      } catch (error) {
        console.warn(
          `${LOG_PREFIX} Failed to discover ${runtimeId} sessions during startup rehydration: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const liveLaneSessionKeys = new Set<string>();
    const reposNeedingRehydration = new Set<string>();

    for (const lane of activeLanes) {
      if (!lane.sessionKey) continue;
      const runtimeSessions = discoveredByRuntime.get(lane.runtime) ?? [];
      if (!runtimeSessions.some((session) => session.sessionKey === lane.sessionKey)) {
        continue;
      }

      liveLaneSessionKeys.add(lane.sessionKey);
      reposNeedingRehydration.add(normalizeRepoPath(lane.repoPath));
    }

    if (reposNeedingRehydration.size === 0) {
      startupRehydrationComplete = true;
      return;
    }

    const claudeSessions = (discoveredByRuntime.get('claude-code') ?? [])
      .filter((session) => session.status !== 'failed')
      .filter((session) => !liveLaneSessionKeys.has(session.sessionKey));

    let rehydratedCount = 0;

    for (const repoPath of reposNeedingRehydration) {
      const sessionName = orchestratorSessionName(repoPath);
      if (sessions.has(sessionName)) {
        continue;
      }

      const candidate = claudeSessions
        .filter((session) => normalizeRepoPath(session.cwd) === repoPath)
        .sort(compareRehydrationCandidates)[0];
      const claudeSessionId = candidate ? extractClaudeSessionId(candidate.sessionKey) : null;
      if (!candidate || !claudeSessionId) {
        continue;
      }

      sessions.set(
        sessionName,
        buildRehydratedSession(repoPath, claudeSessionId, candidate.lastActivityAt.getTime()),
      );
      rehydratedCount += 1;
      console.log(`${LOG_PREFIX} Rehydrated ${sessionName} from ${candidate.sessionKey}`);
    }

    console.log(
      `${LOG_PREFIX} Startup scan checked ${activeLanes.length} active lane${activeLanes.length === 1 ? '' : 's'}, restored ${rehydratedCount} orchestrator session${rehydratedCount === 1 ? '' : 's'}, re-bound ${reboundInflightTurns} in-flight turn${reboundInflightTurns === 1 ? '' : 's'}`,
    );
    startupRehydrationComplete = true;
  })()
    .finally(() => {
      startupRehydrationPromise = null;
    });

  return startupRehydrationPromise;
}

// ── Registry ──



export function orchestratorSessionName(repoPath: string, threadId?: string | null): string {
  return sessionNameForRepo('cortex-orchestrator', repoPath, threadId);
}

export function getOrchestratorSession(repoPath: string, threadId?: string | null): OrchestratorSession | null {
  void rehydrateOrchestratorSessions().catch(() => {
    // Startup rehydration is best-effort; callers can still create a fresh session.
  });
  return getRegisteredSession(sessions, orchestratorSessionName(repoPath, threadId));
}

export function requestOrchestratorSessionReset(repoPath: string, threadId?: string | null): { repoPath: string; sessionName: string; threadId: string | null } {
  const result = requestRegisteredSessionReset(sessions, {
    repoPath,
    threadId,
    sessionNameFor: orchestratorSessionName,
    resetExisting: (session, sessionName) => {
      session.claudeSessionId = null;
      // Reset = fresh conversation — recycle the resident proc (it holds the old one).
      if (session.proc) killOrchestratorProc(session, getWarmState(sessionName));
    },
    resetPersistedThread: (normalizedThreadId) => writeOrchestratorBackendSessionId(normalizedThreadId, 'claude', null),
  });
  writeOrchestratorResetSignal(result.repoPath, result.threadId);
  return result;
}

/**
 * Request a graceful orchestrator reload. Unlike `requestOrchestratorSessionReset`,
 * this PRESERVES the `claudeSessionId` so the next user turn resumes the
 * existing transcript via `--resume`. A RESIDENT proc bakes its MCP config at
 * spawn, so we recycle it here (the mcpConfigHash check would catch it on the
 * next turn anyway, but recycling now makes the config change take effect
 * immediately). Used by the conversational `cortex.register_mcp` flow.
 *
 * Callers are expected to also broadcast a `notice` event to WS subscribers
 * so the UI can show a reload banner (see ws-server `/internal/orchestrator-reload`).
 */
export function reloadOrchestratorSession(repoPath: string, threadId?: string | null): {
  repoPath: string;
  sessionName: string;
  threadId: string | null;
  claudeSessionId: string | null;
} {
  const normalizedRepoPath = normalizeRepoPath(repoPath);
  const normalizedThreadId = normalizeThoughtsThreadId(threadId);
  const sessionName = orchestratorSessionName(normalizedRepoPath, normalizedThreadId);
  const session = sessions.get(sessionName);
  // MCP-config change → recycle the resident proc so the next turn spawns with
  // the new config (a resident proc bakes config at spawn).
  if (session?.proc) killOrchestratorProc(session, getWarmState(sessionName), true);
  return {
    repoPath: normalizedRepoPath,
    sessionName,
    threadId: normalizedThreadId,
    claudeSessionId: session?.claudeSessionId ?? null,
  };
}

// ── Ensure session exists ──

export function ensureOrchestratorSession(repoPath: string, threadId?: string | null): OrchestratorSession {
  void rehydrateOrchestratorSessions().catch(() => {
    // Startup rehydration is best-effort; callers can still create a fresh session.
  });

  return ensureRegisteredSession(sessions, {
    repoPath,
    threadId,
    sessionNameFor: orchestratorSessionName,
    logPrefix: '[orchestrator-session]',
    create: (normalizedRepoPath, normalizedThreadId, sessionName) => ({
      sessionName,
      repoPath: normalizedRepoPath,
      threadId: normalizedThreadId,
      claudeSessionId: readOrchestratorBackendSessionId(normalizedThreadId, 'claude'),
      status: 'ready',
      proc: null,
      createdAt: Date.now(),
    }),
  });
}

// ── Send message (spawn process, stream JSON) ──

/**
 * Permission mode passed to Claude Code when spawning the orchestrator.
 *
 * - `'full'`: current behavior — spawns with `--dangerously-skip-permissions`
 *   so Claude can act autonomously on files, run commands, and drive MCP
 *   tools without prompting. Used by automated paths (intake, auto-review)
 *   and by user messages sent with the "Full access" chip armed.
 * - `'plan'`: spawns with `--permission-mode plan` so Claude can read and
 *   call MCP tools freely but any write (Edit / Write / Bash side-effects)
 *   must be explicitly approved by the user. Used when the chat's permission
 *   chip is toggled to "Read-only" — the safe-mode orchestrator.
 */
export type OrchestratorPermissionMode = 'full' | 'plan';
export const DEFAULT_ORCHESTRATOR_MODEL = DEFAULT_CLAUDE_ORCHESTRATOR_MODEL;

export interface SendToOrchestratorOptions {
  permissionMode?: OrchestratorPermissionMode;
  /**
   * MCP tool profile. `'propose'` (Collide proposer) strips the operator
   * (dispatch) server from this turn's MCP config — the run can read + use
   * cortex but cannot dispatch work. Defaults to `'full'`. See `ToolProfile`.
   */
  toolProfile?: ToolProfile;
  thinkingEffort?: ThinkingEffort;
  serviceTier?: OrchestratorServiceTier;
  model?: string;
  /**
   * #624 — Abort signal for user-initiated interrupt. When aborted mid-stream,
   * the in-flight claude CLI subprocess is terminated with SIGTERM so the turn
   * ends within 1-2s. Partial transcript output that already fired via onEvent
   * is preserved — only NEW output is stopped.
   */
  signal?: AbortSignal;
  /**
   * Image attachments from the composer's picture pills. Converted into
   * base64 image content blocks on the stream-json stdin turn so the
   * model actually SEES them (the wire used to drop these silently).
   */
  attachments?: Array<{ dataUri: string; name?: string }>;
  crashSurvival?: OrchestratorCrashSurvivalMeta;
}

/** data:image/png;base64,xxxx → an Anthropic image content block. */
function attachmentToImageBlock(att: { dataUri: string }): { type: 'image'; source: { type: 'base64'; media_type: string; data: string } } | null {
  const match = /^data:([^;,]+);base64,(.+)$/.exec(att.dataUri);
  if (!match) return null;
  return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
}

// ── Warm resident-process pool ──
// Each orchestrator chat keeps one resident process. Its baked cwd, model,
// permissions, tools, effort, MCP config, and carrier fingerprint determine
// whether the process can stay warm or must recycle and resume its session.
//
// LOCKOUT: a resident proc keeps stdin OPEN, which removes the
// "stdin closes ⇒ an approval can never be answered" layer of the proposer
// read-only guarantee. So a PLAN-mode proc that emits ANY permission request
// (can_use_tool / ExitPlanMode) is KILLED on the spot — the strongest possible
// auto-deny, and one that needs no knowledge of the (UNDOCUMENTED) stream-json
// permission-response envelope. The proc dies before the tool can execute;
// assertNoPrintFlag and assertProposerEventAllowed remain the backstops.

/**
 * Sends a message to the orchestrator through its RESIDENT `claude` process
 * (warm-pool). Spawns on the first turn / after a config change; reuses the
 * live process on every turn after. Calls `onEvent` for each parsed event;
 * resolves when the turn settles on the stream `result`.
 */
export async function sendToOrchestrator(
  session: OrchestratorSession,
  message: string,
  onEvent: (event: OrchestratorEvent) => void,
  options: SendToOrchestratorOptions = {},
): Promise<void> {
  const permissionMode: OrchestratorPermissionMode = options.permissionMode ?? 'full';
  const requestedModel = resolveClaudeOrchestratorModel(options.model);
  const toolProfile: ToolProfile = options.toolProfile ?? 'full';
  const w = getWarmState(session.sessionName);

  // Steer-Now / queue preempt: the ws-server aborts the prior turn's
  // controller before calling sendTurn, so a still-'busy' session here means a
  // just-interrupted subprocess that's mid-teardown. Wait for it to close
  // rather than rejecting the steered message outright.
  if (session.status === 'busy') {
    await waitForSessionIdle(session, PREEMPT_SETTLE_MS);
  }

  // #457/#2909 — Resume after safe recycles; unexpected exits start fresh.
  if (session.status === 'dead') {
    console.log(`[orchestrator-session] Auto-recovering dead session ${session.sessionName}`);
    session.status = 'ready';
    if (!w.resumeAfterKill) session.claudeSessionId = null;
    w.resumeAfterKill = false;
    session.proc = null;
    w.procConfig = null;
  }
  // Still busy after the settle window — a genuinely concurrent turn that was
  // never interrupted, or a hung proc. Reject as before. The `session.status =
  // 'busy'` claim below is synchronous (no await before the spawn), so a second
  // waiter that lost the race re-enters here and rejects instead of double-spawning.
  if (session.status === 'busy') {
    throw new Error('Orchestrator session is busy');
  }
  w.resumeUnavailable = false;

  // #1551 — preflight the repo path before ANY per-turn work (MCP config,
  // warm-proc spawn). Missing folder OR non-git folder fails with a
  // human-actionable message instead of "spawn claude ENOENT".
  assertOrchestratorRepoPath(session.repoPath);

  const isFableProfile = toolProfile === 'fable' || toolProfile === 'fable-solo';
  let carrier: ClaudeHarnessCarrier;
  try {
    carrier = isFableProfile
      ? nativeClaudeHarnessCarrier(requestedModel)
      : await resolveClaudeHarnessCarrier({
          requestedModel,
          sessionDir: join(ORCHESTRATOR_STATE_DIR, 'carrier', session.sessionName),
        });
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    onEvent({ type: 'error', error: failure.message });
    throw failure;
  }
  const model = carrier.model;
  const effortPin = resolveEffortPin({ runtime: 'claude-code', model,
    explicitModel: options.model, requestedEffort: options.thinkingEffort });
  if (!effortPin.ok) throw new EffortPinRejectionError(effortPin.code, effortPin.message);
  const thinkingEffort = effortPin.selectedEffort ?? 'adaptive';
  if (options.serviceTier && options.serviceTier !== 'default' && (options.serviceTier !== 'fast' || carrier.source !== 'native' || !claudeModelSupportsFast(model) || process.env.CLAUDE_CODE_DISABLE_FAST_MODE === '1')) {
    throw new Error('Fast mode is not available for this Claude model and provider. Choose Standard.');
  }

  if (consumeOrchestratorResetSignal(session.repoPath, session.threadId)) {
    session.claudeSessionId = null;
    // A reset means a fresh conversation — recycle the warm proc (it holds the old one).
    if (session.proc) killOrchestratorProc(session, w);
  }

  // Write the MCP config (idempotent) + compute the desired resident-proc config.
  // A 'propose' turn gets the operator-stripped read-only surface — Collide's
  // lockout. The config baked into the resident proc is compared each turn.
  const mcpConfig = toClaudeJson(buildToolRegistry(session.repoPath, { profile: toolProfile, threadId: session.threadId }));
  const mcpFingerprint = fingerprintMcpConfig(mcpConfig);
  const mcpConfigPath = ensureMcpConfig(session.repoPath, toolProfile, mcpConfig, session.threadId);
  const desiredConfig: OrchestratorProcConfig = {
    cwd: session.repoPath,
    model,
    permissionMode,
    toolProfile,
    effort: thinkingEffort,
    fastMode: options.serviceTier === undefined ? undefined : options.serviceTier === 'fast',
    mcpConfigPath,
    mcpConfigHash: mcpFingerprint.hash,
    mcpConfigMaterial: mcpFingerprint.material,
    modelSource: carrier.source,
    carrierFingerprint: carrier.fingerprint,
  };

  // Recycle when the resident proc's baked config changes.
  if (session.proc && !procConfigMatches(w.procConfig, desiredConfig)) {
    const divergence = firstProcConfigDivergence(w.procConfig, desiredConfig);
    console.log(`[orchestrator-session] recycle ${session.sessionName} — config changed at ${divergence}`);
    killOrchestratorProc(session, w, true);
  }

  const systemPrompt = buildOrchestratorSystemPrompt(session.repoPath, { backend: 'claude', toolProfile });
  const promptFingerprint = orchestratorPromptFingerprint(systemPrompt);

  onEvent({ type: 'turn_receipt', leadModel: model, effort: thinkingEffort,
    ...(effortPin.selectedEffort === null ? { effortSource: 'runtime-default' as const } : {}) });
  if (session.proc && !orchestratorProcessPolicyCurrent(session.proc)) killOrchestratorProc(session, w, true);
  // Spawn a fresh proc when there's no warm one (first turn / after recycle).
  if (!session.proc) {
    reapIdleForCapacity(session.sessionName);
    try {
      spawnOrchestratorProc(session, w, desiredConfig, carrier.spawnEnv, systemPrompt);
    } catch (error) {
      session.status = 'dead';
      const e = error instanceof Error ? error : new Error(String(error));
      onEvent({ type: 'error', error: e.message });
      throw e;
    }
  }
  // Attachments → image blocks. Same CLI contract as interactive-session.ts;
  // the message is written to the RESIDENT proc's still-open stdin (no
  // stdin.end() — the proc lives on for the next turn).
  const imageBlocks = (options.attachments ?? [])
    .map(attachmentToImageBlock)
    .filter((block): block is NonNullable<typeof block> => block !== null);

  // #2142 — one turn, up to two attempts. The retry re-enters HERE, not through
  // sendToOrchestrator: the carrier, MCP config and warm proc resolved above are
  // reused as-is, and the correction rides the same warm session so the packet
  // plan from attempt 1 is still in the model's context.
  const runAttempt = (attemptMessage: string, attempt: 1 | 2): Promise<FalseDispatchAttemptResult> => {
    // Attachments belong to the operator's message only — the correction turn is
    // text, and re-sending images would double them into the session context.
    const content: string | Array<Record<string, unknown>> = imageBlocks.length > 0 && attempt === 1
      ? [{ type: 'text', text: attemptMessage }, ...imageBlocks]
      : attemptMessage;
    const payload = `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`;
    session.status = 'busy';
    clearIdleTimer(w);

    return new Promise<FalseDispatchAttemptResult>((resolvePromise, rejectPromise) => {
      const proc = session.proc;
      if (!proc || !proc.stdin || proc.stdin.destroyed) {
        session.status = 'dead';
        const e = new Error('Orchestrator resident proc stdin is not writable');
        onEvent({ type: 'error', error: e.message });
        rejectPromise(e);
        return;
      }

      const crashOffset = w.crashStdoutPath ? fileSize(w.crashStdoutPath) : 0;
      const crashRecord = crashSurvivableOrchestratorEnabled() && w.crashStdoutPath && w.crashStderrPath && proc.pid
        ? createOrchestratorTurnRecordForFiles({
            backend: 'claude',
            sessionName: session.sessionName,
            repoPath: session.repoPath,
            threadId: options.crashSurvival?.threadId ?? session.threadId,
            pid: proc.pid,
            stdoutPath: w.crashStdoutPath,
            stderrPath: w.crashStderrPath,
            stdoutOffset: crashOffset,
            assistantMessageId: options.crashSurvival?.assistantMessageId ?? null,
            assistantStartedAtMs: options.crashSurvival?.assistantStartedAtMs ?? null,
            model,
          })
        : null;

      // #457 — Hang watchdog. Kills the resident proc (surfacing WHY) if the turn
      // never settles on a `result`.
      const timeout = setTimeout(() => {
        console.warn(`[orchestrator-session] Process timeout (${PROCESS_TIMEOUT_MS}ms) — killing ${session.sessionName}`);
        const minutes = Math.round(PROCESS_TIMEOUT_MS / 60_000);
        onEvent({
          type: 'error',
          error: `Orchestrator hit the ${minutes}-minute watchdog limit and was terminated — a turn running this long has almost certainly hung. Re-send your message to continue.`,
        });
        settleOrchestratorTurn(session, w, null);
        killOrchestratorProc(session, w);
      }, PROCESS_TIMEOUT_MS);

      const turn: OrchestratorActiveTurn = {
        onEvent,
        captureEvent: () => {},
        resolve: resolvePromise,
        reject: rejectPromise,
        timeout,
        abortSignal: options.signal ?? null,
        abortListener: null,
        settled: false,
        toolTracker: createToolCallTracker(),
        turnSessionId: session.claudeSessionId,
        cost: null,
        lastAssistantText: '',
        sawToolUseAfterText: false,
        launchAgentCallCount: 0,
        crashRecord,
        stopCrashTail: null,
        promptFingerprint,
      };
      // Narrate-and-exit / false-dispatch telemetry state lives on the turn.
      turn.captureEvent = (e: OrchestratorEvent) => {
        if (e.type === 'text') {
          turn.lastAssistantText += e.text;
          turn.sawToolUseAfterText = false;
        } else if (e.type === 'tool_use') {
          turn.sawToolUseAfterText = true;
          if (launchesWorker(e.name, e.input)) {
            turn.launchAgentCallCount += 1;
          }
        }
        onEvent(e);
      };
      w.activeTurn = turn;
      if (crashRecord) {
        turn.stopCrashTail = tailJsonlFile({
          filePath: crashRecord.stdoutPath,
          fromOffset: crashOffset,
          alive: () => !!session.proc && isPidAlive(crashRecord.pid) && !turn.settled,
          onLine: (line) => handleClaudeJsonLine(session, w, line),
          onEnd: () => {
            if (!turn.settled) {
              const stderr = existsSync(crashRecord.stderrPath)
                ? (() => {
                    try { return readFileSync(crashRecord.stderrPath, 'utf8').trim(); } catch { return ''; }
                  })()
                : '';
              settleOrchestratorTurn(session, w, stderr ? new Error(stderr.slice(0, 500)) : null);
            }
          },
        });
      }

      // #624 — User interrupt settles this turn and recycles the resident proc.
      if (options.signal) {
        if (options.signal.aborted) {
          settleOrchestratorTurn(session, w, null);
          killOrchestratorProc(session, w, true);
          return;
        }
        turn.abortListener = () => {
          console.log(`[orchestrator-session] User interrupt — killing ${session.sessionName}`);
          settleOrchestratorTurn(session, w, null);
          killOrchestratorProc(session, w, true);
        };
        options.signal.addEventListener('abort', turn.abortListener, { once: true });
      }

      try {
        withOrchestratorPromptPolicy(proc, () => proc.stdin!.write(payload, 'utf8', (error?: Error | null) => {
          if (error) {
            console.warn(`[orchestrator-session] stdin write failed for ${session.sessionName}:`, error);
            session.status = 'dead';
            settleOrchestratorTurn(session, w, error);
          }
        }));
      } catch (error) {
        session.status = 'dead';
        settleOrchestratorTurn(session, w, error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  // #2904 — Claude Code ignores --append-system-prompt on --resume, so a
  // session holding an older prompt gets the current one in this turn.
  const turnMessage = w.sessionPrompt === promptFingerprint
    ? message
    : withCurrentOrchestratorPrompt(message, systemPrompt);
  await runTurnWithFalseDispatchRetry({ message: turnMessage, onEvent, runAttempt });
  if (!w.resumeUnavailable) return;
  w.resumeUnavailable = false;
  requestOrchestratorSessionReset(session.repoPath, session.threadId);
  onEvent({
    type: 'turn_retry', attempt: 2, reason: 'resume-unavailable',
    notice: 'Claude could not load the saved session. Starting a new conversation and retrying your message once.',
  });
  return sendToOrchestrator(session, message, onEvent, options);
}
