/** Shell target picker uses the production terminal inventory and owned PTYs. */
import type { SurfaceRoutes } from '../surface-routes';

export default async function register(): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--terminal')) return {};
  const { GET } = await import('../../../src/app/api/mobile/terminal-sessions/route');
  return { routes: { 'GET /api/mobile/terminal-sessions': GET } };
}
