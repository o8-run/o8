import { NextRequest, NextResponse } from 'next/server';

import { findLatestLaneByPacket, getLane } from '@/lib/lane/registry';
import { requirePanelAuth } from '@/lib/panel/auth';
import { ArchitectureDeltaInputError } from '@/lib/review/architecture-delta';

import { ArchitectureReviewChangedError, buildArchitectureReviewTarget, buildLaneArchitectureReviewTarget } from '@/lib/review/architecture-review-target';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const laneId = request.nextUrl.searchParams.get('lane')?.trim() || null;
  const workspace = request.nextUrl.searchParams.get('workspace')?.trim() || null;
  if (!laneId && !workspace) {
    return NextResponse.json({ ok: false, error: 'A review lane or workspace is required.' }, { status: 400 });
  }

  try {
    if (laneId) {
      const lane = getLane(laneId) ?? findLatestLaneByPacket(laneId);
      if (!lane) {
        return NextResponse.json({ ok: false, error: 'No review lane found for that id or packet.' }, { status: 404 });
      }
      const { result } = await buildLaneArchitectureReviewTarget(lane, request.nextUrl.searchParams);
      return NextResponse.json(result, {
        headers: { 'Cache-Control': 'no-store, max-age=0' },
      });
    }

    if (!workspace) {
      return NextResponse.json({ ok: false, error: 'A review workspace is required.' }, { status: 400 });
    }
    return NextResponse.json(await buildArchitectureReviewTarget(workspace, request.nextUrl.searchParams), {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to build the architecture delta.';
    const status = error instanceof ArchitectureReviewChangedError ? 409 : error instanceof ArchitectureDeltaInputError ? 400 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
