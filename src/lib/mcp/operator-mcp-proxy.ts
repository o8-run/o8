#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DEFAULT_API_PORT } from '@/lib/panel/api-port';
import { getDataDir } from '@/lib/data-dir-migration';
import { withVisualizationContext } from './visualization-context';
import { deferredMcpRequest } from './deferred-tools';
import type { McpTool } from './operator-handlers/shared';
import { isModernMcpRequest, modernMcpError, modernMcpHeaders, modernMcpResult } from './operator-mcp-protocol';

type JsonRpcId = number | string | null;
const deviceWorker = randomUUID();


function readTrimmed(path: string): string {
  try { return existsSync(path) ? readFileSync(path, 'utf-8').trim() : ''; } catch { return ''; }
}

function resolveApiBase(): string {
  const portText = readTrimmed(join(getDataDir(), 'api-port'));
  const port = Number(portText);
  if (Number.isInteger(port) && port > 0 && port < 65536) return `http://127.0.0.1:${port}`;
  if (process.env.O8_API_BASE) return process.env.O8_API_BASE;
  if (process.env.O8_API_PORT) return `http://127.0.0.1:${process.env.O8_API_PORT}`;
  return `http://127.0.0.1:${DEFAULT_API_PORT}`;
}

function requestId(message: unknown): JsonRpcId {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  const id = (message as { id?: unknown }).id;
  return typeof id === 'number' || typeof id === 'string' || id === null ? id : null;
}

function expectsResponse(message: unknown): boolean {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return true;
  const id = (message as { id?: unknown }).id;
  return id !== undefined && id !== null;
}

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function request(message: unknown): Promise<unknown> {
  const workerOnly = process.env.O8_DEVICE_WORKER_ONLY === '1';
  const token = workerOnly ? process.env.O8_WORKER_TOKEN : readTrimmed(join(getDataDir(), 'ws-token'));
  const response = await fetch(`${resolveApiBase()}${workerOnly ? '/api/devices/agent' : '/api/mcp'}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'x-o8-device-worker': deviceWorker,
      'x-o8-device-conversation': process.env.O8_VISUALIZATION_THREAD_ID || deviceWorker,
      'x-o8-device-pid': String(process.pid),
      ...(workerOnly ? { 'x-o8-mcp-profile': 'devices' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(process.env.O8_OPERATOR_MCP_PROFILE ? { 'x-o8-mcp-profile': process.env.O8_OPERATOR_MCP_PROFILE } : {}),
      ...modernMcpHeaders(message),
    },
    body: JSON.stringify(withVisualizationContext(message, { repoPath: process.env.O8_VISUALIZATION_REPO_PATH,
      threadId: process.env.O8_VISUALIZATION_THREAD_ID })),
  });

  if (response.status === 202) return;
  const text = await response.text();
  if (!response.ok) {
    // Keep recognized JSON-RPC errors intact so modern clients can select a
    // supported revision rather than mistaking a refusal for a dead server.
    try {
      const body = JSON.parse(text);
      if (body?.jsonrpc === '2.0' && typeof body.error?.code === 'number') return body;
    } catch { /* Non-protocol HTTP refusals retain the existing diagnostic. */ }
    throw new Error(`o8 MCP host returned HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
  }
  if (text.trim()) return JSON.parse(text);
}

async function forward(message: unknown): Promise<void> {
  const modern = isModernMcpRequest(message);
  if (modern) {
    const refusal = modernMcpError(message);
    if (refusal) { send(refusal); return; }
  }
  if (message && typeof message === 'object' && !Array.isArray(message) && 'method' in message) {
    const projected = await deferredMcpRequest(message as Parameters<typeof deferredMcpRequest>[0], async () => {
      const response = await request({ jsonrpc: '2.0', id: requestId(message), method: 'tools/list',
        ...(modern ? { params: { _meta: (message as { params?: Record<string, unknown> }).params?._meta } } : {}),
      }) as
        { result?: { tools?: McpTool[] }; error?: unknown };
      if (!Array.isArray(response?.result?.tools)) throw new Error('Unable to read the o8 tool catalog');
      return response.result.tools;
    });
    if (projected.response) {
      send(modern ? { ...projected.response, result: modernMcpResult(projected.response.result, message.method === 'tools/list') } : projected.response);
      return;
    }
    message = projected.message;
  }
  const response = await request(message);
  if (response !== undefined) send(response);
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  void forward(message).catch((error) => {
    if (!expectsResponse(message)) return;
    send({
      jsonrpc: '2.0',
      id: requestId(message),
      error: {
        code: -32001,
        message: `o8 app MCP host unavailable: ${error instanceof Error ? error.message : String(error)}`,
      },
    });
  });
});
rl.on('close', () => process.exit(0));
