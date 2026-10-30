/**
 * Settlement adaptation from T3 Code (https://github.com/pingdotgg/t3code),
 * apps/server/src/orchestration-v2/Orchestrator.ts, commit
 * f58fad04162165653bf06f0c987bbfb0074a8a4b.
 * Copyright (c) 2026 T3 Tools Inc.; MIT; see licenses/t3code-MIT.txt.
 * Adapted for o8: existing operator routes, persistence and native listings.
 */
import { NextResponse, NextRequest } from 'next/server';
import { inboxPackets, projectRuntimeInbox } from '@/lib/inbox/subjects';
import { getRuntimeInventorySnapshot } from '@/lib/runtime/inventory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const fresh = req.nextUrl.searchParams.get('fresh') === '1';
    const snapshot = await getRuntimeInventorySnapshot({ fresh });

    const packets = inboxPackets();
    return NextResponse.json({ ...snapshot, agents: await Promise.all(snapshot.agents.map(agent => projectRuntimeInbox(agent, packets))) }, {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
      },
    });
  } catch (error) {
    console.error('[runtime/inventory] Failed to load snapshot', error);
    return NextResponse.json(
      { error: 'Failed to load runtime inventory.' },
      {
        status: 500,
        headers: {
          'Cache-Control': 'no-store, max-age=0',
        },
      },
    );
  }
}
