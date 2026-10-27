import { viewerJson } from '@/lib/viewers/response';
import { NextRequest } from 'next/server';
import { getCommandCenterSnapshotWithOptions } from '@/lib/command-center/snapshot';
import { performance } from 'node:perf_hooks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const startedAt = performance.now();
    const fresh = req.nextUrl.searchParams.get('fresh') === '1';
    const snapshot = await getCommandCenterSnapshotWithOptions({ fresh });
    return viewerJson(snapshot, {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
        'Server-Timing': `total;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)}`,
      },
    });
  } catch (error) {
    return viewerJson(
      {
        error: error instanceof Error ? error.message : 'Unable to load command center snapshot',
      },
      { status: 500 },
    );
  }
}
