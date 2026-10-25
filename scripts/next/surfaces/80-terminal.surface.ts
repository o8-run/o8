import type { SurfaceRoutes } from '../surface-routes';
export default async function register(): Promise<SurfaceRoutes> {
  return { early: true, routes: process.argv.includes('--terminal') ? { 'GET /api/panel/status': async () => Response.json({}) } : {} };
}
