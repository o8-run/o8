export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { getOperatorDefaults } from '@/lib/operator/defaults';
import { listBots } from '@/lib/bots/registry';

/** Always-on bots from every house, in rail order. */
export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  const { values } = await getOperatorDefaults();
  const enabled = new Set(values.botRailEnabledIds);
  return NextResponse.json({ bots: listBots().filter(bot => enabled.has(bot.id)) });
}
