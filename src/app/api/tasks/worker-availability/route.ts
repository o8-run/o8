import { NextResponse, type NextRequest } from 'next/server';
import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { requirePanelAuth } from '@/lib/panel/auth';
import { getRemoteWorkerAvailability } from '@/lib/cloud/worker-readiness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  if (resolveRequestPrincipalContext(request).role === 'worker') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  try {
    return NextResponse.json(getRemoteWorkerAvailability(), { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Unable to read remote worker availability.' }, { status: 500 });
  }
}
