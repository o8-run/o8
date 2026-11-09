import { NextResponse, type NextRequest } from 'next/server';

import { resolveRequestPrincipalContext, workerPacketRefusal } from '@/lib/auth/principal';
import { requirePanelAuth } from '@/lib/panel/auth';
import { TaskMutationError, type TaskMutationResult } from '@/lib/tasks/actions';
import { getTaskPoolTask } from '@/lib/tasks/pool';

type TaskMutationBody = Record<string, unknown>;

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
type TaskMutationContext = { params: Promise<{ taskId: string }> };
type TaskMutationHandler = (taskId: string, body: TaskMutationBody) => Promise<TaskMutationResult>;

export async function runTaskMutationRoute(
  request: NextRequest,
  context: TaskMutationContext,
  handler: TaskMutationHandler,
) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const { taskId } = await context.params;
  if (!taskId?.trim()) {
    return NextResponse.json({ error: 'taskId is required' }, { status: 400 });
  }

  const body = await request.json().catch(() => ({})) as TaskMutationBody;
  const principal = resolveRequestPrincipalContext(request);

  try {
    if (principal.role === 'worker') {
      // The gate lets a packet worker report on and block a task. It may touch only its own
      // packet's task, under the default actor, so it cannot hold another packet's work or speak
      // as the operator.
      const task = await getTaskPoolTask(taskId, {
        projectId: optionalString(body?.projectId), repoPath: optionalString(body?.repoPath),
      });
      const refusal = workerPacketRefusal(principal, task?.packetId);
      if (refusal) {
        return NextResponse.json(
          { ok: false, error: refusal },
          { status: 403, headers: { 'Cache-Control': 'no-store, max-age=0' } },
        );
      }
    }
    const result = await handler(taskId, principal.role === 'worker' ? { ...body, actor: undefined } : body);
    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Task mutation failed.';
    const status = error instanceof TaskMutationError ? error.status : 500;
    return NextResponse.json(
      { error: message },
      { status, headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  }
}
