import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { publishRealtimeMutation, getUpdateIdleWindow } = vi.hoisted(() => ({
  publishRealtimeMutation: vi.fn(async () => true),
  getUpdateIdleWindow: vi.fn(),
}));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation }));
vi.mock('@/lib/app-update/idle-window', () => ({ getUpdateIdleWindow }));

function post(body = {}) {
  return new Request('http://localhost/api/panel/update/apply', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

describe('native freshness through the production apply and state routes', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-22T14:00:00Z'));
    publishRealtimeMutation.mockReset().mockResolvedValue(true);
    getUpdateIdleWindow.mockReset().mockResolvedValue({ idle: false, idleExceptParked: true,
      parkedLanes: [{ id: 'review', status: 'reviewing' }], active: {}, unavailable: [] });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('requests a fresh native check instead of returning current from six-hour-old state', async () => {
    const state = await import('@/lib/app-update/relaunch-state');
    state.setAppUpdateState({ updatePending: false, checkOutcome: 'current', checkedAt: '2026-10-22T08:00:00Z' });
    const route = await import('@/app/api/panel/update/apply/route');
    const stateRoute = await import('@/app/api/panel/app/update-state/route');
    const pending = route.POST(post());
    await vi.advanceTimersByTimeAsync(100);
    const control = await (await stateRoute.GET()).json();
    expect(control.checkRequestedAt).toEqual(expect.any(String));
    await stateRoute.POST(new Request('http://localhost/api/panel/app/update-state', {
      method: 'POST', body: JSON.stringify({ updatePending: true, version: '0.1.999',
        checkOutcome: 'available', checkedAt: new Date().toISOString() }),
    }));
    await vi.advanceTimersByTimeAsync(100);
    const response = await pending;
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ checkedAt: expect.any(String), checkAgeMs: expect.any(Number),
      idle: { parkedLanes: [{ id: 'review' }] }, state: { version: '0.1.999' } });
  });

  it('returns a retry hint when no native check can answer within the bound, including force', async () => {
    const state = await import('@/lib/app-update/relaunch-state');
    state.setAppUpdateState({ updatePending: false, checkOutcome: 'current', checkedAt: '2026-10-22T08:00:00Z' });
    const route = await import('@/app/api/panel/update/apply/route');
    const pending = route.POST(post({ force: true }));
    await vi.advanceTimersByTimeAsync(30_000);
    const response = await pending;
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ checkedAt: '2026-10-22T08:00:00Z', checkAgeMs: expect.any(Number),
      error: { code: 'update_check_unavailable', retryable: true, retryAfterMs: expect.any(Number) } });
    expect(publishRealtimeMutation).not.toHaveBeenCalled();
  });

  it('marks bridge startup failure retryable and includes freshness even on validation errors', async () => {
    const state = await import('@/lib/app-update/relaunch-state');
    state.setAppUpdateState({ updatePending: true, version: '0.1.999' });
    publishRealtimeMutation.mockResolvedValue(false);
    const route = await import('@/app/api/panel/update/apply/route');
    const response = await route.POST(post());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ checkedAt: expect.any(String), checkAgeMs: 0,
      error: { code: 'update_signal_unavailable', retryable: true, retryAfterMs: expect.any(Number) } });
    expect(await (await route.POST(post({ force: 'yes' }))).json()).toMatchObject({ checkedAt: expect.any(String), checkAgeMs: 0 });
  });

  it('joins an explicit check and apply even when the previous current result is recent', async () => {
    const state = await import('@/lib/app-update/relaunch-state');
    state.setAppUpdateState({ updatePending: false, checkOutcome: 'current', checkedAt: '2026-10-22T13:52:00Z' });
    const route = await import('@/app/api/panel/update/apply/route');
    const control = await import('@/app/api/panel/app/update-state/route');
    const check = route.POST(post({ checkOnly: true }));
    await vi.advanceTimersByTimeAsync(100);
    const requested = (await (await control.GET()).json()).checkRequestedAt;
    expect(requested).toEqual(expect.any(String));
    const apply = route.POST(post({ checkNow: true }));
    await vi.advanceTimersByTimeAsync(100);
    expect((await (await control.GET()).json()).checkRequestedAt).toBe(requested);
    await control.POST(new Request('http://localhost/api/panel/app/update-state', { method: 'POST', body: JSON.stringify({
      updatePending: true, version: '0.1.999', checkOutcome: 'available', checkedAt: new Date().toISOString(),
    }) }));
    await vi.advanceTimersByTimeAsync(100);
    expect(await (await check).json()).toMatchObject({ ok: true, requested: false, result: { code: 'check_available' }, checkAgeMs: expect.any(Number), state: { version: '0.1.999' } });
    expect((await apply).status).toBe(202);
    expect(publishRealtimeMutation).toHaveBeenCalledOnce();
    expect((await (await control.GET()).json()).checkRequestedAt).toBeNull();
  });

  it('times out an explicit check without applying or consulting restart admission', async () => {
    const state = await import('@/lib/app-update/relaunch-state');
    state.setAppUpdateState({ updatePending: false, checkOutcome: 'current', checkedAt: new Date().toISOString() });
    const route = await import('@/app/api/panel/update/apply/route');
    const check = route.POST(post({ checkOnly: true }));
    await vi.advanceTimersByTimeAsync(26_000);
    expect((await check).status).toBe(503);
    expect(publishRealtimeMutation).not.toHaveBeenCalled();
    expect(getUpdateIdleWindow).not.toHaveBeenCalled();
  });

  it.each(['checkNow', 'checkOnly'])('refuses malformed %s before requesting a native check', async field => {
    const state = await import('@/lib/app-update/relaunch-state');
    state.setAppUpdateState({ updatePending: false, checkOutcome: 'current', checkedAt: new Date().toISOString() });
    const route = await import('@/app/api/panel/update/apply/route');
    const response = await route.POST(post({ [field]: 'yes' }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('invalid_request');
    const control = await import('@/app/api/panel/app/update-state/route');
    expect((await (await control.GET()).json()).checkRequestedAt).toBeNull();
    expect(publishRealtimeMutation).not.toHaveBeenCalled();
  });

  it('exposes a check-only MCP request through the actual handler and native handoff', async () => {
    const state = await import('@/lib/app-update/relaunch-state');
    state.setAppUpdateState({ updatePending: false, checkOutcome: 'current', checkedAt: '2026-10-22T13:52:00Z' });
    const route = await import('@/app/api/panel/update/apply/route');
    const control = await import('@/app/api/panel/app/update-state/route');
    const mcp = await import('@/lib/mcp/operator-handlers/update');
    expect(mcp.UPDATE_TOOLS[0].inputSchema.properties).toHaveProperty('checkOnly');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => route.POST(new Request(input, init))));
    const pending = mcp.handleUpdateApply({ checkOnly: true });
    await vi.advanceTimersByTimeAsync(100);
    expect((await (await control.GET()).json()).checkRequestedAt).toEqual(expect.any(String));
    await control.POST(new Request('http://localhost/api/panel/app/update-state', { method: 'POST', body: JSON.stringify({
      updatePending: false, checkOutcome: 'current', checkedAt: new Date().toISOString(),
    }) }));
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(result.isError).toBe(false);
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({ requested: false,
      result: { code: 'check_current' }, checkAgeMs: expect.any(Number) });
    expect(publishRealtimeMutation).not.toHaveBeenCalled();
  });
});
