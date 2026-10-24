import type { SurfaceContext, SurfaceRoutes } from '../surface-routes';
export default async function register({ repo }: SurfaceContext): Promise<SurfaceRoutes> {
  const composer = process.argv.includes('--composer');
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
    admit: ({ body }) => !body || JSON.parse(body).threadId?.startsWith('thoughts-composer-') && JSON.parse(body).repoPath === repo ? 200 : 400,
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
