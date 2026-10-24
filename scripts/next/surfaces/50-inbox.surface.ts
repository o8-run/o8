import type { SurfaceContext, SurfaceRoutes } from '../surface-routes';
export default async function register({ dataDir, repo, fixtureToken }: SurfaceContext): Promise<SurfaceRoutes> {
  const inbox = process.argv.includes('--inbox');
  const approvals = inbox && !process.argv.includes('--inbox-empty') ? await (await import('../inbox-fixture')).seedInboxFixture(repo, dataDir) : [];
  const plan = process.argv.includes('--inbox-plan') && process.env.O8_NEXT_INBOX_PLAN_FIXTURE
    ? await (await import('../inbox-plan-fixture')).seedInboxPlanFixture(repo, dataDir, fixtureToken, process.env.O8_NEXT_INBOX_PLAN_FIXTURE) : null;
  if (plan) approvals.push(...plan.approvals);
  const proxy = plan ? await import('../../../src/app/api/v2/proxy/llm/route') : null;
  const inboxRoutes = inbox ? await import('../../../src/app/api/panel/supervisor-inbox/route') : null;
  const approvalRoutes = inbox ? await import('../../../src/app/api/panel/approvals/route') : null;
  if (inbox && process.env.O8_NEXT_INBOX_ORACLE) await (await import('../inbox-fixture')).writeInboxOracle(process.env.O8_NEXT_INBOX_ORACLE);
  return {
    routes: {
      ...(inboxRoutes && approvalRoutes ? {
        'GET /api/panel/supervisor-inbox': inboxRoutes.GET, 'GET /api/panel/approvals': approvalRoutes.GET,
        'POST /api/panel/approvals': approvalRoutes.POST,
      } : {}),
      ...(proxy ? { 'POST /api/v2/proxy/llm': proxy.POST } : {}),
    },
    admit: ({ route, body, headers }) => {
      if (!body) return 200;
      const target = JSON.parse(body);
      const owned = route === approvalRoutes?.POST ? approvals.some(approval => approval.id === target.id) && ['approve', 'reject'].includes(target.action)
        : route === proxy?.POST && ['inbox-plan-native', 'inbox-plan-desktop'].includes(String(headers['x-tab-id'])) && target.repoPath === repo;
      return owned ? 200 : 400;
    },
    before: ({ route, body }) => {
      if (route === approvalRoutes?.POST && JSON.parse(body).action === 'approve'
        && plan?.approvals.some(approval => approval.id === JSON.parse(body).id)) plan.beforeDecision();
    },
    close: () => plan?.close(),
  };
}
