import { childDiagnostic } from '@/lib/providers/child-diagnostics';
import { credentialPolicyFingerprint } from '@/lib/providers/credential-policy';
import { onCredentialPolicyChange } from '@/lib/providers/policy-events';
import { configuredRuntimeId, configuredMcpEnvironment } from '@/lib/providers/spawn-environment';
import 'server-only';

import { spawn, type ChildProcessWithoutNullStreams } from '@/lib/providers/child-process';
import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';
import {
  listEnabledExternalMcpServers,
  type ExternalMcpServerRecord,
} from '@/lib/mcp/external-servers';
import { registerSymonMcpCacheInvalidator } from '@/lib/mcp/symon-tools-cache';

const PROTOCOL_VERSION = '2024-11-05';
const REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_IDLE_MS = 3 * 60_000;
const MAX_TOOL_NAME_LENGTH = 64;
const SERVER_NAME_LENGTH = 24;

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface PendingResponse {
  resolve: (response: JsonRpcResponse) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface SourceTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface SymonMcpToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface SymonMcpServerCatalog {
  id: string;
  name: string;
  toolNames: string[];
}

export interface SymonMcpCatalog {
  tools: SymonMcpToolSchema[];
  servers: SymonMcpServerCatalog[];
}

interface CatalogEntry {
  schema: SymonMcpToolSchema;
  server: ExternalMcpServerRecord;
  sourceToolName: string;
}

interface McpSession {
  listTools(): Promise<SourceTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

function idleMs(): number {
  const configured = Number(process.env.O8_SYMON_MCP_IDLE_MS);
  return Number.isFinite(configured) && configured >= 10 ? configured : DEFAULT_IDLE_MS;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rpcError(method: string, response: JsonRpcResponse): Error | null {
  if (!response.error) return null;
  const message = childDiagnostic(typeof response.error.message === 'string' ? response.error.message : 'Unknown MCP error');
  return new Error(`${method} failed: ${message}`);
}

function normalizeInputSchema(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { type: 'object', properties: {}, required: [] };
  }
  const schema = value as Record<string, unknown>;
  return {
    ...schema,
    type: 'object',
    properties: schema.properties && typeof schema.properties === 'object'
      && !Array.isArray(schema.properties) ? schema.properties : {},
    required: Array.isArray(schema.required) ? schema.required : [],
  };
}

function normalizeTools(result: unknown): SourceTool[] {
  if (!result || typeof result !== 'object') return [];
  const tools = (result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const tool = candidate as Record<string, unknown>;
    const name = typeof tool.name === 'string' ? tool.name.trim() : '';
    if (!name) return [];
    return [{
      name,
      ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
      inputSchema: normalizeInputSchema(tool.inputSchema),
    }];
  });
}

class StdioSession implements McpSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingResponse>();
  private nextId = 1;
  private stdout = '';
  private closed = false;
  private inFlight = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private initializePromise: Promise<void> | null = null;

  constructor(
    private readonly server: ExternalMcpServerRecord,
    private readonly onClose: () => void,
  ) {
    const launch = cliInvocation(server.command, server.args);
    this.child = spawn(launch.command, launch.args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: configuredMcpEnvironment(server.command, server.env ?? {}, true, server.args),
    });
    this.child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));
    this.child.stderr.on('data', () => {
      // Never retain or return server stderr. It can contain configured secrets.
    });
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.on('error', (error) => this.fail(error));
    this.child.on('exit', (code, signal) => {
      if (this.closed) return;
      const reason = signal ? `signal ${signal}` : `exit code ${code ?? '?'}`;
      this.fail(new Error(`MCP process exited (${reason})`));
    });
  }

  async listTools(): Promise<SourceTool[]> {
    await this.initialize();
    const response = await this.request('tools/list', {});
    const failure = rpcError('tools/list', response);
    if (failure) throw failure;
    return normalizeTools(response.result);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.initialize();
    const response = await this.request('tools/call', { name, arguments: args });
    const failure = rpcError('tools/call', response);
    if (failure) throw failure;
    return response.result;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('MCP session closed'));
    }
    this.pending.clear();
    try { this.child.kill('SIGTERM'); } catch { /* Process already exited. */ }
    const forceKill = setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) {
        try { this.child.kill('SIGKILL'); } catch { /* Process already exited. */ }
      }
    }, 500);
    forceKill.unref();
    this.onClose();
  }

  private async initialize(): Promise<void> {
    if (!this.initializePromise) {
      this.initializePromise = (async () => {
        const response = await this.request('initialize', {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'o8-symon-mcp', version: '1.0.0' },
        });
        const failure = rpcError('initialize', response);
        if (failure) throw failure;
        this.notify('notifications/initialized', {});
      })();
    }
    return this.initializePromise;
  }

  private request(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    if (this.closed) return Promise.reject(new Error('MCP session is closed'));
    const id = this.nextId;
    this.nextId += 1;
    this.inFlight += 1;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${REQUEST_TIMEOUT_MS}ms`));
        this.finishRequest();
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        timeout,
        resolve: (response) => {
          resolve(response);
          this.finishRequest();
        },
        reject: (error) => {
          reject(error);
          this.finishRequest();
        },
      });
      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
        this.finishRequest();
      }
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    if (this.closed) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  private onStdout(chunk: Buffer): void {
    this.stdout += chunk.toString('utf8');
    let newline = this.stdout.indexOf('\n');
    while (newline !== -1) {
      const line = this.stdout.slice(0, newline).trim();
      this.stdout = this.stdout.slice(newline + 1);
      newline = this.stdout.indexOf('\n');
      if (!line) continue;
      try {
        const response = JSON.parse(line) as JsonRpcResponse;
        if (typeof response.id !== 'number') continue;
        const pending = this.pending.get(response.id);
        if (!pending) continue;
        this.pending.delete(response.id);
        clearTimeout(pending.timeout);
        pending.resolve(response);
      } catch {
        // Ignore notifications and malformed frames.
      }
    }
  }

  private finishRequest(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (this.closed || this.inFlight > 0) return;
    this.idleTimer = setTimeout(() => this.close(), idleMs());
    this.idleTimer.unref();
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    this.onClose();
  }
}

class HttpSession implements McpSession {
  private sessionId: string | null = null;
  private initializePromise: Promise<void> | null = null;

  constructor(private readonly server: ExternalMcpServerRecord) {}

  async listTools(): Promise<SourceTool[]> {
    await this.initialize();
    const response = await this.request('tools/list', {});
    const failure = rpcError('tools/list', response);
    if (failure) throw failure;
    return normalizeTools(response.result);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.initialize();
    const response = await this.request('tools/call', { name, arguments: args });
    const failure = rpcError('tools/call', response);
    if (failure) throw failure;
    return response.result;
  }

  close(): void {}

  private async initialize(): Promise<void> {
    if (!this.initializePromise) {
      this.initializePromise = (async () => {
        const response = await this.request('initialize', {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'o8-symon-mcp', version: '1.0.0' },
        });
        const failure = rpcError('initialize', response);
        if (failure) throw failure;
        await this.notify('notifications/initialized', {});
      })();
    }
    return this.initializePromise;
  }

  private async request(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    const id = Date.now() + Math.floor(Math.random() * 10_000);
    return this.post({ jsonrpc: '2.0', id, method, params }, true);
  }

  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    await this.post({ jsonrpc: '2.0', method, params }, false);
  }

  private async post(body: Record<string, unknown>, expectResponse: boolean): Promise<JsonRpcResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const url = this.server.url || this.server.command;
    const headers: Record<string, string> = {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(this.server.oauthToken ? { authorization: `Bearer ${this.server.oauthToken}` } : {}),
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
    };
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`MCP HTTP request failed with status ${response.status}`);
      this.sessionId = response.headers.get('mcp-session-id') || this.sessionId;
      if (!expectResponse || response.status === 202) return {};
      return parseHttpResponse(await response.text());
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`MCP HTTP request timed out after ${REQUEST_TIMEOUT_MS}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function parseHttpResponse(text: string): JsonRpcResponse {
  try {
    return JSON.parse(text) as JsonRpcResponse;
  } catch {
    const dataLines = text.split(/\r?\n/).filter((line) => line.startsWith('data:'));
    for (let index = dataLines.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(dataLines[index].slice(5).trim()) as JsonRpcResponse;
      } catch {
        // Keep scanning earlier SSE events.
      }
    }
    throw new Error('MCP HTTP server returned an invalid response');
  }
}

const sessions = new Map<string, McpSession>();
const pendingSessions = new Map<string, Promise<McpSession>>();
const warnedUnavailable = new Set<string>();
let catalogEntries: CatalogEntry[] | null = null;
let catalogPromise: Promise<CatalogEntry[]> | null = null;
let catalogGeneration = 0;

async function getSession(server: ExternalMcpServerRecord): Promise<McpSession> {
  const existing = sessions.get(server.id);
  if (existing) return existing;
  const pending = pendingSessions.get(server.id);
  if (pending) return pending;
  const generation = catalogGeneration;
  const creating = Promise.resolve().then(() => {
    if (generation !== catalogGeneration) throw new Error('MCP registry changed');
    let session: McpSession;
    if (server.transport === 'stdio') {
      session = new StdioSession(server, () => {
        if (sessions.get(server.id) === session) sessions.delete(server.id);
      });
    } else {
      session = new HttpSession(server);
    }
    sessions.set(server.id, session);
    return session;
  }).finally(() => {
    if (pendingSessions.get(server.id) === creating) pendingSessions.delete(server.id);
  });
  pendingSessions.set(server.id, creating);
  return creating;
}

function closeSessions(): void {
  for (const session of sessions.values()) session.close();
  sessions.clear();
  pendingSessions.clear();
}

function invalidateAll(): void {
  catalogGeneration += 1;
  catalogEntries = null;
  catalogPromise = null;
  closeSessions();
}

registerSymonMcpCacheInvalidator(invalidateAll);
onCredentialPolicyChange(invalidateAll);
let payerFingerprint: string | undefined;
function refreshPayerPolicy(): void {
  const current = listEnabledExternalMcpServers().filter(server => server.symonInjection)
    .map(server => credentialPolicyFingerprint(configuredRuntimeId(server.command) ?? 'unknown')).join(':');
  if (payerFingerprint !== undefined && payerFingerprint !== current) invalidateAll();
  payerFingerprint = current;
}
process.once('exit', closeSessions);

function sanitizeNamePart(value: string, maxLength: number): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, maxLength) || '_';
}

function externalToolName(serverName: string, toolName: string): string {
  const server = sanitizeNamePart(serverName, SERVER_NAME_LENGTH);
  const toolBudget = Math.max(1, MAX_TOOL_NAME_LENGTH - `mcp__${server}__`.length);
  return `mcp__${server}__${sanitizeNamePart(toolName, toolBudget)}`;
}

async function buildCatalog(): Promise<CatalogEntry[]> {
  const generation = catalogGeneration;
  const servers = listEnabledExternalMcpServers().filter((server) => server.symonInjection);
  const candidates = (await Promise.all(servers.map(async (server) => {
    try {
      const tools = await (await getSession(server)).listTools();
      warnedUnavailable.delete(server.id);
      return tools.map((tool) => ({
        schema: {
          name: externalToolName(server.name, tool.name),
          description: tool.description || `Call ${tool.name} on the connected ${server.name} MCP server.`,
          parameters: tool.inputSchema,
        },
        server,
        sourceToolName: tool.name,
      }));
    } catch {
      if (generation !== catalogGeneration) return [];
      if (!warnedUnavailable.has(server.id)) {
        warnedUnavailable.add(server.id);
        console.warn(`[symon-mcp] Connected server "${server.name}" is unavailable; omitting its tools.`);
      }
      sessions.get(server.id)?.close();
      return [];
    }
  }))).flat();

  const counts = new Map<string, number>();
  for (const entry of candidates) {
    counts.set(entry.schema.name, (counts.get(entry.schema.name) ?? 0) + 1);
  }
  const collisions = new Set(
    [...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name),
  );
  for (const name of collisions) {
    console.warn(`[symon-mcp] Refusing colliding external tool name "${name}".`);
  }
  return candidates.filter((entry) => !collisions.has(entry.schema.name));
}

async function entries(force = false): Promise<CatalogEntry[]> {
  refreshPayerPolicy();
  if (!force && catalogEntries) return catalogEntries;
  if (catalogPromise) return catalogPromise;
  const generation = catalogGeneration;
  const building = buildCatalog()
    .then((next) => {
      // An old refresh must neither publish nor return revoked tools.
      if (generation !== catalogGeneration) return [];
      catalogEntries = next;
      return next;
    })
    .finally(() => {
      if (catalogPromise === building) catalogPromise = null;
    });
  catalogPromise = building;
  return building;
}

export async function getSymonMcpCatalog(options?: { refresh?: boolean }): Promise<SymonMcpCatalog> {
  const catalog = await entries(options?.refresh === true);
  const serverMap = new Map<string, SymonMcpServerCatalog>();
  for (const entry of catalog) {
    const server = serverMap.get(entry.server.id) ?? {
      id: entry.server.id,
      name: entry.server.name,
      toolNames: [],
    };
    server.toolNames.push(entry.schema.name);
    serverMap.set(entry.server.id, server);
  }
  return {
    tools: catalog.map((entry) => entry.schema),
    servers: [...serverMap.values()],
  };
}

export async function callSymonMcpTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const entry = (await entries()).find((candidate) => candidate.schema.name === name);
  if (!entry) throw new Error('Unknown or unavailable connected MCP tool');
  try {
    return await (await getSession(entry.server)).callTool(entry.sourceToolName, args);
  } catch (error) {
    throw new Error(`Connected MCP tool failed: ${errorMessage(error)}`);
  }
}
