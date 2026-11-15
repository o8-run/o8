import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// The browser update card that ran the install in the webview is gone. These
// cases keep the server entry points: the apply route and the MCP handler
// accept a forced install and queue one realtime apply for the native window.
const fixture = vi.hoisted(() => ({ mutations: [] as Array<Record<string, unknown>> }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: async (input: { mutation: Record<string, unknown> }) => {
  fixture.mutations.push(input.mutation); return true;
} }));
vi.mock('@/lib/app-update/idle-window', () => ({ getUpdateIdleWindow: async () => ({ idle: true, idleExceptParked: true,
  parkedLanes: [], unavailable: [], active: { lanes: [], terminalSessions: [], ownedSessions: [], managedRuns: [], cloudJobs: [] } }) }));
const apply = await import('@/app/api/panel/update/apply/route');
const { setAppUpdateState } = await import('@/lib/app-update/relaunch-state');
const { handleUpdateApply } = await import('@/lib/mcp/operator-handlers/update');
const request = () => new Request('http://localhost/api/panel/update/apply', { method: 'POST', body: JSON.stringify({ force: true }) });

beforeEach(() => {
  fixture.mutations = [];
  setAppUpdateState({ updatePending: true, version: '0.2.0' });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost'); const req = new Request(url, init);
    if (url.pathname === '/api/panel/update/apply') return req.method === 'POST' ? apply.POST(req) : apply.GET();
    return Response.json({});
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

it.each(['API', 'MCP'] as const)('%s install queues one realtime apply', async entry => {
  if (entry === 'API') expect((await apply.POST(request())).status).toBe(202);
  else expect((await handleUpdateApply({ force: true })).isError).toBe(false);
  expect(fixture.mutations).toHaveLength(1);
});
