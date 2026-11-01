/** Production continuation routes, limited to the composer's disposable records. */
import type { SurfaceContext, SurfaceRoutes } from '../surface-routes';
import { realpathSync } from 'node:fs';

export default async function register({ seeds, repo }: SurfaceContext): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--composer')) return {};
  const history = await import('../../../src/app/api/v2/chat-history/route');
  const handoff = await import('../../../src/app/api/orchestrator/handoff/route');
  const media = await import('../../../src/app/api/mobile/media/route');
  const { persistComposerImages } = await import('../../../src/lib/mobile/orchestrator-image-media');
  const dataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=';
  const images = persistComposerImages([{ dataUri, name: 'Recorded image.png' }]);
  let delayMs = 0;
  let loseNextSave = false;
  const scenario = async (request: import('next/server').NextRequest) => {
    if (request.method === 'POST') {
      const config = await request.json();
      delayMs = typeof config.delayMs === 'number' ? Math.min(1000, Math.max(0, config.delayMs)) : 0;
      loseNextSave = config.loseNextSave === true;
    }
    return Response.json({ media: images, dataUri });
  };
  return {
    priority: 19,
    routes: {
      'POST /api/v2/chat-history': history.POST, 'PATCH /api/v2/chat-history': history.PATCH,
      'POST /api/orchestrator/handoff': handoff.POST, 'GET /api/mobile/media': media.GET,
      'GET /api/prompt-action-fixture': scenario, 'POST /api/prompt-action-fixture': scenario,
    },
    admit: ({ route, body }) => {
      if (!body || route === scenario) return 200;
      try {
        const value = JSON.parse(body);
        const id = route === handoff.POST ? value.threadId : value.tabId;
        const owned = seeds.some(seed => seed.id === id);
        return owned || route === history.POST && /^thoughts-next-\d+$/.test(id)
          && realpathSync(value.repoPath) === realpathSync(repo) ? 200 : 404;
      } catch { return 400; }
    },
    run: async (route, request) => {
      if (route === history.POST && (await request.clone().json()).tabId?.startsWith('thoughts-next-') && delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
      return route(request);
    },
    after: async ({ route, body }, response) => {
      if (route !== history.POST || !response.ok) return false;
      const value = JSON.parse(body);
      if (!seeds.some(seed => seed.id === value.tabId)) {
        seeds.push({ id: value.tabId, title: value.title, messages: value.messages });
      }
      if (loseNextSave && value.tabId?.startsWith('thoughts-next-')) {
        loseNextSave = false;
        return true;
      }
      return false;
    },
  };
}
