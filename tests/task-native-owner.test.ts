import { NextRequest } from 'next/server';
import { afterEach, expect, it, vi } from 'vitest';
const local = vi.hoisted(() => vi.fn());
vi.mock('@/lib/tasks/http/claim', () => ({ POST: local }));
vi.mock('@/lib/tasks/http/dispatch', () => ({ POST: local }));
vi.mock('@/lib/tasks/http/archive', () => ({ POST: local }));
vi.mock('@/lib/tasks/http/prune', () => ({ POST: local }));
import { POST as claim } from '@/app/api/tasks/[taskId]/claim/route';
import { POST as dispatch } from '@/app/api/tasks/[taskId]/dispatch/route';
import { POST as archive } from '@/app/api/tasks/[taskId]/archive/route';
import { POST as prune } from '@/app/api/tasks/[taskId]/prune/route';
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
it.each([['claim', claim], ['dispatch', dispatch], ['archive', archive], ['prune', prune]] as const)(
  'forwards %s without running the local action service', async (verb, handler) => {
    vi.stubEnv('O8_NEXT_O8D', '1');
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetcher);
    const request = new NextRequest(`http://localhost/api/tasks/task/${verb}`, {
      method: 'POST', headers: { authorization: 'Bearer fixture' }, body: JSON.stringify({ note: 'fixture' }),
    });
    expect((await handler(request, { params: Promise.resolve({ taskId: 'task' }) })).status).toBe(200);
    expect(local).not.toHaveBeenCalled();
    expect(fetcher.mock.calls[0][0]).toContain(`/api/tasks/task/${verb}`);
    expect(new TextDecoder().decode(fetcher.mock.calls[0][1].body as ArrayBuffer)).toBe('{"note":"fixture"}');
  },
);
