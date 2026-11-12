import { ownedByNativeTransport } from '@/lib/ws-server/native-owner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const unavailable = () => Response.json({ error: 'Native handler unavailable.' }, { status: 503 });

export async function GET(request: Request): Promise<Response> {
  return ownedByNativeTransport(async local => (await import('@/lib/runtimes/managed-runs/http-route')).GET(local), unavailable)(request);
}

export async function POST(request: Request): Promise<Response> {
  return ownedByNativeTransport(async local => (await import('@/lib/runtimes/managed-runs/http-route')).POST(local), unavailable)(request);
}
