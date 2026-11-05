import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { SurfaceContext, SurfaceRoutes } from '../surface-routes';
/** Review's Commit, Push and Open pull request on the production routes. --review-git gives the
 * review fixture's repository a GitHub origin whose pushes land in a local bare repository. */
export default async function register({ root, repo }: SurfaceContext): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--review-git')) return {};
  const remote = join(root, 'review-remote.git');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
  git('remote', 'add', 'origin', 'https://github.com/o8-fixture/review.git');
  git('config', 'remote.origin.pushurl', remote);
  const commit = await import('../../../src/app/api/review/commit/route');
  const push = await import('../../../src/app/api/review/push/route');
  const workspace = await import('../../../src/app/api/review/workspace/route');
  return {
    routes: {
      'POST /api/review/commit': commit.POST, 'POST /api/review/push': push.POST,
      'GET /api/review/workspace': workspace.GET,
    },
    admit: () => 200,
  };
}
