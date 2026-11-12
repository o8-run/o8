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

  const principal = resolveRequestPrincipalContext(request);
  const unbound = workerPacketRefusal(principal, principal.role === 'worker' ? principal.packetId : null);
  if (unbound) {
    return NextResponse.json({ ok: false, error: unbound }, {
      status: 403, headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  }
  const { taskId } = await context.params;
  if (!taskId?.trim()) {
    return NextResponse.json({ error: 'taskId is required' }, { status: 400 });
  }

  const projectId = request.nextUrl.searchParams.get('projectId')?.trim() || null;
  const repoPath = request.nextUrl.searchParams.get('repoPath')?.trim() || null;

  try {
    // A worker's lookup only sees its own packet, so another packet's id and an unknown id
    // get the same refusal below, and no other packet's brief is built.
    const task = await getTaskPoolTask(taskId, {
      projectId, repoPath,
      packetId: principal.role === 'worker' ? principal.packetId : undefined,
    });
    const refusal = workerPacketRefusal(principal, task?.packetId);
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
