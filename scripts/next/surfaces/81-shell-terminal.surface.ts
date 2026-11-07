/** Shell target picker uses the production terminal inventory and owned PTYs;
 * Terminal View marks and imports the CLI's turns through the production route. */
import type { SurfaceRoutes } from '../surface-routes';

export default async function register(): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--terminal')) return {};
  const { GET } = await import('../../../src/app/api/mobile/terminal-sessions/route');
  const turns = await import('../../../src/app/api/v2/chat-history/terminal-turns/route');
  return {
    routes: { 'GET /api/mobile/terminal-sessions': GET, 'POST /api/v2/chat-history/terminal-turns': turns.POST },
    // Only the Terminal View mark and import carry a body.
    admit: ({ url, body }) => !body || url.pathname === '/api/v2/chat-history/terminal-turns' ? 200 : 400,
  };
}
