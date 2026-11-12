import { ownedByNativeTransport } from '@/lib/ws-server/native-owner';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = ownedByNativeTransport(
  async request => (await import('@/lib/visualizations/publish-route')).POST(request),
  () => Response.json({ error: 'Visualization owner unavailable' }, { status: 503 }),
);

export { GET } from '@/lib/visualizations/read';
