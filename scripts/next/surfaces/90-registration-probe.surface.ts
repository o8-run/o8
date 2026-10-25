/** Test-only peer for the native fake surface's module-owned request. */
import type { SurfaceRoutes } from '../surface-routes';

export default async function register(): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--shell')) return {};
  let requests = 0;
  return {
    routes: {
      'POST /api/panel/registration-probe': async request => Response.json({
        surface: request.nextUrl.searchParams.get('surface'),
        payload: (await request.json()).probe,
        desktopSession: request.headers.has('x-clerk-session-token'),
        request: ++requests,
      }),
    },
    admit: () => 200,
  };
}
