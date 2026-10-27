import { childEnvironment } from '@/lib/providers/spawn-environment';
import { ensureOpenclawGateway } from './openclaw-gateway';
import { buildGovernedO8Profile as buildProfile, prepareOpenclawProfile, OPENCLAW_O8_CONFIG, OPENCLAW_SOURCE_CONFIG } from './openclaw-profile';
import { providerSpawnEnvironment } from '@/lib/providers/spawn-environment';
/**
 * openclaw orchestrator backend.
 *
 * Spawns `openclaw --profile o8 agent --json` once per turn — openclaw as the
 * orchestrator, driving Codex worker packets THROUGH the o8 operator MCP (the
 * `o8__dispatch_mission` tool), never via openclaw's own native spawn. The turn
 * runs against a lazily-spawned o8-profile openclaw gateway (see
 * `ensureOpenclawGateway`) so the operator's real codex-harness agents run.
 *
 * Why this is governed: the dedicated `o8` openclaw profile holds governed
 * COPIES of the operator's real openclaw agents — each copy's `tools.deny`
 * strips the native `sessions_spawn` tool, so the model's ONLY way to dispatch
 * a worker is the o8 MCP tool. That is the structural fix for issue #1075
 * (orchestrator-runtime ≠ worker-runtime). The agent is selected per request.
 *
 * Streaming: openclaw's `agent --json` returns a single final JSON blob
 * (`{ payloads, meta }`), not an incremental event log — so this backend emits
 * the assistant text + a `done` event, with no live tool/thinking deltas. A
 * documented v1 limitation; see docs/internals/openclaw-integration.md.
 */

import { spawn, type ChildProcess } from '@/lib/providers/child-process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import { EffortPinRejectionError } from '@/lib/orchestrator/effort-pin';
import { openclawThinkingFlag } from './openclaw-thinking';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import type { RealtimeMutationRecord } from '@/lib/realtime/types';
import type {
  OrchestratorBackend,
  OrchestratorSessionInfo,
  OrchestratorTurnOptions,
} from './types';
import { resolveOpenclawSpawnBinary } from './openclaw-spawn-preflight';
import { readOpenclawAgentPrimaryModel, type OpenclawAgentResult, resolveOpenclawPromptSeeded } from './openclaw-turn-state';
import { getDataDir } from '@/lib/data-dir-migration';
import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';
import { ORCHESTRATOR_OUTCOME_OWNERSHIP_FALLBACK_V1 } from '@/lib/prompts/v1';
// ── Types ────────────────────────────────────────────────────────────────────
interface OpenclawOrchestratorSession {
  sessionName: string;
  repoPath: string;
  /** openclaw agent id this session orchestrates with (e.g. `main`). */
  agentId: string;
  status: 'ready' | 'busy' | 'dead';
  proc: ChildProcess | null;
  createdAt: number;
  /** True once the o8 orchestrator framing has been seeded into this
   *  session's first message (replaces the removed systemPromptOverride). */
  promptSeeded?: boolean;
}

/**
 * Shape of the JSON blob `openclaw agent --json` writes to stdout. Gateway mode
 * wraps it — `{ status, summary, result: { payloads, meta } }`; the embedded
 * path was flat (`{ payloads, meta }`). Both shapes are unwrapped where parsed.
 */
let openclawRealtimeMutationSeq = 0;
// ── Constants ────────────────────────────────────────────────────────────────
/** Dedicated openclaw profile — isolates state/config under ~/.openclaw-o8. */
const OPENCLAW_PROFILE = 'o8';
/** Mirror of the other orchestrator backends' 4-hour process budget (hang watchdog, not a work budget). */
const PROCESS_TIMEOUT_MS = 14_400_000;
/**
 * The o8 profile gets its OWN gateway port — never the operator's personal
 * openclaw gateway. Probed once and persisted to ~/.o8/openclaw-gateway-port
 * (mirrors ~/.o8/api-port).
 */
const OPENCLAW_GATEWAY_PORT_BASE = 18800;
const OPENCLAW_GATEWAY_PORT_FILE = join(getDataDir(), 'openclaw-gateway-port');
/** The operator's personal openclaw gateway — never reuse this port. */
const OPENCLAW_PERSONAL_GATEWAY_PORT = 18789;

/** Repo-agnostic o8 orchestrator framing; per-repo context rides the turn. */
export const OPENCLAW_ORCHESTRATOR_PROMPT = `You are the orchestrator for o8 — the fleet-level brain that manages AI coding agents across the user's repositories.

You never write code yourself. You dispatch Codex worker agents, each into an isolated git worktree, by calling the \`o8__dispatch_mission\` MCP tool. o8's governance layer — review gate, heal-bot, retries, merge approval — wraps every worker you dispatch.

## The one rule that matters most

never tell the user you dispatched, launched, or started a worker unless you actually called \`o8__dispatch_mission\` in this same turn and saw it succeed. Claiming a dispatch you did not make is the single worst failure — the user trusts your word and walks away while nothing runs. If you cannot dispatch, say so plainly.

## The loop

PLAN -> DISPATCH -> REVIEW -> APPROVE. Each stage is one turn.
- Plan: break the intent into scoped tasks, one Codex worker each.
- Dispatch: call \`o8__dispatch_mission\` — one call per task; parallel is fine.
- Review: on a later turn, inspect the diff with the o8 MCP review tools before approving a merge.

## Turn discipline

- Do the work in this turn. Never narrate future work ("Let me check…") and then stop.
- End on a concrete outcome — what you dispatched, or what specifically blocked you — not a plan.
- Do not promise to "check back" or "review when it's done". You have no timer; the user re-prompts you for the review turn.

## Outcome ownership

${ORCHESTRATOR_OUTCOME_OWNERSHIP_FALLBACK_V1}
Preserve Outcome, Evidence, Residual, and Decision across the durable mission. Read-only and diagnostic work remains non-mutating, and this doctrine never expands your authority.

## o8 operator MCP tools

- \`o8__create_mission\` / \`o8__dispatch_mission\` — create + dispatch worker packets.
- \`o8__get_mission_status\` — poll packet status.
- \`o8__submit_review\` / \`o8__approve_and_merge\` — review + merge a finished packet.`;

// ── Session registry ─────────────────────────────────────────────────────────

const sessions = new Map<string, OpenclawOrchestratorSession>();

function normalizeRepoPath(repoPath: string): string {
  return resolve(repoPath).replace(/\/+$/, '');
}

function repoHash(repoPath: string): string {
  return createHash('sha256').update(repoPath).digest('hex').slice(0, 8);
}

/** Filesystem/CLI-safe form of an openclaw agent id. */
function sanitizeAgentId(agentId: string): string {
  return agentId.trim().replace(/[^a-zA-Z0-9_-]/g, '_') || 'default';
}

/**
 * Session name is keyed per repo + agent — the same repo orchestrated by two
 * different openclaw agents is two independent sessions (separate transcripts,
 * separate `--session-id`). See docs/internals/openclaw-integration.md.
 */
export function openclawOrchestratorSessionName(repoPath: string, agentId: string): string {
  return `o8-openclaw-orchestrator-${repoHash(normalizeRepoPath(repoPath))}-${sanitizeAgentId(agentId)}`;
}

function getSession(repoPath: string, agentId: string): OpenclawOrchestratorSession | null {
  return sessions.get(openclawOrchestratorSessionName(repoPath, agentId)) ?? null;
}

function ensureSession(repoPath: string, agentId: string): OpenclawOrchestratorSession {
  const normalizedRepoPath = normalizeRepoPath(repoPath);
  const sessionName = openclawOrchestratorSessionName(normalizedRepoPath, agentId);
  const existing = sessions.get(sessionName);
  if (existing && existing.status !== 'dead') {
    return existing;
  }

  const session: OpenclawOrchestratorSession = {
    sessionName,
    repoPath: normalizedRepoPath,
    agentId,
    status: 'ready',
    proc: null,
    createdAt: Date.now(),
  };
  sessions.set(sessionName, session);
  console.log(`[openclaw-orchestrator] Created ${sessionName} for ${normalizedRepoPath} (agent ${agentId})`);
  return session;
}

// ── o8 profile setup ─────────────────────────────────────────────────────────

/**
 * Govern one openclaw agent for use as the o8 orchestrator: a full copy of the
 * operator's agent with two changes —
 *   1. `sessions_spawn` is forced into `tools.deny` (and stripped from
 *      `tools.alsoAllow`) so the model's ONLY dispatch path is the o8 MCP
 *      `o8__dispatch_mission` tool. This is the #1075 lockout.
 *   2. the o8 orchestrator framing is prepended to `systemPromptOverride` so
 *      the agent follows the dispatch loop + the anti-fake-claim rule, while
 *      keeping any prompt the agent already had.
 * The operator's real agent (~/.openclaw) is never modified — only this copy.
 */
/**
 * Model ids the governed agent accepts as a `--model` override — the keys of
 * its `agents.list[].models` map (OpenClaw 2026.7.1 treats that map as the
 * per-agent allowlist; an id outside it hard-errors the turn:
 * `Model override "X" is not allowed for agent "Y"`, live-hit 2026-07-16 when
 * a thread's Codex model chip leaked across a backend switch). Empty set on
 * any read failure — callers then skip the override and the agent uses its
 * configured primary.
 */
export function openclawAgentAllowedModels(agentId: string): Set<string> {
  try {
    const source = JSON.parse(readFileSync(OPENCLAW_O8_CONFIG, 'utf8')) as {
      agents?: { list?: Array<{ id?: unknown; models?: Record<string, unknown> }> };
    };
    const agent = (source.agents?.list ?? []).find((a) => a.id === agentId);
    if (!agent?.models || typeof agent.models !== 'object') return new Set();
    return new Set(Object.keys(agent.models));
  } catch {
    return new Set();
  }
}

/** The operator's openclaw agents — `{ id, name }` per entry in `agents.list`. */
export function listOpenclawAgents(): Array<{ id: string; name: string }> {
  try {
    const source = JSON.parse(readFileSync(OPENCLAW_SOURCE_CONFIG, 'utf8')) as {
      agents?: { list?: Array<{ id?: unknown; name?: unknown }> };
    };
    const rawList = source.agents?.list;
    const list = Array.isArray(rawList) ? rawList : [];
    return list
      .map((a) => {
        const id = typeof a.id === 'string' ? a.id : '';
        const name = typeof a.name === 'string' && a.name.trim() ? a.name : id;
        return { id, name };
      })
      .filter((a) => a.id);
  } catch {
    return [];
  }
}

/**
 * Resolve the openclaw agent id for a turn: the per-request `agent` when given,
 * else the first agent in the operator's profile (the headless-path default),
 * else a last-resort fallback.
 */
export function resolveOpenclawAgentId(requested?: string): string {
  const trimmed = requested?.trim();
  if (trimmed) return trimmed;
  return listOpenclawAgents()[0]?.id ?? 'main';
}

/** Read the persisted o8 gateway port — null when unset/invalid. */
function readOpenclawGatewayPort(): number | null {
  try {
    const port = Number.parseInt(readFileSync(OPENCLAW_GATEWAY_PORT_FILE, 'utf8').trim(), 10);
    return Number.isInteger(port)
      && port > 1024
      && port < 65536
      && port !== OPENCLAW_PERSONAL_GATEWAY_PORT
      ? port
      : null;
  } catch {
    return null;
  }
}

/** Probe a single TCP port on loopback — resolves true when the port is free. */
function probePort(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.once('error', () => resolvePort(false));
    server.once('listening', () => server.close(() => resolvePort(true)));
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Ensure the o8 profile has its own gateway port — allocated once, persisted to
 * ~/.o8/openclaw-gateway-port. Never the operator's personal openclaw gateway
 * (:18789). Call before `ensureOpenclawProfile()` so the generated config can
 * read the dedicated port.
 */
export async function ensureOpenclawGatewayPort(): Promise<number> {
  const existing = readOpenclawGatewayPort();
  if (existing !== null) return existing;

  let port = OPENCLAW_GATEWAY_PORT_BASE;
  for (
    let candidate = OPENCLAW_GATEWAY_PORT_BASE;
    candidate < OPENCLAW_GATEWAY_PORT_BASE + 200;
    candidate++
  ) {
    if (candidate === OPENCLAW_PERSONAL_GATEWAY_PORT) continue;
    if (await probePort(candidate)) {
      port = candidate;
      break;
    }
  }

  mkdirSync(getDataDir(), { recursive: true });
  writeFileSync(OPENCLAW_GATEWAY_PORT_FILE, `${port}\n`, 'utf8');
  console.log(`[openclaw-orchestrator] Allocated o8 gateway port ${port} -> ${OPENCLAW_GATEWAY_PORT_FILE}`);
  return port;
}

// ── o8 profile gateway ───────────────────────────────────────────────────────

// ── Turn message ─────────────────────────────────────────────────────────────

/** Prepend fleet/repo context to the user message (the system prompt is repo-agnostic). */
function buildRepoContextPreamble(repoPath: string): string {
  const repoName = repoPath.split('/').filter(Boolean).pop() ?? repoPath;

  let repoList = `  - ${repoName} -> ${repoPath}`;
  try {
    const reposFile = join(getDataDir(), 'repos.json');
    if (existsSync(reposFile)) {
      const parsed = JSON.parse(readFileSync(reposFile, 'utf8')) as {
        repos?: Array<{ name?: string; localPath: string }>;
      };
      const repos = parsed.repos ?? [];
      if (repos.length > 0) {
        repoList = repos
          .map((r) => `  - ${r.name ?? r.localPath.split('/').filter(Boolean).pop() ?? r.localPath} -> ${r.localPath}`)
          .join('\n');
      }
    }
  } catch {
    // Best effort — fall back to the primary repo only.
  }

  return [
    '[o8 fleet context]',
    `Primary repo: ${repoName} at ${repoPath}`,
    'Registered repos:',
    repoList,
    '',
    '',
  ].join('\n');
}

function publishOpenclawRealtimeEvent(
  session: OpenclawOrchestratorSession,
  event: OrchestratorEvent,
  threadId: string | null,
): void {
  const base = {
    repoPath: session.repoPath,
    threadId,
    backend: 'openclaw' as const,
    agent: session.agentId,
  };
  const realtime = event.type === 'text'
    ? { event: 'output' as const, action: 'orchestrator-output', status: 'completed' as const, note: `openclaw assistant output (${event.text.length} chars)`, data: { ...base, text: event.text, thinking: false } }
    : event.type === 'error'
      ? { event: 'error' as const, action: 'orchestrator-error', status: 'failed' as const, note: event.error.slice(0, 240), data: { ...base, error: event.error } }
      : event.type === 'done'
        ? { event: 'status' as const, action: 'orchestrator-status', status: 'completed' as const, note: 'openclaw orchestrator turn completed', data: { ...base, status: 'ready' as const, sessionId: event.sessionId, cost: event.cost } }
        : null;
  if (!realtime) return;

  const createdAt = new Date().toISOString();
  const mutation = {
    mutationId: `openclaw-${realtime.event}-${Date.now()}-${openclawRealtimeMutationSeq += 1}`,
    source: 'server',
    action: realtime.action,
    status: realtime.status,
    runtime: 'openclaw',
    surfaceId: session.sessionName,
    sessionKey: session.sessionName,
    repoPath: session.repoPath,
    note: realtime.note,
    createdAt,
    settledAt: createdAt,
    channel: 'orchestrator',
    event: realtime.event,
    data: realtime.data,
  } as RealtimeMutationRecord;
  void publishRealtimeMutation({ mutation, fresh: true });
}

// ── Send turn ────────────────────────────────────────────────────────────────

async function sendToOpenclawOrchestrator(
  session: OpenclawOrchestratorSession,
  message: string,
  onEvent: (event: OrchestratorEvent) => void,
  options: OrchestratorTurnOptions = {},
): Promise<void> {
  if (session.status === 'dead') {
    console.log(`[openclaw-orchestrator] Auto-recovering dead session ${session.sessionName}`);
    session.status = 'ready';
    session.proc = null;
  }
  if (session.status === 'busy') {
    throw new Error('openclaw orchestrator session is busy');
  }

  session.status = 'busy';
  const emitEvent = (event: OrchestratorEvent) => { onEvent(event); publishOpenclawRealtimeEvent(session, event, options.threadId ?? null); };

  let openclawBin: string;
  let thinking: Awaited<ReturnType<typeof openclawThinkingFlag>>;
  try {
    openclawBin = await resolveOpenclawSpawnBinary(session.repoPath);
    thinking = await openclawThinkingFlag(openclawBin, options.thinkingEffort);
    const gatewayPort = await ensureOpenclawGatewayPort();
    ensureOpenclawProfile();
    await ensureOpenclawGateway(gatewayPort, openclawBin);
  } catch (err) {
    session.status = 'dead';
    emitEvent({ type: 'error', error: err instanceof Error ? err.message : String(err),
      ...(err instanceof EffortPinRejectionError ? { code: err.code } : {}) });
    emitEvent({ type: 'done', sessionId: session.sessionName, cost: null });
    return;
  }

  // First turn of a session carries the orchestrator framing that used to
  // live in the (now-removed) systemPromptOverride config key — the session
  // retains it as conversation context for every later turn.
  const includesFraming = !session.promptSeeded;
  const framing = includesFraming ? `${OPENCLAW_ORCHESTRATOR_PROMPT}\n\n---\n\n` : '';
  const fullMessage = framing + buildRepoContextPreamble(session.repoPath) + message;

  const args = [
    '--profile', OPENCLAW_PROFILE,
    'agent',
    '--json',
    '--agent', session.agentId,
    '--session-id', session.sessionName,
    '--message', fullMessage,
  ];
  if (thinking) args.push('--thinking', thinking);
  const requestedModel = options.model?.trim();
  let effectiveModel = readOpenclawAgentPrimaryModel(OPENCLAW_O8_CONFIG, session.agentId);
  if (requestedModel) {
    const allowed = openclawAgentAllowedModels(session.agentId);
    if (allowed.has(requestedModel)) {
      args.push('--model', requestedModel);
      effectiveModel = requestedModel;
    } else {
      // A model chip from another backend (e.g. a Codex id after a backend
      // switch) hard-errors the whole turn in OpenClaw 2026.7.1. Use the
      // agent's configured primary instead and say so, rather than dying.
      console.log(`[openclaw-orchestrator] model override ${requestedModel} not in agent ${session.agentId} allowlist (${[...allowed].join(', ') || 'none readable'}); using the agent's default model`);
      emitEvent({ type: 'thinking', text: `Model ${requestedModel} isn't configured for the OpenClaw agent "${session.agentId}" — using its default model instead.` });
    }
  }
  emitEvent({ type: 'turn_receipt', leadModel: effectiveModel, effort: thinking ?? 'adaptive' });
  console.log(`[openclaw-diag] spawn args: ${args.map((a, i) => (args[i - 1] === '--message' ? `<message ${fullMessage.length} chars>` : a)).join(' ')}`);
  return new Promise<void>((promiseResolve, promiseReject) => {
    const launch = cliInvocation(openclawBin, args);
    const proc = spawn(launch.command, launch.args, { windowsHide: true,
      cwd: session.repoPath,
      env: providerSpawnEnvironment(childEnvironment({ runtimeId: 'openclaw', env: { FORCE_COLOR: '0', NO_COLOR: '1', O8_MANAGED_SESSION: '1' } }), { runtimeId: 'openclaw' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    session.proc = proc;

    const processTimeout = setTimeout(() => {
      console.warn(`[openclaw-orchestrator] Process timeout (${PROCESS_TIMEOUT_MS}ms) — killing ${session.sessionName}`);
      // Surface the kill to the chat — mirrors orchestrator-session.ts so the
      // user sees a small terminating note instead of a silent freeze.
      const minutes = Math.round(PROCESS_TIMEOUT_MS / 60_000);
      emitEvent({
        type: 'error',
        error: `Orchestrator hit the ${minutes}-minute watchdog limit and was terminated — a turn running this long has almost certainly hung. Re-send your message to continue.`,
      });
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 5_000);
    }, PROCESS_TIMEOUT_MS);

    const userAbortSignal = options.signal;
    let userAbortListener: (() => void) | null = null;
    if (userAbortSignal) {
      if (userAbortSignal.aborted) {
        proc.kill('SIGTERM');
      } else {
        userAbortListener = () => {
          console.log(`[openclaw-orchestrator] User interrupt — killing ${session.sessionName}`);
          if (!proc.killed) proc.kill('SIGTERM');
          setTimeout(() => {
            if (!proc.killed) proc.kill('SIGKILL');
          }, 2_000);
        };
        userAbortSignal.addEventListener('abort', userAbortListener, { once: true });
      }
    }
    const detachUserAbortListener = () => {
      if (userAbortSignal && userAbortListener) {
        userAbortSignal.removeEventListener('abort', userAbortListener);
        userAbortListener = null;
      }
    };

    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8'); });
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });

    proc.on('error', (err) => {
      clearTimeout(processTimeout);
      detachUserAbortListener();
      session.status = 'dead';
      session.proc = null;
      emitEvent({ type: 'error', error: err.message });
      promiseReject(err);
    });

    proc.on('close', (code) => {
      clearTimeout(processTimeout);
      detachUserAbortListener();
      session.proc = null;
      session.status = code === 0 ? 'ready' : 'dead';

      // openclaw `--json` writes one final JSON blob to stdout (not a stream).
      let parsed: OpenclawAgentResult | null = null;
      const trimmed = stdout.trim();
      if (trimmed) {
        try {
          parsed = JSON.parse(trimmed) as OpenclawAgentResult;
        } catch {
          parsed = null;
        }
      }

      console.log(`[openclaw-diag] close: code=${code} stdoutBytes=${stdout.length} stderrBytes=${stderr.length} parsed=${parsed ? 'OK' : 'NULL'}`);
      console.log(`[openclaw-diag] stdout head: ${JSON.stringify(stdout.slice(0, 600))}`);
      if (stderr.trim()) console.log(`[openclaw-diag] stderr head: ${JSON.stringify(stderr.slice(0, 600))}`);

      let assistantText = '';
      if (parsed) {
        // Gateway mode wraps the result — `{ status, result: { payloads, meta } }`;
        // the embedded path was flat. Unwrap `result` when present.
        const resultBlock = parsed.result ?? parsed;
        const text = (resultBlock.payloads ?? [])
          .map((p) => (typeof p.text === 'string' ? p.text : ''))
          .filter(Boolean)
          .join('\n\n');
        assistantText = text;
        if (!assistantText && typeof resultBlock.meta?.finalAssistantVisibleText === 'string') {
          assistantText = resultBlock.meta.finalAssistantVisibleText;
        }
        console.log(`[openclaw-diag] resultBlock keys=[${Object.keys(resultBlock).join(',')}] payloads=${(resultBlock.payloads ?? []).length} textLen=${assistantText.length}`);
        if (assistantText) {
          emitEvent({ type: 'text', text: assistantText });
        } else if (code === 0) {
          emitEvent({ type: 'error', error: `openclaw returned no assistant text: ${trimmed.slice(0, 500)}` });
        }
      } else if (code === 0) {
        // Exited clean but stdout wasn't parseable JSON — surface it so the
        // turn isn't silently empty.
        emitEvent({ type: 'error', error: `openclaw returned unparseable output: ${trimmed.slice(0, 500)}` });
      }

      if (code !== 0) {
        const rawError = stderr.trim().slice(0, 500) || `openclaw exited with code ${code}`;
        // Stale-credential class (the governed profile's OAuth token expired
        // or its refresh token was consumed — single-use). The raw gateway
        // error is undiagnosable from the chat surface; say exactly what to
        // run instead (2026-07-16 saga: the o8 profile carried a token that
        // expired six weeks earlier and every turn died cryptically).
        const isStaleAuth = /refresh token has already been used|token refresh failed|please try signing in again/i.test(rawError);
        emitEvent({
          type: 'error',
          error: isStaleAuth
            ? `OpenClaw's o8 profile login has expired (its copy of your credentials went stale). One-time fix — run this in a terminal, then retry:\n\nopenclaw --profile o8 models auth --agent ${session.agentId} setup-token --provider openai --yes\n\n(${rawError.slice(0, 200)})`
            : rawError,
        });
      }

      session.promptSeeded = resolveOpenclawPromptSeeded(
        session.promptSeeded === true,
        code,
        assistantText,
      );

      emitEvent({ type: 'done', sessionId: session.sessionName, cost: null });
      promiseResolve();
    });
  });
}

// ── Backend ──────────────────────────────────────────────────────────────────

export const openclawBackend: OrchestratorBackend = {
  id: 'openclaw',
  label: 'openclaw',
  peekSession(repoPath, agent): OrchestratorSessionInfo | null {
    const session = getSession(repoPath, resolveOpenclawAgentId(agent));
    return session ? { sessionName: session.sessionName, status: session.status } : null;
  },
  ensureSession(repoPath, agent): OrchestratorSessionInfo {
    const session = ensureSession(repoPath, resolveOpenclawAgentId(agent));
    return { sessionName: session.sessionName, status: session.status };
  },
  sendTurn(repoPath, message, onEvent, options) {
    const session = ensureSession(repoPath, resolveOpenclawAgentId(options?.agent));
    return sendToOpenclawOrchestrator(session, message, onEvent, options);
  },
};

export function buildGovernedO8Profile(source: Record<string, unknown>, o8Entry: unknown): Record<string, unknown> {
  return buildProfile(source, o8Entry, readOpenclawGatewayPort() ?? OPENCLAW_GATEWAY_PORT_BASE);
}
export function ensureOpenclawProfile(): void {
  prepareOpenclawProfile(readOpenclawGatewayPort() ?? OPENCLAW_GATEWAY_PORT_BASE);
}
