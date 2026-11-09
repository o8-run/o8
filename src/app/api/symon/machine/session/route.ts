export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse, type NextRequest } from 'next/server';
import { endSymonMachineSession } from '@/lib/mobile/symon-machine-session';

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as { sessionId?: unknown } | null;
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
  const { status, body: result } = await endSymonMachineSession(sessionId);
  return NextResponse.json(result, { status });
}
