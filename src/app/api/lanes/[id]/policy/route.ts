import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { readEffectivePolicy } from '@/lib/lane/effective-policy-read';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;
  if (resolveRequestPrincipalContext(req).role !== 'operator') {
    return NextResponse.json({ ok: false, error: { code: 'operator_required', message: 'Policy reads require an operator credential.' } }, { status: 403 });
  }
  const { id } = await params;
  const policy = await readEffectivePolicy(id);
  return NextResponse.json(policy ?? { ok: false, error: { code: 'not_found', message: 'Work revision not found.' } }, {
    status: policy ? 200 : 404, headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}
