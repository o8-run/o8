import { NextResponse, type NextRequest } from 'next/server';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { readIntegrationQueue, prepareIntegrationQueue } from '@/lib/integration-queue/service';
import { IntegrationQueueError } from '@/lib/integration-queue/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };
async function handle(request: NextRequest, context: Context, prepare: boolean) {
  if (resolveRequestPrincipal(request) !== 'operator') return NextResponse.json({ error: 'Operator token required.' }, { status: 403 });
  try {
    const { id } = await context.params;
    let body: unknown;
    if (prepare) {
      try { body = await request.json(); }
      catch { throw new IntegrationQueueError('Invalid integration queue JSON.', 400); }
    }
    const result = prepare ? await prepareIntegrationQueue(id, body) : await readIntegrationQueue(id);
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof IntegrationQueueError ? error.message : 'Integration state is unreadable. An operator must inspect the queue.' },
      { status: error instanceof IntegrationQueueError ? error.status : 503 });
  }
}
export async function GET(request: NextRequest, context: Context) { return handle(request, context, false); }
export async function POST(request: NextRequest, context: Context) { return handle(request, context, true); }
