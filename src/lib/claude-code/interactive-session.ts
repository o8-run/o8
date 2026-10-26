import { withProviderStoreLock } from '@/lib/providers/store-lock';
import { assertNotKnowledgeSource } from '@/lib/cortex/knowledge/sources';
import { childEnvironment } from '@/lib/providers/spawn-environment';
import { credentialPolicyFingerprint } from '@/lib/providers/credential-policy';
import { providerSpawnEnvironment } from '@/lib/providers/spawn-environment';
import 'server-only';

import { spawn } from '@/lib/providers/child-process';
import { existsSync } from 'node:fs';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  createClaudeCodeStreamJsonParser,
} from './stream-json-parser';
import { assertNoPrintFlag } from './assert-no-print-flag';
import { resolveClaudeBinary } from '@/lib/runtimes/shared/cli-locate';
import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';
import { claudeEffortFlagValue, type ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type {
  ClaudeCodeStreamJsonParser,
  ClaudeCodeStreamJsonParserEvent,
  ClaudeCodeStreamJsonParserOptions,
} from './stream-json-parser';

export type ClaudeCodeInteractiveSessionStatus = 'ready' | 'busy' | 'dead';
export type ClaudeCodePermissionMode = 'acceptEdits' | 'plan' | 'bypassPermissions';

export interface ClaudeCodeInteractiveSession {
  tabId: string;
  cwd: string;
  model: string | null;
  permissionMode: ClaudeCodePermissionMode;
  proc: ChildProcessWithoutNullStreams;
  sessionId: string | null;
  status: ClaudeCodeInteractiveSessionStatus;
  stdinWritable: boolean;
  createdAt: number;
  lastUsedAt: number;
}

export interface SendClaudeCodeInteractiveMessageOptions extends ClaudeCodeStreamJsonParserOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

type InteractiveTurn = {
  parser: ClaudeCodeStreamJsonParser;
  onEvent: (event: ClaudeCodeStreamJsonParserEvent) => void;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  abortSignal: AbortSignal | null;
  abortListener: (() => void) | null;
  settled: boolean;
};

interface InternalClaudeCodeInteractiveSession extends ClaudeCodeInteractiveSession {
  credentialPolicy: string;
  idleTimer: ReturnType<typeof setTimeout> | null;
  stdoutLineBuffer: string;
  stderrBuffer: string;
  activeTurn: InteractiveTurn | null;
}

const PROCESS_TIMEOUT_MS = 1_800_000;
const IDLE_TIMEOUT_MS = 30 * 60_000;
const sessions = new Map<string, InternalClaudeCodeInteractiveSession>();
type PermissionRequestEvent = Extract<ClaudeCodeStreamJsonParserEvent, { type: 'permission_request' }>;

// Shared validated resolver (F6JHXW): env override, then a per-call
// re-validated scan — rides through Claude's non-atomic self-updates and
// finds npm/brew/nvm installs the old hardcoded default never could.
function claudeCodeBin(): string {
  return resolveClaudeBinary();
}

function normalizeCwd(cwd: string): string {
  return resolve(cwd.replace(/^~/, homedir())).replace(/\/+$/, '');
}

function normalizeModel(model: string | undefined): string | null {
  const trimmed = model?.trim();
  return trimmed ? trimmed : null;
}

function normalizePermissionMode(permissionMode?: ClaudeCodePermissionMode): ClaudeCodePermissionMode {
  return permissionMode ?? 'acceptEdits';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function sessionIdFromEvent(event: Record<string, unknown>): string | null {
  const type = typeof event.type === 'string' ? event.type : '';
  if (type !== 'init' && type !== 'system' && type !== 'result') {
    return null;
  }

  const rawSessionId = event.session_id ?? event.sessionId;
  return typeof rawSessionId === 'string' && rawSessionId.trim()
    ? rawSessionId
    : null;
}

function permissionRequestFromEvent(event: Record<string, unknown>): PermissionRequestEvent | null {
  if (event.type !== 'can_use_tool') return null;

  const args = asRecord(event.input) ?? asRecord(event.args) ?? undefined;
  const name = asString(event.name) ?? asString(event.tool_name) ?? asString(event.tool);
  const text = asString(event.text)
    ?? asString(event.message)
    ?? asString(event.reason)
    ?? (name
      ? `Claude is requesting permission to use ${name}.`
      : 'Claude is requesting permission to use a tool.');

  return {
    type: 'permission_request',
    id: asString(event.id) ?? asString(event.tool_use_id) ?? null,
    name,
    text,
    ...(args ? { args } : {}),
  };
}

function normalizeResumeSessionId(sessionId?: string | null): string | null {
  const trimmed = sessionId?.trim();
  if (!trimmed) return null;
  const unprefixed = trimmed.startsWith('claude-code:')
    ? trimmed.slice('claude-code:'.length)
    : trimmed;
  return unprefixed.trim() || null;
}

export function buildClaudeStreamJsonArgs(
  model: string | null,
  permissionMode: ClaudeCodePermissionMode,
  resumeSessionId?: string | null,
  effort?: ThinkingEffort,
): string[] {
  const args = [
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    permissionMode,
    '--include-partial-messages',
  ];

  if (model) {
    args.push('--model', model);
  }

  if (effort && effort !== 'adaptive') {
    args.push('--effort', claudeEffortFlagValue(effort));
  }

  const normalizedResumeSessionId = normalizeResumeSessionId(resumeSessionId);
  if (normalizedResumeSessionId) {
    args.push('--resume', normalizedResumeSessionId);
  }

  assertNoPrintFlag(args, 'Interactive Claude Code sessions');
  if (args.includes('--dangerously-skip-permissions')) {
    throw new Error('Interactive Claude Code sessions must not default to --dangerously-skip-permissions');
  }

  return args;
}

export function buildClaudeStreamJsonUserPayload(text: string): string {
  return `${JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: text,
    },
  })}\n`;
}

function clearIdleTimer(session: InternalClaudeCodeInteractiveSession): void {
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
}

function killProcess(proc: ChildProcessWithoutNullStreams): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill('SIGTERM');
  setTimeout(() => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  }, 2_000);
}

function detachAbortListener(turn: InteractiveTurn): void {
  if (turn.abortSignal && turn.abortListener) {
    turn.abortSignal.removeEventListener('abort', turn.abortListener);
    turn.abortListener = null;
  }
}

function scheduleIdleKill(session: InternalClaudeCodeInteractiveSession): void {
  clearIdleTimer(session);
  if (session.status === 'dead') return;

  session.idleTimer = setTimeout(() => {
    console.log(`[claude-code-interactive-session] Idle timeout — killing ${session.tabId}`);
    killClaudeCodeInteractiveSession(session.tabId);
  }, IDLE_TIMEOUT_MS);
}

function captureSessionMetadata(
  session: InternalClaudeCodeInteractiveSession,
  chunk: string,
): PermissionRequestEvent[] {
  session.stdoutLineBuffer += chunk;
  const lines = session.stdoutLineBuffer.split('\n');
  session.stdoutLineBuffer = lines.pop() ?? '';
  const permissionEvents: PermissionRequestEvent[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = asRecord(JSON.parse(trimmed));
      const sessionId = parsed ? sessionIdFromEvent(parsed) : null;
      if (sessionId) {
        session.sessionId = sessionId;
      }
      const permissionEvent = parsed ? permissionRequestFromEvent(parsed) : null;
      if (permissionEvent) permissionEvents.push(permissionEvent);
    } catch {
      // Ignore non-JSON banners; the stream-json parser applies the same rule.
    }
  }
  return permissionEvents;
}

function settleTurn(
  session: InternalClaudeCodeInteractiveSession,
  error: Error | null,
): void {
  const turn = session.activeTurn;
  if (!turn || turn.settled) return;

  turn.settled = true;
  clearTimeout(turn.timeout);
  detachAbortListener(turn);
  session.activeTurn = null;
  session.lastUsedAt = Date.now();

  if (session.status !== 'dead') {
    session.status = 'ready';
    scheduleIdleKill(session);
  }

  if (error) {
    turn.reject(error);
  } else {
    turn.resolve();
  }
}

function flushActiveTurn(
  session: InternalClaudeCodeInteractiveSession,
): void {
  const turn = session.activeTurn;
  if (turn) handleParserEvents(session, turn.parser.flush());
}

function handleParserEvents(
  session: InternalClaudeCodeInteractiveSession,
  events: ClaudeCodeStreamJsonParserEvent[],
): void {
  const turn = session.activeTurn;
  if (!turn) return;

  for (const event of events) {
    if (event.type === 'done' && event.sessionId) {
      session.sessionId = event.sessionId;
    }
    if (event.type === 'done' && event.isError) {
      // Consumers use done to render success. Reject before forwarding it so
      // the streaming route emits an error instead of a successful close.
      settleTurn(session, new Error('Worker returned a failed result.'));
      return;
    }
    turn.onEvent(event);
    if (event.type === 'done') {
      settleTurn(session, null);
      return;
    }
  }
}

function markDead(session: InternalClaudeCodeInteractiveSession): void {
  clearIdleTimer(session);
  session.status = 'dead';
  session.stdinWritable = false;
}

function attachProcessHandlers(session: InternalClaudeCodeInteractiveSession): void {
  const { proc } = session;

  proc.stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    const permissionEvents = captureSessionMetadata(session, text);
    const turn = session.activeTurn;
    if (turn) {
      const parserEvents = turn.parser.pushChunk(text);
      handleParserEvents(session, permissionEvents.length ? [...permissionEvents, ...parserEvents] : parserEvents);
    }
  });

  proc.stderr.on('data', (chunk: Buffer) => {
    session.stderrBuffer += chunk.toString('utf8');
    if (session.stderrBuffer.length > 4_000) {
      session.stderrBuffer = session.stderrBuffer.slice(-4_000);
    }
  });

  proc.stdin.on('error', () => {
    session.stdinWritable = false;
  });
  proc.stdin.on('close', () => {
    session.stdinWritable = false;
  });
  proc.stdin.on('finish', () => {
    session.stdinWritable = false;
  });

  proc.on('error', (err) => {
    markDead(session);
    settleTurn(session, err);
  });

  proc.on('close', (code, signal) => {
    markDead(session);
    flushActiveTurn(session);
    if (!session.activeTurn) return;

    const suffix = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
    const stderr = session.stderrBuffer.trim();
    const error = new Error(
      `Claude Code interactive session exited before completing the turn (${suffix})${stderr ? `: ${stderr.slice(0, 500)}` : ''}`,
    );
    settleTurn(session, error);
  });
}

function spawnSession(
  tabId: string,
  cwd: string,
  model: string | null,
  permissionMode: ClaudeCodePermissionMode,
  resumeSessionId?: string | null,
): InternalClaudeCodeInteractiveSession {
  const normalizedResumeSessionId = normalizeResumeSessionId(resumeSessionId);
  // Node's spawn reports a missing WORKING DIRECTORY as "spawn <binary>
  // ENOENT" — preflight the cwd so a moved/deleted repo folder fails with
  // the truth instead of implicating a healthy claude install (FKAR3B).
  if (!existsSync(cwd)) {
    throw new Error(
      `This chat's repo folder no longer exists at ${cwd} — it may have been moved or deleted. `
      + 'Re-add the repo or fix its path, then start a new session.',
    );
  }
  const launch = cliInvocation(
    claudeCodeBin(),
    buildClaudeStreamJsonArgs(model, permissionMode, normalizedResumeSessionId),
  );
  const credentialPolicy = credentialPolicyFingerprint('claude-code');
  const proc = spawn(launch.command, launch.args, {
    windowsHide: true,
    cwd,
    env: providerSpawnEnvironment(childEnvironment({ runtimeId: 'claude-code', env: { FORCE_COLOR: '0', O8_MANAGED_SESSION: '1' } }), { runtimeId: 'claude-code' }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const session: InternalClaudeCodeInteractiveSession = {
    credentialPolicy,
    tabId,
    cwd,
    model,
    permissionMode,
    proc,
    sessionId: normalizedResumeSessionId,
    status: 'ready',
    stdinWritable: Boolean(proc.stdin.writable && !proc.stdin.destroyed),
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    idleTimer: null,
    stdoutLineBuffer: '',
    stderrBuffer: '',
    activeTurn: null,
  };

  attachProcessHandlers(session);
  scheduleIdleKill(session);
  sessions.set(tabId, session);
  console.log(
    `[claude-code-interactive-session] Spawned ${tabId} in ${cwd} (${permissionMode})${normalizedResumeSessionId ? ' with resume' : ''}`,
  );
  return session;
}

export function getClaudeCodeInteractiveSession(
  tabId: string,
): ClaudeCodeInteractiveSession | null {
  return sessions.get(tabId) ?? null;
}

export function ensureSession(
  tabId: string,
  cwd: string,
  model?: string,
  permissionMode?: ClaudeCodePermissionMode,
  resumeSessionId?: string | null,
): ClaudeCodeInteractiveSession {
  assertNotKnowledgeSource(cwd);
  const normalizedCwd = normalizeCwd(cwd);
  assertNotKnowledgeSource(normalizedCwd);
  const normalizedModel = normalizeModel(model);
  const normalizedPermissionMode = normalizePermissionMode(permissionMode);
  const existing = sessions.get(tabId);

  // Permission mode is process-scoped, so a mode change must get a fresh process.
  if (
    existing
    && existing.status !== 'dead'
    && existing.credentialPolicy === credentialPolicyFingerprint('claude-code')
    && existing.cwd === normalizedCwd
    && existing.model === normalizedModel
    && existing.permissionMode === normalizedPermissionMode
  ) {
    return existing;
  }

  // Resume target: prefer the captured session_id of the session being
  // replaced — this carries live conversation context across a
  // mode/model/cwd change — and fall back to the caller-supplied id for a
  // true cold start (no in-memory session at all).
  const effectiveResumeSessionId = existing?.sessionId ?? resumeSessionId ?? null;

  if (existing) {
    killClaudeCodeInteractiveSession(tabId);
  }

  return spawnSession(
    tabId,
    normalizedCwd,
    normalizedModel,
    normalizedPermissionMode,
    effectiveResumeSessionId,
  );
}

export async function sendMessage(
  session: ClaudeCodeInteractiveSession,
  text: string,
  onEvent: (event: ClaudeCodeStreamJsonParserEvent) => void,
  options: SendClaudeCodeInteractiveMessageOptions = {},
): Promise<void> {
  const internal = session as InternalClaudeCodeInteractiveSession;
  assertNotKnowledgeSource(internal.cwd);
  if (internal.credentialPolicy !== credentialPolicyFingerprint('claude-code')) {
    killClaudeCodeInteractiveSession(internal.tabId);
    throw new Error('Credentials or billing changed. Retry the launch.');
  }
  if (!text.trim()) {
    throw new Error('Message is required');
  }
  if (internal.status === 'dead') {
    throw new Error('Claude Code interactive session is dead');
  }
  if (internal.status === 'busy') {
    throw new Error('Claude Code interactive session is busy');
  }
  if (!internal.stdinWritable || internal.proc.stdin.destroyed) {
    internal.status = 'dead';
    throw new Error('Claude Code interactive session stdin is not writable');
  }

  clearIdleTimer(internal);
  internal.status = 'busy';
  internal.lastUsedAt = Date.now();

  return new Promise<void>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      console.warn(`[claude-code-interactive-session] Process timeout (${options.timeoutMs ?? PROCESS_TIMEOUT_MS}ms) — killing ${internal.tabId}`);
      killClaudeCodeInteractiveSession(internal.tabId);
      settleTurn(internal, new Error('Claude Code interactive session timed out'));
    }, options.timeoutMs ?? PROCESS_TIMEOUT_MS);

    const turn: InteractiveTurn = {
      parser: createClaudeCodeStreamJsonParser(options),
      onEvent,
      resolve: resolvePromise,
      reject: rejectPromise,
      timeout,
      abortSignal: options.signal ?? null,
      abortListener: null,
      settled: false,
    };
    internal.activeTurn = turn;

    if (options.signal) {
      if (options.signal.aborted) {
        killClaudeCodeInteractiveSession(internal.tabId);
        settleTurn(internal, new Error('Claude Code interactive session was aborted'));
        return;
      }
      turn.abortListener = () => {
        console.log(`[claude-code-interactive-session] User interrupt — killing ${internal.tabId}`);
        killClaudeCodeInteractiveSession(internal.tabId);
        settleTurn(internal, new Error('Claude Code interactive session was aborted'));
      };
      options.signal.addEventListener('abort', turn.abortListener, { once: true });
    }

    const payload = buildClaudeStreamJsonUserPayload(text);

    try {
      withProviderStoreLock(() => {
        if (internal.credentialPolicy !== credentialPolicyFingerprint('claude-code')) throw new Error('Credentials or billing changed. Retry the launch.');
        internal.proc.stdin.write(payload, 'utf8', (error?: Error | null) => {
          if (error) {
            internal.stdinWritable = false;
            internal.status = 'dead';
            settleTurn(internal, error);
          }
        });
      });
    } catch (error) {
      internal.stdinWritable = false;
      internal.status = 'dead';
      settleTurn(
        internal,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  });
}

export function killClaudeCodeInteractiveSession(tabId: string): boolean {
  const session = sessions.get(tabId);
  if (!session) return false;

  markDead(session);
  sessions.delete(tabId);
  killProcess(session.proc);
  return true;
}

export function killSession(tabId: string): boolean {
  return killClaudeCodeInteractiveSession(tabId);
}

export function killAllClaudeCodeInteractiveSessions(): void {
  for (const tabId of Array.from(sessions.keys())) {
    killClaudeCodeInteractiveSession(tabId);
  }
}
