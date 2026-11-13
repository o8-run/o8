import { NextRequest, NextResponse } from 'next/server';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { adoptExternalReview } from '@/lib/tasks/external-review-adopt';
export const runtime = 'nodejs';
export async function POST(request: NextRequest) {
  if (resolveRequestPrincipal(request) !== 'operator') return NextResponse.json({ error: 'Operator token required.' }, { status: 403 });
  try {
    const body = await request.json();
    if (typeof body?.repoPath !== 'string' || !['number', 'string'].includes(typeof body.pullRequest)
      || (body.intendedOutcome !== undefined && typeof body.intendedOutcome !== 'string')) return NextResponse.json({ error: 'Invalid adoption input.' }, { status: 400 });
    return NextResponse.json(await adoptExternalReview(body));
  } catch { return NextResponse.json({ error: 'PR adoption unavailable. Check the registered repository and PR identity.' }, { status: 409 }); }
}
