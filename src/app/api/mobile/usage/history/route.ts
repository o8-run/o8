import { NextResponse, type NextRequest } from 'next/server';
import { getUsageHistory, parseUsageRange } from '@/lib/mobile/usage-history';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };

export async function GET(request: NextRequest) {
  const range = parseUsageRange(request.nextUrl.searchParams.get('range'));
  if (!range) return NextResponse.json({ error: 'Invalid range. Use 24h, 7d, 30d or 90d.' }, { status: 400, headers });
  try {
    return NextResponse.json(getUsageHistory(range), { headers });
  } catch {
    return NextResponse.json({ error: 'Usage history unavailable.' }, { status: 500, headers });
  }
}
