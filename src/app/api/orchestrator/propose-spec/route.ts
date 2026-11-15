import type { NextRequest } from 'next/server';
import { ownedByNativeTransport } from '@/lib/ws-server/native-owner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<Response> {
  return ownedByNativeTransport(
    async local => (await import('@/lib/orchestrator/http/propose-spec')).POST(local as NextRequest),
    () => Response.json({ error: 'Orchestrator owner unavailable.' }, { status: 503 }),
  )(request);
}
