export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { listBots } from '@/lib/bots/registry';

/** Always-on bots from every house, in rail order. */
export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  return NextResponse.json({ bots: listBots() });
}
