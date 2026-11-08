import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-orchestrator-state-patch-'));
const WS_TOKEN = 'operator-ws-token-patch-0123456789abcdef';
writeFileSync(join(dataDir, 'ws-token'), `${WS_TOKEN}\n`, 'utf8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const stateRoute = await import('@/app/api/orchestrator/state/route');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const {
  readOrchestratorControlPlaneState,
  writeOrchestratorControlPlaneState,
} = await import('@/lib/orchestrator/control-plane');

afterAll(async () => {
  const { closeDb } = await import('@/lib/db');
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

function packetFixture(): OrchestratorPacket {
  return {
    id: 'pkt-state-patch',
    referenceLabel: 'PATCH-1',
    title: 'Packet patch contract',
    summary: 'Before',
    workspaceTargetPath: null,
    branchTarget: 'packet/state-patch',
    runtime: 'codex',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'draft',
    releaseState: 'pending',
    status: 'draft',
    blockedReason: null,
    lane: null,
    review: null,
  };
}

function seedMission(): OrchestratorMissionState {
  return writeOrchestratorControlPlaneState({
    ...createEmptyOrchestratorMissionState(),
    missionId: 'mission-state-patch',
    packets: [packetFixture()],
  });
}

function patchRequest(updates: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/orchestrator/state', {
    method: 'PATCH',
    headers: {
      host: 'localhost',
      authorization: `Bearer ${WS_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      packetId: 'pkt-state-patch',
      updates,
    }),
  });
}

describe('PATCH /api/orchestrator/state archive', () => {
  it('refuses to archive a packet while its worker runs, and archives once it stops', async () => {
    const { createLane, setLaneStatus } = await import('@/lib/lane/registry');
    seedMission();
    const lane = createLane({
      repoPath: process.cwd(), branch: 'packet/state-patch', baseBranch: 'main', runtime: 'codex',
      label: 'archive guard', ownership: 'managed', packetId: 'pkt-state-patch', actor: 'system',
    });
    setLaneStatus(lane.id, 'running');

    const refused = await stateRoute.PATCH(patchRequest({ archivedAt: '2026-11-08T00:00:00.000Z' }));
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.message).toContain('stop it before archiving');
    expect(readOrchestratorControlPlaneState().packets[0]?.archivedAt ?? null).toBeNull();

    setLaneStatus(lane.id, 'failed');
    const archived = await stateRoute.PATCH(patchRequest({ archivedAt: '2026-11-08T00:00:00.000Z' }));
    expect(archived.status).toBe(200);
    expect(readOrchestratorControlPlaneState().packets[0]?.archivedAt).toBe('2026-11-08T00:00:00.000Z');

    const restored = await stateRoute.PATCH(patchRequest({ archivedAt: null }));
    expect(restored.status).toBe(200);
    expect(readOrchestratorControlPlaneState().packets[0]?.archivedAt ?? null).toBeNull();
  });
});

describe('PATCH /api/orchestrator/state', () => {
  it('rejects a direct status write with the correct lane transition verb', async () => {
    seedMission();

    const response = await stateRoute.PATCH(patchRequest({ status: 'archived' }));
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body).toEqual({
      error: {
        code: 'packet_status_write_unsupported',
        message: expect.stringContaining('close_packet_unmerged'),
        field: 'status',
        requestedValue: 'archived',
        correctVerb: 'close_packet_unmerged',
      },
    });
    expect(readOrchestratorControlPlaneState().packets[0]?.status).toBe('draft');
  });

  it('still persists supported packet metadata writes', async () => {
    seedMission();

    const response = await stateRoute.PATCH(patchRequest({ summary: 'After' }));
    const body = await response.json() as { mission?: OrchestratorMissionState };

    expect(response.status).toBe(200);
    expect(body.mission?.packets[0]?.summary).toBe('After');
    expect(readOrchestratorControlPlaneState().packets[0]?.summary).toBe('After');
  });
});

interface RpcResponse {
  id?: number;
  result?: {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  };
}

interface CapturedRequest {
  method: string | undefined;
  path: string | undefined;
  authorization: string | undefined;
  body: {
    packetId?: string;
    updates?: Record<string, unknown>;
  };
}

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fake API did not bind a TCP port.');
  return address.port;
}

function rpcClient(child: ChildProcessWithoutNullStreams) {
  let buffered = '';
  const pending = new Map<number, (response: RpcResponse) => void>();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf('\n');
      if (newline < 0) break;
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (!line.startsWith('{')) continue;
      const response = JSON.parse(line) as RpcResponse;
      if (typeof response.id === 'number') {
        pending.get(response.id)?.(response);
        pending.delete(response.id);
      }
    }
  });

  return async (id: number, packetId: string, updates: Record<string, unknown>): Promise<RpcResponse> => {
    const response = new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for MCP response ${id}.`));
      }, 10_000);
      pending.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: {
        name: 'cortex_update_packet',
        arguments: { packetId, updates },
      },
    })}\n`);
    return await response;
  };
}

describe('cortex_update_packet real MCP process', () => {
  it('rejects status locally and authenticates supported PATCH requests with the ws-token', { timeout: 20_000 }, async () => {
    const captured: CapturedRequest[] = [];
    const server = createServer((request, response) => {
      if (request.method !== 'PATCH' || request.url !== '/api/orchestrator/state') {
        response.writeHead(404);
        response.end();
        return;
      }
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        raw += chunk;
      });
      request.on('end', () => {
        const body = JSON.parse(raw || '{}') as CapturedRequest['body'];
        captured.push({
          method: request.method,
          path: request.url,
          authorization: request.headers.authorization,
          body,
        });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          mission: {
            packets: [{
              id: body.packetId,
              ...(body.updates ?? {}),
            }],
            updatedAt: '2026-07-30T00:00:00.000Z',
          },
        }));
      });
    });
    const port = await listen(server);
    // The running desktop discovers web servers by probing every listening
    // localhost port with GET /. Keep that ambient request from contaminating
    // this PATCH-only fixture, and make the shared-run race deterministic.
    await fetch(`http://127.0.0.1:${port}/`, {
      headers: { 'user-agent': 'o8-port-probe' },
    });
    const child = spawn('npx', ['tsx', 'src/lib/mcp/cortex-mcp-server.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CORTEX_API_BASE: `http://127.0.0.1:${port}`,
        CORTEX_IDE_DATA_DIR: dataDir,
        O8_DATA_DIR: dataDir,
        O8_MCP_NODE22_CHECKED: '1',
        WS_TOKEN: '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const call = rpcClient(child);

    try {
      const rejected = await call(1, 'pkt-mcp-status', { status: 'archived' });
      const rejectedText = rejected.result?.content?.[0]?.text ?? '{}';
      expect(rejected.result?.isError).toBe(true);
      expect(JSON.parse(rejectedText)).toEqual({
        ok: false,
        error: expect.objectContaining({
          code: 'packet_status_write_unsupported',
          correctVerb: 'close_packet_unmerged',
        }),
      });
      expect(captured).toHaveLength(0);

      const updated = await call(2, 'pkt-mcp-summary', { summary: 'Supported' });
      expect(updated.result?.isError).not.toBe(true);
      expect(captured).toHaveLength(1);
      expect(captured[0]).toEqual({
        method: 'PATCH',
        path: '/api/orchestrator/state',
        authorization: `Bearer ${WS_TOKEN}`,
        body: {
          packetId: 'pkt-mcp-summary',
          updates: { summary: 'Supported' },
        },
      });
    } finally {
      child.stdin.end();
      await Promise.race([
        once(child, 'exit'),
        new Promise<void>((resolve) => {
          setTimeout(() => {
            child.kill('SIGKILL');
            resolve();
          }, 2_000);
        }),
      ]);
      server.close();
      await once(server, 'close');
    }
  });
});
