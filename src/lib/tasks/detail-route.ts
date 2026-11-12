import { NextResponse, type NextRequest } from 'next/server';

import { resolveRequestPrincipalContext, workerPacketRefusal } from '@/lib/auth/principal';
import { requirePanelAuth } from '@/lib/panel/auth';
import { getTaskPoolTask } from '@/lib/tasks/pool';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ taskId: string }> },
) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const { taskId } = await context.params;
  if (!taskId?.trim()) {
    return NextResponse.json({ error: 'taskId is required' }, { status: 400 });
  }

  const projectId = request.nextUrl.searchParams.get('projectId')?.trim() || null;
  const repoPath = request.nextUrl.searchParams.get('repoPath')?.trim() || null;

  try {
    const task = await getTaskPoolTask(taskId, { projectId, repoPath });
    const refusal = workerPacketRefusal(resolveRequestPrincipalContext(request), task?.packetId);
    if (refusal) {
      return NextResponse.json({ ok: false, error: refusal }, {
        status: 403, headers: { 'Cache-Control': 'no-store, max-age=0' },
      });
    }
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }
    return NextResponse.json(
      { schema: 'o8/task.detail/v1', task },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to read task.' },
      { status: 500 },
    );
  }
}
