import { writeFileSync } from 'node:fs';
import type { SurfaceContext, SurfaceRoutes } from '../surface-routes';
export default async function register({ repo }: SurfaceContext): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--inline') || process.argv.includes('--settings')) return {};
  await (await import('../inline-fixture')).seedInlineFixture(repo, process.argv.includes('--inline-committed'));
  const merge = await import('../../../src/app/api/orchestrator/merge/route');
  const lane = await import('../../../src/app/api/lanes/[id]/route');
  const diff = await import('../../../src/app/api/lanes/[id]/diff/route');
  const worktree = await import('../../../src/app/api/worktrees/diff/route');
  const review = await import('../../../src/app/api/orchestrator/review-state/route');
  let mutation: Record<string, unknown> | null = null;
  return {
    priority: 90,
    routes: {
      'POST /api/orchestrator/merge': merge.POST, 'GET /api/worktrees/diff': worktree.GET,
      'GET /api/orchestrator/review-state': review.GET,
      'GET /api/orchestrator/inline-fixture-log': async () => Response.json({ mutation, requests: mutation ? ['POST /api/orchestrator/merge'] : [] }),
      ...Object.fromEntries(['next-review-approve', 'next-review-reject'].map(id => [
        `GET /api/lanes/${id}/diff`, request => diff.GET(request, { params: Promise.resolve({ id }) }),
      ])),
      ...Object.fromEntries((await import('../../../src/lib/lane/registry')).listLanes().map(item => [
        `GET /api/lanes/${item.id}`, request => lane.GET(request, { params: Promise.resolve({ id: item.id }) }),
      ])),
    },
    admit: ({ body }) => !body || !JSON.parse(body).packetId || JSON.parse(body).packetId === 'next-inline' ? 200 : 400,
    before: ({ route, body }) => {
      if (route !== merge.POST || !body) return;
      const target = JSON.parse(body) as { packetId?: string; expectedHeadSha?: string };
      mutation = { packetId: target.packetId === 'next-inline' ? 'next-inline' : null,
        expectedHeadSha: /^[a-f0-9]{40}$/i.test(target.expectedHeadSha ?? '') ? target.expectedHeadSha : null };
      if (process.env.O8_NEXT_MUTATION_ORACLE) writeFileSync(process.env.O8_NEXT_MUTATION_ORACLE, JSON.stringify(mutation));
    },
  };
}
