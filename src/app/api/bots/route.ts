export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { getOperatorDefaults } from '@/lib/operator/defaults';
import { listConfiguredRosterBots } from '@/lib/bots/roster';

/** Only Settings-selected bots, with durable membership and adapter deduplication. */
export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  try {
    const { values } = await getOperatorDefaults();
    return NextResponse.json({ bots: listConfiguredRosterBots(values.botRailEnabledIds) });
  } catch {
    return NextResponse.json({ error: 'Bot roster is temporarily unavailable.' }, { status: 503 });
  }
}
