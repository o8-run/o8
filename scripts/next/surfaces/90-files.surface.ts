import type { SurfaceContext, SurfaceRoutes } from '../surface-routes';
export default async function register({ repo }: SurfaceContext): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--files')) return {};
  const content = await import('../../../src/app/api/panel/file-content/route');
  const diff = await import('../../../src/app/api/panel/file-diff/route');
  const files = await import('../../../src/app/api/v2/files/route');
  await (await import('../../../src/lib/repos/registry')).addRepo(repo);
  return {
    routes: { 'GET /api/panel/file-content': content.GET, 'GET /api/panel/file-diff': diff.GET, 'POST /api/v2/files': files.POST },
    admit: ({ body }) => !body || JSON.parse(body).workspace === repo ? 200 : 400,
    run: async (route, request) => {
      const response = await route(request);
      if (process.argv.includes('--files-missing-revision') && response.ok && route === content.GET) {
        const snapshot = await response.json() as Record<string, unknown>;
        delete snapshot.contentHash;
        return Response.json(snapshot);
      }
      return response;
    },
  };
}
