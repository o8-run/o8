import { credentialPolicyFingerprint } from '@/lib/providers/credential-policy';
import { withProviderStoreLock } from '@/lib/providers/store-lock';
import { childEnvironment, childEnvironmentContext, retainChildTransportCredentials } from '@/lib/providers/spawn-environment';
import { resolveProviderKey } from '@/lib/providers/key-store';
import { spawn } from '@/lib/providers/child-process';
import { closeSync } from 'node:fs';
import { assertNoPrintFlag } from '@/lib/claude-code/assert-no-print-flag';
import { processStreamEvent, parseOrchestratorTurnUsage, type OrchestratorEvent } from './orchestrator-stream-events';
import { isFalseDispatchTurn } from './orchestrator-false-dispatch';
import { detectPermissionRequest, missingClaudeResumeError } from './orchestrator-session-predicates';
import { readDeliveredOrchestratorPrompt, recordDeliveredOrchestratorPrompt, orchestratorPromptFingerprint } from './orchestrator-prompt-ledger';
import { assertOrchestratorRepoPath } from './repo-preflight';
import { buildOrchestratorArgs } from './orchestrator-spawn-args';
import { fableEnvOverride } from './fable-profile';
import { pathWithNodeRuntime } from '@/lib/util/node-on-path';
import { resolveClaudeBinary } from '@/lib/runtimes/shared/cli-locate';
import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';
import { runtimeBillingMode } from '@/lib/providers/runtime-billing';
import { crashSurvivableOrchestratorEnabled, createOrchestratorTurnRecord, openAppendFile, updateOrchestratorTurnPid, discardOrchestratorTurnRecord, finishOrchestratorTurn, type OrchestratorTurnRecord } from './orchestrator-crash-survival';
import type { ChildProcess } from 'node:child_process';
import type { WarmState, OrchestratorProcConfig } from './orchestrator-session-state';
import type { OrchestratorSession } from './orchestrator-session';
export const sessions = new Map<string, OrchestratorSession>();

const IDLE_REAP_MS = 30 * 60_000;
const MAX_LIVE_PROCS = 4; // mirror the Brain warm-pool cap
const warmStates = new Map<string, WarmState>();
const processPolicies = new WeakMap<ChildProcess, string>();

export function orchestratorProcessPolicyCurrent(proc: ChildProcess | null): boolean {
  return !!proc && processPolicies.get(proc) === credentialPolicyFingerprint('claude-code');
}

export function withOrchestratorPromptPolicy(proc: ChildProcess, write: () => void): void {
  withProviderStoreLock(() => {
    if (!orchestratorProcessPolicyCurrent(proc)) {
      proc.kill('SIGTERM');
      throw new Error('Credentials or billing changed before prompt delivery. Retry the turn.');
    }
    write();
  });
}

export function getWarmState(sessionName: string): WarmState {
  let w = warmStates.get(sessionName);
  if (!w) {
    w = { procConfig: null, activeTurn: null, idleTimer: null, stdoutLineBuffer: '', stderrBuffer: '', lastUsedAt: Date.now(), crashStdoutPath: null, crashStderrPath: null, resumeAfterKill: false, resumeUnavailable: false, sessionPrompt: null };
    warmStates.set(sessionName, w);
  }
  return w;
}

export function clearIdleTimer(w: WarmState): void {
  if (w.idleTimer) { clearTimeout(w.idleTimer); w.idleTimer = null; }
}

export function scheduleIdleReap(session: OrchestratorSession, w: WarmState): void {
  clearIdleTimer(w);
  if (session.status === 'dead' || !session.proc) return;
  w.idleTimer = setTimeout(() => {
    console.log(`[orchestrator-session] idle-reap ${session.sessionName}`);
    killOrchestratorProc(session, w, true);
  }, IDLE_REAP_MS);
}

export function killOrchestratorProc(session: OrchestratorSession, w: WarmState, resumeSession = false): void {
  clearIdleTimer(w);
  const proc = session.proc;
  session.proc = null;
  w.resumeAfterKill = resumeSession;
  w.procConfig = null;
  w.crashStdoutPath = null;
  w.crashStderrPath = null;
  session.status = 'dead';
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    proc.kill('SIGTERM');
    setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); }, 2_000);
  }
}

function liveOrchestratorProcCount(): number {
  let n = 0;
  for (const s of sessions.values()) if (s.proc) n += 1;
  return n;
}

/** At MAX_LIVE, reap the least-recently-used IDLE proc (never a busy one). */
export function reapIdleForCapacity(exceptSessionName: string): void {
  if (liveOrchestratorProcCount() < MAX_LIVE_PROCS) return;
  let lru: { session: OrchestratorSession; w: WarmState } | null = null;
  for (const s of sessions.values()) {
    if (s.sessionName === exceptSessionName || !s.proc || s.status !== 'ready') continue;
    const w = warmStates.get(s.sessionName);
    if (!w) continue;
    if (!lru || w.lastUsedAt < lru.w.lastUsedAt) lru = { session: s, w };
  }
  if (lru) {
    console.log(`[orchestrator-session] MAX_LIVE (${MAX_LIVE_PROCS}) — reaping idle ${lru.session.sessionName}`);
    killOrchestratorProc(lru.session, lru.w, true);
  }
}

/** Settle the active turn — emit `done` (+ an error event on a bad crash), run
 *  the narrate-and-exit / false-dispatch telemetry, resolve, and (if the proc is
 *  still alive) leave it READY + schedule the idle reap.
 *
 *  `successfulResult` (#2142) means this settle came from a successful stream
 *  `result` — the model finished the turn on its own. It defaults to FALSE so every other
 *  call site (watchdog timeout, user abort, stdin write failure, plan-mode
 *  LOCKOUT, crash-tail end, proc close, dead rehydrated turn) is excluded from
 *  false-dispatch handling by construction. Those turns are already abnormal;
 *  a turn that was killed mid-narration has no business being retried as a
 *  hallucinated dispatch. */
export function settleOrchestratorTurn(
  session: OrchestratorSession,
  w: WarmState,
  error: Error | null,
  successfulResult = false, terminalOutcome: 'completed' | 'failed' | 'unconfirmed' = 'unconfirmed',
): void {
  const turn = w.activeTurn;
  if (!turn || turn.settled) return;
  const hadCrashRecord = !!turn.crashRecord;
  turn.settled = true;
  clearTimeout(turn.timeout);
  turn.stopCrashTail?.();
  turn.stopCrashTail = null;
  finishOrchestratorTurn(turn.crashRecord, error ? 'failed' : 'completed');
  turn.crashRecord = null;
  if (turn.abortSignal && turn.abortListener) {
    turn.abortSignal.removeEventListener('abort', turn.abortListener);
    turn.abortListener = null;
  }
  w.activeTurn = null;
  w.lastUsedAt = Date.now();
  if (turn.turnSessionId) session.claudeSessionId = turn.turnSessionId;
  // Only a successful turn proves the session received this turn's prompt.
  if (successfulResult && turn.turnSessionId && turn.promptFingerprint) {
    w.sessionPrompt = turn.promptFingerprint;
    recordDeliveredOrchestratorPrompt(turn.turnSessionId, turn.promptFingerprint);
  }

  let falseDispatch = false;
  if (!error) {
    const tail = turn.lastAssistantText.trim().slice(-1200);
    const hasSummaryMarker = /VERDICT\s*[#-]|Dispatched\s+\d+\s+agent/i.test(tail);
    if (turn.sawToolUseAfterText || !hasSummaryMarker) {
      // #2142 decision — narrate-and-exit stays a warn. Its condition
      // (`sawToolUseAfterText || !hasSummaryMarker`) is true for most ordinary
      // turns: any turn that ends without a VERDICT/"Dispatched N agent" marker
      // trips it, which is nearly every healthy conversational reply. Acting on
      // it would fail turns wholesale. False dispatch is the opposite shape — a
      // specific contradiction between what the turn DID and what it SAID — so
      // only that one is promoted to a failure here.
      console.warn(`[orchestrator-session] narrate-and-exit suspected for ${session.sessionName}: sawToolUseAfterText=${turn.sawToolUseAfterText} hasSummaryMarker=${hasSummaryMarker} tailLen=${tail.length}`);
    }
    falseDispatch = isFalseDispatchTurn({
      completedResult: successfulResult,
      error,
      launchAgentCallCount: turn.launchAgentCallCount,
      assistantText: turn.lastAssistantText,
    });
    if (falseDispatch) {
      console.warn(`[orchestrator-session] FALSE-DISPATCH for ${session.sessionName}: launchAgentCallCount=0 but text claims dispatch — text sample: ${JSON.stringify(turn.lastAssistantText.slice(-200))}`);
    }
  }

  // A false-dispatch turn must NOT report success. Withhold `done` and hand it
  // to the retry driver, which replays it only if the LAST attempt also fails
  // (so the client latch still releases) and drops it for a discarded attempt.
  const done: Extract<OrchestratorEvent, { type: 'done' }> = {
    type: 'done', terminalOutcome: turn.abortSignal?.aborted ? 'unconfirmed' : successfulResult ? 'completed' : terminalOutcome, sessionId: turn.turnSessionId, cost: turn.cost, ...(turn.usage ? { usage: turn.usage } : {}),
  };
  if (!falseDispatch && !w.resumeUnavailable) turn.onEvent(done);
  if (error && !w.resumeUnavailable) turn.onEvent({ type: 'error', error: error.message });

  if ((session.proc || hadCrashRecord) && session.status !== 'dead') {
    session.status = 'ready';
    scheduleIdleReap(session, w);
  }
  turn.resolve({ falseDispatch, withheldDone: falseDispatch ? done : null });
}

export function handleClaudeJsonLine(session: OrchestratorSession, w: WarmState, line: string): boolean {
  if (!line.trim()) return true;
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(line) as Record<string, unknown>; } catch { return true; }

  // LOCKOUT auto-deny — a plan-mode proc that asks to escalate is killed.
  if (w.procConfig?.permissionMode === 'plan' && detectPermissionRequest(raw)) {
    console.warn(`[orchestrator-session] LOCKOUT auto-deny — plan-mode proc ${session.sessionName} emitted a permission request; killing (write blocked).`);
    settleOrchestratorTurn(session, w, null); // proposal text already captured
    killOrchestratorProc(session, w);
    return false;
  }

  const turn = w.activeTurn;
  if (!turn) return true; // stray output between turns
  const resumeError = missingClaudeResumeError(raw, session.claudeSessionId);
  if (resumeError) {
    w.resumeUnavailable = true;
    settleOrchestratorTurn(session, w, new Error(resumeError));
    return false;
  }
  processStreamEvent(raw, turn.captureEvent, (id) => { turn.turnSessionId = id; }, (c) => { turn.cost = c; }, turn.toolTracker);
  if (raw.type === 'result') {
    turn.usage = parseOrchestratorTurnUsage(raw);
    const successfulResult = raw.is_error !== true && !(typeof raw.subtype === 'string' && raw.subtype.startsWith('error_'));
    turn.heldResult = successfulResult && turn.toolTracker.backgroundAgents.holdsResult();
    if (turn.heldResult) return true;
    // Only a successful result drives false-dispatch checks and prompt delivery.
    settleOrchestratorTurn(session, w, null, successfulResult, successfulResult ? 'completed' : 'failed');
    return false;
  }
  return true;
}

export function attachOrchestratorProcHandlers(session: OrchestratorSession, w: WarmState): void {
  const proc = session.proc;
  if (!proc) return;

  // Every handler below is identity-guarded: after a recycle
  // (killOrchestratorProc nulls session.proc, then a NEW proc spawns), the OLD
  // proc's stdout tail / close / error events still fire on the event loop.
  // Without the guard the old close settled the NEW turn as "proc exited with
  // code 143" and clobbered session.proc — every recycle-triggering turn died
  // instantly (live-hit 2026-07-13). Deliberate kill paths (timeout, interrupt,
  // LOCKOUT, recycle) settle their turn explicitly before killing, so skipping
  // the stale close loses nothing.
  proc.stdout?.on('data', (chunk: Buffer) => {
    if (session.proc !== proc) return;
    w.stdoutLineBuffer += chunk.toString('utf-8');
    const lines = w.stdoutLineBuffer.split('\n');
    w.stdoutLineBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!handleClaudeJsonLine(session, w, line)) return;
    }
  });

  proc.stderr?.on('data', (chunk: Buffer) => {
    if (session.proc !== proc) return;
    w.stderrBuffer += chunk.toString('utf-8');
    if (w.stderrBuffer.length > 4_000) w.stderrBuffer = w.stderrBuffer.slice(-4_000);
  });

  proc.on('error', (err) => {
    if (session.proc !== proc) return;
    clearIdleTimer(w);
    session.proc = null;
    w.procConfig = null;
    session.status = 'dead';
    const turn = w.activeTurn;
    if (turn && !turn.settled) {
      turn.settled = true;
      clearTimeout(turn.timeout);
      w.activeTurn = null;
      turn.onEvent({ type: 'error', error: err.message });
      turn.reject(err);
    }
  });

  proc.on('close', (code) => {
    if (session.proc !== proc) return;
    clearIdleTimer(w);
    session.proc = null;
    w.procConfig = null;
    if (w.activeTurn && !w.activeTurn.settled) {
      // Crashed / killed mid-turn — flush the tail then settle (error event only
      // on a non-clean exit, matching the cold path).
      if (w.stdoutLineBuffer.trim()) {
        try {
          const raw = JSON.parse(w.stdoutLineBuffer) as Record<string, unknown>;
          const turn = w.activeTurn;
          processStreamEvent(raw, turn.captureEvent, (id) => { turn.turnSessionId = id; }, (c) => { turn.cost = c; }, turn.toolTracker);
          if (raw.type === 'result') turn.usage = parseOrchestratorTurnUsage(raw);
        } catch { /* ignore */ }
      }
      w.stdoutLineBuffer = '';
      const stderr = w.stderrBuffer.trim();
      if (w.activeTurn.heldResult) settleOrchestratorTurn(session, w, null, true, 'completed');
      else settleOrchestratorTurn(session, w, code === 0 || code === null ? null : new Error(stderr.slice(0, 500) || `orchestrator proc exited with code ${code}`), false, code === 0 ? 'unconfirmed' : 'failed');
    }
    session.status = 'dead'; // proc gone → next turn respawns (auto-recover)
  });
}

/** Spawn a fresh resident proc with the baked config. First-turn cold. */
export function spawnOrchestratorProc(
  session: OrchestratorSession,
  w: WarmState,
  config: OrchestratorProcConfig,
  carrierEnv: Record<string, string>,
  systemPrompt: string,
): void {
  // Layer B — a Fable turn keeps `--dangerously-skip-permissions` (kept MCP tools
  // run autonomously) AND adds `--disallowedTools <native>` to strip Claude's
  // native read/write tools (the token lever). isFable takes precedence over the
  // plan branch so the lockout holds regardless of permission mode. See
  // `fable-profile.ts` for the empirical basis.
  if (config.modelSource === 'openrouter' && (runtimeBillingMode('claude-code') !== 'api' || !resolveProviderKey('OPENROUTER_API_KEY'))) throw new Error('Claude Code API billing is disabled or its API key was revoked.');
  const isFable = config.toolProfile === 'fable' || config.toolProfile === 'fable-solo';
  const args = buildOrchestratorArgs({
    permissionMode: config.permissionMode,
    toolProfile: config.toolProfile,
    effort: config.effort,
    fastMode: config.fastMode,
    mcpConfigPath: config.mcpConfigPath,
    model: config.model,
    claudeSessionId: session.claudeSessionId,
    systemPrompt,
  });

  // The orchestrator must stay on the interactive REPL path for every carrier.
  assertNoPrintFlag(args, 'Orchestrator REPL session');

  let crashRecord: OrchestratorTurnRecord | null = null;
  let stdoutFd: number | null = null;
  let stderrFd: number | null = null;
  const crashEnabled = crashSurvivableOrchestratorEnabled();
  if (crashEnabled) {
    crashRecord = createOrchestratorTurnRecord({
      backend: 'claude',
      sessionName: session.sessionName,
      repoPath: session.repoPath,
      threadId: session.threadId,
      pid: 0,
    });
    stdoutFd = openAppendFile(crashRecord.stdoutPath);
    stderrFd = openAppendFile(crashRecord.stderrPath);
  }
  // Preflight the cwd (#1551, shared helper): missing folder OR non-git folder
  // fails here with a human-actionable message instead of "spawn claude ENOENT"
  // (which names the healthy binary) or a confusing mid-turn tool error.
  assertOrchestratorRepoPath(session.repoPath);
  const launch = cliInvocation(resolveClaudeBinary(), args);
  const launchEnv = childEnvironment({ runtimeId: 'claude-code', env: {
    PATH: pathWithNodeRuntime(), FORCE_COLOR: '0', NO_COLOR: '1', O8_MANAGED_SESSION: '1',
    ...carrierEnv, ...(isFable && runtimeBillingMode('claude-code') === 'api' ? fableEnvOverride() : {}),
  } });
  if (config.modelSource === 'codex-subscription' || config.modelSource === 'openrouter') {
    for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) if (carrierEnv[name] !== undefined) launchEnv[name] = carrierEnv[name];
    retainChildTransportCredentials(launchEnv, ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
  }
  const policy = childEnvironmentContext(launchEnv)!.policy!;
  const proc = spawn(launch.command, launch.args, { windowsHide: true,
    cwd: session.repoPath,
    // Fable key injection stays scoped; the selected harness carrier contributes
    // only its explicit environment through carrierEnv.
    env: launchEnv,
    detached: crashEnabled,
    stdio: crashEnabled && stdoutFd !== null && stderrFd !== null
      ? ['pipe', stdoutFd, stderrFd]
      : ['pipe', 'pipe', 'pipe'],
  });
  processPolicies.set(proc, policy);
  if (stdoutFd !== null) closeSync(stdoutFd);
  if (stderrFd !== null) closeSync(stderrFd);
  if (crashEnabled) proc.unref();
  if (crashRecord) {
    const updated = updateOrchestratorTurnPid(crashRecord, proc.pid ?? 0);
    w.crashStdoutPath = updated.stdoutPath;
    w.crashStderrPath = updated.stderrPath;
    // This record only allocated the warm proc's stream files — per-turn
    // records are created per send. Discard, don't settle (task #8 ledger).
    discardOrchestratorTurnRecord(updated);
  }
  session.proc = proc;
  w.resumeAfterKill = false;
  w.procConfig = config;
  // A resumed session keeps the prompt it last received; a new one gets this one.
  w.sessionPrompt = session.claudeSessionId
    ? readDeliveredOrchestratorPrompt(session.claudeSessionId)
    : orchestratorPromptFingerprint(systemPrompt);
  w.stdoutLineBuffer = '';
  w.stderrBuffer = '';
  attachOrchestratorProcHandlers(session, w);
  console.log(`[orchestrator-session] spawned warm proc ${session.sessionName} (${config.permissionMode}/${config.toolProfile})`);
}
