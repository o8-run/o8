import { NextResponse } from 'next/server';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { mobileModelCatalog } from '@/lib/mobile/model-catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const principal = resolveRequestPrincipal(request);
  if (principal === 'worker') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  if (principal !== 'operator' && principal !== 'device') {
    return NextResponse.json({ error: 'Operator or enrolled device required' }, { status: 401 });
  }
  return NextResponse.json(mobileModelCatalog(), { headers: { 'Cache-Control': 'no-store' } });
}
