import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Only external observations are replaced; MCP routing, settings and lane storage are real.
vi.mock('@/lib/runtimes/shared/auth-detect', () => ({
  getRuntimeAuthSnapshot: async () => ({ statuses: {}, detail: 'auth detail '.repeat(1200) }),
  getDispatchableRuntimeAvailability: async () => [],
}));
vi.mock('@/lib/runtime/inventory', () => ({
  getRuntimeInventorySnapshot: async () => ({ agents: [] }),
}));

const { POST } = await import('@/app/api/mcp/route');
const defaultsRoute = await import('@/app/api/panel/operator-defaults/route');
const statusRoute = await import('@/app/api/operator/status/route');
const { createLane, appendEvent, setLaneStatus } = await import('@/lib/lane/registry');
const { recordRoleRoutingReceipt } = await import('@/lib/operator/role-routing-ledger');
const { getOperatorDefaultsSync } = await import('@/lib/operator/defaults');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { closeDb } = await import('@/lib/db');
const dataDir = process.env.CORTEX_IDE_DATA_DIR!;
const token = getOrCreateWsToken();
const lanes: Array<ReturnType<typeof createLane>> = [];

async function call(name: string, args: Record<string, unknown> = {}) {
  const response = await POST(new Request('http://localhost/api/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }));
  expect(response.status).toBe(200);
  const rpc = await response.json();
  expect(rpc.error).toBeUndefined();
  expect(rpc.result.isError).not.toBe(true);
  let text = rpc.result.content[0].text as string;
  let payload = JSON.parse(text);
  if (payload.schema === 'o8/mcp/result-page/v1') {
    let serialized = payload.text;
    let pages = 1;
    while (payload.nextArguments) {
      const page = await POST(new Request('http://localhost/api/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call',
          params: { name: 'o8_result_page', arguments: payload.nextArguments } }),
      }));
      expect(page.status).toBe(200);
      const next = await page.json();
      expect(next.result.isError).not.toBe(true);
      payload = JSON.parse(next.result.content[0].text);
      serialized += payload.text;
      expect(++pages).toBeLessThan(100);
    }
    text = JSON.parse(serialized).content[0].text;
    payload = JSON.parse(text);
  }
  return { text, payload };
}

beforeAll(() => {
  for (let i = 0; i < 3; i += 1) {
    const lane = createLane({ repoPath: dataDir, runtime: 'codex', branch: `work-${i}`,
      label: `Task ${i}`, packetId: `packet-${i}`, sessionKey: `codex-owned:budget-${i}` });
    lanes.push(lane);
    setLaneStatus(lane.id, 'running', 'system');
    for (let event = 0; event < 40; event += 1) {
      appendEvent(lane.id, 'status_change', 'system', { status: 'running', observation: event });
    }
  }
  for (let i = 0; i < 60; i += 1) {
    recordRoleRoutingReceipt({ role: 'build', requested: {
      backend: null, runtime: 'codex', model: null, effort: 'high', label: 'Worker',
    }, sources: { backend: 'default', runtime: 'default', model: 'default', effort: 'default' },
    status: 'selected', reason: `Receipt ${i}: ${'route observation '.repeat(20)}` });
  }
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === '/api/panel/operator-defaults') {
      return request.method === 'POST' ? defaultsRoute.POST(request) : defaultsRoute.GET(request);
    }
    if (url.pathname === '/api/operator/status') return statusRoute.GET(new NextRequest(request));
    throw new Error(`Unexpected route: ${url.pathname}`);
  });
});

afterAll(() => { vi.restoreAllMocks(); closeDb(); });

describe('compact default MCP responses (#4073)', () => {
  it('returns values and sources without diagnostic payloads', async () => {
    const { text, payload } = await call('o8_operator_defaults');
    // All values and sources already occupy about 6 KB; keep them complete.
    expect(text.length).toBeLessThan(6_500);
    expect(payload.values).toEqual(getOperatorDefaultsSync().values);
    expect(payload.sources).toEqual(getOperatorDefaultsSync().sources);
    expect(payload.recentRoleReceipts).toBeUndefined();
    expect(payload.cliAuth).toBeUndefined();
    expect(payload.settingsToml).toBeUndefined();
  });

  it('opts into receipts, auth and metadata independently without writing settings', async () => {
    await call('o8_operator_defaults', { parallelCap: 7 });
    const before = readFileSync(join(dataDir, 'settings.toml'), 'utf8');
    for (const [flag, field] of [['includeReceipts', 'recentRoleReceipts'], ['includeAuth', 'cliAuth'],
      ['includeDetails', 'settingsToml']]) {
      const { payload } = await call('o8_operator_defaults', { [flag]: true });
      expect(payload[field]).toBeDefined();
      for (const other of ['recentRoleReceipts', 'cliAuth', 'settingsToml'].filter((key) => key !== field)) {
        expect(payload[other]).toBeUndefined();
      }
    }
    expect(readFileSync(join(dataDir, 'settings.toml'), 'utf8')).toBe(before);
  });

  it('keeps response flags out of persisted updates and restores opt-in diagnostics', async () => {
    const { payload } = await call('o8_operator_defaults', {
      parallelCap: 7, includeReceipts: true, includeAuth: true, includeDetails: true,
    });
    expect(payload.values.parallelCap).toBe(7);
    expect(payload.sources.parallelCap).toBe('file');
    expect(payload.recentRoleReceipts).toHaveLength(60);
    expect(payload.cliAuth.detail).toContain('auth detail');
    expect(payload.settingsToml).toBeDefined();
    const persisted = readFileSync(join(dataDir, 'settings.toml'), 'utf8');
    expect(persisted).toContain('parallel_cap = 7');
    expect(persisted).not.toMatch(/includeReceipts|includeAuth|includeDetails/);
    const reread = await call('o8_operator_defaults');
    expect(reread.payload.values.parallelCap).toBe(7);
    expect(reread.payload.cliAuth).toBeUndefined();
  });

  it('returns each task once, with groups referring to task ids', async () => {
    const { text, payload } = await call('o8_task_list');
    expect(text.length).toBeLessThan(4_000);
    expect(payload.tasks).toHaveLength(3);
    const ids = payload.tasks.map((task: { id: string }) => task.id);
    expect(Object.values(payload.groups).flat().sort()).toEqual([...ids].sort());
    expect(payload.counts.running).toBe(3);
    expect(payload.tasks[0].laneId).toBeDefined();
    expect(payload.tasks[0].project).toBeUndefined();
    const detailed = await call('o8_task_list', { includeDetails: true });
    expect(detailed.payload.tasks[0].lane).toHaveProperty('branch');
    expect(Object.values(detailed.payload.groups).flat().sort()).toEqual([...ids].sort());
    const withBrief = await call('o8_task_list', { includeBrief: true });
    expect(withBrief.payload.tasks[0].lane).toEqual(detailed.payload.tasks[0].lane);
  });

  it('preserves status authority and observation time while making evidence opt-in', async () => {
    const overview = await call('o8_status');
    expect(overview.text.length).toBeLessThan(4_000);
    expect(overview.payload.data.agents).toHaveLength(3);
    const args = { sessionKey: lanes[0].sessionKey };
    const { text, payload } = await call('o8_status', args);
    expect(text.length).toBeLessThan(4_000);
    expect(payload.data.agents).toHaveLength(1);
    const agent = payload.data.agents[0];
    expect(agent).toMatchObject({ sessionKey: lanes[0].sessionKey, authority: 'lane-state',
      status: 'running', observedAt: expect.any(String), summary: expect.any(String) });
    expect(agent.statusEvidence.evidence).toBeUndefined();
    expect(agent.statusEvidence.evidenceCount).toBeGreaterThanOrEqual(40);
    const detailed = await call('o8_status', { ...args, includeEvidence: true });
    expect(detailed.payload.data.agents[0].statusEvidence.evidence).toHaveLength(agent.statusEvidence.evidenceCount);
    expect(detailed.payload.data.agents[0].status).toBe(agent.status);
  });
});
