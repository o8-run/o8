import { childEnvironment } from '@/lib/providers/spawn-environment';
import { providerMcpEnvironment } from '@/lib/providers/spawn-environment';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { buildToolRegistry } from '@/lib/mcp/tool-spine/build';
import { entriesForSurface, type ToolProfile } from '@/lib/mcp/tool-spine/registry';
import { StdioJsonRpcPeer } from '@/lib/runtimes/shared/stdio-json-rpc';
import { buildNextUrl } from '@/lib/ws-server/next-fetch';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import type { O8CommandServer, O8ServerRequest } from './o8-commands';
import { withVisualizationContext } from '@/lib/mcp/visualization-context';

/** Long enough for blocking commands such as wait_for_mission_ready. */
const SERVER_REQUEST_TIMEOUT_MS = 15 * 60_000;

export interface O8ServerSet {
  servers: O8CommandServer[];
  close(): Promise<void>;
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('Stopped'));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

let nextRequestId = 0;

/**
 * POSTs one JSON-RPC message and reads the whole reply. Not fetch: fetch gives
 * up when headers take more than five minutes, which cut blocking commands such
 * as wait_for_mission_ready short (#3739). The caller's signal and `timeoutMs`
 * bound the request instead.
 */
function postJson(url: string, headers: Record<string, string>, body: string, signal: AbortSignal | undefined,
  timeoutMs: number): Promise<{ status: number; text: string }> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = send(target, { method: 'POST', signal,
      headers: { ...headers, 'Content-Length': String(Buffer.byteLength(body)) } }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    const timer = setTimeout(() => request.destroy(new Error(`The o8 operator server did not answer within ${timeoutMs}ms`)),
      timeoutMs);
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
    request.end(body);
  });
}

/**
 * The operator server's in-app host, reached the way the operator stdio proxy
 * forwards every message: a JSON-RPC POST to /api/mcp with the ws token.
 */
function createOperatorOverHttp(timeoutMs = SERVER_REQUEST_TIMEOUT_MS): O8ServerRequest {
  return async (method, params, signal) => {
    const response = await postJson(buildNextUrl('/api/mcp', undefined, 'POST'), {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getOrCreateWsToken()}`,
    }, JSON.stringify({ jsonrpc: '2.0', id: `pi-${++nextRequestId}`, method, params }), signal, timeoutMs);
    if (response.status < 200 || response.status > 299) {
      throw new Error(`The o8 operator server returned HTTP ${response.status}`);
    }
    const message = JSON.parse(response.text) as { result?: unknown; error?: { message?: string } };
    if (message.error) throw new Error(message.error.message ?? 'The o8 operator server refused the request');
    return message.result;
  };
}

export const operatorOverHttp: O8ServerRequest = createOperatorOverHttp();

async function openStdioServer(name: string, launch: { command: string; args?: string[]; env?: Record<string, string> },
  cwd: string): Promise<{ server: O8CommandServer; close: () => Promise<void> }> {
  const peer = new StdioJsonRpcPeer({ command: launch.command, args: launch.args ?? [], cwd,
    env: providerMcpEnvironment(childEnvironment({ runtimeId: 'pi', env: launch.env })) }, SERVER_REQUEST_TIMEOUT_MS);
  try {
    await peer.request('initialize', { protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'o8-pi-orchestrator', version: '1.0.0' } }, 60_000);
  } catch (error) {
    await peer.close({ gracefulMs: 200 });
    throw error;
  }
  return {
    server: { name, request: (method, params, signal) => abortable(peer.request(method, params), signal) },
    close: () => peer.close({ gracefulMs: 200 }),
  };
}

/**
 * Opens the built-in o8 servers the Claude orchestrator surface gets for this
 * repo and tool profile: the operator server and cortex (read-only on a
 * proposer turn), from the same tool-spine entries. User-configured external
 * servers are not attached to Pi.
 */
export async function openO8Servers(repoPath: string, options: {
  profile?: ToolProfile;
  threadId?: string | null;
  /** Test seam for the operator host. Production uses /api/mcp. */
  operatorRequest?: O8ServerRequest;
  /** Test seam for the /api/mcp request bound. */
  operatorTimeoutMs?: number;
}): Promise<O8ServerSet> {
  const registry = buildToolRegistry(repoPath, { profile: options.profile, threadId: options.threadId });
  const servers: O8CommandServer[] = [];
  const closers: Array<() => Promise<void>> = [];
  const close = async () => { await Promise.allSettled(closers.map(closeServer => closeServer())); };
  try {
    for (const { name, config, entry } of entriesForSurface(registry, 'claude-orchestrator')) {
      if (entry.source !== 'builtin') continue;
      if (entry.id === 'builtin:operator') {
        const request = options.operatorRequest
          ?? (options.operatorTimeoutMs === undefined ? operatorOverHttp : createOperatorOverHttp(options.operatorTimeoutMs));
        servers.push({ name, request: (method, params, signal) => request(method,
          withVisualizationContext({ method, params }, { repoPath, threadId: options.threadId ?? undefined }).params, signal) });
      } else if (config.type === 'stdio') {
        const opened = await openStdioServer(name, config, repoPath);
        closers.push(opened.close);
        servers.push(opened.server);
      }
    }
  } catch (error) {
    await close();
    throw error;
  }
  return { servers, close };
}
