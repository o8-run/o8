import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { SurfaceContext, SurfaceRoutes } from '../surface-routes';

export async function prepare(): Promise<SurfaceRoutes> {
  if (process.argv.includes('--onboarding')) createRequire(import.meta.url)('./setup/discovery.cjs');
  return {};
}
export default async function register({ dataDir, repo, seeds }: SurfaceContext): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--onboarding')) return {};
  for (const file of readdirSync(join(dataDir, 'chat-history'))) rmSync(join(dataDir, 'chat-history', file));
  seeds.splice(0);
  const { addRepo } = await import('../../../src/lib/repos/registry');
  await addRepo(repo);
  const defaults = await import('../../../src/app/api/panel/operator-defaults/route');
  const repos = await import('../../../src/app/api/panel/repos/route');
  const projects = await import('../../../src/app/api/panel/projects/route');
  const config = await import('../../../src/app/api/setup/config/route');
  const history = await import('../../../src/app/api/mobile/history/route');
  const context = await import('../../../src/app/api/v2/chat-history/route');
  const queue = await import('../../../src/app/api/orchestrator/composer-queue/route');
  const wsInfo = await import('../../../src/app/api/panel/ws-info/route');
  const { getAllRuntimes } = await import('../../../src/lib/runtimes');
  for (const runtime of getAllRuntimes()) runtime.discoverSessions = async () => [];
  const { GET: sessions } = await import('../../../src/app/api/mobile/orchestrator/threads/route');
  const { GET: state } = await import('../../../src/app/api/orchestrator/state/route');
  const { GET: inventory } = await import('../../../src/app/api/runtime/inventory/route');
  return { priority: 5, admit: () => 200,
    run: async (route, request) => {
      const response = await route(request);
      if (process.argv.includes('--onboarding-empty-model') && response.ok
        && request.method === 'GET' && request.nextUrl.pathname === '/api/panel/operator-defaults'
        && request.nextUrl.searchParams.get('include') === 'setup') {
        const payload = await response.json();
        payload.setupRecommendation.leadModel = '';
        return Response.json(payload, { status: response.status, headers: response.headers });
      }
      return response;
    }, routes: {
    'GET /api/panel/repos': repos.GET, 'POST /api/panel/repos': repos.POST,
    'GET /api/panel/projects': projects.GET,
    'GET /api/panel/operator-defaults': defaults.GET, 'POST /api/panel/operator-defaults': defaults.POST,
    'GET /api/setup/config': config.GET, 'POST /api/setup/config': config.POST,
    'GET /api/mobile/history': history.GET, 'GET /api/v2/chat-history': context.GET,
    'POST /api/v2/chat-history': context.POST, 'GET /api/orchestrator/composer-queue': queue.GET,
    'POST /api/orchestrator/composer-queue': queue.POST, 'GET /api/panel/ws-info': wsInfo.GET,
    'GET /api/mobile/orchestrator/threads': sessions, 'GET /api/orchestrator/state': state,
    'GET /api/runtime/inventory': inventory,
  } };
}
