import type { SurfaceContext, SurfaceRoutes } from '../surface-routes';
export default async function register({ root }: SurfaceContext): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--projects')) return {};
  const projects = await (await import('../projects-fixture')).projectsFixture(root);
  return {
    priority: 10,
    match: projects.route,
    admit: () => 200,
    after: (input, response) => projects.dropResponse(input.method, input.url.pathname, input.body, response),
    receipt: { folders: projects.folders },
  };
}
