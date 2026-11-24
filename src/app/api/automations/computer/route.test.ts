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

import { GET } from './route';

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
