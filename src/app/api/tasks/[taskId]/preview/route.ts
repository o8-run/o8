import type { NextRequest } from 'next/server';
import { coordinatorOrigin } from '@/lib/cloud/coordinator-origin';
import { ownedByNativeTransport } from '@/lib/ws-server/native-owner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ taskId: string }> };
const unavailable = () => Response.json({ error: 'Remote preview is unavailable.' }, { status: 503 });

// Next checks the coordinator page and forwards its origin, which may frame the preview.
const pageOrigin = (request: Request): string | Response => coordinatorOrigin(request as NextRequest)
  ?? Response.json({ error: 'Open this preview in the coordinator desktop app.' }, { status: 409, headers: { 'Cache-Control': 'no-store' } });

// Defer loading the stateful preview module until local handling is selected.
export async function POST(request: NextRequest, context: Context): Promise<Response> {
  return ownedByNativeTransport(async local => (await import('@/lib/cloud/task-preview-route')).POST(local as NextRequest, context), unavailable, { pageOrigin })(request);
}

export async function DELETE(request: NextRequest, context: Context): Promise<Response> {
  return ownedByNativeTransport(async local => (await import('@/lib/cloud/task-preview-route')).DELETE(local as NextRequest, context), unavailable)(request);
}
