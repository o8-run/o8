import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const marker = 'MCP_PRIVATE_FAILURE_MARKER_3373';
vi.mock('@/lib/cortex/qa/ask', () => ({
  askCortex: vi.fn(async () => { throw new Error('MCP_PRIVATE_FAILURE_MARKER_3373'); }),
  runAskPipeline: vi.fn(async () => { throw new Error('MCP_PRIVATE_FAILURE_MARKER_3373'); }),
}));
vi.mock('@/lib/cortex/qa/compose-class-a', () => ({
  ManagedBrainUnavailableError: class extends Error {},
}));
vi.mock('@/lib/problems/service', () => ({
  reconcileProblemDossiers: vi.fn(async () => { throw new Error('MCP_PRIVATE_FAILURE_MARKER_3373'); }),
}));
vi.mock('@/lib/agent-control/service', () => ({
  performLegacyRuntimeActionViaAgentControl: vi.fn(async () => { throw new Error('MCP_PRIVATE_FAILURE_MARKER_3373'); }),
}));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
vi.mock('@/lib/worktree/metadata-lock-process-identity', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/metadata-lock-process-identity')>(),
  probeMetadataLockProcessIdentity: vi.fn(async () => ({
    state: 'live', identity: { version: 1, platform: 'darwin', bootId: 'fixture-boot', startId: 'fixture-start' },
  })),
}));

const answerRoute = await import('@/app/api/cortex/ask/answer/route');
const streamRoute = await import('@/app/api/cortex/ask/route');
const { handleOperatorMcpMessage } = await import('@/lib/mcp/operator-mcp-host');
const runtimeRoute = await import('@/app/api/runtime/action/route');
const { O8WebviewClient } = await import('@/lib/mcp/o8-webview-client');

type ToolResult = { isError?: boolean; content: Array<{ text: string }> };

function toolCaller(child: ChildProcessWithoutNullStreams) {
  let id = 0;
  let buffered = '';
  const pending = new Map<number, (result: ToolResult) => void>();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf('\n');
      if (newline < 0) break;
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (!line.startsWith('{')) continue;
      const response = JSON.parse(line) as { id: number; result: ToolResult };
      pending.get(response.id)?.(response.result);
    }
  });
  return (name: string, args: Record<string, unknown>) => new Promise<ToolResult>((resolve, reject) => {
    const callId = ++id;
    const timer = setTimeout(() => {
      pending.delete(callId);
      reject(new Error(`Timed out waiting for MCP call ${callId}.`));
    }, 45_000);
    pending.set(callId, (result) => {
      clearTimeout(timer);
      pending.delete(callId);
      resolve(result);
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: callId, method: 'tools/call', params: { name, arguments: args },
    })}\n`);
  });
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('MCP failure text through the server entrypoints', () => {
  for (const serverName of ['cortex', 'operator']) {
    it(`${serverName} keeps route failures in host logs and preserves actionable 4xx errors`, { timeout: 90_000 }, async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const dataDir = mkdtempSync(join(tmpdir(), 'o8-mcp-errors-'));
      const bodies: string[] = [];
      const replays: Array<{ status: number; replayed: string | null; body: string }> = [];
      writeFileSync(join(dataDir, 'fetch-bridge.mjs'), `
const pending = new Map();
let id = 0;
process.on('message', (message) => {
  const handlers = pending.get(message.id);
  if (!handlers) return;
  pending.delete(message.id);
  if (message.error) handlers.reject(new Error(message.error));
  else handlers.resolve(new Response(message.body, { status: message.status }));
});
globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
  const requestId = ++id;
  pending.set(requestId, { resolve, reject });
  process.send({ id: requestId, url: String(url), body: init?.body || '{}' });
});
`);
      const child = spawn(process.execPath, [
        '--import', 'tsx', '--import', join(dataDir, 'fetch-bridge.mjs'),
        `src/lib/mcp/${serverName}-mcp-server.ts`,
      ], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CORTEX_API_BASE: 'http://fixture.invalid',
          O8_API_BASE: 'http://fixture.invalid',
          CORTEX_IDE_DATA_DIR: dataDir,
          O8_DATA_DIR: dataDir,
          O8_MCP_NODE22_CHECKED: '1',
          O8_OPERATOR_MCP_PROFILE: 'full',
          CORTEX_READONLY: '0',
          WS_TOKEN: '',
        },
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      }) as ChildProcessWithoutNullStreams;
      child.on('message', async (message: { id: number; url: string; body: string }) => {
        const raw = message.body;
        const bodyArgs = JSON.parse(raw || '{}') as { question?: string; packetId?: string; missionId?: string; message?: string };
        const question = bodyArgs.question ?? bodyArgs.packetId ?? bodyArgs.missionId ?? bodyArgs.message ?? new URL(message.url).searchParams.get('missionId');
        if (question === 'network') {
          child.send({ id: message.id, error: `${marker}\n    at privateFailure (fixture.ts:1:1)` });
          return;
        }
        let routeResponse: Response;
        if (question === 'runtime-failure') {
          routeResponse = await runtimeRoute.POST(new NextRequest(message.url, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw,
          }));
          const replay = await runtimeRoute.POST(new NextRequest(message.url, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw,
          }));
          replays.push({ status: replay.status, replayed: replay.headers.get('x-o8-idempotency-replayed'), body: await replay.text() });
        } else if (question === 'route-failure') {
          routeResponse = await answerRoute.POST(new NextRequest(message.url, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw,
          }));
        } else if (question === 'actionable') {
          routeResponse = Response.json({ error: 'packet not found', detail: marker }, { status: 404 });
        } else if (question === 'controls') {
          routeResponse = Response.json({ error: 'packet\u0000 not found\u001b' }, { status: 400 });
        } else if (question === 'multiline') {
          routeResponse = Response.json({ error: `${marker}\n    at privateFailure (fixture.ts:1:1)` }, { status: 400 });
        } else if (question === 'oversized') {
          routeResponse = Response.json({ error: marker.repeat(30) }, { status: 400 });
        } else if (question === 'unparseable') {
          routeResponse = new Response(`${marker}\n    at privateFailure (fixture.ts:1:1)`, { status: 200 });
        } else {
          routeResponse = Response.json({ error: `${marker}\n    at privateFailure (fixture.ts:1:1)` }, { status: 500 });
        }
        const body = await routeResponse.text();
        if (question === 'route-failure') bodies.push(body);
        child.send({ id: message.id, status: routeResponse.status, body });
      });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      const call = toolCaller(child);
      try {
        for (const question of ['route-failure', 'raw-failure', 'multiline', 'oversized', 'unparseable', 'network']) {
          const result = await call('cortex_ask', { question });
          expect(result.isError, question).toBe(true);
          const text = JSON.stringify(result);
          expect(text, question).not.toContain(marker);
          expect(text, question).not.toContain('at privateFailure');
          expect(text.length, question).toBeLessThan(300);
        }
        expect(bodies.length).toBeGreaterThan(0);
        expect(bodies.join('')).not.toContain(marker);
        expect(log.mock.calls.flat().some((value) => value instanceof Error && value.message.includes(marker))).toBe(true);
        expect(stderr).toContain(marker);
        expect(stderr).toContain('/api/cortex/ask/answer');
        expect(stderr).toContain('500');
        for (const question of ['actionable', 'controls']) {
          const result = await call('cortex_ask', { question });
          expect(result.isError).toBe(true);
          expect(result.content[0].text).toContain('packet not found');
          expect(JSON.stringify(result)).not.toContain(marker);
          expect(result.content[0].text).not.toMatch(/\p{Cc}/u);
        }
        for (const question of ['raw-failure', 'actionable']) {
          const result = serverName === 'cortex'
            ? await call('cortex_steer_agent', { surfaceId: 'fixture', message: question })
            : await call('approve_and_merge', { packetId: question });
          expect(result.isError).toBe(true);
          expect(JSON.stringify(result)).not.toContain(marker);
          expect(result.content[0].text).toContain(question === 'actionable' ? 'packet not found' : 'o8 API error (500)');
        }
        if (serverName === 'cortex') {
          const result = await call('cortex_steer_agent', { surfaceId: 'fixture', message: 'runtime-failure' });
          expect(result.isError).toBe(true);
          expect(result.content[0].text).toContain('action outcome is unknown');
          expect(JSON.stringify(result)).not.toContain(marker);
          expect(replays).toHaveLength(1);
          expect(replays[0]).toMatchObject({ status: 409, replayed: '1' });
          expect(replays[0].body).not.toContain(marker);
        } else {
          for (const missionId of ['raw-failure', 'actionable']) {
            for (const name of ['get_mission_status', 'dispatch_mission']) {
              const result = await call(name, { missionId });
              expect(result.isError).toBe(true);
              expect(JSON.stringify(result)).not.toContain(marker);
              expect(result.content[0].text).toContain(missionId === 'actionable' ? 'packet not found' : 'o8 API error (500)');
            }
          }
          const validation = await call('submit_review', { packetId: 'fixture', approved: true, findings: [{}] });
          expect(validation.isError).toBe(true);
          expect(validation.content[0].text).toContain('must include file and description');
        }
        const validation = await call('cortex_ask', {});
        expect(validation.isError).toBe(true);
        expect(validation.content[0].text).toContain('question is required');
        if (serverName === 'cortex') {
          const registration = await call('register_mcp', { name: 'fixture', command: 'fixture' });
          expect(registration.isError).toBe(true);
          expect(JSON.stringify(registration)).not.toContain(marker);
        }
      } finally {
        child.stdin.end();
        const killTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
        if (child.exitCode === null) await once(child, 'exit');
        clearTimeout(killTimer);
        rmSync(dataDir, { recursive: true, force: true });
      }
    });
  }

  it('hides arbitrary handler exceptions through the operator host', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await handleOperatorMcpMessage({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'o8_problem_get', arguments: { dossierId: 'fixture' } },
    });
    const result = response?.result as ToolResult;
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(result.content[0].text).toContain('o8 operation failed');
    expect(log.mock.calls.flat().some((value) => value instanceof Error && value.message.includes(marker))).toBe(true);
  });

  it('hides webview and directory bridge exceptions through registered operator tools', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // #4789 refuses to fall back to the installed app socket under an isolated data dir,
    // so name a fixture socket; the bridge calls below are stubbed and never connect.
    vi.stubEnv('O8_TAURI_MCP_SOCKET', join(tmpdir(), 'o8-mcp-error-results-fixture.sock'));
    vi.spyOn(O8WebviewClient.prototype, 'screenshot').mockRejectedValue(new Error(marker));
    vi.spyOn(O8WebviewClient.prototype, 'inspectDirectoryDialog').mockRejectedValue(new Error(marker));
    vi.spyOn(O8WebviewClient.prototype, 'evalJs').mockResolvedValue({ result: JSON.stringify({ ok: false, error: marker }) });
    for (const name of ['o8_view_screenshot', 'o8_view_inspect_directory_dialog', 'o8_view_surface_state']) {
      const response = await handleOperatorMcpMessage({
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} },
      });
      const result = response?.result as ToolResult;
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain(marker);
      expect(result.content[0].text).toContain('o8 operation failed');
    }
  });

  it('keeps streaming ask pipeline exceptions out of SSE errors', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await streamRoute.POST(new NextRequest('http://127.0.0.1/api/cortex/ask', {
      method: 'POST', body: JSON.stringify({ question: 'route-failure' }),
    }));
    const body = await response.text();
    expect(body).toContain('event: error');
    expect(body).not.toContain(marker);
    expect(log.mock.calls.flat().some((value) => value instanceof Error && value.message.includes(marker))).toBe(true);
  });
});
