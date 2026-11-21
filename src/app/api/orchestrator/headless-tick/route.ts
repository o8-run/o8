import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { runHeadlessSprintTick } from '@/lib/orchestrator/headless-loop';

import { drainQueuedPacketSteers } from '@/lib/orchestrator/operator-mission-service/steer-queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body: unknown = await request.json().catch(() => ({}));
  if (body && typeof body === 'object' && 'releasePacketIds' in body) {
    return NextResponse.json({
      ok: false,
      error: 'release_requires_merge_evidence',
      message: 'A scheduler wake cannot release packets. Use the reviewed merge path.',
    }, { status: 400, headers: { 'Cache-Control': 'no-store, max-age=0' } });
  }

  try {
    await drainQueuedPacketSteers();
    const result = await runHeadlessSprintTick();
    return NextResponse.json({
      ok: true,
      pending: result.pending,
      launched: result.launched,
      active: result.active,
      currentWave: result.currentWave,
      totalWaves: result.totalWaves,
    }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unable to run headless tick',
    }, {
      status: 500,
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  }
}
