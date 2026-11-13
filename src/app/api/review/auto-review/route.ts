import { NextRequest, NextResponse } from 'next/server';
import { getLane } from '@/lib/lane/registry';
import { requirePanelAuth } from '@/lib/panel/auth';
import { triggerAutoReview } from '@/lib/lane/auto-review';
import { ensureReviewQueueDrainStarted } from '@/lib/lane/review-drain-bootstrap';
import { CorrectionReviewBlocked } from '@/lib/orchestrator/correction-review';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = await request.json().catch(() => ({})) as { action?: unknown; laneId?: unknown };
  const action = typeof body.action === 'string' ? body.action : '';

  if (action === 'bootstrap') {
    const { ensureNextServerInitialized } = await import('@/lib/startup/next');
    await ensureNextServerInitialized();
    return NextResponse.json({ ok: true }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  }

  if (action === 'start') {
    ensureReviewQueueDrainStarted();
    return NextResponse.json({ ok: true }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  }

  if (action === 'enqueue') {
    const laneId = typeof body.laneId === 'string' ? body.laneId.trim() : '';
    if (!laneId) {
      return NextResponse.json({ ok: false, error: 'laneId is required' }, { status: 400 });
    }

    const lane = getLane(laneId);
    if (!lane) {
      return NextResponse.json({ ok: false, error: 'Lane not found' }, { status: 404 });
    }

    try { triggerAutoReview(lane); }
    catch (error) {
      if (!(error instanceof CorrectionReviewBlocked)) throw error;
      return NextResponse.json({ ok: false, error: error.message }, { status: 409 });
    }
    return NextResponse.json({ ok: true }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  }

  return NextResponse.json({ ok: false, error: 'Unknown action' }, { status: 400 });
}
