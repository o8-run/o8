import type { SurfaceContext, SurfaceRoutes } from '../surface-routes';

export default async function register({ repo }: SurfaceContext): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--activity')) return {};
  const activity = await (await import('./activity-fixture')).installActivityFixture(repo);
  return {
    priority: 0,
    routes: activity.routes,
    // Production handlers validate bodies; the host still applies operator auth.
    admit: () => 200,
    after: ({ method, url, body }, response) => activity.dropResponse(method, url.pathname, body, response),
  };
}
