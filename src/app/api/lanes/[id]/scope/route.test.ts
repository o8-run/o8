import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const expand = vi.fn(async (input: Record<string, unknown>) => ({ ...input, expanded: true }));
let role: 'worker' | 'operator' = 'operator';

vi.mock('@/lib/auth/packet-worker-auth', () => ({ requirePanelOrWorkerAuth: () => null }));
vi.mock('@/lib/auth/principal', () => ({
  resolveRequestPrincipalContext: () => (role === 'worker' ? { role, packetId: 'pkt-1' } : { role }),
  workerPacketRefusal: () => null,
}));
vi.mock('@/lib/lanes/scope', () => ({
  getPacketScope: async () => ({ packetId: 'pkt-1' }),
  projectPacketScope: (scope: unknown) => scope,
}));
vi.mock('@/lib/orchestrator/packet-scope-expansion', () => ({
  requestPacketScopeExpansion: (input: Record<string, unknown>) => expand(input),
}));

import { POST } from './route';

function post(body: unknown) {
  return POST(
    new NextRequest('http://localhost/api/lanes/pkt-1/scope', { method: 'POST', body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: 'pkt-1' }) },
  );
}

describe('POST /api/lanes/[id]/scope', () => {
  beforeEach(() => { expand.mockClear(); role = 'operator'; });

  it('records a lead grant when the caller is not a worker', async () => {
    const response = await post({ paths: ['src/b.ts'], reason: 'caller needs it', grant: true });
    expect(response.status).toBe(200);
    expect(expand).toHaveBeenCalledWith({ packetId: 'pkt-1', paths: ['src/b.ts'], reason: 'caller needs it', grantedBy: 'lead' });
  });

  it('refuses a worker that tries to grant its own scope', async () => {
    role = 'worker';
    const response = await post({ paths: ['src/b.ts'], reason: 'caller needs it', grant: true });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('scope_grant_forbidden');
    expect(expand).not.toHaveBeenCalled();
  });

  it('keeps a worker request as a request', async () => {
    role = 'worker';
    const response = await post({ paths: ['src/b.ts'], reason: 'caller needs it' });
    expect(response.status).toBe(200);
    expect(expand).toHaveBeenCalledWith(expect.objectContaining({ grantedBy: 'worker' }));
  });
});
