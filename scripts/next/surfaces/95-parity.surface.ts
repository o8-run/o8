/** Desktop reads for the disposable parity host; all handlers remain production code. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Route, SurfaceContext, SurfaceRoutes } from '../surface-routes';

export default async function register({ repo, dataDir, seeds, transcriptFixtures }: SurfaceContext): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--parity')) return {};
  const { addRepo } = await import('../../../src/lib/repos/registry');
  await addRepo(repo);
  const defaults = await import('../../../src/app/api/panel/operator-defaults/route');
  await defaults.POST(new Request('http://127.0.0.1/api/panel/operator-defaults', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ crashReportsEnabled: false, productTelemetryEnabled: false, telemetryConsentAnswered: true }),
  }));
  if (!process.argv.includes('--onboarding')) {
    writeFileSync(join(dataDir, 'setup.json'), JSON.stringify({ setupComplete: true, skippedSteps: [] }));
  }
  const reads = [
    'panel/repos', 'panel/projects', 'panel/workspaces', 'panel/operator-defaults',
    'setup/config', 'v2/keys', 'tasks', 'v2/chat-history/list', 'panel/terminal-state', 'panel/branches', 'panel/entitlement',
  ];
  const routes: Record<string, Route> = {};
  for (const path of reads) {
    // Explicit inventory, never derive an import path from an HTTP request.
    const routeModule = await import(`../../../src/app/api/${path}/route`);
    if (typeof routeModule.GET === 'function') routes[`GET /api/${path}`] = routeModule.GET;
    if (path === 'panel/terminal-state') routes[`POST /api/${path}`] = routeModule.POST;
  }
  const history = transcriptFixtures ? seeds.find(seed => seed.id === 'thoughts-rich') : undefined;
  if (history) {
    await routes['POST /api/panel/terminal-state'](new Request('http://127.0.0.1/api/panel/terminal-state?scope=tile-root', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ activeTabId: history.id, savedAt: '2026-10-01T00:00:00.000Z', tabs: [{
        id: history.id, label: history.title, kind: 'orchestrator', repoName: 'fixture-repo', repoPath: repo,
      }] }),
    }) as Parameters<Route>[0]);
  }
  return { priority: 99, routes, receipt: { parityWorkspace: repo }, admit: () => 200 };
}
