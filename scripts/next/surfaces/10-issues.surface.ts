import { setTimeout as delay } from 'node:timers/promises';
import type { Route, SurfaceContext, SurfaceRoutes } from '../surface-routes';
export default async function register({ dataDir, root, repo }: SurfaceContext): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--issues')) return {};
  const issues = await (await import('../issues-fixture')).issueFixture(dataDir, root, repo);
  const routes: Record<string, Route> = Object.fromEntries([
    ...Object.entries(issues.gets).map(([path, route]) => [`GET ${path}`, route]),
    ...Object.entries(issues.posts).map(([path, route]) => [`POST ${path}`, route]),
  ]);
  const delayedBootstrap = process.argv.includes('--issues-delay-bootstrap');
  if (delayedBootstrap) {
    const { GET } = await import('../../../src/app/api/mobile/orchestrator/threads/route');
    routes['GET /api/mobile/orchestrator/threads'] = async request => {
      await delay(2_000);
      return GET(request);
    };
  }
  return {
    ...(delayedBootstrap ? { priority: 10 } : {}),
    routes,
    admit: input => input.body && !issues.posts[input.url.pathname] ? 400 : 200,
    close: issues.close,
  };
}
