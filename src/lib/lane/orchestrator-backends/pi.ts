/**
 * Pi orchestrator backend (#3258): the bundled Pi SDK session as the
 * orchestrator, on the managed model route (paid plan token or the free
 * allowance; the worker never holds a credential).
 *
 * Pi gets the same built-in o8 servers as the Claude orchestrator (operator and
 * cortex, projected by the turn's tool profile) through three catalog tools, so
 * every o8 command is reachable without sending every schema on every call. In
 * Full access its own file writes and commands in the repo run without asking,
 * as the Claude orchestrator's do (#3555); policy-blocked commands, workspace
 * path checks and command limits still apply, and commands write only in the
 * workspace and a private temp dir (#3658). Outside workspace explicitly lifts
 * that command boundary for the selected turn. A plan-mode turn gets the
 * proposer projection and only `read_file`.
 *
 * One turn at a time per repo and thread, and one resident Pi process for it.
 * The session file lives under the o8 data directory, so a new process after a
 * restart, failure or idle close resumes the same conversation.
 */

import { unmappedEffortError } from './unmapped-effort';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { sessionNameForRepo } from '@/lib/lane/orchestrator-session-core';
import { buildOrchestratorSystemPrompt } from '@/lib/lane/orchestrator-system-prompt';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import type { ToolProfile } from '@/lib/mcp/tool-spine/registry';
import { createO8CommandTools, listO8Commands, o8CommandPrompt } from '@/lib/pi/orchestrator/o8-commands';
import { openO8Servers, type O8ServerSet } from '@/lib/pi/orchestrator/o8-servers';
import type { PiModelRoute, PiUsageAttribution } from '@/lib/pi/openrouter-choice';
import type { ManagedPiTransportOptions } from '@/lib/pi/sdk/transport';
import { requirePiNode, requirePiPlatform } from '@/lib/pi/sdk/platform';
import { O8_MANAGED_PI_MODEL } from '@/lib/pi/sdk/live-contract';
import { isOpenRouterPiModelChoice } from '@/lib/pi/sdk/openrouter-model-choice';
import type { OpenRouterPiReceipt, OpenRouterSpendCeiling } from '@/lib/pi/sdk/openrouter-transport';
import type { createPiSdkSession, PiSdkSessionOptions } from '@/lib/pi/sdk/session';
import { newestPiSessionFile, prunePiSessionFiles } from '@/lib/pi/sdk/session-files';
import { piOrchestratorStateDir } from '@/lib/pi/orchestrator/context';
import { assertOrchestratorPermissionMode } from '@/lib/orchestrator/permission-mode';
import type { OrchestratorBackend, OrchestratorSessionInfo, OrchestratorTurnOptions } from './types';

/** Per-turn limits. A turn that dispatches and waits on a mission needs more than the prototype's defaults. */
export const PI_ORCHESTRATOR_LIMITS = { maxModelCalls: 40, maxToolCalls: 80, runTimeoutMs: 30 * 60_000 } as const;
/** An idle thread's Pi and cortex processes close after this; the next message resumes from the session file. */
export const PI_ORCHESTRATOR_IDLE_MS = 15 * 60_000;
/** Earlier session files a fresh-conversation thread (a review slot) keeps for inspection. */
const PI_FRESH_SESSION_KEEP = 2;

type PiSession = Awaited<ReturnType<typeof createPiSdkSession>>;

/** The tool surface a resident was started with. A turn needing another one gets a new process. */
interface PiSurface {
  profile: ToolProfile;
  readOnly: boolean;
  outsideWorkspace: boolean;
}

interface ResidentPi extends PiSurface {
  name: string;
  /** The model route this process was started on; another route needs a new process. */
  routeId: string;
  /** This turn's OpenRouter call receipts (#3584). Empty on the managed route. */
  receipts: OpenRouterPiReceipt[];
  /** Who this turn's calls are recorded for; refreshed every turn, since a review session can be reused (#3742). */
  attribution: PiUsageAttribution;
  ceiling?: OpenRouterSpendCeiling;
  session: PiSession;
  servers: O8ServerSet;
  emit?: (event: OrchestratorEvent) => void;
  idle?: ReturnType<typeof setTimeout>;
}

function piUsageAttribution(name: string, repoPath: string, options: OrchestratorTurnOptions): PiUsageAttribution {
  return options.reviewUsage
    ? { role: 'reviewer', agentName: 'pi-reviewer', sessionKey: name, repoPath, laneId: options.reviewUsage.laneId,
      packetId: options.reviewUsage.packetId, runId: options.reviewUsage.reviewTurnId, surface: options.reviewUsage.surface }
    : { role: 'orchestrator', agentName: 'pi-orchestrator', sessionKey: name, repoPath };
}

/** Plan mode is read-only, like Claude's plan mode: proposer servers and no repo writes or commands. */
export function piSurfaceForTurn(options: OrchestratorTurnOptions): PiSurface {
  const plan = options.permissionMode === 'plan';
  const profile: ToolProfile = plan ? 'propose' : options.toolProfile ?? 'full';
  return { profile, readOnly: plan || profile === 'propose', outsideWorkspace: options.permissionMode === 'outside-workspace' };
}

/**
 * Full access: the operator chose "can edit files and run actions" for this turn.
 * Commands still run confined to the workspace and a private temp dir (#3658).
 */
const fullAccess: NonNullable<PiSdkSessionOptions['approve']> = async () => true;

/** Start failures o8 itself explains; anything else stays in the host log. */
const PI_START_FAILURE_TEXT = /^The Pi prototype (?:needs Node|does not support)/;

/** Trusted seams for tests. Production uses the managed transport, Full access approval and /api/mcp. */
export interface PiOrchestratorDeps {
  transport?: PiSdkSessionOptions['transport'];
  approve?: PiSdkSessionOptions['approve'];
  openServers?: typeof openO8Servers;
  stateRoot?: () => string;
  idleMs?: number;
  /** Resolves an explicit model choice; production checks the OpenRouter catalogue. */
  resolveRoute?: (requested?: string | null) => Promise<PiModelRoute>;
  /** Spend ceiling for one OpenRouter lead turn; production uses the operator's packet cap. */
  openRouterTurnCeilingUsd?: () => number;
  /** Network seam for the OpenRouter route in tests. */
  openRouterFetch?: typeof fetch;
  /** Relay seam for the managed route in tests. */
  managedInference?: Pick<ManagedPiTransportOptions, 'resolveRoute' | 'fetch'>;
}

const MANAGED_ROUTE: PiModelRoute = { carrier: 'managed', model: O8_MANAGED_PI_MODEL, label: O8_MANAGED_PI_MODEL.name };

/** The managed route needs no lookup; only an explicit OpenRouter choice loads the OpenRouter code. */
async function resolveLeadRoute(deps: PiOrchestratorDeps, requested?: string | null): Promise<PiModelRoute> {
  if (deps.resolveRoute) return deps.resolveRoute(requested);
  if (!isOpenRouterPiModelChoice(requested)) return MANAGED_ROUTE;
  const { resolvePiModelRoute } = await import('@/lib/pi/openrouter-choice');
  return resolvePiModelRoute(requested);
}

async function leadTurnCeilingUsd(deps: PiOrchestratorDeps): Promise<number> {
  if (deps.openRouterTurnCeilingUsd) return deps.openRouterTurnCeilingUsd();
  const { getOperatorDefaultsSync } = await import('@/lib/operator/defaults');
  return getOperatorDefaultsSync().values.meteredPacketCostCapUsd;
}

/** A turn's cost when every OpenRouter call reported one; unknown stays null rather than zero. */
export function piTurnCost(receipts: readonly OpenRouterPiReceipt[]): number | null {
  const calls = receipts.filter(receipt => receipt.status !== 'refused');
  if (!calls.length || calls.some(receipt => receipt.costUsd === null)) return null;
  return Number(calls.reduce((sum, receipt) => sum + (receipt.costUsd ?? 0), 0).toFixed(10));
}

function textOf(result: unknown): string {
  const content = (result as { content?: unknown })?.content;
  if (!Array.isArray(content)) return typeof result === 'string' ? result : '';
  return content.map(part => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
    ? (part as { text: string }).text : '')).join('\n');
}

/**
 * Maps one Pi agent event to orchestrator stream events. Only text and tool
 * activity cross; message objects, which can carry provider diagnostics, never do.
 */
export function piEventToOrchestratorEvents(event: Record<string, unknown>): OrchestratorEvent[] {
  if (event.type === 'message_update') {
    const update = event.assistantMessageEvent as { type?: unknown; delta?: unknown } | undefined;
    if (typeof update?.delta !== 'string' || !update.delta) return [];
    if (update.type === 'text_delta') return [{ type: 'text', text: update.delta }];
    if (update.type === 'thinking_delta') return [{ type: 'thinking', text: update.delta }];
    return [];
  }
  if (event.type === 'tool_execution_start' && typeof event.toolName === 'string') {
    return [{ type: 'tool_use', id: typeof event.toolCallId === 'string' ? event.toolCallId : null, name: event.toolName, input: event.args ?? {} }];
  }
  if (event.type === 'tool_execution_end' && typeof event.toolName === 'string') {
    return [{
      type: 'tool_result',
      id: typeof event.toolCallId === 'string' ? event.toolCallId : null,
      name: event.toolName,
      output: textOf(event.result),
      isError: event.isError === true,
    }];
  }
  return [];
}

export function createPiOrchestratorBackend(deps: PiOrchestratorDeps = {}): OrchestratorBackend & {
  closeAll(): Promise<void>;
  hasSession(repoPath: string, threadId?: string | null): Promise<boolean>;
} {
  const resident = new Map<string, ResidentPi>();
  /** Threads with a turn in flight, startup included. Reserved before any await. */
  const active = new Set<string>();
  const inflight = new Set<Promise<void>>();
  const ensured = new Set<string>();
  let closing = false;
  const stateRoot = deps.stateRoot ?? (() => join(getDataDir(), 'pi', 'orchestrator'));

  const nameFor = (repoPath: string, threadId?: string | null) => sessionNameForRepo('pi-orchestrator', repoPath, threadId);
  const stateDirFor = (name: string) => piOrchestratorStateDir(name, stateRoot());

  /** Closes one resident; the map entry goes only if it still names this resident. */
  async function close(pi: ResidentPi) {
    clearTimeout(pi.idle);
    if (resident.get(pi.name) === pi) resident.delete(pi.name);
    await Promise.allSettled([pi.session.close(), pi.servers.close()]);
  }

  async function start(name: string, repoPath: string, options: OrchestratorTurnOptions, surface: PiSurface,
    route: PiModelRoute): Promise<ResidentPi> {
    const stateDir = stateDirFor(name);
    const signal = options.signal ?? new AbortController().signal;
    const servers = await (deps.openServers ?? openO8Servers)(repoPath, { profile: surface.profile, threadId: options.threadId });
    try {
      const commands = servers.servers.length ? await listO8Commands(servers.servers, signal) : [];
      const systemPrompt = [
        buildOrchestratorSystemPrompt(repoPath, { backend: 'pi', toolProfile: surface.profile }),
        commands.length ? o8CommandPrompt(commands) : '',
      ].filter(Boolean).join('\n\n');
      const routeId = route.carrier === 'openrouter' ? route.choice : route.model.id;
      // The transports read this object on every call, so each turn's calls go to that turn.
      const attribution = piUsageAttribution(name, repoPath, options);
      const pi = { name, servers, routeId, receipts: [], attribution, ...surface } as unknown as ResidentPi;
      let transport = deps.transport;
      if (!transport && route.carrier === 'openrouter') {
        const { createPiOpenRouterRouteTransport } = await import('@/lib/pi/openrouter-choice');
        const routed = createPiOpenRouterRouteTransport(route, {
          ceilingUsd: await leadTurnCeilingUsd(deps),
          attribution,
          onReceipt: (receipt) => { pi.receipts.push(receipt); },
          fetch: deps.openRouterFetch,
        });
        transport = routed.transport;
        pi.ceiling = routed.ceiling;
      } else if (!transport) {
        // Managed calls are metered by the relay; each is also recorded locally with its tokens (#3742).
        const { createPiManagedUsageTransport } = await import('@/lib/pi/managed-usage');
        transport = createPiManagedUsageTransport(route.model, attribution, deps.managedInference);
      }
      // A fresh conversation never resumes the old ones, so only the latest few are kept (#3742).
      if (options.freshSession) await prunePiSessionFiles(join(stateDir, 'sessions'), PI_FRESH_SESSION_KEEP);
      // Loaded on the first Pi turn, so ws-server startup never evaluates the Pi SDK.
      const { createPiSdkSession } = await import('@/lib/pi/sdk/session');
      pi.session = await createPiSdkSession({
        workspace: repoPath,
        stateDir,
        model: route.model,
        sessionFile: options.freshSession ? undefined : await newestPiSessionFile(join(stateDir, 'sessions')),
        transport,
        approve: deps.approve ?? (surface.readOnly ? undefined : fullAccess),
        // Only the explicit per-turn grant lifts command confinement. File-tool checks remain in place.
        confineCommands: surface.outsideWorkspace ? false : 'workspace',
        hostTools: commands.length ? createO8CommandTools(commands) : [],
        systemPrompt,
        readOnly: surface.readOnly,
        onEvent: (event) => {
          for (const mapped of piEventToOrchestratorEvents(event)) pi.emit?.(mapped);
        },
        ...PI_ORCHESTRATOR_LIMITS,
      });
      return pi;
    } catch (error) {
      await servers.close();
      throw error;
    }
  }

  async function runTurn(name: string, repoPath: string, message: string, onEvent: (event: OrchestratorEvent) => void,
    options: OrchestratorTurnOptions) {
    let sessionId: string | null = null;
    let turnReceipts: readonly OpenRouterPiReceipt[] = [];
    const done = () => onEvent({ type: 'done', sessionId, cost: piTurnCost(turnReceipts) });
    const surface = piSurfaceForTurn(options);
    let route: PiModelRoute;
    try {
      route = await resolveLeadRoute(deps, options.model);
    } catch (error) {
      // An explicit model that cannot run fails visibly; it never falls back to another payer.
      const { PiModelChoiceError } = await import('@/lib/pi/openrouter-choice');
      onEvent({ type: 'error', error: error instanceof PiModelChoiceError ? error.message : 'Pi could not resolve the selected model.' });
      done();
      return;
    }
    const routeId = route.carrier === 'openrouter' ? route.choice : route.model.id;
    let pi = resident.get(name);
    // A different tool surface or model route needs a different process; the session file keeps the conversation.
    if (pi && (options.freshSession || pi.profile !== surface.profile || pi.readOnly !== surface.readOnly
      || pi.outsideWorkspace !== surface.outsideWorkspace || pi.routeId !== routeId || !pi.session.running)) {
      await close(pi);
      pi = undefined;
    }
    if (pi) {
      pi.receipts = [];
      pi.ceiling?.reset();
    }
    if (!pi) {
      try {
        pi = await start(name, repoPath, options, surface, route);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (!PI_START_FAILURE_TEXT.test(detail)) console.warn('[pi-orchestrator] Pi could not start:', error);
        if (!options.signal?.aborted) {
          onEvent({ type: 'error', error: PI_START_FAILURE_TEXT.test(detail) ? detail : 'Pi could not start. Details are in the o8 log.' });
        }
        done();
        return;
      }
      if (closing) {
        await close(pi);
        done();
        return;
      }
      resident.set(name, pi);
    }
    const current = pi;
    sessionId = current.session.sessionId;
    clearTimeout(current.idle);
    current.emit = onEvent;
    turnReceipts = current.receipts;
    for (const key of Object.keys(current.attribution)) delete current.attribution[key as keyof PiUsageAttribution];
    Object.assign(current.attribution, piUsageAttribution(name, repoPath, options));
    onEvent({ type: 'turn_receipt', leadModel: route.carrier === 'openrouter' ? route.choice : 'pi', effort: 'adaptive', effortSource: 'runtime-default',
      permissionMode: options.permissionMode ?? 'full' });
    const stop = () => { void current.session.abort(); };
    options.signal?.addEventListener('abort', stop, { once: true });
    try {
      if (options.signal?.aborted) return;
      const result = await current.session.prompt(message);
      if (result.errorMessage && !options.signal?.aborted) onEvent({ type: 'error', error: result.errorMessage });
    } catch (error) {
      // A failed prompt closes the Pi process; the next message starts a new one on the same session file.
      await close(current);
      if (!options.signal?.aborted) {
        console.warn('[pi-orchestrator] Pi run failed:', error);
        onEvent({ type: 'error', error: 'Pi stopped unexpectedly. Send the message again to continue.' });
      }
    } finally {
      options.signal?.removeEventListener('abort', stop);
      current.emit = undefined;
      if (resident.get(name) === current) {
        current.idle = setTimeout(() => { if (!active.has(name)) void close(current); },
          deps.idleMs ?? PI_ORCHESTRATOR_IDLE_MS);
        current.idle.unref?.();
      }
      done();
    }
  }

  function sendTurn(repoPath: string, message: string, onEvent: (event: OrchestratorEvent) => void,
    options: OrchestratorTurnOptions = {}): Promise<void> {
    const effortError = unmappedEffortError(options.thinkingEffort);
    if (effortError) {
      onEvent(effortError); onEvent({ type: 'done', sessionId: null, cost: null });
      return Promise.resolve();
    }
    try {
      assertOrchestratorPermissionMode('pi', options.permissionMode, options.toolProfile);
    } catch (error) {
      onEvent({ type: 'error', error: error instanceof Error ? error.message : 'Invalid permission mode.' });
      onEvent({ type: 'done', sessionId: null, cost: null });
      return Promise.resolve();
    }
    const name = nameFor(repoPath, options.threadId);
    ensured.add(name);
    if (closing || active.has(name)) {
      onEvent({ type: 'error', error: closing ? 'Pi is shutting down.' : 'Pi is still working on the previous message in this thread.' });
      onEvent({ type: 'done', sessionId: resident.get(name)?.session.sessionId ?? null, cost: null });
      return Promise.resolve();
    }
    active.add(name);
    const turn = runTurn(name, repoPath, message, onEvent, options).finally(() => {
      active.delete(name);
      inflight.delete(turn);
    });
    inflight.add(turn);
    return turn;
  }

  const status = (name: string) => (active.has(name) ? 'busy' as const : 'ready' as const);
  const liveSteer: NonNullable<OrchestratorBackend['liveSteer']> = async (repoPath, message, options) => {
    assertOrchestratorPermissionMode('pi', options.permissionMode, options.toolProfile);
    const route = await resolveLeadRoute(deps, options.model);
    const routeId = route.carrier === 'openrouter' ? route.choice : route.model.id;
    const name = nameFor(repoPath, options.threadId);
    const pi = resident.get(name);
    const surface = piSurfaceForTurn(options);
    if (closing || !active.has(name) || !pi || !pi.session.running || pi.profile !== surface.profile
      || pi.readOnly !== surface.readOnly || pi.outsideWorkspace !== surface.outsideWorkspace || pi.routeId !== routeId) return { accepted: false };
    // Model lookup may await I/O. Recheck the saved claim at the last native handoff.
    options.beforeAdmit();
    return pi.session.steer(message);
  };

  return {
    id: 'pi',
    label: 'Pi',
    get liveSteer() {
      try { requirePiPlatform(); requirePiNode(); return liveSteer; } catch { return undefined; }
    },
    peekSession(repoPath, _agent, threadId): OrchestratorSessionInfo | null {
      const name = nameFor(repoPath, threadId);
      return ensured.has(name) ? { sessionName: name, status: status(name) } : null;
    },
    ensureSession(repoPath, _agent, threadId): OrchestratorSessionInfo {
      const name = nameFor(repoPath, threadId);
      ensured.add(name);
      return { sessionName: name, status: status(name) };
    },
    sendTurn,
    /** True once this repo and thread have a Pi conversation to resume. */
    async hasSession(repoPath, threadId) {
      const name = nameFor(repoPath, threadId);
      return resident.has(name) || Boolean(await newestPiSessionFile(join(stateDirFor(name), 'sessions')));
    },
    /** Ends every turn and process, including ones still starting. */
    async closeAll() {
      closing = true;
      await Promise.allSettled([...resident.values()].map(close));
      await Promise.allSettled([...inflight]);
      await Promise.allSettled([...resident.values()].map(close));
      closing = false;
    },
  };
}

export const piBackend = createPiOrchestratorBackend();
