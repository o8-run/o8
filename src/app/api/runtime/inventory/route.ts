import { createInboxReadContext } from '@/lib/inbox/store';
import { NextResponse, NextRequest } from 'next/server';
import { inboxPackets, projectRuntimeInbox, readInboxLanes } from '@/lib/inbox/subjects';
import { getRuntimeInventorySnapshot } from '@/lib/runtime/inventory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const fresh = req.nextUrl.searchParams.get('fresh') === '1';
    const snapshot = await getRuntimeInventorySnapshot({ fresh });

    const lanes = readInboxLanes();
    // A recorded standalone lane cannot inherit a packet through session reuse.
    const needsPackets = snapshot.agents.some(agent => !lanes.has(agent.sessionKey) || lanes.get(agent.sessionKey)?.packetId);
    const packets = needsPackets ? inboxPackets() : [];
    const context = createInboxReadContext();
    const projected = snapshot.agents.map(agent => projectRuntimeInbox(agent, packets, lanes, context));
    const agents = projected.some(agent => agent instanceof Promise) ? await Promise.all(projected) : projected;
    return NextResponse.json({ ...snapshot, agents }, {
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
