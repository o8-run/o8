import type { NextRequest } from 'next/server';
import { ownedByNativeTransport } from '@/lib/ws-server/native-owner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<Response> {
  return ownedByNativeTransport(
    async local => (await import('@/lib/threads/route')).GET(local as NextRequest),
    () => Response.json({ error: 'Thread owner unavailable.' }, { status: 503 }),
  )(request);
}
