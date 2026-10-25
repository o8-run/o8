import { childDiagnostic } from '@/lib/providers/child-diagnostics';
import { childEnvironment } from '@/lib/providers/spawn-environment';
/**
 * Minimal MCP-stdio JSON-RPC client for codebase-memory tool calls.
 *
 * `callCodebaseMemoryTool` preserves the one-shot API used by indexing.
 * Recall paths can use `withCodebaseMemoryToolSession` to initialize one
 * child and issue several related calls without paying process startup for
 * every symbol and fallback lookup.
 *
 * Wire format mirrors src/lib/mcp/test-connection.ts. Both build on the
 * MCP 2024-11-05 protocol with newline-delimited JSON-RPC frames.
 */

import 'server-only';

import { spawn } from '@/lib/providers/child-process';

const INIT_TIMEOUT_MS = 10_000;
const DEFAULT_CALL_TIMEOUT_MS = 5 * 60_000; // 5 min — large repos take time to index

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface McpToolCallInput {
  binPath: string;
  cwd: string;
  toolName: string;
  args?: Record<string, unknown>;
  /** Override timeout (ms) for the tools/call response. */
  timeoutMs?: number;
}

export interface McpToolCallSuccess {
  ok: true;
  result: unknown;
  durationMs: number;
}

export interface McpToolCallFailure {
  ok: false;
  error: string;
  stderr?: string;
  durationMs: number;
}

export type McpToolCallResult = McpToolCallSuccess | McpToolCallFailure;

export type CodebaseMemoryToolCaller = (
  input: Omit<McpToolCallInput, 'binPath' | 'cwd'>,
) => Promise<McpToolCallResult>;

export type McpToolSessionResult<T> =
  | { ok: true; value: T; durationMs: number }
  | McpToolCallFailure;

interface PendingResponse {
  resolve: (response: JsonRpcResponse) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * Initialize one stdio child, run a bounded group of tool calls, then close it.
 * Tool-level failures are returned by `callTool` without ending the session so
 * callers can attempt a fallback against the same initialized process.
 */
export async function withCodebaseMemoryToolSession<T>(
  input: Pick<McpToolCallInput, 'binPath' | 'cwd' | 'timeoutMs'>,
  run: (callTool: CodebaseMemoryToolCaller) => Promise<T>,
): Promise<McpToolSessionResult<T>> {
  const started = Date.now();
  let stderrBuf = '';
  let stdoutBuf = '';
  let nextId = 1;
  let closing = false;
  let fatalError: Error | null = null;
  const pending = new Map<number, PendingResponse>();

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(input.binPath, [], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: input.cwd,
      env: childEnvironment(),
    });
  } catch (error) {
    const message = childDiagnostic(error instanceof Error ? error.message : String(error));
    return {
      ok: false,
      error: `Spawn failed — ${message}`,
      durationMs: Date.now() - started,
    };
  }

  const failSession = (error: Error) => {
    if (!fatalError) fatalError = error;
    for (const response of pending.values()) {
      clearTimeout(response.timeout);
      response.reject(fatalError);
    }
    pending.clear();
  };

  const stopChild = () => {
    if (closing) return;
    closing = true;
    for (const response of pending.values()) {
      clearTimeout(response.timeout);
      response.reject(new Error('MCP session closed'));
    }
    pending.clear();
    try {
      child.kill('SIGTERM');
    } catch {
      return;
    }
    const forceKill = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          // Process already exited.
        }
      }
    }, 500);
    forceKill.unref();
  };

  child.on('error', (error) => {
    if (!closing) failSession(new Error(`Process error — ${error.message}`));
  });
  child.on('exit', (code, signal) => {
    if (closing) return;
    const hint = signal ? `signal ${signal}` : `exit code ${code ?? '?'}`;
    failSession(new Error(`Process exited before tool call completed (${hint})`));
  });
  child.stdin?.on('error', (error: Error) => {
    if (!closing) failSession(new Error(`Child stdin error — ${error.message}`));
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf-8');
    if (stderrBuf.length > 8000) stderrBuf = stderrBuf.slice(-8000);
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf-8');
    let newline = stdoutBuf.indexOf('\n');
    while (newline !== -1) {
      const line = stdoutBuf.slice(0, newline).trim();
      stdoutBuf = stdoutBuf.slice(newline + 1);
      newline = stdoutBuf.indexOf('\n');
      if (!line) continue;
      try {
        const message = JSON.parse(line) as JsonRpcResponse;
        if (typeof message.id !== 'number') continue;
        const response = pending.get(message.id);
        if (!response) continue;
        pending.delete(message.id);
        clearTimeout(response.timeout);
        response.resolve(message);
      } catch {
        // Notification or malformed output — ignore.
      }
    }
  });

  const writeRequest = (request: JsonRpcRequest) => {
    if (fatalError) throw fatalError;
    if (!child.stdin || child.stdin.destroyed) {
      throw new Error('Child stdin closed before request was sent');
    }
    child.stdin.write(`${JSON.stringify(request)}\n`);
  };

  const request = (
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<JsonRpcResponse> => {
    const id = nextId;
    nextId += 1;
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        const error = new Error(`Request id ${id} timed out after ${timeoutMs}ms`);
        failSession(error);
        reject(error);
      }, timeoutMs);
      pending.set(id, { resolve, reject, timeout });
      try {
        writeRequest({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timeout);
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  const callTool: CodebaseMemoryToolCaller = async (callInput) => {
    const callStarted = Date.now();
    const timeoutMs = callInput.timeoutMs ?? input.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    try {
      const response = await request('tools/call', {
        name: callInput.toolName,
        arguments: callInput.args ?? {},
      }, timeoutMs);
      if (response.error) {
        return {
          ok: false,
          error: childDiagnostic(`${callInput.toolName} failed — ${response.error.message}`),
          stderr: childDiagnostic(stderrBuf) || undefined,
          durationMs: Date.now() - callStarted,
        };
      }
      const toolResult = response.result as
        | { isError?: boolean; content?: Array<{ type?: string; text?: string }> }
        | undefined;
      if (toolResult?.isError === true) {
        const text = toolResult.content
          ?.map((content) => content?.text ?? '')
          .filter(Boolean)
          .join(' ')
          .trim();
        return {
          ok: false,
          error: childDiagnostic(`${callInput.toolName} reported isError${text ? ` — ${text}` : ''}`),
          stderr: childDiagnostic(stderrBuf) || undefined,
          durationMs: Date.now() - callStarted,
        };
      }
      return {
        ok: true,
        result: response.result,
        durationMs: Date.now() - callStarted,
      };
    } catch (error) {
      return {
        ok: false,
        error: childDiagnostic(error instanceof Error ? error.message : String(error)),
        stderr: childDiagnostic(stderrBuf) || undefined,
        durationMs: Date.now() - callStarted,
      };
    }
  };

  try {
    const initializeTimeoutMs = input.timeoutMs == null
      ? INIT_TIMEOUT_MS
      : Math.min(INIT_TIMEOUT_MS, input.timeoutMs);
    const initialize = await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'o8-codebase-memory-indexer', version: '1.0.0' },
    }, initializeTimeoutMs);
    if (initialize.error) {
      return {
        ok: false,
        error: childDiagnostic(`initialize failed — ${initialize.error.message}`),
        stderr: childDiagnostic(stderrBuf) || undefined,
        durationMs: Date.now() - started,
      };
    }
    writeRequest({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const value = await run(callTool);
    return { ok: true, value, durationMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      error: childDiagnostic(error instanceof Error ? error.message : String(error)),
      stderr: childDiagnostic(stderrBuf) || undefined,
      durationMs: Date.now() - started,
    };
  } finally {
    stopChild();
  }
}

export async function callCodebaseMemoryTool(
  input: McpToolCallInput,
): Promise<McpToolCallResult> {
  const session = await withCodebaseMemoryToolSession(
    { binPath: input.binPath, cwd: input.cwd },
    (callTool) => callTool({
      toolName: input.toolName,
      args: input.args,
      timeoutMs: input.timeoutMs,
    }),
  );
  if (!session.ok) return session;
  return { ...session.value, durationMs: session.durationMs };
}
