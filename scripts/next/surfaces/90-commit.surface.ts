import type { SurfaceContext, SurfaceRoutes } from '../surface-routes';
export default async function register({ repo }: SurfaceContext): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--commits') || process.argv.includes('--settings')) return {};
  const detail = await import('../../../src/app/api/panel/commits/[hash]/route');
  const file = await import('../../../src/app/api/panel/commits/[hash]/file/route');
  const commit = await import('../../../src/app/api/review/commit/route');
  const push = await import('../../../src/app/api/review/push/route');
  const files = await import('../../../src/app/api/v2/files/route');
  await (await import('./commit/fixture')).seedCommitFixture(repo);
  await (await import('../../../src/lib/repos/registry')).addRepo(repo);
  return {
    routes: { 'POST /api/review/commit': commit.POST, 'POST /api/review/push': push.POST, 'POST /api/v2/files': files.POST },
    match: (method, path) => {
      const match = method === 'GET' && path.match(/^\/api\/panel\/commits\/([^/]+)(\/file)?$/);
      return match ? request => (match[2] ? file.GET : detail.GET)(request, { params: Promise.resolve({ hash: match[1] }) }) : undefined;
    },
    admit: ({ body }) => !body || JSON.parse(body).workspace === repo ? 200 : 400,
  };
}
