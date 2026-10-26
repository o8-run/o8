import { afterEach, expect, it, vi } from 'vitest';
import * as stateRoute from '@/app/api/panel/app/update-state/route';
import * as applyRoute from '@/app/api/panel/update/apply/route';

function report(body: Record<string, unknown>) {
  return stateRoute.POST(new Request('http://127.0.0.1/api/panel/app/update-state', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
}

afterEach(() => vi.useRealTimers());

it('requests another native check within a minute of current and clears it after a new offer', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const started = Date.now();
  const checkedAt = new Date(started).toISOString();
  await report({ updatePending: false, checkOutcome: 'current', checkedAt });
  expect((await (await stateRoute.GET()).json()).checkRequestedAt).toBeNull();
  vi.setSystemTime(started + 59_999);
  expect((await (await stateRoute.GET()).json()).checkRequestedAt).toBeNull();
  vi.setSystemTime(started + 60_000);
  const control = await (await stateRoute.GET()).json();
  expect(control.checkRequestedAt).toBe(new Date().toISOString());
  expect((await (await stateRoute.GET()).json()).checkRequestedAt).toBe(control.checkRequestedAt);

  // The native loop consumes this route with no webview and reports its next result.
  vi.setSystemTime(started + 60_001);
  await report({ updatePending: true, checkOutcome: 'available', version: '0.0.2', checkedAt: new Date().toISOString() });
  const offered = await (await stateRoute.GET()).json();
  expect(offered.checkRequestedAt).toBeNull();
  expect(offered.state).toMatchObject({ updatePending: true, version: '0.0.2' });
});

it('does not trust a minute-old current result on the normal apply route', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const started = Date.now() + 120_000;
  vi.setSystemTime(started);
  await report({ updatePending: false, checkOutcome: 'current', checkedAt: new Date().toISOString() });
  vi.setSystemTime(started + 60_000);
  const pending = applyRoute.POST(new Request('http://127.0.0.1/api/panel/update/apply', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }));
  await new Promise(resolve => setTimeout(resolve, 10));
  try {
    expect((await (await stateRoute.GET()).json()).checkRequestedAt).toBe(new Date().toISOString());
  } finally {
    vi.setSystemTime(started + 60_001);
    await report({ updatePending: false, checkOutcome: 'current', checkedAt: new Date().toISOString() });
    await pending;
  }
  await expect((await pending).json()).resolves.toMatchObject({ result: { code: 'already_current' }, checkAgeMs: 0 });
  expect((await (await stateRoute.GET()).json()).checkRequestedAt).toBeNull();
});
