import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDataDir } from '@/lib/data-dir-migration';
import { createApproval } from '@/lib/approvals/store';
import { createLane } from '@/lib/lane/registry';

const inventory = vi.hoisted(() => ({ snapshot: { agents: [] as unknown[] } }));
vi.mock('@/lib/runtime/inventory', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/runtime/inventory')>(),
  getRuntimeInventorySnapshot: vi.fn(async () => inventory.snapshot),
}));
vi.mock('@/lib/push/notify', () => ({ notifyApprovalCreated: vi.fn() }));
const sync = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@/lib/orchestrator/control-plane', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/orchestrator/control-plane')>();
  return { ...actual, syncOrchestratorControlPlaneState: async () => { sync.calls += 1; return actual.syncOrchestratorControlPlaneState(); } };
});

const { GET } = await import('@/app/api/orchestrator/state/route');
const TOKEN = 'operator-ws-token-state-cache-0123456789';
mkdirSync(getDataDir(), { recursive: true });
writeFileSync(join(getDataDir(), 'ws-token'), `${TOKEN}\n`, 'utf8');
const token = () => TOKEN;
async function state() {
  const response = await GET(new NextRequest('http://127.0.0.1/api/orchestrator/state', { headers: { authorization: `Bearer ${token()}` } }));
  expect(response.status).toBe(200);
  return response.json() as Promise<{ agents: unknown[] }>;
}

describe('GET /api/orchestrator/state at rest', () => {
  beforeEach(() => { sync.calls = 0; });

  it('answers an unchanged poll without syncing or rebuilding the state again', async () => {
    const first = await state();
    for (let index = 0; index < 5; index += 1) expect(await state()).toEqual(first);
    expect(sync.calls).toBe(1);
  });

  it('rebuilds as soon as a lane, a pending approval or the inventory changes', async () => {
    await state();
    sync.calls = 0;
    createLane({ repoPath: '/tmp/state-cache-repo', projectId: 'state-cache', branch: 'state-cache', runtime: 'codex' });
    await state();
    expect(sync.calls).toBe(1);
    createApproval({ projectId: 'state-cache', source: 'test', runtime: 'codex', agent: 'worker', sessionKey: 'state-cache',
      title: 'State cache', description: 'State cache', summary: 'state cache', risk: 'low' });
    await state();
    expect(sync.calls).toBe(2);
    inventory.snapshot = { agents: [] };
    await state();
    expect(sync.calls).toBe(3);
    await state();
    expect(sync.calls).toBe(3);
  });
});
