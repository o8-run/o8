import type { SurfaceContext, SurfaceRoutes } from '../surface-routes';
export default async function register({ repo }: SurfaceContext): Promise<SurfaceRoutes> {
  const review = process.argv.includes('--review');
  if (review) await (await import('../review-fixture')).seedReviewFixture(repo);
  // Retain production module initialization even in the other fixture modes.
  const packetDiff = await import('../../../src/app/api/lanes/[id]/diff/route');
  const worktreeDiff = await import('../../../src/app/api/worktrees/diff/route');
  const reviewState = await import('../../../src/app/api/orchestrator/review-state/route');
  const decision = await import('../../../src/app/api/orchestrator/review/route');
  let responseLost = false;
  return {
    routes: review ? {
      'GET /api/worktrees/diff': worktreeDiff.GET, 'GET /api/orchestrator/review-state': reviewState.GET,
      'POST /api/orchestrator/review': decision.POST,
      ...Object.fromEntries(['next-review-approve', 'next-review-reject'].map(id => [
        `GET /api/lanes/${id}/diff`, request => packetDiff.GET(request, { params: Promise.resolve({ id }) }),
      ])),
    } : {},
    admit: ({ body, route }) => !body || route === decision.POST && ['next-review-approve', 'next-review-reject'].includes(JSON.parse(body).packetId) ? 200 : 400,
    after: (input, response) => {
      if (process.argv.includes('--review-drop-first') && input.route === decision.POST
        && response.ok && !responseLost && JSON.parse(input.body).approved === false) {
        responseLost = true; return true;
      }
      return false;
    },
  };
}
