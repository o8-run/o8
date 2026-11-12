import type { NextRequest } from 'next/server';

import { archiveTask } from '@/lib/tasks/actions';
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
  return runTaskMutationRoute(request, context, (taskId, body) => archiveTask(taskId, {
    actor: actor(body.actor),
    projectId: optionalString(body.projectId),
    repoPath: optionalString(body.repoPath),
    reason: optionalString(body.reason),
  }));
}
