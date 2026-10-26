import { soloEnvironment, spawnSolo } from './solo-deferred-launch';
import { childEnvironment, internalBrokerEnvironment } from '@/lib/providers/spawn-environment';
import { providerSpawnEnvironment } from '@/lib/providers/spawn-environment';
import { sandboxFlagsForMode, reasoningEffortFromThinkingEffort, resolveOrchestratorModelSync, codexOrchestratorModelFlags } from './codex-orchestrator-options';
export { resolveOrchestratorModelSync, codexOrchestratorModelFlags, buildCodexOrchestratorPrompt } from './codex-orchestrator-options';
/**
 * Codex orchestrator session. Exec uses a per-repo CODEX_HOME with merged MCP
 * config; the app-server bridge uses a thread config in the user's Codex home.
 *
 * Each turn owns a process. App threads use the app-server bridge, which can
 * accept native input during that turn; exec continues through exec resume.
 */

import { spawn } from '@/lib/providers/child-process';
import type { ChildProcess } from 'node:child_process';
import { closeSync, readFileSync } from 'node:fs';
import type { OrchestratorEvent } from './orchestrator-stream-events';
import type { ToolProfile } from '@/lib/mcp/tool-spine/registry';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import {
  readOrchestratorBackendSessionId,
  writeOrchestratorBackendSessionId,
} from '@/lib/mobile/orchestrator-thread-history';
import { codexAppThreadConfig, prepareCodexHome, userCodexHome } from './codex-orchestrator-config';
import { splitCodexOrchestratorPrompt, writeCodexAppBridgeSpec } from '@/lib/codex/app-bridge-spec';
import { codexAppBridgeLaunch } from '@/lib/codex/app-bridge-launch';
import { registerCodexAppBridgeSteer } from '@/lib/codex/app-bridge-steer';
import { noteCodexAppTurnLine } from '@/lib/codex/app-thread-sync';
export { ensureCodexHome, mergeCodexMcpConfig, prepareCodexHome, stripPluginSections } from './codex-orchestrator-config';
import { parseLocalModel } from '@/lib/codex/local-model';
import { codexCliSupportsUltraEfforts } from '@/lib/codex/reasoning-effort';
import { resolveCodexAppThreadsSync } from '@/lib/operator/defaults';
import { MODEL_IDS } from '@/lib/models';
import { CODEX_SOL_FALLBACK_MODEL, CODEX_SOL_UPDATE_NOTICE, isCodexSolUnsupported } from '@/lib/codex/model-compatibility';
import { pathWithNodeRuntime } from '@/lib/util/node-on-path';
import { assertOrchestratorRepoPath } from '@/lib/lane/repo-preflight';
import { handleCodexJsonLine, type CodexLineHandlerState } from './codex-orchestrator-events';
import { codexOrchestrationModeFlags } from './orchestrator-backends/orchestration-mode';
import type { OrchestratorExecutionMode } from '@/lib/orchestrator/types';
import { prepareSingleOrchestratorLaunch } from './single-orchestrator-policy';
import { codexComposerImagePaths, type ComposerImageAttachment } from '@/lib/mobile/orchestrator-image-media';
import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';
import { getCodexSpeedCatalogue } from '@/lib/codex/service-tier-catalogue';
import { serviceTierForTurn, type OrchestratorServiceTier } from '@/lib/orchestrator/service-tier';
import { recoverRuntimeSessionMessage, SESSION_CONTEXT_UNAVAILABLE } from './runtime-session-recovery';
import {
  ensureRegisteredSession,
  getRegisteredSession,
  normalizeRepoPath,
  normalizeThoughtsThreadId,
  PREEMPT_SETTLE_MS,
  PROCESS_TIMEOUT_MS,
  requestRegisteredSessionReset,
  sessionNameForRepo,
  waitForSessionIdle,
} from './orchestrator-session-core';
import {
  crashSurvivableOrchestratorEnabled,
  createOrchestratorTurnRecord,
  fileSize,
  finishOrchestratorTurn,
  isPidAlive,
  isRehydratedTurnAlive,
  listActiveOrchestratorTurns,
  openAppendFile,
  readJsonlLines,
  tailJsonlFile,
  updateOrchestratorTurnPid,
  type OrchestratorCrashSurvivalMeta,
  type OrchestratorTurnRecord,
} from './orchestrator-crash-survival';
// ── Types ────────────────────────────────────────────────────────────────────
export interface CodexOrchestratorSession {
  sessionName: string;
  repoPath: string;
  /** UI/history thread id (thoughts-*), when this session belongs to a persisted chat. */
  historyThreadId: string | null;
  /** Codex thread id captured from the `thread.started` event for `exec resume`. */
  threadId: string | null;
  status: 'ready' | 'busy' | 'dead';
  proc: ChildProcess | null;
  createdAt: number;
}
// Mirror of OrchestratorPermissionMode from orchestrator-session.ts.
export type CodexOrchestratorPermissionMode = 'full' | 'plan';
export interface SendToCodexOrchestratorOptions {
  /** Original operator text for the app-server user input; absent on automated continuations. */
  rawMessage?: string;
  permissionMode?: CodexOrchestratorPermissionMode;
  orchestrationMode?: OrchestratorExecutionMode;
  /**
   * MCP tool profile. `'propose'` (Collide proposer) strips the operator
   * (dispatch) server from this turn's Codex config.toml — the run can read +
   * use cortex but cannot dispatch work. Defaults to `'full'`. See `ToolProfile`.
   */
  toolProfile?: ToolProfile;
  thinkingEffort?: ThinkingEffort;
  serviceTier?: OrchestratorServiceTier;
  model?: string;
  attachments?: ComposerImageAttachment[];
  signal?: AbortSignal;
  crashSurvival?: OrchestratorCrashSurvivalMeta;
}
// ── Constants ────────────────────────────────────────────────────────────────
export const CODEX_FIRST_EVENT_TIMEOUT_MS = 45_000;
// ── Registry ─────────────────────────────────────────────────────────────────
const sessions = new Map<string, CodexOrchestratorSession>();

export function codexOrchestratorSessionName(repoPath: string, threadId?: string | null): string {
  return sessionNameForRepo('cortex-codex-orchestrator', repoPath, threadId);
}

export function getCodexOrchestratorSession(repoPath: string, threadId?: string | null): CodexOrchestratorSession | null {
  return getRegisteredSession(sessions, codexOrchestratorSessionName(repoPath, threadId));
}

export function ensureCodexOrchestratorSession(repoPath: string, threadId?: string | null): CodexOrchestratorSession {
  return ensureRegisteredSession(sessions, {
    repoPath,
    threadId,
    sessionNameFor: codexOrchestratorSessionName,
    logPrefix: '[codex-orchestrator-session]',
    create: (normalizedRepoPath, normalizedThreadId, sessionName) => ({
      sessionName,
      repoPath: normalizedRepoPath,
      historyThreadId: normalizedThreadId,
      threadId: readOrchestratorBackendSessionId(normalizedThreadId, 'codex'),
      status: 'ready',
      proc: null,
      createdAt: Date.now(),
    }),
  });
}

interface CodexOrchestratorRehydrateOptions {
  onReboundEvent?: (record: OrchestratorTurnRecord, event: OrchestratorEvent) => void;
}

export function rehydrateCodexOrchestratorTurns(options: CodexOrchestratorRehydrateOptions = {}): number {
  let count = 0;
  for (const record of listActiveOrchestratorTurns()) {
    if (record.backend !== 'codex') continue;
    const sessionName = record.sessionName || codexOrchestratorSessionName(record.repoPath, record.threadId);
    let session = sessions.get(sessionName);
    if (!session) {
      session = {
        sessionName,
        repoPath: normalizeRepoPath(record.repoPath),
        historyThreadId: normalizeThoughtsThreadId(record.threadId),
        threadId: readOrchestratorBackendSessionId(normalizeThoughtsThreadId(record.threadId), 'codex'),
        status: 'busy',
        proc: null,
        createdAt: record.startedAt,
      };
      sessions.set(sessionName, session);
    } else {
      session.status = 'busy';
    }
    const lineState: CodexLineHandlerState = { cost: null, threadId: session.threadId };
    const isLocalModel = typeof record.model === 'string' && !!parseLocalModel(record.model);
    const emit = (event: OrchestratorEvent) => {
      options.onReboundEvent?.(record, event);
    };
    const handleLine = (line: string) => {
      handleCodexJsonLine(line, lineState, emit, { isLocalModel, model: record.model ?? undefined });
      if (lineState.threadId) session!.threadId = lineState.threadId;
    };
    const finishRecord = () => {
      if (lineState.threadId) session!.threadId = lineState.threadId;
      session!.status = 'ready';
      emit({
        type: 'done', terminalOutcome: lineState.terminalOutcome ?? 'unconfirmed',
        sessionId: lineState.threadId,
        cost: lineState.cost,
        ...(lineState.usage ? { usage: lineState.usage } : {}),
      });
      finishOrchestratorTurn(record, 'completed');
    };
    const replay = readJsonlLines(record.stdoutPath, record.stdoutOffset ?? 0).lines;
    for (const line of replay) {
      handleLine(line);
    }
    if (!isRehydratedTurnAlive(record, PROCESS_TIMEOUT_MS)) {
      finishRecord();
      count += 1;
      continue;
    }
    tailJsonlFile({
      filePath: record.stdoutPath,
      fromOffset: fileSize(record.stdoutPath),
      alive: () => isRehydratedTurnAlive(record, PROCESS_TIMEOUT_MS),
      onLine: handleLine,
      onEnd: () => {
        finishRecord();
      },
    });
    count += 1;
  }
  return count;
}

// ── Permission mode mapping ──────────────────────────────────────────────────

// ── Event mapping (codex JSON → OrchestratorEvent) ───────────────────────────

// ── Send message ─────────────────────────────────────────────────────────────

function isMissingCodexRolloutResumeError(error: string): boolean {
  const normalized = error.toLowerCase();
  if (!normalized.includes('thread/resume')) return false;
  return normalized.includes('no rollout found for thread id')
    || (normalized.includes('failed to resolve rollout path') && normalized.includes('file does not exist'));
}

export async function sendToCodexOrchestrator(
  session: CodexOrchestratorSession,
  message: string,
  onEvent: (event: OrchestratorEvent) => void,
  options: SendToCodexOrchestratorOptions = {},
): Promise<void> {
  const requestedModel = resolveOrchestratorModelSync(options.model);
  const resumed = Boolean(session.threadId);
  if (!resumed && requestedModel !== MODEL_IDS.raw.openAiGpt61Sol) {
    return sendToCodexOrchestratorAttempt(session, message, onEvent, options);
  }

  const deferredTerminalEvents: OrchestratorEvent[] = [];
  let streamed = false;
  await sendToCodexOrchestratorAttempt(session, message, (event) => {
    if (event.type === 'error' || event.type === 'done') deferredTerminalEvents.push(event);
    else {
      if (event.type !== 'turn_receipt') streamed = true;
      onEvent(event);
    }
  }, options, () => { streamed = true; });

  const unsupported = deferredTerminalEvents.some((event) => event.type === 'error'
    && isCodexSolUnsupported(requestedModel, event.error));
  if (!streamed && unsupported && !options.signal?.aborted) {
    session.status = 'ready';
    onEvent({ type: 'turn_retry', attempt: 2, reason: 'codex-model-unsupported', notice: CODEX_SOL_UPDATE_NOTICE });
    return sendToCodexOrchestratorAttempt(session, message, onEvent, { ...options, model: CODEX_SOL_FALLBACK_MODEL, serviceTier: options.serviceTier === undefined ? undefined : 'default' });
  }
  const terminalError = deferredTerminalEvents.find((event) => event.type === 'error');
  const missingRollout = terminalError?.type === 'error'
    && isMissingCodexRolloutResumeError(terminalError.error);
  if (resumed && !streamed && missingRollout && !options.signal?.aborted) {
    let recoveredMessage: string;
    try {
      recoveredMessage = recoverRuntimeSessionMessage({ ...session, message, rawMessage: options.rawMessage });
    } catch {
      session.status = 'ready';
      onEvent({ type: 'error', error: SESSION_CONTEXT_UNAVAILABLE });
      onEvent({ type: 'done', terminalOutcome: 'failed', sessionId: session.threadId, cost: null });
      return;
    }
    if (options.signal?.aborted) {
      for (const event of deferredTerminalEvents) onEvent(event);
      return;
    }
    const missingThreadId = session.threadId;
    session.threadId = null;
    session.status = 'ready';
    onEvent({ type: 'turn_retry', attempt: 2, reason: 'runtime-session-recovered', notice: 'The saved runtime session was unavailable. Continuing in a new session with the earlier conversation restored.' });
    try {
      await sendToCodexOrchestratorAttempt(session, recoveredMessage, onEvent, options);
    } finally {
      // Cancellation or startup failure must not turn the next send into a
      // context-free first turn. Keep recovery required until a new thread exists.
      if (!session.threadId) {
        session.threadId = missingThreadId;
        session.status = 'ready';
        writeOrchestratorBackendSessionId(session.historyThreadId, 'codex', missingThreadId);
      }
    }
    return;
  }

  for (const event of deferredTerminalEvents) onEvent(event);
}

async function sendToCodexOrchestratorAttempt(
  session: CodexOrchestratorSession,
  message: string,
  onEvent: (event: OrchestratorEvent) => void,
  options: SendToCodexOrchestratorOptions = {},
  onActivity?: () => void,
): Promise<void> {
  // Fable is Claude-only — its native-tool lockout + BYO-key path live in the
  // Claude REPL (orchestrator-session.ts). The registry routes 'fable' to
  // fableBackend, so a 'fable' profile reaching a Codex orchestrator is a
  // mis-wire; fail closed rather than silently running Fable's surface on Codex.
  if (options.toolProfile === 'fable') {
    throw new Error("Codex orchestrator does not support the 'fable' tool profile (Fable is Claude-only).");
  }
  const settleBeforeSpawnIfAborted = (): boolean => {
    if (!options.signal?.aborted) return false;
    session.status = 'ready';
    session.proc = null;
    onEvent({ type: 'done', sessionId: session.threadId, cost: null });
    return true;
  };
  if (settleBeforeSpawnIfAborted()) return;
  const permissionMode: CodexOrchestratorPermissionMode = options.permissionMode ?? 'full';
  let model = resolveOrchestratorModelSync(options.model);

  // A preempted subprocess may still be tearing down. Native steering uses
  // the bridge's liveSteer path instead of entering sendTurn again.
  if (session.status === 'busy') {
    await waitForSessionIdle(session, PREEMPT_SETTLE_MS);
  }
  if (settleBeforeSpawnIfAborted()) return;

  // Recover an interrupted process before starting the next turn.
  if (session.status === 'dead') {
    console.log(`[codex-orchestrator-session] Auto-recovering dead session ${session.sessionName}`);
    session.status = 'ready';
    session.threadId = null;
    session.proc = null;
  }
  // Still busy after the settle window — genuinely concurrent / hung. Reject.
  // The synchronous `session.status = 'busy'` claim below means a second waiter
  // that lost the race re-enters here and rejects instead of double-spawning.
  if (session.status === 'busy') {
    throw new Error('Codex orchestrator session is busy');
  }

  session.status = 'busy';
  // Preflight the repo before resolving or spawning the CLI (#1551).
  try {
    assertOrchestratorRepoPath(session.repoPath);
  } catch (err) {
    session.status = 'dead';
    onEvent({ type: 'error', error: err instanceof Error ? err.message : String(err) });
    onEvent({ type: 'done', sessionId: session.threadId, cost: null });
    return;
  }
  let codexHome: string;
  try {
    // A 'propose' turn gets the operator-stripped (read-only proposer) config —
    // Collide's dispatch lockout.
    const prepared = prepareCodexHome(session.repoPath, options.toolProfile ?? 'full', model, session.historyThreadId);
    codexHome = prepared.codexHome;
    model = prepared.model;
    if (prepared.note) {
      console.warn(`[codex-orchestrator-session] ${prepared.note}`);
      onEvent({ type: 'thinking', text: prepared.note });
    }
  } catch (err) {
    session.status = 'dead';
    const note = `Failed to prepare Codex orchestrator config: ${err instanceof Error ? err.message : String(err)}`;
    onEvent({ type: 'error', error: note });
    onEvent({ type: 'done', sessionId: session.threadId, cost: null });
    return;
  }
  if (settleBeforeSpawnIfAborted()) return;
  const isLocalModel = !!parseLocalModel(model);
  let reasoningEffort = reasoningEffortFromThinkingEffort(options.thinkingEffort, model);

  const { resolveCli, CliNotFoundError } = await import('@/lib/runtimes/shared/cli-resolver');
  if (settleBeforeSpawnIfAborted()) return;
  let codexBin: string;
  try {
    const resolved = await resolveCli({
      runtimeId: 'codex',
      binaryName: 'codex',
      envOverride: 'O8_CODEX_BIN',
    });
    codexBin = resolved.path;
    // The model-gated clamp (flagship models may use max/ultra) is not enough — the
    // INSTALLED CLI must also understand the tier. An older codex refuses to
    // load config mentioning `max` and exits 1 before the first token.
    if ((reasoningEffort === 'max' || reasoningEffort === 'ultra') && !codexCliSupportsUltraEfforts(resolved.version)) {
      console.warn(`[codex-orchestrator] installed codex ${resolved.version ?? '(unknown version)'} predates '${reasoningEffort}' — clamping to xhigh`);
      reasoningEffort = 'xhigh';
    }
  } catch (err) {
    if (settleBeforeSpawnIfAborted()) return;
    session.status = 'dead';
    const note = err instanceof CliNotFoundError
      ? `Codex binary not found: ${err.message}`
      : `Failed to resolve Codex binary: ${err instanceof Error ? err.message : String(err)}`;
    onEvent({ type: 'error', error: note });
    onEvent({ type: 'done', sessionId: session.threadId, cost: null });
    return;
  }
  if (settleBeforeSpawnIfAborted()) return;

  let imagePaths: string[];
  try {
    imagePaths = codexComposerImagePaths(options.attachments ?? [], codexHome);
  } catch (error) {
    session.status = 'dead';
    onEvent({ type: 'error', error: `Unable to prepare image attachments: ${error instanceof Error ? error.message : String(error)}` });
    onEvent({ type: 'done', sessionId: session.threadId, cost: null });
    return;
  }

  onEvent({ type: 'turn_receipt', leadModel: model, effort: reasoningEffort });

  const serviceTier = serviceTierForTurn(options.serviceTier, 'codex', resolveOrchestratorModelSync(options.model), 'codex', model);
  if (serviceTier && serviceTier !== 'default') {
    try {
      const catalogue = await getCodexSpeedCatalogue(codexHome);
      if (!catalogue.models[model]?.some((tier) => tier.id === serviceTier)) throw new Error();
    } catch {
      session.status = 'ready';
      onEvent({ type: 'error', error: 'This service tier is not available for the selected Codex model and account. Choose Standard or check the CLI.' });
      onEvent({ type: 'done', sessionId: session.threadId, cost: null });
      return;
    }
    if (settleBeforeSpawnIfAborted()) return;
  }
  const serviceTierArgs = serviceTier ? ['-c', `service_tier="${serviceTier}"`] : [];
  // #3573: with "Show chats in the Codex app" on, the turn runs through the
  // app-server bridge in the operator's own Codex home, so the Codex app lists
  // it. Solo keeps its sandboxed private home; local models keep exec's --oss path.
  const codexApp = options.orchestrationMode !== 'single' && !isLocalModel && resolveCodexAppThreadsSync();

  // First-turn launch vs resume.
  const isResume = Boolean(session.threadId);
  const args: string[] = isResume
    ? [
        'exec',
        'resume',
        session.threadId!,
        '--json',
        ...(options.orchestrationMode === 'single' ? [] : sandboxFlagsForMode(permissionMode)),
        ...codexOrchestrationModeFlags(options.orchestrationMode),
        ...codexOrchestratorModelFlags(model, reasoningEffort),
        ...serviceTierArgs,
        // Disable the hosted image_generation tool (defaults to nonexistent
        // gpt-image-2 in Codex CLI 0.130.0 → 400s every turn at spawn).
        '-c',
        'tools.image_generation=false',
        ...imagePaths.flatMap((path) => ['--image', path]),
        '--',
        message,
      ]
    : [
        'exec',
        '--json',
        ...(options.orchestrationMode === 'single' ? [] : sandboxFlagsForMode(permissionMode)),
        ...codexOrchestrationModeFlags(options.orchestrationMode),
        ...codexOrchestratorModelFlags(model, reasoningEffort),
        ...serviceTierArgs,
        '-c',
        'tools.image_generation=false',
        '-C',
        session.repoPath,
        ...imagePaths.flatMap((path) => ['--image', path]),
        '--',
        message,
      ];

  const overrides = { PATH: pathWithNodeRuntime(), FORCE_COLOR: '0', NO_COLOR: '1', O8_MANAGED_SESSION: '1', CODEX_HOME: codexHome };
  const baseEnv: NodeJS.ProcessEnv = options.orchestrationMode === 'single' ? soloEnvironment(overrides) : childEnvironment({ runtimeId: 'codex', env: overrides });
  let spawnBinary = codexBin;
  let spawnArgs = args;
  let spawnEnv = baseEnv;
  let cleanupSingleLaunch = () => {};
  if (codexApp) {
    try {
      const prompt = splitCodexOrchestratorPrompt(message, options.rawMessage);
      const specPath = writeCodexAppBridgeSpec({
        codexBin,
        cwd: session.repoPath,
        threadId: session.threadId,
        developerInstructions: prompt.instructions,
        message: prompt.message,
        imagePaths,
        model,
        effort: reasoningEffort,
        serviceTier: serviceTier ?? null,
        sandbox: permissionMode === 'plan' ? 'read-only' : 'danger-full-access',
        config: codexAppThreadConfig(session.repoPath, options.toolProfile ?? 'full', session.historyThreadId),
      });
      const bridge = codexAppBridgeLaunch();
      spawnBinary = bridge.command;
      spawnArgs = [...bridge.args, specPath];
      spawnEnv = { ...baseEnv, CODEX_HOME: userCodexHome() };
    } catch (err) {
      session.status = 'dead';
      onEvent({ type: 'error', error: `Codex app mode unavailable: ${err instanceof Error ? err.message : String(err)}` });
      onEvent({ type: 'done', sessionId: session.threadId, cost: null });
      return;
    }
  }
  if (options.orchestrationMode === 'single') {
    try {
      const prepared = await prepareSingleOrchestratorLaunch({
        repoPath: session.repoPath, codexHome, binary: codexBin, args, env: baseEnv,
      });
      spawnBinary = prepared.binary;
      spawnArgs = prepared.args;
      spawnEnv = prepared.env;
      cleanupSingleLaunch = prepared.cleanup;
    } catch (err) {
      session.status = 'dead';
      onEvent({ type: 'error', error: `Single mode unavailable: ${err instanceof Error ? err.message : String(err)}` });
      onEvent({ type: 'done', sessionId: session.threadId, cost: null });
      return;
    }
  }

  return new Promise<void>((promiseResolve) => {
    let crashRecord: OrchestratorTurnRecord | null = null;
    let stdoutFd: number | null = null;
    let stderrFd: number | null = null;
    const crashEnabled = crashSurvivableOrchestratorEnabled();
    if (crashEnabled) {
      crashRecord = createOrchestratorTurnRecord({
        backend: 'codex',
        sessionName: session.sessionName,
        repoPath: session.repoPath,
        threadId: options.crashSurvival?.threadId ?? session.historyThreadId,
        pid: 0,
        assistantMessageId: options.crashSurvival?.assistantMessageId ?? null,
        assistantStartedAtMs: options.crashSurvival?.assistantStartedAtMs ?? null,
        model,
      });
      stdoutFd = openAppendFile(crashRecord.stdoutPath);
      stderrFd = openAppendFile(crashRecord.stderrPath);
    }
    let proc: ChildProcess;
    const singleProcessGroup = options.orchestrationMode === 'single';
    try {
      const launch = cliInvocation(spawnBinary, spawnArgs);
      const createChild = options.orchestrationMode === 'single' ? spawnSolo : spawn;
      proc = createChild(launch.command, launch.args, { windowsHide: true,
        cwd: session.repoPath,
        env: options.orchestrationMode === 'single' ? spawnEnv : codexApp ? internalBrokerEnvironment(providerSpawnEnvironment(spawnEnv, { runtimeId: 'codex' })) : providerSpawnEnvironment(spawnEnv, { runtimeId: 'codex' }),
        detached: crashEnabled || singleProcessGroup,
        stdio: crashEnabled && stdoutFd !== null && stderrFd !== null
          ? ['ignore', stdoutFd, stderrFd, ...(codexApp ? ['ipc' as const] : [])]
          : ['ignore', 'pipe', 'pipe', ...(codexApp ? ['ipc' as const] : [])],
      });
    } catch (err) {
      if (stdoutFd !== null) closeSync(stdoutFd);
      if (stderrFd !== null) closeSync(stderrFd);
      finishOrchestratorTurn(crashRecord, 'failed');
      cleanupSingleLaunch();
      session.status = 'dead';
      const note = err instanceof Error ? err.message : String(err);
      onEvent({ type: 'error', error: note });
      onEvent({ type: 'done', sessionId: session.threadId, cost: null });
      promiseResolve();
      return;
    }
    if (stdoutFd !== null) closeSync(stdoutFd);
    if (stderrFd !== null) closeSync(stderrFd);
    if (crashEnabled) proc.unref();
    if (crashRecord) {
      crashRecord = updateOrchestratorTurnPid(crashRecord, proc.pid ?? 0);
    }
    session.proc = proc;
    const stopSteer = codexApp ? registerCodexAppBridgeSteer(session, proc, { model, permissionMode, toolProfile: options.toolProfile ?? 'full', orchestrationMode: options.orchestrationMode }) : () => {};
    const userAbortSignal = options.signal;
    let userAbortListener: (() => void) | null = null;
    const detachUserAbortListener = () => {
      if (userAbortSignal && userAbortListener) {
        userAbortSignal.removeEventListener('abort', userAbortListener);
        userAbortListener = null;
      }
    };

    let lineBuffer = '';
    const lineState: CodexLineHandlerState = { cost: null, threadId: session.threadId };
    let stopCrashTail: (() => void) | null = null;
    let crashTailOffset = 0;
    let settled = false;
    let processTimeout: ReturnType<typeof setTimeout> | null = null;
    let firstEventTimeout: ReturnType<typeof setTimeout> | null = null;
    let sawFirstEvent = false;
    const handleCodexLine = (line: string) => {
      if (codexApp) noteCodexAppTurnLine(line, { tabId: session.historyThreadId, repoPath: session.repoPath });
      const parsed = handleCodexJsonLine(line, lineState, onEvent, { isLocalModel, model, onActivity });
      if (parsed) {
        sawFirstEvent = true;
        if (firstEventTimeout) {
          clearTimeout(firstEventTimeout);
          firstEventTimeout = null;
        }
      }
    };

    const drainCrashOutput = () => {
      stopCrashTail?.();
      stopCrashTail = null;
      if (!crashRecord) return;
      const remainder = readJsonlLines(crashRecord.stdoutPath, crashTailOffset);
      crashTailOffset = remainder.offset;
      for (const line of remainder.lines) handleCodexLine(line);
    };

    const settle = (status: 'ready' | 'dead', error?: string, drain = false) => {
      if (settled) return;
      settled = true;
      stopSteer();
      if (processTimeout) clearTimeout(processTimeout);
      if (firstEventTimeout) clearTimeout(firstEventTimeout);
      if (drain) drainCrashOutput();
      else stopCrashTail?.();
      finishOrchestratorTurn(crashRecord, error ? 'failed' : 'completed');
      if (proc.exitCode == null && proc.signalCode == null) proc.once('close', cleanupSingleLaunch);
      else cleanupSingleLaunch();
      detachUserAbortListener();
      session.proc = null;
      if (lineState.threadId) session.threadId = lineState.threadId;
      session.status = status;
      if (error) onEvent({ type: 'error', error });
      onEvent({
        type: 'done', terminalOutcome: options.signal?.aborted ? 'unconfirmed' : lineState.terminalOutcome ?? 'unconfirmed',
        sessionId: lineState.threadId,
        cost: lineState.cost,
        ...(lineState.usage ? { usage: lineState.usage } : {}),
      });
      promiseResolve();
    };

    const terminate = (escalateAfterMs: number) => {
      const kill = (signal: NodeJS.Signals) => {
        if (singleProcessGroup && proc.pid) {
          try { process.kill(-proc.pid, signal); return; } catch {
            if (proc.exitCode != null || proc.signalCode != null) return;
          }
        }
        if (proc.exitCode != null || proc.signalCode != null) return;
        proc.kill(signal);
      };
      kill('SIGTERM');
      const escalation = setTimeout(() => {
        kill('SIGKILL');
      }, escalateAfterMs);
      escalation.unref?.();
    };

    if (crashRecord) {
      stopCrashTail = tailJsonlFile({
        filePath: crashRecord.stdoutPath,
        // The file was created empty immediately before spawn. Starting at its
        // post-spawn size can skip a fast child's first event.
        fromOffset: 0,
        alive: () => isPidAlive(crashRecord?.pid) && session.proc === proc,
        onLine: handleCodexLine,
        onOffset: (offset) => { crashTailOffset = offset; },
        onEnd: () => {},
      });
    }

    proc.stdout?.on('data', (chunk: Buffer) => {
      lineBuffer += chunk.toString('utf-8');
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';

      for (const line of lines) {
        handleCodexLine(line);
      }
    });

    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    proc.on('error', (err) => {
      settle('dead', err.message, true);
    });

    proc.on('close', (code) => {
      if (settled) return;
      if (lineBuffer.trim()) {
        handleCodexLine(lineBuffer);
      }
      const crashStderr = crashRecord && code !== 0
        ? readFileSync(crashRecord.stderrPath, 'utf8')
        : '';
      const diagnostic = (stderr || crashStderr).trim();
      // Startup warnings can fill the display limit before the resume failure.
      // Keep that diagnostic visible to the one-time missing-thread recovery.
      const resumeDiagnostic = diagnostic.split(/\r?\n/).find((line) => isMissingCodexRolloutResumeError(line)
        || isCodexSolUnsupported(model, line));
      // Node prints a bundle URL and potentially huge code frame before the error.
      const errorDiagnostic = diagnostic.split(/\r?\n/).find((line) => /^\s*\w*Error(?: \[[^\]]+\])?:/.test(line));
      const error = code === 0
        ? undefined
        : (resumeDiagnostic || errorDiagnostic?.trim() || diagnostic).slice(0, 500) || `codex exited with code ${code}`;
      settle(code === 0 ? 'ready' : 'dead', error, true);
    });

    if (!sawFirstEvent) {
      firstEventTimeout = setTimeout(() => {
        const note = 'Codex produced no output for 45s — the turn was aborted; re-send to retry';
        console.warn(`[codex-orchestrator-session] ${note} (${session.sessionName})`);
        settle('dead', note);
        terminate(2_000);
      }, CODEX_FIRST_EVENT_TIMEOUT_MS);
    }

    processTimeout = setTimeout(() => {
      const minutes = Math.round(PROCESS_TIMEOUT_MS / 60_000);
      const note = `Orchestrator hit the ${minutes}-minute watchdog limit and was terminated — re-send your message to continue.`;
      console.warn(`[codex-orchestrator-session] ${note} (${session.sessionName})`);
      settle('dead', note);
      terminate(5_000);
    }, PROCESS_TIMEOUT_MS);

    userAbortListener = () => {
      console.log(`[codex-orchestrator-session] User interrupt — killing ${session.sessionName}`);
      settle('dead');
      terminate(2_000);
    };
    if (userAbortSignal?.aborted) userAbortListener();
    else userAbortSignal?.addEventListener('abort', userAbortListener, { once: true });
  });
}

/**
 * Reset the codex orchestrator session for a repo — forces the next call to
 * start a fresh codex thread instead of resuming. Used by the conversational
 * reload paths so a new MCP registration takes effect immediately.
 */
export function requestCodexOrchestratorSessionReset(repoPath: string, threadId?: string | null): {
  repoPath: string;
  sessionName: string;
  threadId: string | null;
} {
  return requestRegisteredSessionReset(sessions, {
    repoPath,
    threadId,
    sessionNameFor: codexOrchestratorSessionName,
    resetExisting: (session) => {
      session.threadId = null;
    },
    resetPersistedThread: (normalizedThreadId) => writeOrchestratorBackendSessionId(normalizedThreadId, 'codex', null),
  });
}
