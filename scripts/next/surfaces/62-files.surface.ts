/** Test-only Files reads: the panel's listing, a file's text and the project's worktrees, read only. */
import type { SurfaceContext, SurfaceRoutes } from '../surface-routes';

export default async function register({ repo }: SurfaceContext): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--files')) return {};
  // File text is served only for a registered repository, as in the app.
  await (await import('../../../src/lib/repos/registry')).addRepo(repo);
  const listing = await import('../../../src/app/api/panel/files/route');
  const file = await import('../../../src/app/api/v2/files/route');
  const worktrees = await import('../../../src/app/api/review/workspace/route');
  return {
    routes: {
      'GET /api/panel/files': listing.GET,
      'GET /api/v2/files': file.GET,
      'GET /api/review/workspace': worktrees.GET,
    },
  };
}
