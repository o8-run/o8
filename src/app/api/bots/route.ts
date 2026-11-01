export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { listRosterBots } from '@/lib/bots/roster';

/** Always-on bots from every house, in rail order. */
export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  try {
    return NextResponse.json({ bots: listRosterBots() });
  } catch {
    return NextResponse.json({ error: 'Bot roster is temporarily unavailable.' }, { status: 503 });
  }
}
