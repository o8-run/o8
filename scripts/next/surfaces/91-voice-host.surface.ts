/** Test-only voice host peer: answers the native window's voice-host controls
 * (start, stop, accepted) and lists them back, so the shell test can read
 * what it sent. The production route forwards to the hidden voice window. */
import type { SurfaceRoutes } from '../surface-routes';

export default async function register(): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--voice-host')) return {};
  const controls: unknown[] = [];
  return {
    routes: {
      'POST /api/next/voice-host': async request => {
        controls.push(await request.json());
        return Response.json({ ok: true });
      },
      'GET /api/next/voice-host': async () => Response.json({ ready: true, controls }),
    },
    admit: () => 200,
  };
}
