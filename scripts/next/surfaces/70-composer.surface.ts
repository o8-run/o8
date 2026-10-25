import { realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SurfaceContext, SurfaceRoutes } from '../surface-routes';
export default async function register({ repo, dataDir, seeds }: SurfaceContext): Promise<SurfaceRoutes> {
  const composer = process.argv.includes('--composer');
  if (composer && process.argv.includes('--composer-loaded')) {
    const id = 'thoughts-composer-loaded';
    const messages = Array.from({ length: 200 }, (_, index) => ({
      id: `loaded-${index}`, role: index % 2 ? 'assistant' : 'user',
      content: `Message ${index}: fixed session typing fixture.\n\n` +
        'A paragraph with **styled text**, `inline code`, and a stable transcript row. '.repeat(8),
      timestamp: 1790812800000 + index * 1000,
    }));
    seeds.push({ id, title: 'Loaded composer fixture', messages });
    writeFileSync(join(dataDir, 'chat-history', `${id}.json`), JSON.stringify({
      id, title: 'Loaded composer fixture', repoPath: repo, backend: 'pi', model: 'pi',
      orchestratorVisible: true, savedAt: '2026-10-01T00:00:00.000Z', messages,
    }));
  }
  const queue = await import('../../../src/app/api/orchestrator/composer-queue/route');
  // Same injectable native admission boundary as the existing composer tests.
  if (composer) {
    const { getOrchestratorBackend } = await import('../../../src/lib/lane/orchestrator-backends/registry');
    Object.defineProperty(getOrchestratorBackend('pi'), 'liveSteer', { value:
      async (_repo: string, _text: string, options: { beforeAdmit: () => void }) => {
        options.beforeAdmit(); return { accepted: true };
      }, configurable: true });
  }
  let responseLost = false;
  return {
    routes: {
      'GET /api/orchestrator/composer-queue': queue.GET,
      ...(composer ? { 'POST /api/orchestrator/composer-queue': queue.POST,
        'PATCH /api/orchestrator/composer-queue': queue.PATCH, 'DELETE /api/orchestrator/composer-queue': queue.DELETE } : {}),
    },
    // The repository is supplied by the owned host, never by an external account.
    admit: ({ body }) => {
      if (!body) return 200;
      try {
        const target = JSON.parse(body);
        return target.threadId?.startsWith('thoughts-composer-') && realpathSync(target.repoPath) === realpathSync(repo) ? 200 : 400;
      } catch { return 400; }
    },
    after: async (input, response) => {
      if (composer && response.ok && (input.route === queue.PATCH || (input.route === queue.POST && JSON.parse(input.body).intent === 'steer-now'))) {
        const { claimComposerSteer } = await import('../../../src/lib/orchestrator/composer-queue');
        const { runQueuedComposerSteer } = await import('../../../src/lib/ws-server/composer-queue-heartbeat');
        const item = claimComposerSteer((await response.clone().json()).item.id);
        if (item) await runQueuedComposerSteer(item);
      }
      if (composer && input.route === queue.POST && response.ok && !responseLost && JSON.parse(input.body).payload?.text === 'Fixture lose response') {
        responseLost = true; return true;
      }
      return false;
    },
  };
}
