import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { rerunWithFeedback } from '@/lib/mcp/operator-mission-tools';
import { handleApproveAndMerge } from '@/lib/mcp/operator-handlers/approve';
import { handleClosePacketUnmerged } from '@/lib/mcp/operator-handlers/close-packet';
import { handleSend, handleSteerPacket } from '@/lib/mcp/operator-handlers/status';

const ROOT = join(__dirname, '..');

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('packet mutation callers preserve one correlation id across transport retries', () => {
  it('MCP rerun retries the exact serialized request body', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('socket closed'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { inProgress: true } }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { dispatched: true } }));
    vi.stubGlobal('fetch', fetchMock);

    const request = rerunWithFeedback({ packetId: 'pkt-mcp-rerun', feedback: 'try again' });
    await vi.runAllTimersAsync();
    await request;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const requestBodies = fetchMock.mock.calls.map(([, init]) => String((init as RequestInit).body));
    expect(requestBodies[0]).toBe(requestBodies[1]);
    expect(JSON.parse(requestBodies[0])).toMatchObject({
      packetId: 'pkt-mcp-rerun',
      feedback: 'try again',
      idempotencyKey: expect.any(String),
    });
  });

  it('MCP steer retries the exact serialized request body', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('socket closed'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { inProgress: true } }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { laneId: 'lane-mcp-steer' } }));
    vi.stubGlobal('fetch', fetchMock);

    const request = handleSteerPacket({ packetId: 'pkt-mcp-steer', message: 'continue' });
    await vi.runAllTimersAsync();
    await request;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const requestBodies = fetchMock.mock.calls.map(([, init]) => String((init as RequestInit).body));
    expect(requestBodies[0]).toBe(requestBodies[1]);
    expect(JSON.parse(requestBodies[0])).toMatchObject({
      packetId: 'pkt-mcp-steer',
      message: 'continue',
      idempotencyKey: expect.any(String),
    });
  });

  it('MCP session steer polls its exact runtime mutation body before reading status', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const url = String(input);
      if (url.includes('/api/operator/status')) return jsonResponse({ status: 'running' });
      const actionCalls = fetchMock.mock.calls.filter(([calledInput]) => (
        String(calledInput).includes('/api/runtime/action')
      )).length;
      if (actionCalls === 1) throw new Error('socket closed');
      if (actionCalls === 2) {
        return new Response(JSON.stringify({ ok: true, result: { inProgress: true } }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return jsonResponse({ ok: true, status: 'running' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const request = handleSend({ sessionKey: 'runtime-session-1', message: 'keep going' });
    await vi.runAllTimersAsync();
    await request;

    const runtimeCalls = fetchMock.mock.calls.filter(([input]) => (
      String(input).includes('/api/runtime/action')
    ));
    expect(runtimeCalls).toHaveLength(3);
    const requestBodies = runtimeCalls.map(([, init]) => String((init as RequestInit).body));
    expect(new Set(requestBodies).size).toBe(1);
    expect(JSON.parse(requestBodies[0])).toMatchObject({
      action: 'steer',
      surfaceId: 'runtime-session-1',
      message: 'keep going',
      clientMutationId: expect.any(String),
    });
  });

  it('MCP approve-and-merge polls the caller correlation id through HTTP 202', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        result: { inProgress: true },
      }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { merged: true } }));
    vi.stubGlobal('fetch', fetchMock);

    const request = handleApproveAndMerge({
      packetId: 'pkt-mcp-merge',
      idempotencyKey: 'merge-correlation-1',
    });
    await vi.runAllTimersAsync();
    await request;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const requestBodies = fetchMock.mock.calls.map(([, init]) => String((init as RequestInit).body));
    expect(requestBodies[1]).toBe(requestBodies[0]);
    expect(JSON.parse(requestBodies[0])).toMatchObject({
      packetId: 'pkt-mcp-merge',
      idempotencyKey: 'merge-correlation-1',
    });
  });

  it('MCP close polls one exact client mutation through HTTP 202', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        result: { inProgress: true },
      }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { closed: true } }));
    vi.stubGlobal('fetch', fetchMock);

    const request = handleClosePacketUnmerged({
      packetId: 'pkt-mcp-close',
      disposition: 'wontfix',
      acknowledgeMissingWorktree: true,
    });
    await vi.runAllTimersAsync();
    await request;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const requestBodies = fetchMock.mock.calls.map(([, init]) => String((init as RequestInit).body));
    expect(requestBodies[1]).toBe(requestBodies[0]);
    expect(JSON.parse(requestBodies[0])).toMatchObject({
      packetId: 'pkt-mcp-close',
      disposition: 'wontfix',
      acknowledgeMissingWorktree: true,
      clientMutationId: expect.any(String),
    });
  });
});

describe('MCP packet mutation callers share the correlated receipt helpers', () => {
  it('MCP runtime and lifecycle mutators share the exact-body receipt helper', () => {
    const cortexSource = readFileSync(join(ROOT, 'src/lib/mcp/cortex-mcp-server.ts'), 'utf8');
    expect(cortexSource).toContain('pollCorrelatedMcpApiMutation');
    expect(cortexSource).toContain("{ action: 'steer', surfaceId, message }");
    const delegationSource = readFileSync(join(ROOT, 'src/lib/mcp/cortex-delegation-handlers.ts'), 'utf8');
    expect(delegationSource).toContain("{ action: 'interrupt', surfaceId }");
    expect(delegationSource).toContain('pollCorrelatedMcpApiMutation');

    const missionSource = readFileSync(join(ROOT, 'src/lib/mcp/operator-mission-tools.ts'), 'utf8');
    expect(missionSource).toContain('pollCorrelatedMcpMutation');
    expect(missionSource).toContain("correlationField: 'idempotencyKey'");
    expect(missionSource).toContain("'/api/orchestrator/reset-packet'");
    expect(missionSource).toContain("'/api/orchestrator/rerun-with-feedback'");
  });
});
