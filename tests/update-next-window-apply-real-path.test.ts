import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ busy: false, publishRealtimeMutation: vi.fn(async () => true) }));
vi.mock('@/lib/app-update/idle-window', () => ({ getUpdateIdleWindow: async () => ({
  idle: !fixture.busy, idleExceptParked: !fixture.busy, parkedLanes: [], unavailable: [],
  active: { lanes: [], terminalSessions: fixture.busy ? [{ name: 'temporary-work' }] : [], managedRuns: [], ownedSessions: [], cloudJobs: [] },
}) }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: fixture.publishRealtimeMutation }));

let applyRoute: typeof import('@/app/api/panel/update/apply/route');
let stateRoute: typeof import('@/app/api/panel/app/update-state/route');

const apply = async (body: object) => applyRoute.POST(new Request('http://127.0.0.1/api/panel/update/apply', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}));
// The native updater loop drives these two calls (src-tauri/src/update_scheduler.rs).
const nativeRead = async () => (await stateRoute.GET()).json();
const native = async (autoApply: object) => (await stateRoute.POST(new Request('http://127.0.0.1/api/panel/app/update-state', {
  method: 'POST', body: JSON.stringify({ autoApply }),
}))).json();

beforeEach(async () => {
  // Fresh server state per case. The isolated fixture uses a self-updatable install on every test host.
  vi.resetModules();
  vi.stubEnv('APPIMAGE', '/fixture/o8.AppImage');
  fixture.busy = false;
  fixture.publishRealtimeMutation.mockClear();
  applyRoute = await import('@/app/api/panel/update/apply/route');
  stateRoute = await import('@/app/api/panel/app/update-state/route');
  await (await import('@/lib/operator/defaults')).updateOperatorDefaults({ updateAutoApply: 'off' });
  (await import('@/lib/app-update/relaunch-state')).setAppUpdateState({ updatePending: true, version: '0.2.0' });
});
afterEach(() => vi.unstubAllEnvs());

it('installs an Update click through the native updater when o8 next is the window', async () => {
  vi.stubEnv('O8_NEXT_MAIN_WINDOW', '1');
  const response = await apply({});
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ requested: true,
    message: 'Update 0.2.0 apply request sent to the native updater.' });
  // No classic webview exists to receive the realtime mutation.
  expect(fixture.publishRealtimeMutation).not.toHaveBeenCalled();
  expect((await nativeRead()).applyRequestedAt).toEqual(expect.any(String));

  // Automatic updates stay off; the click alone admits this one install.
  expect(await native({ action: 'admit', attemptId: 'clicked' })).toMatchObject({ allowed: true, version: '0.2.0' });
  expect(await native({ action: 'restart', attemptId: 'clicked' })).toMatchObject({ allowed: true,
    state: { autoApply: { phase: 'restarting' } } });
  expect(await native({ action: 'admit', attemptId: 'later' })).toMatchObject({ allowed: false });
});

it('forces a clicked install past live work only when the click asked for force', async () => {
  vi.stubEnv('O8_NEXT_MAIN_WINDOW', '1');
  fixture.busy = true;
  expect((await apply({})).status).toBe(409);
  expect((await apply({ force: true })).status).toBe(202);
  expect(await native({ action: 'admit', attemptId: 'forced' })).toMatchObject({ allowed: true });
});

it('a failed clicked install ends the request instead of retrying it automatically', async () => {
  vi.stubEnv('O8_NEXT_MAIN_WINDOW', '1');
  expect((await apply({})).status).toBe(202);
  expect(await native({ action: 'admit', attemptId: 'clicked' })).toMatchObject({ allowed: true });
  await native({ action: 'failed', attemptId: 'clicked', error: 'Download failed.' });
  expect((await nativeRead()).applyRequestedAt).toBeNull();
  expect(await native({ action: 'admit', attemptId: 'retry' })).toMatchObject({ allowed: false });
});

it('keeps sending the click to the classic window when it exists', async () => {
  const response = await apply({});
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ message: 'Update 0.2.0 apply request sent to the app webview.' });
  expect(fixture.publishRealtimeMutation).toHaveBeenCalledTimes(1);
  expect((await nativeRead()).applyRequestedAt).toBeNull();
  expect(await native({ action: 'admit', attemptId: 'automatic' })).toMatchObject({ allowed: false });
});

it('reports the running server version for the Update pill', async () => {
  const { version } = (await import('../package.json')).default;
  expect(await (await applyRoute.GET()).json()).toMatchObject({ currentVersion: version });
});

it('shows the native download, install and restart steps for the progress bar', async () => {
  vi.stubEnv('O8_NEXT_MAIN_WINDOW', '1');
  expect((await apply({})).status).toBe(202);
  const progress = async () => (await (await applyRoute.GET()).json()).state.autoApply.progress;
  expect(await native({ action: 'admit', attemptId: 'clicked' })).toMatchObject({ allowed: true });
  expect(await progress()).toEqual({ stage: 'downloading', receivedBytes: 0, totalBytes: null });
  expect(await native({ action: 'progress', attemptId: 'clicked', receivedBytes: 5_242_880, totalBytes: 20_971_520 }))
    .toMatchObject({ allowed: true });
  expect(await progress()).toEqual({ stage: 'downloading', receivedBytes: 5_242_880, totalBytes: 20_971_520 });
  expect(await native({ action: 'progress', attemptId: 'stale', receivedBytes: 1, totalBytes: null }))
    .toMatchObject({ allowed: false, attemptMissing: true });
  expect(await native({ action: 'progress', attemptId: 'clicked', receivedBytes: -1, totalBytes: null }))
    .toMatchObject({ allowed: false, error: { code: 'invalid_progress' } });
  expect(await native({ action: 'install', attemptId: 'clicked' })).toMatchObject({ allowed: true });
  expect(await progress()).toMatchObject({ stage: 'installing' });
  expect(await native({ action: 'restart', attemptId: 'clicked' })).toMatchObject({ allowed: true });
  expect(await progress()).toMatchObject({ stage: 'restarting' });
});
