import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/mobile/pull-request-projection', () => ({ mobileThreadPullRequests: async () => [] }));

const listMobileOrchestratorThreads = vi.fn(() => []);
const createThread = vi.fn(() => ({ id: 'thoughts-fixture' }));

vi.mock('@/lib/mobile/orchestrator-thread-history', () => ({
  createMobileOrchestratorThread: createThread,
  listArchivedOrchestratorThreadIds: vi.fn(() => []),
  listMobileOrchestratorThreads,
}));

const lookupLinkedWork = vi.hoisted(() => vi.fn(() => new Map()));
vi.mock('@/lib/mobile/linked-work', () => ({ lookupLinkedWork }));

const { GET, POST } = await import('@/app/api/mobile/orchestrator/threads/route');

function request(search = ''): NextRequest {
  return new NextRequest(`http://localhost:3001/api/mobile/orchestrator/threads${search}`);
}

describe('mobile orchestrator threads route backend filter', () => {
  beforeEach(() => {
    listMobileOrchestratorThreads.mockReset();
    listMobileOrchestratorThreads.mockReturnValue([]);
    lookupLinkedWork.mockReset();
    lookupLinkedWork.mockReturnValue(new Map());
  });

  it('passes Hermes backend filters through to the thread history helper', async () => {
    const res = await GET(request('?backend=hermes'));

    expect(res.status).toBe(200);
    expect(listMobileOrchestratorThreads).toHaveBeenCalledWith({ backend: 'hermes', limit: undefined });
  });

  it('passes Collide backend filters through to the thread history helper', async () => {
    const res = await GET(request('?backend=collide'));

    expect(res.status).toBe(200);
    expect(listMobileOrchestratorThreads).toHaveBeenCalledWith({ backend: 'collide', limit: undefined });
  });

  it('keeps the default non-openclaw bucket when no backend is requested', async () => {
    const res = await GET(request());

    expect(res.status).toBe(200);
    expect(listMobileOrchestratorThreads).toHaveBeenCalledWith({ backend: null, limit: undefined });
  });

  it('does not fall back to the default bucket for unknown backend values', async () => {
    const res = await GET(request('?backend=not-real'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ threads: [] });
    expect(listMobileOrchestratorThreads).not.toHaveBeenCalled();
  });
  it('adds optional counts in one batch while preserving existing fields', async () => {
    const threads = [{ id: 'thoughts-a', title: 'One' }, { id: 'thoughts-b', title: 'Two' }];
    const counts = { pullRequests: { total: 1, open: 1, merged: 0, closed: 0 }, branches: 1 };
    listMobileOrchestratorThreads.mockReturnValue(threads as never);
    lookupLinkedWork.mockReturnValue(new Map([['thoughts-a', counts]]));
    const json = await (await GET(request())).json();
    expect(json.threads).toMatchObject([{ ...threads[0], linkedWork: counts }, { ...threads[1], linkedWork: null }]);
    expect(lookupLinkedWork).toHaveBeenCalledExactlyOnceWith(threads);
    expect(json.threads.map(({ id, title }: { id: string; title: string }) => ({ id, title }))).toEqual(threads);
  });

});

describe('phone thread creation model admission', () => {
  it('forwards a listed Codex model and refuses unknown models', async () => {
    const request = (model: string) => new NextRequest('http://localhost/api/mobile/orchestrator/threads', {
      method: 'POST', body: JSON.stringify({ repoPath: '/tmp/fixture', backend: 'codex', model }),
    });
    createThread.mockClear();
    expect((await POST(request('gpt-6.1-sol'))).status).toBe(200);
    expect(createThread).toHaveBeenCalledWith(expect.objectContaining({ backend: 'codex', model: 'gpt-6.1-sol' }));
    createThread.mockClear();
    const refused = await POST(request('unknown-model'));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: expect.stringContaining('Unknown model') });
    expect(createThread).not.toHaveBeenCalled();
  });
});
