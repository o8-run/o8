import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/mobile/pull-request-projection', () => ({ mobileThreadPullRequests: async () => [] }));

const listMobileOrchestratorThreads = vi.fn(() => []);

vi.mock('@/lib/mobile/orchestrator-thread-history', () => ({
  createMobileOrchestratorThread: vi.fn(),
  listArchivedOrchestratorThreadIds: vi.fn(() => []),
  listMobileOrchestratorThreads,
}));

const { GET } = await import('@/app/api/mobile/orchestrator/threads/route');

function request(search = ''): NextRequest {
  return new NextRequest(`http://localhost:3001/api/mobile/orchestrator/threads${search}`);
}

describe('mobile orchestrator threads route backend filter', () => {
  beforeEach(() => {
    listMobileOrchestratorThreads.mockClear();
  });

  it('passes Hermes backend filters through to the thread history helper', async () => {
    const res = await GET(request('?backend=hermes'));

    expect(res.status).toBe(200);
    expect(listMobileOrchestratorThreads).toHaveBeenCalledWith({ backend: 'hermes' });
  });

  it('passes Collide backend filters through to the thread history helper', async () => {
    const res = await GET(request('?backend=collide'));

    expect(res.status).toBe(200);
    expect(listMobileOrchestratorThreads).toHaveBeenCalledWith({ backend: 'collide' });
  });

  it('keeps the default non-openclaw bucket when no backend is requested', async () => {
    const res = await GET(request());

    expect(res.status).toBe(200);
    expect(listMobileOrchestratorThreads).toHaveBeenCalledWith({ backend: null });
  });

  it('does not fall back to the default bucket for unknown backend values', async () => {
    const res = await GET(request('?backend=not-real'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ threads: [] });
    expect(listMobileOrchestratorThreads).not.toHaveBeenCalled();
  });
});
