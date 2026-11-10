import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { correctWorkers, listCorrectableWorkers, listWorkerCorrections, readWorkerCorrection } from '@/lib/orchestrator/worker-corrections';
import { validateComposerQueueTarget } from '@/lib/orchestrator/composer-queue';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import { correctAuthorFromReview } from '@/lib/orchestrator/review-author-correction';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
function authorize(request: NextRequest) {
  return requirePanelAuth(request) ?? (resolveRequestPrincipal(request) !== 'operator'
    ? NextResponse.json({ error: 'Worker corrections require operator authority.' }, { status: 403 }) : null);
}
const failure = (error: unknown) => NextResponse.json({ error: error instanceof Error ? error.message : 'Correction failed.' }, { status: 409 });
export async function GET(request: NextRequest) {
  const denied = authorize(request); if (denied) return denied;
  try {
    const target = validateComposerQueueTarget({ repoPath: request.nextUrl.searchParams.get('repoPath'), threadId: request.nextUrl.searchParams.get('threadId') });
    return NextResponse.json({ workers: await listCorrectableWorkers(target), corrections: listWorkerCorrections(target) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error); }
}
export async function POST(request: NextRequest) {
  const denied = authorize(request); if (denied) return denied;
  let body: Record<string, unknown> | undefined;
  try {
    body = await request.json();
    if (body?.review !== undefined && (body.payload !== undefined || body.id !== undefined)) throw new Error('A saved review handoff cannot include replacement feedback or identity.');
    const receipt = body?.review !== undefined
      ? await correctAuthorFromReview(body as unknown as Parameters<typeof correctAuthorFromReview>[0])
      : await correctWorkers(body as unknown as Parameters<typeof correctWorkers>[0]);
    await publishRealtimeMutation({ mutation: { mutationId: receipt.id, source: 'desktop', action: 'worker-correction',
      status: 'completed', surfaceId: receipt.threadId, repoPath: receipt.repoPath, createdAt: new Date().toISOString() } }).catch(() => {});
    return NextResponse.json({ receipt });
  } catch (error) {
    // A durable intent precedes every worker side effect. Only confirmed absence
    // lets the client discard its identity after a rejected request.
    let notAdmitted = false;
    try { notAdmitted = typeof body?.id === 'string' && !readWorkerCorrection(body.id); } catch { /* Unknown stays retry-safe. */ }
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Correction failed.', notAdmitted }, { status: 409 });
  }
}
