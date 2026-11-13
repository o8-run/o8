import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { handleManagedMessage, parseManagedMessage } from '@/lib/symon/managed-messages-inbound';

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  const inbound = parseManagedMessage(await request.json().catch(() => null) as Record<string, unknown> | null);
  if (!inbound) {
    return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 });
  }
  return handleManagedMessage(inbound);
}
