import { NextResponse } from 'next/server';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { startExternalReview } from '../external-review-start';
import { validateRequestedRuntime } from '@/lib/agents/routing';
import type { NextRequest } from 'next/server';

import { dispatchTask, readTaskEffortSelection } from '@/lib/tasks/actions';
import { runTaskMutationRoute } from '@/app/api/tasks/[taskId]/mutation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function actor(value: unknown) {
  return value === 'user' || value === 'system' || value === 'orchestrator'
    ? value
    : undefined;
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ taskId: string }> },
) {
  const { taskId } = await context.params;
  if (taskId.startsWith('external-pr-')) {
    if (resolveRequestPrincipal(request) !== 'operator') return NextResponse.json({ error: 'Operator token required.' }, { status: 403 });
    try { const task = await startExternalReview(taskId); return NextResponse.json({ schema: 'o8/task.mutation/v1', ok: true, action: 'dispatch', taskId, packetId: task?.revision.packetId, note: 'Review queued.', externalReview: task }); }
    catch { return NextResponse.json({ error: 'Review could not start. Refresh its input and inspect the existing attempt.' }, { status: 409 }); }
  }
  return runTaskMutationRoute(request, context, (taskId, body) => dispatchTask(taskId, {
    actor: actor(body.actor),
    projectId: optionalString(body.projectId),
    repoPath: optionalString(body.repoPath),
    message: optionalString(body.message),
    model: optionalString(body.model),
    requestedEffort: readTaskEffortSelection(body),
    workerIntent: optionalString(body.workerIntent),
    requestedProvider: optionalString(body.requestedProvider),
    requestedRuntime: validateRequestedRuntime(body.requestedRuntime),
  }));
}
