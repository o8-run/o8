import { NextResponse, type NextRequest } from 'next/server';
import { listMobileOrchestratorThreads } from '@/lib/mobile/orchestrator-thread-history';
import { mobileThreadPullRequests } from '@/lib/mobile/pull-request-projection';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest) {
  try {
    const ids: string[] = [];
    for (const backend of [null, 'openclaw'] as const) {
      for (let offset = 0; ; offset += 500) {
        const threads = listMobileOrchestratorThreads({ backend, limit: 500, offset });
        ids.push(...threads.map(thread => thread.id));
        if (threads.length < 500) break;
      }
    }
    const rows = await mobileThreadPullRequests(ids);
    const pullRequests = rows.filter(pr => pr.state === 'open').map(({ changedFiles: _count, ...pr }) => pr);
    return NextResponse.json({ pullRequests, updatedAt: rows.map(pr => pr.updatedAt ?? '').sort().at(-1) ?? null },
      { headers: { 'Cache-Control': 'private, max-age=15' } });
  } catch {
    return NextResponse.json({ error: 'Pull requests unavailable.' }, { status: 503 });
  }
}
