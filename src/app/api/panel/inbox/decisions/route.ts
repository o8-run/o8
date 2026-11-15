import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { readInboxDecisions } from '@/lib/inbox/decisions-read';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store, max-age=0' };
export async function GET(req: NextRequest) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;
  if (resolveRequestPrincipalContext(req).role !== 'operator') {
    return NextResponse.json({ ok: false, error: { code: 'operator_required', message: 'Inbox decisions require an operator credential.' } }, { status: 403, headers });
  }
  const query = req.nextUrl.searchParams;
  const state = query.get('state') ?? 'unresolved';
  const limit = Number(query.get('limit') ?? '25');
  if (!['unresolved', 'history', 'all'].includes(state) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    return NextResponse.json({ ok: false, error: { code: 'invalid_query', message: 'Use state unresolved, history or all, and limit 1 through 100.' } }, { status: 400, headers });
  }
  try {
    return NextResponse.json(await readInboxDecisions({ state: state as 'unresolved' | 'history' | 'all', limit,
      projectId: query.get('projectId') ?? undefined, cursor: query.get('cursor') ?? undefined }), { headers });
  } catch {
    return NextResponse.json({ ok: false, error: { code: 'decisions_unavailable', message: 'Task state could not be read. Retry the read before deciding.' } }, { status: 503, headers });
  }
}
