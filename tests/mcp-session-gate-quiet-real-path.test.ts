import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { afterEach, expect, it, vi } from 'vitest';

import { atRest, idleGateStats, noteRequest, resetIdleGate, startIdleGate } from '@/lib/background-work/idle-gate';
import { recurring } from '@/lib/background-work/ledger';

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill();
  resetIdleGate();
  vi.useRealTimers();
});

/** Every request the proxy sent, with the JSON-RPC method it carried. */
async function proxySession(): Promise<Array<{ method: string; headers: IncomingHttpHeaders }>> {
  const seen: Array<{ method: string; headers: IncomingHttpHeaders }> = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const message = JSON.parse(body) as { id?: number; method: string };
      seen.push({ method: message.method, headers: request.headers });
      if (message.id === undefined) { response.writeHead(202).end(); return; }
      const result = message.method === 'tools/list'
        ? { tools: [{ name: 'o8_status', description: 'status', inputSchema: { type: 'object' } }] }
        : message.method === 'initialize'
          ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
          : { content: [{ type: 'text', text: 'ok' }] };
      response.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const child = spawn(process.execPath, [
      join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'), '--tsconfig', join(process.cwd(), 'tsconfig.json'),
      join(process.cwd(), 'src/lib/mcp/operator-mcp-proxy.ts'),
    ], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: {
        ...process.env, O8_API_BASE: `http://127.0.0.1:${port}`, O8_MCP_TOOL_LOADING: 'full',
        O8_DATA_DIR: mkdtempSync(join(tmpdir(), 'o8-mcp-gate-')),
      },
    });
    children.push(child);
    const replies = new Map<number, () => void>();
    createInterface({ input: child.stdout! }).on('line', (line) => {
      const value = JSON.parse(line) as { id?: number };
      if (typeof value.id === 'number') replies.get(value.id)?.();
    });
    const call = (id: number, method: string, params: Record<string, unknown> = {}) => new Promise<void>((resolve) => {
      replies.set(id, resolve);
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    await call(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
    child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    await call(2, 'tools/list');
    await call(3, 'tools/call', { name: 'o8_status', arguments: {} });
    await vi.waitFor(() => expect(seen.some((item) => item.method === 'notifications/initialized')).toBe(true));
    return seen;
  } finally {
    server.close();
  }
}

it("does not wake the gate on an agent session's MCP handshake or an agent tool's read, and wakes on a tool call", async () => {
  const seen = await proxySession();
  const handshake = seen.filter((item) => item.method !== 'tools/call');
  const calls = seen.filter((item) => item.method === 'tools/call');
  expect(handshake.map((item) => item.method)).toEqual(expect.arrayContaining(['initialize', 'notifications/initialized', 'tools/list']));
  expect(calls).toHaveLength(1);

  vi.useFakeTimers();
  resetIdleGate();
  startIdleGate({ liveSessions: () => false });
  const idleSafe = vi.fn();
  const timer = recurring('fixture-mcp', idleSafe, 1_000);
  try {
    vi.advanceTimersByTime(120_000);
    expect(atRest()).toBe(true);
    for (const item of handshake) noteRequest(item.headers, 'POST', '/api/mcp');
    // What o8_list_repos and the other MCP tool servers send when they read the API.
    noteRequest({ 'x-o8-agent-tool': '1' }, 'GET', '/api/panel/repos');
    vi.advanceTimersByTime(5_000);
    expect(atRest()).toBe(true);
    expect(idleGateStats().activity).toEqual({});
    expect(idleGateStats().ignored['agent tool read']).toBe(1);

    // An agent tool that writes still wakes the server, and so does a tool call.
    noteRequest({ 'x-o8-agent-tool': '1' }, 'POST', '/api/panel/repos');
    expect(atRest()).toBe(false);
    noteRequest(calls[0]!.headers, 'POST', '/api/mcp');
    expect(idleGateStats().activity).toEqual({ 'POST /api/panel/repos': 1, 'POST /api/mcp': 1 });
  } finally {
    clearInterval(timer);
  }
}, 60_000);
