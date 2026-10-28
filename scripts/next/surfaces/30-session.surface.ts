import type { SurfaceContext, SurfaceRoutes } from '../surface-routes';
export default async function register({ seeds, transcriptFixtures }: SurfaceContext): Promise<SurfaceRoutes> {
  const { GET: identity } = await import('../../../src/app/api/setup/identity/route');
  const { GET: sessions } = await import('../../../src/app/api/mobile/orchestrator/threads/route');
  const { GET: history } = await import('../../../src/app/api/mobile/history/route');
  const { GET: wsInfo } = await import('../../../src/app/api/panel/ws-info/route');
  const { GET: context } = await import('../../../src/app/api/v2/chat-history/route');
  const { GET: state } = await import('../../../src/app/api/orchestrator/state/route');
  const { GET: inventory } = await import('../../../src/app/api/runtime/inventory/route');
  let failHistory = process.argv.includes('--history-fail-once');
  return {
    priority: 20,
    run: async (route, request) => {
      if (route === history && failHistory) {
        failHistory = false;
        return Response.json({ error: 'Fixture history unavailable' }, { status: 503 });
      }
      return route(request);
    },
    routes: {
      'GET /api/setup/identity': async () => identity(),
      'GET /api/mobile/orchestrator/threads': sessions, 'GET /api/mobile/history': history,
      'GET /api/v2/chat-history': context, 'GET /api/orchestrator/state': state,
      'GET /api/panel/ws-info': wsInfo, 'GET /api/runtime/inventory': inventory,
    },
    admit: ({ route, url, body }) => {
      // Keep this development host from becoming a provider-history reader.
      if (route === history && !seeds.some(seed => `llm-chat:${seed.id}` === url.searchParams.get('sessionKey'))
        && !(transcriptFixtures && url.searchParams.get('sessionKey') === 'opencode-owned:next-worker')) return 404;
      if (route === context && !seeds.some(seed => seed.id === url.searchParams.get('tabId'))) return 404;
      return body ? 400 : 200;
    },
  };
}
