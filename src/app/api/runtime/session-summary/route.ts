import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { readOwnedSessionDisplay } from '@/lib/runtimes/shared/owned-session-index';
import { readWorkerRecovery } from '@/lib/agent-control/worker-recovery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  const sessionKey = request.nextUrl.searchParams.get('sessionKey')?.trim() ?? '';
  if (!sessionKey || sessionKey.length > 250) {
    return NextResponse.json({ error: 'A valid sessionKey is required.' }, { status: 400 });
  }
  try {
    const session = await readOwnedSessionDisplay(sessionKey);
    if (!session) return NextResponse.json({ error: 'Session not found.' }, { status: 404 });
    return NextResponse.json({ session, recovery: await readWorkerRecovery(sessionKey) }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch {
    return NextResponse.json({ error: 'Unable to read session summary.' }, { status: 500 });
  }
}
