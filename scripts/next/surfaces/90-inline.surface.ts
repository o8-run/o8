import { writeFileSync } from 'node:fs';
import type { SurfaceContext, SurfaceRoutes } from '../surface-routes';
export default async function register({ repo }: SurfaceContext): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--inline') || process.argv.includes('--settings')) return {};
  const policyHeld = process.argv.includes('--inline-policy-held');
  const held = process.argv.includes('--inline-held') || policyHeld
    ? await (await import('../inline-held-fixture')).seedInlineHeldFixture(repo, policyHeld) : null;
  if (!held) await (await import('../inline-fixture')).seedInlineFixture(repo, process.argv.includes('--inline-committed'));
  if (process.argv.includes('--inline-switch')) await (await import('../inline-fixture')).seedInlineSwitchFixture(repo);
  const merge = await import('../../../src/app/api/orchestrator/merge/route');
  const lane = await import('../../../src/app/api/lanes/[id]/route');
  const diff = await import('../../../src/app/api/lanes/[id]/diff/route');
  const worktree = await import('../../../src/app/api/worktrees/diff/route');
  const review = await import('../../../src/app/api/orchestrator/review-state/route');
  const approvals = await import('../../../src/app/api/panel/approvals/route');
  const preview = await import('../../../src/app/api/orchestrator/merge-preview/route');
  let mutation: Record<string, unknown> | null = null;
  let confirmation: string | null = null;
  let confirmationLost = false;
  let evidenceUnavailable = false;
  const requests: string[] = [];
  const control = async (request: import('next/server').NextRequest) => {
    try { await held!.change((await request.json()).change); return Response.json({ ok: true }); }
    catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Fixture mutation failed' }, { status: 500 }); }
  };
  return {
    priority: 90,
    routes: {
      'POST /api/orchestrator/merge': merge.POST, 'GET /api/worktrees/diff': worktree.GET,
      'GET /api/orchestrator/review-state': review.GET,
      'GET /api/panel/approvals': approvals.GET, 'POST /api/panel/approvals': approvals.POST,
      'GET /api/orchestrator/merge-preview': preview.GET,
      ...(held ? { 'POST /api/orchestrator/inline-fixture-control': control } : {}),
      'GET /api/orchestrator/inline-fixture-log': async () => Response.json({ mutation, confirmation, requests, held: held?.snapshot() }),
      ...Object.fromEntries(['next-review-approve', 'next-review-reject'].map(id => [
        `GET /api/lanes/${id}/diff`, request => diff.GET(request, { params: Promise.resolve({ id }) }),
      ])),
      ...Object.fromEntries((await import('../../../src/lib/lane/registry')).listLanes().map(item => [
        `GET /api/lanes/${item.id}`, request => lane.GET(request, { params: Promise.resolve({ id: item.id }) }),
      ])),
    },
    admit: ({ route, body }) => {
      if (!body) return 200;
      const target = JSON.parse(body);
      if (route === control) return held && ['dirty', 'head', 'review', 'contract', 'runtime', 'stop', 'restriction', 'repair-dirty', 'race-review', 'governance'].includes(target.change) ? 200 : 400;
      if (route === approvals.POST) return held?.snapshot().approval?.id === target.id && target.action === 'approve' ? 200 : 400;
      return !target.packetId || ['next-inline', ...(process.argv.includes('--inline-switch') ? ['next-inline-b'] : [])].includes(target.packetId) ? 200 : 400;
    },
    before: ({ route, body }) => {
      if (route === preview.GET) requests.push('GET /api/orchestrator/merge-preview');
      if (route === approvals.GET) requests.push('GET /api/panel/approvals');
      if (route === approvals.POST) { requests.push('POST /api/panel/approvals'); confirmation = JSON.parse(body).id; held?.beforeConfirm(); }
      if (route !== merge.POST || !body) return;
      requests.push('POST /api/orchestrator/merge');
      const target = JSON.parse(body) as { packetId?: string; expectedHeadSha?: string };
      mutation = { packetId: target.packetId === 'next-inline' ? 'next-inline' : null,
        expectedHeadSha: /^[a-f0-9]{40}$/i.test(target.expectedHeadSha ?? '') ? target.expectedHeadSha : null };
      if (process.env.O8_NEXT_MUTATION_ORACLE) writeFileSync(process.env.O8_NEXT_MUTATION_ORACLE, JSON.stringify(mutation));
    },
    after: ({ route }, response) => {
      if (process.argv.includes('--inline-confirm-drop-first') && route === approvals.POST && response.ok && !confirmationLost) {
        confirmationLost = true; return true;
      }
      return false;
    },
    run: async (route, request) => {
      if (process.argv.includes('--inline-evidence-fail-first') && route === review.GET
        && request.nextUrl.searchParams.get('spoken') === '1' && !evidenceUnavailable) {
        evidenceUnavailable = true; return Response.json({ error: 'Fixture evidence temporarily unavailable' }, { status: 503 });
      }
      return route(request);
    },
  };
}
