import type { NextRequest } from 'next/server';
import { ownedByNativeTransport } from '@/lib/ws-server/native-owner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, context: { params: Promise<{ taskId: string }> }) {
  return ownedByNativeTransport(
    async () => (await import('@/lib/tasks/report-route')).POST(request, context),
    () => Response.json({ error: 'Task owner unavailable' }, { status: 503 }),
  )(request);
}
