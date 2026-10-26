import { unmappedEffortError } from './unmapped-effort';
import { join } from 'node:path';
import { credentialPolicyFingerprint } from '@/lib/providers/credential-policy';
import { resolveLocalAcpLaunch, localAcpProcessLaunch, acpLaunchFingerprint } from '@/lib/acp/local-connection';
import { resolveOpenRouterKey } from '@/lib/cortex/qa/llm/byok-keys';
/**
 * Generic ACP orchestrator backend.
 *
 * Drives ANY Agent-Client-Protocol agent (agentclientprotocol.com) as an o8
 * orchestrator backend, on top of `@/lib/acp/client`. Parameterized by launch
 * command, so Hermes (`hermes acp`) is just the first agent — openclaw acpx /
 * Zed / any ACP agent ride the same backend via a different launch config.
 *
 * Session model: one long-lived agent subprocess (an AcpClient) per
 * repo+thread, reused across turns (the ACP `sessionId` persists the
 * conversation). The handshake (initialize → session/new, injecting o8's
 * operator MCP server) runs lazily on the first turn; subsequent turns are just
 * `session/prompt`. Abort SIGTERM-cancels the in-flight turn; a watchdog kills a
 * hung subprocess. Mirrors openclaw's lifecycle realtime-publish for mobile.
 *
 * The #1075 orchestrator≠worker lockout is enforced separately by the governed
 * profile (`governHermesProfile`) — an ACP client can't strip an agent's native
 * tools, so Hermes runs against a profile that denies native spawn.
 */

import { spawnSync } from '@/lib/providers/child-process';
import { existsSync } from 'node:fs';

import { AcpClient, AcpRequestError, mapStopReason, type AcpConfigOption, type AcpMcpServer } from '@/lib/acp/client';
import { buildToolRegistry } from '@/lib/mcp/tool-spine/build';
import { toOpenclawJson } from '@/lib/mcp/tool-spine/emit-openclaw';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import type { RealtimeMutationRecord } from '@/lib/realtime/types';
import { resolveOpencodeOrchestratorModelSync } from '@/lib/operator/defaults';
import { scanForBinary } from '@/lib/runtimes/shared/cli-locate';
import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';
import { resolveHermesBinary } from '@/lib/hermes/runtime-resolution';
import { governHermesProfile } from './hermes-profile';
import type {
  OrchestratorBackend,
  OrchestratorBackendId,
  OrchestratorSessionInfo,
  OrchestratorTurnOptions,
} from './types';

/** Hang watchdog (not a work budget) — mirrors the other backends' 4h ceiling. */
const ACP_PROCESS_TIMEOUT_MS = 14_400_000;

/** A refused model reset must not destroy an established conversation. */
class AcpDefaultModelResetError extends Error {}
class AcpModelSelectionError extends Error {}

interface AcpSession {
  key: string;
  sessionName: string;
  repoPath: string;
  threadId: string | null;
  client: AcpClient;
  credentialFingerprint: string;
  launchFingerprint: string;
  sessionId: string | null;
  status: 'ready' | 'busy' | 'dead';
  createdAt: number;
  /** `session/new`'s configOptions — the agent's own model/mode catalogue. */
  configOptions: AcpConfigOption[];
  /** Startup model retained separately so an explicit default can undo a pin. */
  initialModel: string | null;
  /** Last model pushed via `session/set_model`, so we only switch on change. */
  appliedModel: string | null;
  modelUnconfirmed: boolean;
  /**
   * Turns this session has actually completed. Guards the handoff seam: setting
   * a model before the first turn is configuration, not a change of hands, and
   * emitting a seam there would show the operator a handoff from nobody.
   */
  completedTurns: number;
  /** The current turn's event sink — set by sendTurn, cleared on completion. */
  onEvent?: (event: OrchestratorEvent) => void;
}

const sessions = new Map<string, AcpSession>();
let acpRealtimeSeq = 0;

/**
 * Last-seen `configOptions` per backend id, so the model picker can render
 * without holding a live session open. Populated on every handshake; empty
 * until the operator's first turn on that backend (the picker falls back to
 * "no models discovered yet" rather than a hardcoded list).
 */
const sessionConfigCache = new Map<OrchestratorBackendId, AcpConfigOption[]>();

function cacheSessionConfig(id: OrchestratorBackendId, session: AcpSession): void {
  sessionConfigCache.set(id, session.configOptions.map(option => ({
    ...session.client.redactOutput(option), id: option.id, type: option.type, category: option.category,
  })));
}

/**
 * The operator's pinned default model for a backend, or null when unpinned.
 * Only opencode has a setting today; other ACP agents run on their own default.
 */
function defaultModelFor(id: OrchestratorBackendId): string | null {
  if (id !== 'opencode') return null;
  try {
    return resolveOpencodeOrchestratorModelSync();
  } catch {
    return null;
  }
}

/** The `model` select out of a configOptions array, if the agent exposes one. */
function modelConfigOption(options: AcpConfigOption[]): AcpConfigOption | null {
  return options.find((opt) => opt.id === 'model' || opt.category === 'model') ?? null;
}

/**
 * The models an ACP backend last reported it can run. Empty when that backend
 * has never completed a handshake in this process.
 */
export function acpBackendModels(id: OrchestratorBackendId): Array<{ value: string; name?: string }> {
  return modelConfigOption(sessionConfigCache.get(id) ?? [])?.options ?? [];
}

/** Whichever model the backend reported as current at its last handshake. */
export function acpBackendCurrentModel(id: OrchestratorBackendId): string | null {
  return modelConfigOption(sessionConfigCache.get(id) ?? [])?.currentValue ?? null;
}

function sessionKey(backendId: string, repoPath: string, threadId?: string | null): string {
  return `${backendId}::${repoPath}::${threadId ?? 'default'}`;
}

/** o8's operator MCP server in ACP's session/new shape (env as {name,value}[]). */
function o8McpServersForAcp(repoPath: string, threadId: string | null): AcpMcpServer[] {
  try {
    const o8 = toOpenclawJson(buildToolRegistry(repoPath, { threadId })).servers['o8'] as
      | { command: string; args: string[]; env?: Record<string, string> }
      | undefined;
    if (!o8) return [];
    return [{
      name: 'o8',
      command: o8.command,
      args: o8.args,
      env: Object.entries(o8.env ?? {}).map(([name, value]) => ({ name, value })),
    }];
  } catch {
    return [];
  }
}

function publishAcpLifecycle(backendId: string, session: AcpSession, event: OrchestratorEvent): void {
  event = session.client.redactEvent(event);
  const base = { backendId, threadKey: session.key };
  const realtime = event.type === 'text'
    ? { event: 'output' as const, action: 'orchestrator-output', status: 'completed' as const, note: `${backendId} assistant output (${event.text.length} chars)`, data: { ...base, text: event.text, thinking: false } }
    : event.type === 'error'
      ? { event: 'error' as const, action: 'orchestrator-error', status: 'failed' as const, note: event.error.slice(0, 240), data: { ...base, error: event.error, ...(event.code ? { code: event.code } : {}) } }
      : event.type === 'done'
        ? { event: 'status' as const, action: 'orchestrator-status', status: 'completed' as const, note: `${backendId} orchestrator turn completed`, data: { ...base, status: 'ready' as const, sessionId: event.sessionId, cost: event.cost } }
        : null;
  if (!realtime) return;
  const createdAt = new Date().toISOString();
  const mutation = {
    mutationId: `${backendId}-${realtime.event}-${Date.now()}-${acpRealtimeSeq += 1}`,
    source: 'server',
    action: realtime.action,
    status: realtime.status,
    runtime: backendId,
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

export interface AcpLaunch {
  localEnvironment?: import('@/lib/acp/connection-environment').AcpEnvironmentBinding;
  command: string;
  args: string[];
  env?: Record<string, string>;
  omitEnv?: string[];
}

export interface AcpBackendConfig {
  id: OrchestratorBackendId;
  label: string;
  /** Resolve the launch command; null when the agent isn't available/configured. */
  resolveLaunch: (repoPath: string) => AcpLaunch | null;
  /** Handshake/config request bound; tests shrink it. Defaults to AcpClient's. */
  requestTimeoutMs?: number;
}

export function makeAcpBackend(config: AcpBackendConfig): OrchestratorBackend {
  const { id, label } = config;

  function spawnSession(repoPath: string, threadId?: string | null): AcpSession {
    const launch = config.resolveLaunch(repoPath);
    if (!launch) throw new Error(`${label} (ACP) is not available — its agent binary/profile could not be resolved.`);
    const key = sessionKey(id, repoPath, threadId);
    const session: AcpSession = {
      key,
      sessionName: key,
      repoPath,
      threadId: threadId ?? null,
      sessionId: null,
      status: 'ready',
      createdAt: Date.now(),
      configOptions: [],
      initialModel: null,
      appliedModel: null,
      modelUnconfirmed: false,
      completedTurns: 0,
      launchFingerprint: acpLaunchFingerprint(launch),
      credentialFingerprint: credentialPolicyFingerprint(id),
      client: new AcpClient({
        command: launch.command,
        args: launch.args,
        cwd: repoPath,
        env: launch.env,
        localEnvironment: launch.localEnvironment,
        runtimeId: id,
        omitEnv: launch.omitEnv,
        onEvent: (event, sourceSessionId) => { if (sourceSessionId === session.sessionId && session.status === 'busy') session.onEvent?.(event); },
        requestTimeoutMs: config.requestTimeoutMs,
      }),
    };
    sessions.set(key, session);
    return session;
  }

  function ensureSync(repoPath: string, threadId?: string | null): AcpSession {
    const key = sessionKey(id, repoPath, threadId);
    const existing = sessions.get(key);
    if (existing && existing.status !== 'dead' && existing.client.alive) {
      if (existing.status === 'busy') return existing;
      // Established processes retain their original environment even while a
      // different saved connection or its credential store is unavailable.
      if (existing.credentialFingerprint === credentialPolicyFingerprint(id) && existing.sessionId) return existing;
      const launch = config.resolveLaunch(repoPath);
      if (existing.credentialFingerprint === credentialPolicyFingerprint(id) && launch && existing.launchFingerprint === acpLaunchFingerprint(launch)) return existing;
      existing.client.kill();
    }
    if (existing) sessions.delete(key);
    return spawnSession(repoPath, threadId);
  }

  async function ensureHandshake(session: AcpSession): Promise<string> {
    if (session.sessionId) return session.sessionId;
    await session.client.initialize();
    const created = await session.client.newSession(session.repoPath, o8McpServersForAcp(session.repoPath, session.threadId));
    session.sessionId = created.sessionId;
    session.configOptions = created.configOptions;
    // The agent reports what it booted with, so a composer pick that already
    // matches costs no set_model round-trip on the first turn.
    session.initialModel = modelConfigOption(session.configOptions)?.currentValue ?? null;
    session.appliedModel = session.initialModel;
    if (session.configOptions.length) {
      cacheSessionConfig(id, session);
    }
    return session.sessionId;
  }

  /**
   * Push the composer's model onto the live session. Skipped when unchanged, and
   * a refused selection stops this turn while preserving the conversation and
   * its previous model. Never silently run a request on a different model.
   */
  async function applyModel(
    session: AcpSession,
    sessionId: string,
    model: string | undefined,
    onEvent: (event: OrchestratorEvent) => void,
  ): Promise<void> {
    // Precedence: the composer's per-turn pick, then the operator's pinned
    // default, then whatever the agent booted with. The last one is a real
    // option, not a failure — an unpinned backend still runs.
    const restoringDefault = model !== undefined && !model.trim();
    const resetError = () => new AcpDefaultModelResetError(`${label} could not restore its agent default. Choose a model or start a new conversation. This conversation was preserved.`);
    const requested = restoringDefault ? session.initialModel ?? undefined : (model?.trim() || defaultModelFor(id)) ?? undefined;
    if (restoringDefault && !requested && (session.appliedModel !== null || session.modelUnconfirmed)) throw resetError();
    if (session.modelUnconfirmed && !requested) throw new AcpModelSelectionError(`${label} could not confirm its model. Select a model or its default before sending. This conversation was preserved.`);
    if (!requested || (requested === session.appliedModel && !session.modelUnconfirmed)) return;
    const previous = session.appliedModel;
    try {
      await session.client.setModel(sessionId, requested, modelConfigOption(session.configOptions)?.id ?? 'model');
    } catch (error) {
      if (!(error instanceof AcpRequestError)) {
        session.modelUnconfirmed = true;
        session.configOptions = session.configOptions.map(option => option.id === 'model' || option.category === 'model' ? { ...option, currentValue: undefined } : option);
        cacheSessionConfig(id, session);
        throw new AcpModelSelectionError(`${label} could not confirm that model switch. Select a model or its default before sending. This conversation was preserved.`);
      }
      if (restoringDefault) throw resetError();
      throw new AcpModelSelectionError(`${label} could not select that model. ${session.modelUnconfirmed ? 'Its current model is unconfirmed.' : `This conversation still uses ${previous ?? 'the agent default'}.`} Choose another model or its default.`);
    }
    session.modelUnconfirmed = false;
    // Only a switch on a session that has already answered something is a
    // handoff. `lossless: true` is earned here specifically: the ACP session
    // id is unchanged, so the receiving model inherits the real conversation
    // rather than a replay (verified live 2026-08-04).
    if (session.completedTurns > 0 && previous !== requested) {
      onEvent({
        type: 'handoff',
        from: previous ? { backend: id, model: previous } : null,
        to: { backend: id, model: requested },
        lossless: true,
      });
    }
    session.appliedModel = requested;
    session.configOptions = session.configOptions.map(option => option.id === 'model' || option.category === 'model' ? { ...option, currentValue: requested } : option);
    cacheSessionConfig(id, session);
  }

  return {
    id,
    label,
    peekSession(repoPath, _agent, threadId): OrchestratorSessionInfo | null {
      const session = sessions.get(sessionKey(id, repoPath, threadId));
      return session && session.client.alive ? { sessionName: session.sessionName, status: session.status } : null;
    },
    ensureSession(repoPath, _agent, threadId): OrchestratorSessionInfo {
      const session = ensureSync(repoPath, threadId);
      return { sessionName: session.sessionName, status: session.status };
    },
    async sendTurn(repoPath, message, onEvent, options?: OrchestratorTurnOptions): Promise<void> {
      const effortError = unmappedEffortError(options?.thinkingEffort);
      if (effortError) { onEvent(effortError); return; }
      if (options?.signal?.aborted) { onEvent(mapStopReason('cancelled', null)); return; }
      if (id === 'opencode' || id === 'hermes' || (id === 'acp' && resolveLocalAcpLaunch()?.useOpenRouter)) {
        await resolveOpenRouterKey();
        const cold = sessions.get(sessionKey(id, repoPath, options?.threadId));
        if (cold && !cold.sessionId && cold.status !== 'busy' && cold.credentialFingerprint !== credentialPolicyFingerprint(id)) {
          cold.client.kill(); cold.status = 'dead';
        }
      }
      const session = ensureSync(repoPath, options?.threadId);
      if (session.status === 'busy') { onEvent({ type: 'error', error: `${label} is already handling a turn in this conversation. Wait or stop it before sending another.` }); return; }
      session.status = 'busy';

      // Silent-empty-turn guard. opencode's `session/set_model` validates
      // NOTHING — a model the install isn't authenticated for, and even a
      // outright bogus id, both return success and then produce a turn that
      // ends `end_turn` with zero assistant output (verified 2026-08-04 against
      // opencode 1.4.3 with `opencode/minimax-m2.5-free` and
      // `openrouter/does/not-exist`). Reporting that as a clean `done` shows the
      // operator an empty reply and no reason, which is the worst outcome. Count
      // real output so a turn that produced none can say why.
      let produced = 0;
      let awaitingFinalReply = false;
      const countingOnEvent = (event: OrchestratorEvent) => {
        if (event.type === 'text' || event.type === 'thinking' || event.type === 'tool_use') produced += 1;
        if (event.type === 'tool_use' || event.type === 'tool_result') awaitingFinalReply = true;
        else if (event.type === 'text' && event.text.trim()) awaitingFinalReply = false;
        onEvent(session.client.redactEvent(event));
      };
      session.onEvent = countingOnEvent;

      const watchdog = setTimeout(() => {
        session.status = 'dead';
        session.client.kill();
      }, ACP_PROCESS_TIMEOUT_MS);

      const onAbort = () => {
        if (session.sessionId) session.client.cancel(session.sessionId);
      };
      options?.signal?.addEventListener('abort', onAbort, { once: true });

      try {
        const sessionId = await ensureHandshake(session);
        if (options?.signal?.aborted) { onEvent(session.client.redactEvent(mapStopReason('cancelled', sessionId))); return; }
        await applyModel(session, sessionId, options?.model, countingOnEvent);
        if (options?.signal?.aborted) { onEvent(session.client.redactEvent(mapStopReason('cancelled', sessionId))); return; }
        countingOnEvent({
          type: 'turn_receipt',
          leadModel: session.appliedModel ?? defaultModelFor(id) ?? id,
          effort: 'adaptive',
          effortSource: 'runtime-default',
        });
        // session/prompt resolves only at end of turn, so the per-request RPC
        // default would bound the whole turn (#2472). The watchdog and abort
        // are the real bounds.
        if (session.credentialFingerprint !== credentialPolicyFingerprint(id)) {
          session.status = 'dead'; session.client.kill();
          throw new Error('Credentials or billing changed during ACP initialization. Retry the launch.');
        }
        const stopReason = await session.client.prompt(sessionId, message, ACP_PROCESS_TIMEOUT_MS);
        const doneOrError = awaitingFinalReply && stopReason === 'end_turn'
          ? ({ type: 'error', code: 'acp_ended_after_tools',
            error: `${label} ended after tool activity without a final reply. You can continue this conversation; no retry was started.` } satisfies OrchestratorEvent)
          : produced === 0 && stopReason === 'end_turn'
          ? ({
            type: 'error',
            error: session.appliedModel
              ? `${label} finished the turn without producing any output on model "${session.appliedModel}". `
                + 'That model is usually not authenticated for this install, or the id does not exist — '
                + 'this agent accepts unknown model ids silently. Pick a different model.'
              : `${label} finished the turn without producing any output.`,
          } satisfies OrchestratorEvent)
          : mapStopReason(stopReason, sessionId);
        if (doneOrError.type === 'done') session.completedTurns += 1;
        onEvent(session.client.redactEvent(doneOrError));
        publishAcpLifecycle(id, session, doneOrError);
      } catch (err) {
        const errorEvent: OrchestratorEvent = { type: 'error', error: err instanceof Error ? err.message : String(err) };
        onEvent(session.client.redactEvent(errorEvent));
        publishAcpLifecycle(id, session, errorEvent);
        if (!(err instanceof AcpDefaultModelResetError) && !(err instanceof AcpModelSelectionError)) {
          session.status = 'dead';
          session.client.kill();
        }
      } finally {
        clearTimeout(watchdog);
        options?.signal?.removeEventListener('abort', onAbort);
        session.onEvent = undefined;
        if (session.status !== 'dead') session.status = 'ready';
      }
    },
  };
}

// ── Concrete backends ──────────────────────────────────────────────────────────

/**
 * Hermes via `hermes acp`, run against the GOVERNED profile (3d): an isolated
 * HOME whose config denies Hermes's native work toolsets (delegation = the
 * native spawn, terminal/file/code_execution/browser/computer_use) so the
 * orchestrator can only dispatch through o8. SAFETY INTERLOCK: if the profile
 * can't be governed, resolveLaunch throws — Hermes NEVER runs ungoverned.
 */
export const hermesBackend: OrchestratorBackend = makeAcpBackend({
  id: 'hermes',
  label: 'Hermes',
  resolveLaunch: () => {
    const bin = resolveHermesBinary();
    if (!bin) return null;
    const governed = governHermesProfile(bin);
    if (!governed) {
      throw new Error(
        'Hermes orchestrator refused: could not establish the governed profile (deny native toolsets + o8-MCP-only). '
          + 'Hermes must be configured (hermes setup) and govern cleanly before it can orchestrate — running ungoverned '
          + 'would break the orchestrator≠worker guarantee (#1075).',
      );
    }
    return { command: bin, args: ['acp', '--accept-hooks'], env: { HOME: governed.home, HERMES_HOME: join(governed.home, '.hermes') } };
  },
});

/** Resolve the OpenCode 2 preview binary (PATH-ish); null when not installed. */
function resolveOpencodeBinary(): string | null {
  for (const candidate of [
    process.env.O8_OPENCODE_BIN,
    `${process.env.HOME ?? ''}/.npm-global/bin/opencode2`,
    '/opt/homebrew/bin/opencode2',
    '/usr/local/bin/opencode2',
    `${process.env.HOME ?? ''}/.local/bin/opencode2`,
  ]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return scanForBinary('opencode2');
}

/**
 * OpenCode 2 via `opencode2 acp` — the model-agnostic orchestrator.
 *
 * Unlike every other backend, this one is not bound to a provider house: the
 * session's own `configOptions.model` select is the catalogue, scoped to
 * whatever providers the local install is authenticated for. Verified against
 * OpenCode 2 next-17430 on 2026-08-14:
 *   - NDJSON JSON-RPC on stdio, protocolVersion 1 — the shape AcpClient sends;
 *   - o8's operator MCP server loads over stdio (`toolCount=92`), so this
 *     backend can genuinely dispatch rather than only converse;
 *   - `session/new` returns the authenticated provider/model catalogue;
 *   - `session/set_config_option {configId:'model'}` switches models on the
 *     live session, no respawn.
 *
 * `mcpCapabilities` advertises only `{http, sse}`, which reads like stdio is
 * unsupported. It is not — stdio is the ACP baseline and those flags mark the
 * extra transports. Don't "fix" the injection path on the strength of that.
 *
 * The process must boot in the target repository. OpenCode 2 starts a private
 * stdio service before `session/new`; booting from the packaged app resources
 * directory makes that service fail even when `session/new.cwd` is correct.
 */
export const opencodeBackend: OrchestratorBackend = makeAcpBackend({
  id: 'opencode',
  label: 'OpenCode 2',
  resolveLaunch: () => {
    const bin = resolveOpencodeBinary();
    if (!bin) return null;
    return { command: bin, args: ['acp'] };
  },
});

/**
 * The launch spec for an ACP backend, for callers that need to drive the agent
 * outside a turn (the model-catalogue probe). Null when unavailable.
 */
export function resolveAcpLaunch(id: OrchestratorBackendId): AcpLaunch | null {
  if (id === 'acp') return localAcpProcessLaunch();
  if (id === 'opencode') {
    const bin = resolveOpencodeBinary();
    return bin ? { command: bin, args: ['acp'] } : null;
  }
  return null;
}

/** Whether the opencode ACP agent is available (binary present AND executes). */
export function isOpencodeAcpAvailable(): boolean {
  const bin = resolveOpencodeBinary();
  if (!bin) return false;
  if (opencodeHealthCache !== null) return opencodeHealthCache;
  try {
    const version = cliInvocation(bin, ['--version']);
    const probe = spawnSync(version.command, version.args, { windowsHide: true, timeout: 5_000, stdio: 'ignore' });
    opencodeHealthCache = probe.status === 0;
  } catch {
    opencodeHealthCache = false;
  }
  return opencodeHealthCache;
}

let opencodeHealthCache: boolean | null = null;

/** Generic ACP escape hatch — any ACP agent via O8_ACP_COMMAND / O8_ACP_ARGS. */
export const acpBackend: OrchestratorBackend = makeAcpBackend({
  id: 'acp',
  label: 'ACP',
  resolveLaunch: () => {
    return localAcpProcessLaunch();
  },
});

/** Whether the Hermes ACP agent is available (binary present). */
export function isHermesAvailable(): boolean {
  const bin = resolveHermesBinary();
  if (!bin) return false;
  // Presence isn't health: ~/.local/bin/hermes is a wrapper script that execs
  // a Python venv — the 2026-07-07 storage cleanup deleted ~/.hermes and the
  // wrapper survived, so existsSync said "available" on a machine where every
  // Hermes turn could only fail (live-hit 2026-07-16, runtime sweep). Verify
  // the binary actually EXECUTES (cached — this gates a settings picker, not
  // a hot path).
  if (hermesHealthCache !== null) return hermesHealthCache;
  try {
    // Through the interpreter on Windows — an unwrapped spawn of a `.cmd`
    // throws EINVAL, which this cache would record as "installed but broken".
    const version = cliInvocation(bin, ['--version']);
    const probe = spawnSync(version.command, version.args, { windowsHide: true, timeout: 5_000, stdio: 'ignore' });
    hermesHealthCache = probe.status === 0;
  } catch {
    hermesHealthCache = false;
  }
  return hermesHealthCache;
}

let hermesHealthCache: boolean | null = null;
