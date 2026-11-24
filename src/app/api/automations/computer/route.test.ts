import { NextRequest } from 'next/server';
import { expect, it, vi } from 'vitest';

const principal = vi.hoisted(() => ({ role: 'operator' }));
const reads = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/lib/auth/principal', async (original) => ({
  ...(await original<typeof import('@/lib/auth/principal')>()),
  resolveRequestPrincipalContext: () => ({ role: principal.role }),
}));
vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => null }));
vi.mock('@/lib/automations/computer-jobs', () => ({
  readComputerJobs: async () => {
    reads.count++;
    return { jobs: [{ label: 'com.example.syncer' }], hiddenMacosJobs: 0, hiddenOpenApps: 0, collectedAt: 1,
      loginItems: { readable: false, note: 'fixture' } };
  },
}));

const control = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock('@/lib/automations/computer-job-control', () => ({
  controlComputerJob: async (input: unknown) => { control.calls.push(input); return { ok: false, status: 409, error: 'Confirm by naming the job.' }; },
  undoComputerJobAction: async (entryId: string) => { control.calls.push({ undo: entryId }); return { ok: true, entry: { entryId: 'u' }, job: null }; },
}));

import { GET, POST } from './route';

const post = (body: unknown) => POST(new NextRequest('http://localhost/api/automations/computer', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}));

it('lists this Mac\'s jobs for the operator and refuses anyone else without reading them', async () => {
  const response = await GET(new NextRequest('http://localhost/api/automations/computer'));
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toContain('no-store');
  expect(await response.json()).toMatchObject({ ok: true, jobs: [{ label: 'com.example.syncer' }] });
  principal.role = 'worker';
  const refused = await GET(new NextRequest('http://localhost/api/automations/computer'));
  expect(refused.status).toBe(403);
  expect(reads.count).toBe(1);
});

it('passes a named stop or disable and an undo through, and refuses anything else or anyone else', async () => {
  principal.role = 'operator';
  expect((await post({ id: 'user:com.example.syncer', action: 'stop', confirm: 'com.example.syncer' })).status).toBe(409);
  expect((await post({ undo: '00000000-0000-4000-8000-000000000001' })).status).toBe(200);
  expect((await post({ id: 'user:com.example.syncer', action: 'delete' })).status).toBe(400);
  expect((await post({ id: 'system:com.example.daemon', action: 'stop' })).status).toBe(400);
  principal.role = 'worker';
  expect((await post({ id: 'user:com.example.syncer', action: 'stop', confirm: 'com.example.syncer' })).status).toBe(403);
  expect(control.calls).toEqual([
    { id: 'user:com.example.syncer', action: 'stop', confirm: 'com.example.syncer' },
    { undo: '00000000-0000-4000-8000-000000000001' },
  ]);
});
