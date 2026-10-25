import { credentialPolicyFingerprint } from '@/lib/providers/credential-policy';
import { withProviderStoreLock } from '@/lib/providers/store-lock';
import { assertLocalAcpEnvironmentCurrent, localAcpOutputRedactor } from './local-connection';
import type { AcpEnvironmentBinding } from './connection-environment';
import { childEnvironment, childEnvironmentContext, retainChildMetadataRedaction } from '@/lib/providers/spawn-environment';
/**
 * Agent Client Protocol (ACP) stdio client.
 *
 * ACP is the protocol Zed / VS Code / JetBrains use to drive AI coding agents
 * (agentclientprotocol.com — NOT MCP). o8 uses one client for orchestrators and
 * worker runtimes so provider-specific adapters only own durable session truth.
 * This module owns the wire (spawn + JSON-RPC 2.0 over newline-delimited JSON),
 * bounded process lifecycle, reverse requests, and optional event mapping.
 *
 * Wire facts verified against the published spec AND live `hermes acp` v0.17.0:
 *   - framing is NDJSON (one JSON-RPC object per line) — NOT Content-Length;
 *   - lifecycle: initialize → session/new → session/prompt; the prompt REQUEST's
 *     result carries `stopReason` and IS the end-of-turn signal;
 *   - streaming arrives as `session/update` notifications in between;
 *   - session/cancel is a NOTIFICATION (no id);
 *   - agents emit non-standard update variants (hermes: `usage_update`) — unknown
 *     variants are ignored, never fatal.
 */

import type { ChildProcess } from 'node:child_process';
import { spawnWithWorkAdmission as spawn } from '@/lib/app-update/work-launch-admission';

import { cliInvocation, spawnsViaInterpreter } from '@/lib/runtimes/shared/cli-spawn';

import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';

// ── ACP wire types (the subset o8 uses) ──

/** stdio MCP server entry for `session/new` — note `env` is an ARRAY of {name,value}. */
export interface AcpMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities?: Record<string, unknown>;
  agentInfo?: { name?: string; version?: string };
  authMethods?: Array<{ id: string; name?: string; description?: string }>;
}

export type AcpStopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled' | string;

/**
 * One entry of `session/new`'s `configOptions` — the agent's own settings surface.
 * OpenCode ACP returns `model` (a select carrying its full model catalogue plus
 * the current value) and `mode`. This is why o8 never shells out to a model-list
 * command: the live session hands us the list, already scoped to
 * whatever providers that install is authenticated for.
 */
export interface AcpConfigOption {
  id: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: string;
  options?: Array<{ value: string; name?: string }>;
}

export interface AcpNewSessionResult {
  sessionId: string;
  configOptions: AcpConfigOption[];
}

export interface AcpRawNotification {
  method: string;
  params: Record<string, unknown>;
}

export interface AcpInboundRequest extends AcpRawNotification {
  id: string | number;
}

export class AcpRequestError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'AcpRequestError';
  }
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const ACP_PROTOCOL_VERSION = 1;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Defensively narrow `session/new`'s `configOptions`; unknown shapes are dropped.
 * PURE + exported so the model-picker contract is unit-tested against the real
 * agent payload rather than against a hand-built fixture of itself.
 */
export function parseConfigOptions(value: unknown): AcpConfigOption[] {
  if (!Array.isArray(value)) return [];
  const parsed: AcpConfigOption[] = [];
  for (const entry of value) {
    const rec = asRecord(entry);
    const id = rec ? str(rec.id) : null;
    if (!rec || !id) continue;
    const rawOptions = Array.isArray(rec.options) ? rec.options : [];
    const options: Array<{ value: string; name?: string }> = [];
    for (const opt of rawOptions) {
      const o = asRecord(opt);
      const v = o ? str(o.value) : null;
      if (v) options.push({ value: v, name: str(o?.name) ?? undefined });
    }
    parsed.push({
      id,
      name: str(rec.name) ?? undefined,
      category: str(rec.category) ?? undefined,
      type: str(rec.type) ?? undefined,
      currentValue: str(rec.currentValue) ?? undefined,
      options,
    });
  }
  return parsed;
}

/** Extract the text from an ACP ContentBlock ({type:'text', text}) defensively. */
function contentText(content: unknown): string {
  const block = asRecord(content);
  if (block && typeof block.text === 'string') return block.text;
  // Some agents wrap tool output as ToolCallContent[] ({type:'content', content: ContentBlock}).
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        const rec = asRecord(item);
        if (!rec) return '';
        if (typeof rec.text === 'string') return rec.text;
        return contentText(rec.content);
      })
      .join('');
  }
  return '';
}

/**
 * Map one ACP `session/update` payload (`update`) to an OrchestratorEvent, or
 * null when the variant has no o8 event (user echo, plan, command lists, the
 * hermes-specific `usage_update`, in-flight tool progress). PURE — unit-tested.
 */
export function mapAcpUpdate(update: unknown): OrchestratorEvent | null {
  const u = asRecord(update);
  if (!u) return null;
  switch (u.sessionUpdate) {
    case 'agent_message_chunk':
      return { type: 'text', text: contentText(u.content) };
    case 'agent_thought_chunk':
      return { type: 'thinking', text: contentText(u.content) };
    case 'tool_call':
      return {
        type: 'tool_use',
        id: str(u.toolCallId),
        name: str(u.title) ?? str(u.kind) ?? 'tool',
        input: u.rawInput ?? null,
      };
    case 'tool_call_update':
      // Only surface a tool RESULT on completion; in-progress ticks are skipped.
      if (u.status === 'completed') {
        return { type: 'tool_result', id: str(u.toolCallId), name: str(u.title) ?? '', output: contentText(u.content) };
      }
      return null;
    default:
      return null; // user_message_chunk · plan · available_commands_update · usage_update · current_mode_update · …
  }
}

/** Map a terminal stopReason to the o8 `done`/`error` event. */
export function mapStopReason(stopReason: AcpStopReason, sessionId: string | null): OrchestratorEvent {
  if (stopReason === 'refusal') {
    return { type: 'error', error: 'ACP agent refused the turn (no model/provider configured, or the request was declined).' };
  }
  if (!['end_turn', 'max_tokens', 'max_turn_requests', 'cancelled'].includes(stopReason)) return { type: 'error', code: 'acp_unknown_stop_reason', error: 'The agent returned an unrecognized completion status. This turn could not be confirmed.' };
  return { type: 'done', sessionId, cost: null };
}

export interface AcpClientOptions {
  localEnvironment?: AcpEnvironmentBinding;
  runtimeId: string;
  command: string;
  args: string[];
  /** Working directory used to boot the ACP agent and its private service. */
  cwd?: string;
  env?: Record<string, string>;
  /** Remove inherited credentials for explicitly disconnected providers. */
  omitEnv?: string[];
  /** Called for every session/update notification's OrchestratorEvent (mapped). */
  onEvent?: (event: OrchestratorEvent, sessionId?: string) => void;
  /** Raw stderr lines from the agent (logs) — optional, for diagnostics. */
  onStderr?: (chunk: string) => void;
  /** Every raw ACP notification, before any optional OrchestratorEvent mapping. */
  onNotification?: (notification: AcpRawNotification) => void;
  /** Resolve agent-to-client JSON-RPC requests such as one-shot tool approval. */
  onRequest?: (request: AcpInboundRequest) => unknown | Promise<unknown>;
  /** Called after the owned ACP process exits. */
  onExit?: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
  /** Default bound for initialize/session/config requests. */
  requestTimeoutMs?: number;
}

/**
 * A live ACP agent subprocess speaking JSON-RPC 2.0 over NDJSON stdio. One client
 * = one agent process = (typically) one ACP session, reused across turns.
 */
export class AcpClient {
  private readonly outputRedactor: ReturnType<typeof localAcpOutputRedactor>;
  private proc: ChildProcess;
  private readonly credentialRuntimeId?: string;
  private readonly credentialPolicy?: string;
  private nextId = 1;
  private readonly pending = new Map<number, {
    method: string;
    sessionId?: string;
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private readonly outputStreams = new Map<string, Array<{ method: string; params: Record<string, unknown>; text?: string }>>();
  private buf = '';
  private readonly onEvent?: (event: OrchestratorEvent, sessionId?: string) => void;
  private readonly onNotification?: (notification: AcpRawNotification) => void;
  private readonly onRequest?: (request: AcpInboundRequest) => unknown | Promise<unknown>;
  private readonly requestTimeoutMs: number;
  private closed = false;
  private readonly viaInterpreter: boolean;

  constructor(opts: AcpClientOptions) {
    this.onEvent = opts.onEvent;
    this.onNotification = opts.onNotification;
    this.onRequest = opts.onRequest;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    // An ACP agent installed by npm is a `.cmd` on Windows, which spawn cannot
    // run directly (EINVAL, before any process exists). Going through the
    // interpreter makes the agent a GRANDchild, so kill() has to change too —
    // see below.
    const launch = cliInvocation(opts.command, opts.args);
    this.viaInterpreter = spawnsViaInterpreter(opts.command);
    this.credentialRuntimeId = opts.runtimeId;
    const child = withProviderStoreLock(() => {
      if (opts.localEnvironment) assertLocalAcpEnvironmentCurrent(opts.localEnvironment);
      const outputRedactor = localAcpOutputRedactor(opts.localEnvironment, opts.env);
      const env = childEnvironment({ runtimeId: opts.runtimeId, runtimeLaunch: true, omitEnv: opts.omitEnv, env: { ...(opts.cwd ? { PWD: opts.cwd } : {}), ...opts.env } });
      retainChildMetadataRedaction(env, { names: outputRedactor.secretNames, redact: value => outputRedactor.redact(value) });
      const policy = childEnvironmentContext(env)?.policy;
      return { policy, outputRedactor, proc: spawn(launch.command, launch.args, {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: opts.cwd,
        env,
      }) };
    });
    this.proc = child.proc;
    this.outputRedactor = child.outputRedactor;
    this.credentialPolicy = child.policy;
    this.proc.stdout?.setEncoding('utf8');
    this.proc.stdout?.on('data', (chunk: string) => this.onStdout(chunk));
    if (opts.onStderr) {
      const stderr = this.outputRedactor.stream(opts.onStderr);
      this.proc.stderr?.setEncoding('utf8');
      this.proc.stderr?.on('data', (chunk: string) => stderr(chunk));
      this.proc.stderr?.on('end', () => stderr('', true));
    }
    this.proc.on('close', (code, signal) => {
      this.onClose();
      opts.onExit?.({ code, signal });
    });
    this.proc.on('error', (err) => this.failAll(err instanceof Error ? err : new Error(String(err))));
  }

  /** Scrub external artifacts without changing the agent's protocol/session identifiers. */
  redactOutput<T>(value: T): T { return this.outputRedactor.redact(value); }
  private redactPayload<T>(value: T): T { return this.outputRedactor.redact(value, true); }

  redactEvent(event: OrchestratorEvent): OrchestratorEvent {
    const safe = { ...this.redactOutput(event), type: event.type } as OrchestratorEvent;
    if (safe.type === 'turn_receipt' && event.type === 'turn_receipt') {
      safe.effort = event.effort; safe.permissionMode = event.permissionMode;
    }
    if (safe.type === 'done' && event.type === 'done') safe.terminalOutcome = event.terminalOutcome;
    if (safe.type === 'handoff' && event.type === 'handoff') safe.carries = event.carries;
    if (safe.type === 'tool_use' && event.type === 'tool_use') safe.input = this.redactPayload(event.input);
    if (safe.type === 'tool_result' && event.type === 'tool_result') safe.input = this.redactPayload(event.input);
    if (safe.type === 'handoff' && event.type === 'handoff') safe.packet = this.redactPayload(event.packet);
    return safe;
  }

  private flushOutput(sessionId?: string): void {
    for (const [key, notifications] of this.outputStreams) {
      if (sessionId !== undefined && key !== sessionId) continue;
      this.outputStreams.delete(key);
      const chunks = this.outputRedactor.chunks(notifications.filter(item => item.text !== undefined).map(item => item.text!));
      let index = 0;
      for (const { method, params, text } of notifications) {
        if (text === undefined) this.publishNotification(method, params);
        else {
          const update = asRecord(params.update)!;
          this.publishNotification(method, { ...params, update: { ...update, content: { type: 'text', text: chunks[index++] } } });
        }
      }
    }
  }

  private publishNotification(method: string, params: Record<string, unknown>): void {
    const safe = this.redactOutput(params);
    // Routing tags remain internal protocol facts, not agent-authored content.
    safe.sessionId = params.sessionId;
    const update = asRecord(params.update); const safeUpdate = asRecord(safe.update);
    if (update && safeUpdate) {
      safeUpdate.sessionUpdate = update.sessionUpdate;
      if (Object.hasOwn(update, 'rawInput')) safeUpdate.rawInput = this.redactPayload(update.rawInput);
      if (Object.hasOwn(update, 'rawOutput')) safeUpdate.rawOutput = this.redactPayload(update.rawOutput);
      const content = asRecord(update.content); const safeContent = asRecord(safeUpdate.content);
      if (content && safeContent) safeContent.type = content.type;
    }
    this.onNotification?.({ method, params: safe });
    const event = method === 'session/update' ? mapAcpUpdate(safe.update) : null;
    if (event) this.onEvent?.(this.redactEvent(event), typeof params.sessionId === 'string' ? params.sessionId : undefined);
  }

  private onStdout(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: Record<string, unknown> | null;
      try {
        msg = asRecord(JSON.parse(line));
      } catch {
        continue; // non-JSON log line on stdout — ignore
      }
      if (!msg) continue;
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    // Response to one of our requests (has a matching id).
    if (typeof msg.id === 'number' && (('result' in msg) || ('error' in msg))) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timeout);
      if (entry.method === 'session/prompt') this.flushOutput(entry.sessionId);
      const res = msg as unknown as JsonRpcResponse;
      if (res.error) entry.reject(new AcpRequestError(res.error.code, this.redactOutput(`ACP error ${res.error.code}: ${res.error.message}`), this.redactPayload(res.error.data)));
      else entry.resolve(res.result);
      return;
    }
    if ((typeof msg.id === 'number' || typeof msg.id === 'string') && typeof msg.method === 'string') {
      const request: AcpInboundRequest = {
        id: msg.id,
        method: msg.method,
        params: asRecord(msg.params) ?? {},
      };
      if (!this.onRequest) {
        this.write({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32601, message: `Unsupported ACP request: ${request.method}` },
        });
        return;
      }
      void Promise.resolve().then(() => this.onRequest!(request)).then(
        (result) => this.write({ jsonrpc: '2.0', id: request.id, result: result ?? null }),
        (error) => {
          const requestError = error instanceof AcpRequestError
            ? error
            : new AcpRequestError(-32000, error instanceof Error ? error.message : String(error));
          this.write({
            jsonrpc: '2.0',
            id: request.id,
            error: {
              code: requestError.code,
              message: requestError.message,
              ...(requestError.data === undefined ? {} : { data: requestError.data }),
            },
          });
        },
      ).catch(() => { /* the process exited before the response could be written */ });
      return;
    }
    if (typeof msg.method === 'string') {
      const params = asRecord(msg.params) ?? {};
      const event = msg.method === 'session/update' ? mapAcpUpdate(params.update) : null;
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
      if (!this.outputRedactor.hasSecrets) {
        this.publishNotification(msg.method, params);
      } else if (event?.type === 'text' || event?.type === 'thinking') {
        const notifications = this.outputStreams.get(sessionId) ?? [];
        notifications.push({ method: msg.method, params, text: event.text });
        this.outputStreams.set(sessionId, notifications);
      } else {
        const pending = this.outputStreams.get(sessionId);
        if (pending) pending.push({ method: msg.method, params });
        else this.publishNotification(msg.method, params);
      }
    }
  }

  private onClose(): void {
    this.closed = true;
    this.failAll(new Error('ACP agent process exited'));
  }

  private failAll(err: Error): void {
    this.flushOutput();
    for (const { reject, timeout } of this.pending.values()) {
      clearTimeout(timeout);
      reject(new Error(this.redactOutput(err.message)));
    }
    this.pending.clear();
  }

  private write(obj: Record<string, unknown>): void {
    if (this.closed) throw new Error('ACP client is closed');
    this.proc.stdin?.write(JSON.stringify(obj) + '\n');
  }

  private request(method: string, params: unknown, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const sessionId = asRecord(params)?.sessionId;
      this.pending.set(id, { resolve, reject, timeout, method, ...(typeof sessionId === 'string' ? { sessionId } : {}) });
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  async initialize(clientName = 'o8', clientVersion = '0.1.0'): Promise<AcpInitializeResult> {
    const r = asRecord(await this.request('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      clientInfo: { name: clientName, version: clientVersion },
    })) ?? {};
    return {
      protocolVersion: typeof r.protocolVersion === 'number' ? r.protocolVersion : ACP_PROTOCOL_VERSION,
      agentCapabilities: asRecord(r.agentCapabilities) ?? undefined,
      agentInfo: (asRecord(r.agentInfo) ?? undefined) as AcpInitializeResult['agentInfo'],
      authMethods: (Array.isArray(r.authMethods) ? r.authMethods : undefined) as AcpInitializeResult['authMethods'],
    };
  }

  async newSession(cwd: string, mcpServers: AcpMcpServer[] = []): Promise<AcpNewSessionResult> {
    const result = asRecord(await this.request('session/new', { cwd, mcpServers }));
    const sessionId = result ? str(result.sessionId) : null;
    if (!sessionId) throw new Error('ACP session/new returned no sessionId');
    return { sessionId, configOptions: parseConfigOptions(result?.configOptions) };
  }

  /** Reconnect this client process to a durable ACP session without replaying history. */
  async resumeSession(
    sessionId: string,
    cwd: string,
    mcpServers: AcpMcpServer[] = [],
  ): Promise<AcpNewSessionResult> {
    const result = asRecord(await this.request('session/resume', { sessionId, cwd, mcpServers })) ?? {};
    return { sessionId, configOptions: parseConfigOptions(result.configOptions) };
  }

  /** Release one active session while keeping the shared ACP process available. */
  async closeSession(sessionId: string): Promise<void> {
    await this.request('session/close', { sessionId });
  }

  /**
   * Switch the session's model in place. Current ACP agents expose model as a
   * standard config option; older OpenCode builds used `session/set_model`.
   * Keep the narrow legacy fallback so an installed stable CLI can coexist
   * with the OpenCode 2 preview during migration.
   *
   * Agents that don't implement the method reject with "Method not found";
   * callers can preserve the established session while reporting the refusal.
   */
  async setModel(sessionId: string, modelId: string, configId = 'model'): Promise<void> {
    try {
      await this.request('session/set_config_option', {
        sessionId,
        configId,
        value: modelId,
      });
    } catch (err) {
      if (!(err instanceof AcpRequestError) || err.code !== -32601) throw err;
      await this.request('session/set_model', { sessionId, modelId });
    }
  }

  /** Select a model on agents whose model axis is the dedicated ACP method. */
  async setSessionModel(sessionId: string, modelId: string): Promise<void> {
    const result = await this.request('session/set_model', { sessionId, modelId });
    if (!asRecord(result)) throw new Error('ACP session/set_model did not confirm a session.');
  }

  /** Run one prompt turn. Resolves with the stopReason when the agent finishes;
   *  streaming arrives via onEvent in between. */
  async prompt(sessionId: string, text: string, timeoutMs?: number): Promise<AcpStopReason> {
    const pending = withProviderStoreLock(() => {
      if (this.credentialRuntimeId && this.credentialPolicy !== credentialPolicyFingerprint(this.credentialRuntimeId)) {
        this.kill();
        throw new Error('Credentials or billing changed during ACP initialization. Retry the launch.');
      }
      return this.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, timeoutMs);
    });
    const result = asRecord(await pending);
    const stopReason = result && str(result.stopReason);
    if (!stopReason) throw new Error('ACP session/prompt returned no stopReason');
    return stopReason;
  }

  /** Abort the in-flight turn (notification — the agent ends it with stopReason 'cancelled'). */
  cancel(sessionId: string): void {
    if (!this.closed) {
      try {
        this.notify('session/cancel', { sessionId });
      } catch {
        /* already gone */
      }
    }
  }

  get pid(): number | undefined {
    return this.proc.pid;
  }

  get alive(): boolean {
    return !this.closed;
  }

  kill(): void {
    this.closed = true;
    this.failAll(new Error('ACP client was stopped'));
    // When the agent was launched through cmd.exe it is a grandchild, and
    // kill() reaches only the interpreter — the agent keeps running with its
    // stdio pipes broken. `taskkill /T` is the only way to take the tree.
    if (this.viaInterpreter && this.proc.pid) {
      const pid = this.proc.pid;
      void import('@/lib/runtimes/shared/owned-session/helpers')
        .then(({ forceKillTreeWindows }) => forceKillTreeWindows(pid))
        .catch(() => { /* best effort — the SIGTERM below still fires */ });
    }
    try {
      this.proc.kill('SIGTERM');
    } catch {
      /* already dead */
    }
  }

  async close(timeoutMs = 1_500): Promise<void> {
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) return;
    this.kill();
    if (await this.waitForExit(timeoutMs)) return;
    try {
      this.proc.kill('SIGKILL');
    } catch {
      /* already dead */
    }
    await this.waitForExit(750);
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.proc.removeListener('close', exited);
        resolve(false);
      }, timeoutMs);
      const exited = () => {
        clearTimeout(timeout);
        resolve(true);
      };
      this.proc.once('close', exited);
    });
  }
}
