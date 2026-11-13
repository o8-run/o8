import { NextRequest, NextResponse } from 'next/server';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { adoptExternalReview } from '@/lib/tasks/external-review-adopt';
import { ExternalReviewError } from '@/lib/tasks/external-review-error';
export const runtime = 'nodejs';
export async function POST(request: NextRequest) {
  if (resolveRequestPrincipal(request) !== 'operator') return NextResponse.json({ error: 'Operator token required.' }, { status: 403 });
  let body;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Invalid adoption JSON.' }, { status: 400 }); }
  if (!body || typeof body.repoPath !== 'string' || !['number', 'string'].includes(typeof body.pullRequest)
    || (body.intendedOutcome !== undefined && typeof body.intendedOutcome !== 'string')) return NextResponse.json({ error: 'Invalid adoption input.' }, { status: 400 });
  try {
    return NextResponse.json(await adoptExternalReview(body));
  } catch (error) {
    return NextResponse.json({ error: error instanceof ExternalReviewError ? error.message : 'PR adoption conflicts with the current task state. Re-adopt the PR.' },
      { status: error instanceof ExternalReviewError ? error.status : 409 });
  }
}
