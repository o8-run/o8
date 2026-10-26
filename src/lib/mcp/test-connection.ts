/**
 * Exercises a stdio or HTTP MCP server enough to answer:
 *
 *   - Did it start?
 *   - Does it respond to JSON-RPC `initialize`?
 *   - How many tools does `tools/list` report?
 *
 * We don't take a dependency on `@modelcontextprotocol/sdk` here — the
 * Tauri bundle doesn't ship it, and the wire format is small enough to
 * implement directly.
 *
 * Timeouts are strict. A stuck child process is killed with SIGTERM (then
 * SIGKILL). Partial stderr is captured and returned so the UI can show
 * actionable diagnostics.
 */

import { spawn } from '@/lib/providers/child-process';
import { mcpLaunchEnvironment, assertMcpTransport, redactMcpOutput, redactMcpResponse } from '@/lib/providers/mcp-launch-policy';
import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';
import { isNpxFamily } from './npx-detection';

export interface McpTestSuccess {
  ok: true;
  transport: 'stdio' | 'http';
  tools: Array<{ name: string; description?: string }>;
  toolCount: number;
  durationMs: number;
  stderr?: string;
  /** True when the probe used the extended npx-family timeout. */
  npxFamily?: boolean;
}

export interface McpTestFailure {
  ok: false;
  transport: 'stdio' | 'http';
  error: string;
  stderr?: string;
  durationMs: number;
  /** True when the probe used the extended npx-family timeout. */
  npxFamily?: boolean;
}

export type McpTestResult = McpTestSuccess | McpTestFailure;

export interface StdioTestInput {
  transport: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface HttpTestInput {
  transport: 'http';
  url: string;
  headers?: Record<string, string>;
}

export type McpTestInput = StdioTestInput | HttpTestInput;

const DEFAULT_TIMEOUT_MS = 8_000;
const NPX_TIMEOUT_MS = 45_000;
const STDERR_CAP = 4000;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

interface ToolsListResult {
  tools?: Array<{ name?: unknown; description?: unknown }>;
}

function shortenStderr(text: string): string {
  const trimmed = redactMcpOutput(text).trim();
  if (trimmed.length <= STDERR_CAP) return trimmed;
  return `${trimmed.slice(0, STDERR_CAP)}… (${trimmed.length - STDERR_CAP} more bytes)`;
}

function normalizeTools(result: unknown): Array<{ name: string; description?: string }> {
  if (!result || typeof result !== 'object') return [];
  const payload = result as ToolsListResult;
  if (!Array.isArray(payload.tools)) return [];
  const out: Array<{ name: string; description?: string }> = [];
  for (const tool of payload.tools) {
    const name = typeof tool?.name === 'string' ? tool.name : '';
    if (!name) continue;
    const description = typeof tool?.description === 'string' ? tool.description : undefined;
    out.push(description !== undefined ? { name, description } : { name });
  }
  return out;
}

async function testStdio(input: StdioTestInput, timeoutMs: number, npxFamily: boolean): Promise<McpTestResult> {
  const started = Date.now();
  let stderrBuf = '';
  let resolved = false;
  let killed = false;

  return new Promise<McpTestResult>((resolve) => {
    let child: ReturnType<typeof spawn> | null = null;
    try {
      const childEnv = mcpLaunchEnvironment(input.command, input.env ?? {});
      // Most stdio MCP servers are configured as `npx …`, which on Windows is
      // `npx.cmd` — spawning it directly throws EINVAL and the user sees
      // "spawn failed" for a server that is installed and fine.
      const launch = cliInvocation(input.command, input.args ?? []);
      child = spawn(launch.command, launch.args, {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: childEnv,
      });
    } catch (error) {
      const message = redactMcpOutput(error instanceof Error ? error.message : String(error));
      resolve({
        ok: false,
        transport: 'stdio',
        error: `Spawn failed — ${message}`,
        durationMs: Date.now() - started,
        ...(npxFamily ? { npxFamily: true } : {}),
      });
      return;
    }

    const finish = (result: McpTestResult) => {
      if (resolved) return;
      resolved = true;
      if (child && !killed) {
        killed = true;
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        setTimeout(() => {
          if (child && !child.killed) {
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
          }
        }, 500);
      }
      resolve(result);
    };

    const timeout = setTimeout(() => {
      finish({
        ok: false,
        transport: 'stdio',
        error: `Timed out after ${timeoutMs}ms waiting for tools/list`,
        stderr: shortenStderr(stderrBuf) || undefined,
        durationMs: Date.now() - started,
        ...(npxFamily ? { npxFamily: true } : {}),
      });
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timeout);
      finish({
        ok: false,
        transport: 'stdio',
        error: `Process error — ${err.message}`,
        stderr: shortenStderr(stderrBuf) || undefined,
        durationMs: Date.now() - started,
        ...(npxFamily ? { npxFamily: true } : {}),
      });
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += redactMcpOutput(chunk.toString('utf-8'));
      if (stderrBuf.length > STDERR_CAP * 2) {
        stderrBuf = stderrBuf.slice(-STDERR_CAP * 2);
      }
    });

    child.on('exit', (code, signal) => {
      if (resolved) return;
      clearTimeout(timeout);
      const hint = signal ? `signal ${signal}` : `exit code ${code ?? '?'}`;
      finish({
        ok: false,
        transport: 'stdio',
        error: `Process exited before tools/list completed (${hint})`,
        stderr: shortenStderr(stderrBuf) || undefined,
        durationMs: Date.now() - started,
        ...(npxFamily ? { npxFamily: true } : {}),
      });
    });

    // Parse stdout as newline-delimited JSON-RPC.
    let stdoutBuf = '';
    const pending = new Map<number, (resp: JsonRpcResponse) => void>();

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf-8');
      let newlineIdx = stdoutBuf.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = stdoutBuf.slice(0, newlineIdx).trim();
        stdoutBuf = stdoutBuf.slice(newlineIdx + 1);
        newlineIdx = stdoutBuf.indexOf('\n');
        if (!line) continue;
        try {
          const msg = redactMcpResponse(JSON.parse(line)) as JsonRpcResponse;
          if (typeof msg.id === 'number' && pending.has(msg.id)) {
            const handler = pending.get(msg.id)!;
            pending.delete(msg.id);
            handler(msg);
          }
        } catch {
          // Ignore malformed or notification frames.
        }
      }
    });

    const writeRequest = (req: JsonRpcRequest) => {
      if (!child?.stdin || child.stdin.destroyed) {
        finish({
          ok: false,
          transport: 'stdio',
          error: 'Child stdin closed before request was sent',
          stderr: shortenStderr(stderrBuf) || undefined,
          durationMs: Date.now() - started,
          ...(npxFamily ? { npxFamily: true } : {}),
        });
        return false;
      }
      try {
        child.stdin.write(JSON.stringify(req) + '\n');
        return true;
      } catch (error) {
        const message = redactMcpOutput(error instanceof Error ? error.message : String(error));
        finish({
          ok: false,
          transport: 'stdio',
          error: `Failed to write request — ${message}`,
          stderr: shortenStderr(stderrBuf) || undefined,
          durationMs: Date.now() - started,
          ...(npxFamily ? { npxFamily: true } : {}),
        });
        return false;
      }
    };

    const awaitResponse = (id: number): Promise<JsonRpcResponse> => {
      return new Promise<JsonRpcResponse>((responseResolve) => {
        pending.set(id, responseResolve);
      });
    };

    // 1. Send initialize.
    const initId = 1;
    if (!writeRequest({
      jsonrpc: '2.0',
      id: initId,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'o8-test-connection', version: '1.0.0' },
      },
    })) return;

    void awaitResponse(initId).then((initResp) => {
      if (initResp.error) {
        finish({
          ok: false,
          transport: 'stdio',
          error: `initialize failed — ${initResp.error.message}`,
          stderr: shortenStderr(stderrBuf) || undefined,
          durationMs: Date.now() - started,
          ...(npxFamily ? { npxFamily: true } : {}),
        });
        return;
      }

      // Optional per-spec: notify initialized.
      writeRequest({ jsonrpc: '2.0', id: 2, method: 'notifications/initialized' });

      // 2. Send tools/list.
      const listId = 3;
      if (!writeRequest({ jsonrpc: '2.0', id: listId, method: 'tools/list' })) return;

      void awaitResponse(listId).then((listResp) => {
        if (listResp.error) {
          finish({
            ok: false,
            transport: 'stdio',
            error: `tools/list failed — ${listResp.error.message}`,
            stderr: shortenStderr(stderrBuf) || undefined,
            durationMs: Date.now() - started,
            ...(npxFamily ? { npxFamily: true } : {}),
          });
          return;
        }
        const tools = normalizeTools(listResp.result);
        clearTimeout(timeout);
        finish({
          ok: true,
          transport: 'stdio',
          tools,
          toolCount: tools.length,
          durationMs: Date.now() - started,
          stderr: shortenStderr(stderrBuf) || undefined,
          ...(npxFamily ? { npxFamily: true } : {}),
        });
      });
    });
  });
}

async function testHttp(input: HttpTestInput, timeoutMs: number): Promise<McpTestResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    assertMcpTransport(input);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...input.headers,
    };

    const requestBody = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    };

    const res = await fetch(input.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      return {
        ok: false,
        transport: 'http',
        error: `HTTP ${res.status} ${res.statusText}`,
        durationMs: Date.now() - started,
      };
    }

    const text = redactMcpOutput(await res.text());
    let payload: JsonRpcResponse | null = null;
    try {
      payload = redactMcpResponse(JSON.parse(text)) as JsonRpcResponse;
    } catch {
      // Some MCP HTTP servers reply as SSE. Grab the last `data:` chunk.
      const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (!lines[i].startsWith('data:')) continue;
        const data = lines[i].slice(5).trim();
        if (!data) continue;
        try {
          payload = redactMcpResponse(JSON.parse(data)) as JsonRpcResponse;
          break;
        } catch {
          // Keep scanning.
        }
      }
    }

    if (!payload) {
      return {
        ok: false,
        transport: 'http',
        error: 'Server replied with non-JSON body',
        durationMs: Date.now() - started,
      };
    }

    if (payload.error) {
      return {
        ok: false,
        transport: 'http',
        error: `tools/list failed — ${payload.error.message}`,
        durationMs: Date.now() - started,
      };
    }

    const tools = normalizeTools(payload.result);
    return {
      ok: true,
      transport: 'http',
      tools,
      toolCount: tools.length,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    clearTimeout(timeout);
    const aborted = controller.signal.aborted;
    const message = redactMcpOutput(error instanceof Error ? error.message : String(error));
    return {
      ok: false,
      transport: 'http',
      error: aborted ? `Timed out after ${timeoutMs}ms` : `Request failed — ${message}`,
      durationMs: Date.now() - started,
    };
  }
}

export async function testMcpConnection(
  input: McpTestInput,
  timeoutMs?: number,
): Promise<McpTestResult> {
  if (input.transport === 'stdio') {
    const npxFamily = isNpxFamily(input.command);
    const resolvedTimeout = timeoutMs ?? (npxFamily ? NPX_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
    return testStdio(input, resolvedTimeout, npxFamily);
  }
  return testHttp(input, timeoutMs ?? DEFAULT_TIMEOUT_MS);
}
