import { performance } from 'node:perf_hooks';
import { NextRequest } from 'next/server';
import type { AgentRuntime } from '@/lib/runtimes/types';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  discover: vi.fn<AgentRuntime['discoverSessions']>(),
  statusReads: 0,
  connectionReads: 0,
  delayMs: 0,
  leadAdvanceMs: 0,
  blocked: undefined as Promise<void> | undefined,
  fail: false,
}));
vi.mock('@/lib/runtimes', async () => {
  const { piRuntime } = await import('@/lib/runtimes/pi');
  const runtime = { ...piRuntime, discoverSessions: fixture.discover };
  return { getAllRuntimes: () => [runtime], getRuntime: () => runtime };
});
vi.mock('@/lib/lane/sweep-orphan-sessions', () => ({ sweepOrphanedOwnedSessions: async () => {} }));

const { GET: statusGET } = await import('@/app/api/operator/status/route');
const { invalidateRuntimeInventoryCache } = await import('@/lib/runtime/inventory');
const { createLane } = await import('@/lib/lane/registry');
const { createApproval } = await import('@/lib/approvals/store');
const { getSqlite } = await import('@/lib/db');
let POST: typeof import('@/app/api/mcp/route').POST;
const clock = Date.now();
const connections = { dispatchableRuntimes: [{
  id: 'pi', label: 'Pi', available: true,
  connection: { state: 'observed', providers: ['fixture'], observations: [], checkedAt: clock,
    account: 'not_reported', externalTools: 'not_inspected' },
}] };

type Status = {
  summary: string;
  data: {
    agents: Array<{ sessionKey: string; status: string }>;
    approvals: unknown[]; approvalCount: number; recentActivity: unknown[]; spendCapHits: unknown[];
    runtimeConnections: unknown;
    snapshot: { capturedAt: string; ageMs: number; refreshAfterMs: number; maxAgeMs: number };
  };
};

async function call(args: Record<string, unknown> = {}): Promise<Status> {
  const response = await POST(new Request('http://localhost/api/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'o8_status', arguments: args } }),
  }));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.result.isError, JSON.stringify(body.result)).not.toBe(true);
  return JSON.parse(body.result.content[0].text);
}

beforeAll(() => {
  const lane = createLane({ repoPath: process.env.CORTEX_IDE_DATA_DIR!, branch: 'fixture', runtime: 'pi',
    label: 'Live packet', packetId: 'pkt-snapshot', sessionKey: 'pi-owned:snapshot' });
  getSqlite().prepare("UPDATE lanes SET status = 'running' WHERE id = ?").run(lane.id);
  const fallback = createLane({ repoPath: process.env.CORTEX_IDE_DATA_DIR!, branch: 'fallback', runtime: 'pi',
    label: 'Lane fallback', packetId: 'pkt-fallback', sessionKey: 'pi-owned:fallback' });
  getSqlite().prepare("UPDATE lanes SET status = 'reviewing' WHERE id = ?").run(fallback.id);
  createApproval({ source: 'test', runtime: 'pi', agent: 'fixture', title: 'Snapshot approval',
    description: 'Snapshot approval', summary: 'Snapshot approval', sessionKey: 'pi-owned:snapshot', risk: 'medium' });
});

beforeEach(async () => {
  vi.resetModules();
  ({ POST } = await import('@/app/api/mcp/route'));
  vi.spyOn(Date, 'now').mockReturnValue(clock);
  fixture.statusReads = 0;
  fixture.connectionReads = 0;
  fixture.delayMs = 0;
  fixture.leadAdvanceMs = 0;
  fixture.blocked = undefined;
  fixture.fail = false;
  fixture.discover.mockReset().mockImplementation(async () => [{
    sessionKey: 'pi-owned:snapshot', runtimeId: 'pi', displayName: 'Live packet',
    cwd: process.env.CORTEX_IDE_DATA_DIR!, branch: 'fixture', status: 'running', ownership: 'owned',
    lastActivityAt: new Date(clock), initialTask: 'Snapshot task',
    sessionCapabilities: { canSendInput: true, canInterrupt: true, canReviewDiffs: true },
  }]);
  invalidateRuntimeInventoryCache();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/orchestrator/lead') {
      if (fixture.leadAdvanceMs) vi.mocked(Date.now).mockReturnValue(clock + fixture.leadAdvanceMs);
      return Response.json({ cursor: 0, leads: [] });
    }
    if (url.pathname === '/api/operator/status') {
      fixture.statusReads += 1;
      if (fixture.delayMs) await new Promise((resolve) => setTimeout(resolve, fixture.delayMs));
      await fixture.blocked;
      if (fixture.fail) return Response.json({ error: 'Fixture unavailable' }, { status: 400 });
      return statusGET(new NextRequest(url));
    }
    if (url.pathname === '/api/panel/operator-defaults') {
      fixture.connectionReads += 1;
      if (fixture.delayMs) await new Promise((resolve) => setTimeout(resolve, fixture.delayMs));
      return Response.json(connections);
    }
    throw new Error(`Unexpected fixture endpoint: ${url.pathname}`);
  });
});
afterEach(() => { vi.restoreAllMocks(); invalidateRuntimeInventoryCache(); });

describe('o8_status coalesced snapshot through /api/mcp (#4392)', () => {
  it('rejects runtime observations that expire while live lead receipts are read', async () => {
    await call();
    fixture.leadAdvanceMs = 15_000;
    const response = await POST(new Request('http://localhost/api/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'o8_status', arguments: {} } }),
    }));
    const body = await response.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('freshness bound');
  });

  it('coalesces concurrent cold callers into one status and connection inventory refresh', async () => {
    let release!: () => void;
    fixture.blocked = new Promise<void>((resolve) => { release = resolve; });
    const pending = Array.from({ length: 8 }, () => call());
    await vi.waitFor(() => expect(fixture.statusReads).toBeGreaterThan(0));
    release();
    const results = await Promise.all(pending);
    expect(fixture.statusReads).toBe(1);
    expect(fixture.connectionReads).toBe(1);
    expect(fixture.discover).toHaveBeenCalledTimes(1);
    for (const result of results) expect(result).toEqual(results[0]);
  });

  it('preserves current agents, lane fallback, approvals, activity and runtime output for the same fixture', async () => {
    const source = await statusGET(new NextRequest('http://localhost/api/operator/status'));
    const legacy = await source.json();
    const compact = await call();
    for (const agent of compact.data.agents) {
      expect(agent).toHaveProperty('statusEvidence.evidenceCount');
      expect(agent).not.toHaveProperty('statusEvidence.evidence');
    }
    const result = await call({ includeEvidence: true });
    expect(result.summary).toBe(legacy.summary);
    const { snapshot, ...data } = result.data;
    expect(data).toEqual({ agents: legacy.agents, approvals: legacy.approvals.items,
      approvalCount: legacy.approvals.count, recentActivity: legacy.recentActivity, spendCapHits: legacy.spendCapHits,
      terminalReasons: legacy.terminalReasons, terminalReasonsTruncated: legacy.terminalReasonsTruncated,
      runtimeConnections: { status: 'available', runtimes: connections.dispatchableRuntimes } });
    expect(data.agents.map((agent) => agent.sessionKey)).toEqual(expect.arrayContaining(['pi-owned:snapshot', 'pi-owned:fallback']));
    expect(snapshot).toMatchObject({ capturedAt: new Date(clock).toISOString(), ageMs: 0 });
    const filtered = await call({ sessionKey: 'pi-owned:snapshot', includeEvidence: true });
    const filteredSource = await statusGET(new NextRequest('http://localhost/api/operator/status?sessionKey=pi-owned%3Asnapshot'));
    expect(filtered.data.agents).toEqual((await filteredSource.json()).agents);
    expect(filtered.data.agents).toHaveLength(1);
  });

  it('shares runtime and connection discovery across concurrent session filters', async () => {
    fixture.delayMs = 60;
    const [all, filtered] = await Promise.all([call(), call({ sessionKey: 'pi-owned:snapshot' })]);
    expect(all.data.agents).toHaveLength(2);
    expect(filtered.data.agents).toHaveLength(1);
    expect(fixture.discover).toHaveBeenCalledTimes(1);
    expect(fixture.connectionReads).toBe(1);
  });

  it('waits for a shared refresh on an explicit fresh read and at the hard age bound', async () => {
    const initial = await call();
    for (const fresh of [true, false]) {
      vi.mocked(Date.now).mockReturnValue(clock + (fresh ? 1_000 : initial.data.snapshot.maxAgeMs + 1_000));
      let release!: () => void;
      fixture.blocked = new Promise<void>((resolve) => { release = resolve; });
      let finished = false;
      const pending = Promise.all([call({ fresh }), call({ fresh })]).then((value) => { finished = true; return value; });
      await vi.waitFor(() => expect(fixture.statusReads).toBe(fresh ? 2 : 3));
      expect(finished).toBe(false);
      release();
      const results = await pending;
      expect(results[0].data.snapshot.ageMs).toBe(0);
      expect(results[0]).toEqual(results[1]);
    }
    expect(fixture.connectionReads).toBe(3);
  });

  it('reports increasing age, revalidates in the background, and shares an explicit fresh read', async () => {
    const initial = await call();
    expect(initial.data.snapshot).toBeDefined();
    vi.mocked(Date.now).mockReturnValue(clock + initial.data.snapshot.refreshAfterMs);
    let release!: () => void;
    fixture.blocked = new Promise<void>((resolve) => { release = resolve; });
    const cached = await call();
    expect(cached.data.snapshot).toEqual({ ...initial.data.snapshot, ageMs: initial.data.snapshot.refreshAfterMs });
    let finished = false;
    const pending = Promise.all([call({ fresh: true }), call({ fresh: true })]).then((value) => { finished = true; return value; });
    await vi.waitFor(() => expect(fixture.statusReads).toBe(2));
    expect(finished).toBe(false);
    release();
    const refreshed = await pending;
    expect(refreshed[0].data.snapshot.ageMs).toBe(0);
    expect(fixture.statusReads).toBe(2);
    expect(fixture.connectionReads).toBe(2);
  });

  it('waits past the hard age bound and retries a failed refresh without serving expired data', async () => {
    const initial = await call();
    expect(initial.data.snapshot).toBeDefined();
    vi.mocked(Date.now).mockReturnValue(clock + initial.data.snapshot.maxAgeMs);
    fixture.fail = true;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(call()).rejects.toThrow('Fixture unavailable');
    fixture.fail = false;
    const recovered = await call();
    expect(recovered.data.snapshot.ageMs).toBe(0);
    expect(fixture.statusReads).toBe(3);
    log.mockRestore();
  });

  it('counts refresh work in snapshot age and rejects a refresh exceeding its bound', async () => {
    for (const elapsedMs of [2_000, 15_000]) {
      let release!: () => void;
      fixture.blocked = new Promise<void>((resolve) => { release = resolve; });
      const startedAt = Date.now();
      const pending = call({ fresh: true });
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const result = elapsedMs === 15_000
        ? expect(pending).rejects.toThrow('Failed to fetch status: o8 operation failed')
        : pending.then((value) => expect(value.data.snapshot.ageMs).toBe(elapsedMs));
      await vi.waitFor(() => expect(fixture.statusReads).toBe(elapsedMs === 2_000 ? 1 : 2));
      vi.mocked(Date.now).mockReturnValue(startedAt + elapsedMs);
      release();
      await result;
      if (elapsedMs === 15_000) {
        expect(log).toHaveBeenCalledWith('[o8-operator] o8_status failed: ',
          expect.objectContaining({ message: 'Status refresh exceeded its freshness bound' }));
      }
      log.mockRestore();
    }
  });

  it('advertises fresh as an optional boolean through tools/list', async () => {
    const response = await POST(new Request('http://localhost/api/mcp', { method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) }));
    const body = await response.json();
    const status = body.result.tools.find((tool: { name: string }) => tool.name === 'o8_status');
    expect(status.inputSchema.properties.fresh).toMatchObject({ type: 'boolean' });
  });

  it('keeps p95 below 100 ms across 30 warm calls with bounded slow inventory fixtures', async () => {
    fixture.delayMs = 60;
    await call();
    const samples: number[] = [];
    for (let index = 0; index < 30; index += 1) {
      const start = performance.now();
      await call();
      samples.push(performance.now() - start);
    }
    samples.sort((left, right) => left - right);
    const p50 = samples[14];
    const p95 = samples[28];
    console.log(`o8_status 30 warm calls: p50=${p50.toFixed(2)} ms p95=${p95.toFixed(2)} ms worst=${samples[29].toFixed(2)} ms statusReads=${fixture.statusReads} connectionReads=${fixture.connectionReads}`);
    expect(p95).toBeLessThan(100);
    expect(fixture.statusReads).toBe(1);
    expect(fixture.connectionReads).toBe(1);
  });
});
