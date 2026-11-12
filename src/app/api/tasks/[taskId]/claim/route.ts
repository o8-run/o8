import { NextRequest } from 'next/server';
import { ownedByNativeTransport } from '@/lib/ws-server/native-owner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Lane clients and dispatch admission live in the WS owner in native mode.
export async function POST(request: NextRequest, context: { params: Promise<{ taskId: string }> }) {
  return ownedByNativeTransport(
    async forwarded => (await import('@/lib/tasks/http/claim')).POST(new NextRequest(forwarded), context),
    () => Response.json({ error: 'Task service unavailable' }, { status: 503 }),
  )(request);
}
