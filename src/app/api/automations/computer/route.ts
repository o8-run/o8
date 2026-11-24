import { NextResponse, type NextRequest } from 'next/server';

import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { readComputerJobs } from '@/lib/automations/computer-jobs';
import { requirePanelAuth } from '@/lib/panel/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Everything scheduled on this Mac. Read when someone asks (the Scheduled
 * screen opening or refreshing), never on a timer. Only the operator: a
 * worker has no use for the machine's job list.
 */
export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  if (resolveRequestPrincipalContext(request).role !== 'operator') {
    return NextResponse.json({ ok: false, error: 'operator_required' }, { status: 403 });
  }
  const report = await readComputerJobs();
  return NextResponse.json({ ok: true, ...report }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
}
