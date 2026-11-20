import { expect, it, vi } from 'vitest';

vi.mock('@/lib/app-update/idle-window', () => ({
  getUpdateIdleWindow: async () => ({ idle: false, idleExceptParked: false, active: {}, unavailable: [] }),
}));
const stateRoute = await import('@/app/api/panel/app/update-state/route');
const applyRoute = await import('@/app/api/panel/update/apply/route');

it('exposes background download readiness and failure through the existing apply status route without installing', async () => {
  for (const phase of ['available', 'downloading', 'ready', 'failed']) {
    const status = { phase, version: '0.2.0', error: phase === 'failed' ? 'Invalid signature' : null };
    const response = await stateRoute.POST(new Request('http://localhost/api/panel/app/update-state', {
      method: 'POST', body: JSON.stringify({ autoApply: { action: 'held', status } }),
    }));
    expect((await response.json()).allowed).toBe(true);
    const body = await (await applyRoute.GET()).json();
    expect(body.state.heldUpdate).toEqual(status);
    expect(body.state.lastInstall).toBeNull();
    expect(body.state.autoApply).toBeNull();
  }
});
