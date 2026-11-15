import type { NextRequest } from 'next/server';
import { ownedByNativeTransport } from '@/lib/ws-server/native-owner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const unavailable = () => Response.json({ error: 'Native handler unavailable.' }, { status: 503 });
type Context = { params: Promise<{ taskId: string }> };

export async function GET(request: NextRequest, context: Context): Promise<Response> {
  return ownedByNativeTransport(async local => (await import('@/lib/tasks/detail-route')).GET(local as NextRequest, context), unavailable)(request);
}
