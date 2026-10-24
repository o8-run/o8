import type { SurfaceContext, SurfaceRoutes } from '../surface-routes';

// Profile/process isolation must happen before any production module caches it.
export async function prepare({ root }: SurfaceContext): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--settings')) return {};
  const settings = await (await import('../settings-fixture')).settingsFixture(root);
  return {
    priority: 0,
    routes: { ...settings.routes, 'POST /__fixture/settings': settings.control },
    admit: () => 200,
    run: (route, request) => route === settings.control ? route(request) : settings.run(route, request),
    after: (input, response) => input.route !== settings.control && input.method !== 'GET' && response.ok && settings.dropResponse(),
  };
}
