import type { SurfaceContext, SurfaceRoutes } from '../surface-routes';

// Settings › Providers › "+": the production Local ACP connection route on the
// disposable data dir, plus a synthetic ACP registry. The fixture never reaches
// the registry CDN or downloads a package; prepare returns a fixed command.
const FINGERPRINT = 'a'.repeat(64);
const catalog = {
  observedAt: '2026-11-01T00:00:00.000Z',
  stale: false,
  agents: [
    { id: 'fixture-agent', name: 'Fixture Agent', version: '1.2.3', description: 'A synthetic ACP agent for the native fixture.',
      website: 'https://example.com/fixture-agent', npm: { package: 'fixture-agent@1.2.3', args: ['--acp'] }, fingerprint: FINGERPRINT },
    { id: 'guide-only', name: 'Guide Only', version: '0.1.0', description: 'Installed by its own setup guide.',
      website: 'https://example.com/guide-only', fingerprint: 'b'.repeat(64) },
  ],
};

export async function prepare(_context: SurfaceContext): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--settings')) return {};
  const connection = () => import('../../../src/app/api/runtime/acp-connection/route');
  return {
    priority: 1,
    routes: {
      'GET /api/runtime/acp-registry': async () => Response.json(catalog),
      'POST /api/runtime/acp-registry/prepare': async request => {
        const body = await request.json() as { id?: string; fingerprint?: string };
        if (body.id !== 'fixture-agent' || body.fingerprint !== FINGERPRINT) return Response.json({ error: 'Select an agent from the registry.' }, { status: 400 });
        return Response.json({ connection: { name: 'Fixture Agent', command: 'fixture-agent', args: ['--acp'], useOpenRouter: false } });
      },
      'GET /api/runtime/acp-connection': async request => (await connection()).GET(request),
      'POST /api/runtime/acp-connection': async request => (await connection()).POST(request),
    },
    admit: () => 200,
  };
}
