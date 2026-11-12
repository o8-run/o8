import { execFileSync } from 'node:child_process';
import type { SurfaceContext, SurfaceRoutes } from '../surface-routes';
export default async function register({ repo }: SurfaceContext): Promise<SurfaceRoutes> {
  const review = process.argv.includes('--review');
  if (review) await (await import('../review-fixture')).seedReviewFixture(repo);
  // Retain production module initialization even in the other fixture modes.
  const packetDiff = await import('../../../src/app/api/lanes/[id]/diff/route');
  const worktreeDiff = await import('../../../src/app/api/worktrees/diff/route');
  const reviewState = await import('../../../src/app/api/orchestrator/review-state/route');
  const decision = await import('../../../src/app/api/orchestrator/review/route');
  const workspaceChanges = await import('../../../src/app/api/review/workspace/route');
  const lastTurn = await import('../../../src/app/api/review/last-turn/route');
  const delta = await import('../../../src/app/api/review/architecture-delta/route');
  const attention = await import('../../../src/app/api/review/architecture-attention/route');
  let responseLost = false;
  let mapAdvanced = false;
  return {
    routes: {
      'GET /api/review/architecture-delta': async request => {
        if (process.argv.includes('--change-map-stale') && !mapAdvanced && request.nextUrl.searchParams.has('lane')) {
          execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-qm', 'test: advance review after diff read']);
          mapAdvanced = true;
        }
        return delta.GET(request);
      },
      'POST /api/review/architecture-attention': attention.POST,
      ...(review ? {
      'GET /api/worktrees/diff': worktreeDiff.GET, 'GET /api/orchestrator/review-state': reviewState.GET,
      'POST /api/orchestrator/review': decision.POST,
      'GET /api/review/workspace': workspaceChanges.GET, 'GET /api/review/last-turn': lastTurn.GET,
      ...Object.fromEntries(['next-review-approve', 'next-review-reject'].map(id => [
        `GET /api/lanes/${id}/diff`, request => packetDiff.GET(request, { params: Promise.resolve({ id }) }),
      ])),
    } : {}),
    },
    admit: ({ body, route }) => !body || route === attention.POST || route === decision.POST && ['next-review-approve', 'next-review-reject'].includes(JSON.parse(body).packetId) ? 200 : 400,
    after: (input, response) => {
      if (process.argv.includes('--review-drop-first') && input.route === decision.POST
        && response.ok && !responseLost && JSON.parse(input.body).approved === false) {
        responseLost = true; return true;
      }
      return false;
    },
  };
}
