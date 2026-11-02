import { realpathSync } from 'node:fs';
import { NextRequest } from 'next/server';
import type { SurfaceContext, SurfaceRoutes } from '../../../../../scripts/next/surface-routes';

export async function install({ repo, seeds }: SurfaceContext): Promise<SurfaceRoutes> {
  const history = await import('../../../../../src/app/api/v2/chat-history/route');
  const queue = await import('../../../../../src/app/api/orchestrator/composer-queue/route');
  const creates: Array<{ tabId: string; title: string; messages: Array<Record<string, unknown>> }> = [];
  const sends: unknown[] = [];
  let mode = 'ready';
  return { priority: 0, admit: ({ body }) => {
    if (!body) return 200;
    const value = JSON.parse(body);
    return /^thoughts-(?:side-chat|next)-\d+$/.test(value.tabId ?? value.threadId ?? '') && realpathSync(value.repoPath) === realpathSync(repo) ? 200 : 400;
  }, routes: {
    'GET /api/panel/operator-defaults': async () => Response.json({ values: { orchestratorBackend: 'pi', orchestratorModel: 'pi' } }),
    'POST /api/v2/chat-history': async request => {
      const body = await request.clone().json(); creates.push(body);
      if (mode === 'fail') return Response.json({ error: 'Owned chat creation unavailable' }, { status: 503 });
      const response = await history.POST(request);
      if (response.ok && !seeds.some(seed => seed.id === body.tabId)) seeds.push({ id: body.tabId, title: body.title, messages: body.messages });
      return response;
    },
    'POST /api/orchestrator/composer-queue': async request => {
      const body = await request.clone().json(); sends.push(body);
      const response = await queue.POST(request);
      if (response.ok && body.intent === 'steer-now') {
        const { claimComposerSteer } = await import('../../../../../src/lib/orchestrator/composer-queue');
        const { runQueuedComposerSteer } = await import('../../../../../src/lib/ws-server/composer-queue-heartbeat');
        const item = claimComposerSteer((await response.clone().json()).item.id);
        if (item) await runQueuedComposerSteer(item);
      }
      return response;
    },
    'GET /api/side-chat-fixture': async request => {
      mode = request.nextUrl.searchParams.get('mode') ?? mode;
      const histories = Object.fromEntries(await Promise.all(creates.map(async ({ tabId }) => {
        const url = new URL('/api/v2/chat-history', request.url); url.searchParams.set('tabId', tabId);
        return [tabId, await (await history.GET(new NextRequest(url))).json()];
      })));
      return Response.json({ mode, creates, sends, histories });
    },
  } };
}
