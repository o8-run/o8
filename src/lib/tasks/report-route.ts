import type { NextRequest } from 'next/server';

import type { AgentReportReason } from '@/lib/lane/types';
import { reportTask } from '@/lib/tasks/actions';
import { runTaskMutationRoute } from '@/app/api/tasks/[taskId]/mutation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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
  return runTaskMutationRoute(request, context, (taskId, body) => reportTask(taskId, {
    actor: actor(body.actor),
    projectId: optionalString(body.projectId),
    repoPath: optionalString(body.repoPath),
    event: optionalString(body.event),
    status: optionalString(body.status),
    reason: optionalString(body.reason) as AgentReportReason | null,
    message: optionalString(body.message),
    metadata: optionalRecord(body.metadata),
  }));
}
