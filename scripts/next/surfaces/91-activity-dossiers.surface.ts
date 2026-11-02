import type { SurfaceContext, SurfaceRoutes } from '../surface-routes';
export default async function register(context: SurfaceContext): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--activity')) return {};
  // Other Activity cases own the feed/packet data, with no optional decisions.
  if (!process.argv.includes('--activity-dossiers')) return { priority: -1, admit: () => 200, routes: {
    'GET /api/panel/problem-dossiers': async () => Response.json({ dossiers: [] }),
    'GET /api/cortex/proposals': async () => Response.json({ ok: true, proposals: [] }),
    'GET /api/cortex/cross-repo-proposals': async () => Response.json({ ok: true, proposals: [] }),
  } };
  return (await import('../../../native/o8-next/src/surfaces/activity/fixture')).install(context);
}
