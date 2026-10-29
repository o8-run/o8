import type { SurfaceContext, SurfaceRoutes } from '../surface-routes';

/** Deterministic Git snapshot for the real shell's Workspace tools card. */
export default async function register({ repo }: SurfaceContext): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--header-tools')) return {};
  return {
    routes: {
      'GET /api/review/workspace': async request => {
        if (request.nextUrl.searchParams.get('workspace') !== repo) {
          return Response.json({ error: 'Unexpected fixture workspace' }, { status: 400 });
        }
        return Response.json({
          repoPath: repo, repoSlug: 'example/header-fixture', branch: 'feature/header-fixture',
          changedFiles: [
            { path: 'first.rs', additions: 12, deletions: 1 },
            { path: 'second.rs', additions: 5, deletions: 3 },
          ],
          pullRequests: request.nextUrl.searchParams.has('changesOnly') ? [] : [
            { number: 999, headRefName: 'other-branch', title: 'Other pull request' },
            { number: 73, headRefName: 'feature/header-fixture', title: 'Header fixture pull request' },
          ],
        });
      },
    },
  };
}
