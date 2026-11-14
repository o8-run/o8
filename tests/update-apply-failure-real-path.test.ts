/**
 * #3588: a remote apply that fails reports why. The real apply route queues its
 * realtime mutation; the installing window reports the updater's rejection,
 * described by the kept install-error helper, to the server update state that
 * the apply route returns. The browser update card that used to run the
 * install is gone, so the report is sent here as that window sends it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const seams = vi.hoisted(() => ({ published: [] as Array<{ mutation: Record<string, unknown> }> }));
vi.mock('@/lib/realtime/publisher', () => ({
  publishRealtimeMutation: vi.fn(async (request: { mutation: Record<string, unknown> }) => {
    seams.published.push(request);
    return true;
  }),
  requestRealtimeRefresh: vi.fn(async () => true),
}));
vi.mock('@/lib/app-update/idle-window', () => ({
  getUpdateIdleWindow: async () => ({ idle: true, active: { lanes: [], terminalSessions: [], managedRuns: [], ownedSessions: [], cloudJobs: [] },
    unavailable: [], checkedAt: new Date().toISOString() }),
}));

import * as applyRoute from '@/app/api/panel/update/apply/route';
import * as stateRoute from '@/app/api/panel/app/update-state/route';
import { describeInstallError } from '@/lib/app-update/update-card-view';

async function lastInstall() {
  const payload = (await (await applyRoute.GET()).json()) as { state?: { lastInstall?: null | { outcome: string; version: string | null; error: string | null } } };
  return payload.state?.lastInstall ?? null;
}

async function reportInstall(install: { outcome: 'started' | 'failed'; version: string; error?: string }) {
  return stateRoute.POST(new Request('http://localhost/api/panel/app/update-state', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ install }),
  }));
}

beforeEach(async () => {
  seams.published.length = 0;
  await stateRoute.POST(new Request('http://localhost/api/panel/app/update-state', { method: 'POST',
    body: JSON.stringify({ updatePending: true, version: '0.1.999', checkOutcome: 'available', checkedAt: new Date().toISOString() }) }));
});

async function remoteApply() {
  const response = await applyRoute.POST(new Request('http://127.0.0.1/api/panel/update/apply', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force: true }),
  }));
  expect(response.status).toBe(202);
  expect(seams.published.at(-1)?.mutation).toBeDefined();
}

describe('a failed remote update apply reports why (#3588)', () => {
  it('records the updater message in the apply state', async () => {
    await remoteApply();
    expect((await reportInstall({ outcome: 'started', version: '0.1.999' })).ok).toBe(true);
    const error = describeInstallError('Failed to verify the update signature');
    expect((await reportInstall({ outcome: 'failed', version: '0.1.999', error })).ok).toBe(true);
    expect(await lastInstall()).toMatchObject({ outcome: 'failed', version: '0.1.999', error: 'Failed to verify the update signature' });
  });

  it('keeps a message when the updater rejects with an empty error', async () => {
    await remoteApply();
    expect((await reportInstall({ outcome: 'started', version: '0.1.999' })).ok).toBe(true);
    // The error's name stands in for its empty message.
    const error = describeInstallError(new Error(''));
    expect(error).toBe('Error');
    expect((await reportInstall({ outcome: 'failed', version: '0.1.999', error })).ok).toBe(true);
    expect((await lastInstall())?.error).toBe('Error');
  });
});
