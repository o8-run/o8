import type { SurfaceContext, SurfaceRoutes } from '../surface-routes';
export default async function register({ dataDir, root, repo }: SurfaceContext): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--issues')) return {};
  const issues = await (await import('../issues-fixture')).issueFixture(dataDir, root, repo);
  return {
    routes: Object.fromEntries([
      ...Object.entries(issues.gets).map(([path, route]) => [`GET ${path}`, route]),
      ...Object.entries(issues.posts).map(([path, route]) => [`POST ${path}`, route]),
    ]),
    admit: input => input.body && !issues.posts[input.url.pathname] ? 400 : 200,
    close: issues.close,
  };
}
