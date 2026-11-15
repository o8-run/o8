import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { readProjectThreads, ThreadReadInputError } from '@/lib/threads/project';
import type { ThreadGrouping } from '@/lib/threads/grouping';
import type { ThreadState } from '@/lib/threads/types';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request); if (denied) return denied;
  const params = request.nextUrl.searchParams;
  try {
    const result = await readProjectThreads({ repoPaths: params.getAll('repoPath'), projectId: params.get('projectId'),
      state: (params.get('state') || undefined) as ThreadState | undefined, taskId: params.get('taskId') || undefined,
      model: (params.get('model') || undefined) as ThreadGrouping | undefined, revision: params.get('revision') || undefined, offset: Number(params.get('offset') ?? 0), limit: Number(params.get('limit') ?? 100) });
    if (params.has('taskId') && !result.task) return NextResponse.json({ error: 'Thread unavailable in this scope.' }, { status: 404 });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof ThreadReadInputError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.warn('[project-threads] read failed', error);
    return NextResponse.json({ error: 'Thread inventory could not be read. Refresh to try again.' }, { status: 500 });
  }
}
