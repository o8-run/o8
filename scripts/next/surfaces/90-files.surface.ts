import type { SurfaceContext, SurfaceRoutes } from '../surface-routes';
export default async function register({ repo }: SurfaceContext): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--files')) return {};
  const content = await import('../../../src/app/api/panel/file-content/route');
  const files = await import('../../../src/app/api/panel/files/route');
  await (await import('../../../src/lib/repos/registry')).addRepo(repo);
  return {
    routes: { 'GET /api/panel/file-content': content.GET, 'GET /api/panel/files': files.GET },
    admit: ({ body, url }) => !body && url.searchParams.get('workspace') === repo ? 200 : 400,
  };
}
