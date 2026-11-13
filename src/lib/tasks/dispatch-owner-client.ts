import { RuntimeSelectionError } from '@/lib/agents/routing';
import { ControlPlaneLockTimeoutError } from '@/lib/orchestrator/control-plane';
import { getWsBase } from '@/lib/panel/api-port';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { TaskMutationError, type TaskDispatchInput, type TaskMutationResult } from './actions';

/** All admission and deferred callbacks are constructed by the WS owner from this data. */
export async function callTaskDispatchOwner(taskId: string, input: TaskDispatchInput): Promise<TaskMutationResult> {
  let response: Response;
  let reply: TaskMutationResult & { error?: string; errorClass?: string; code?: string; waitTimeoutMs?: number; retryAfterMs?: number };
  try {
    response = await fetch(`${getWsBase().replace(/^ws:/, 'http:')}/api/tasks/dispatch-owner`, {
      method: 'POST', cache: 'no-store',
      headers: { authorization: `Bearer ${getOrCreateWsToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ taskId, input }),
    });
    reply = await response.json();
  } catch {
    // Never retry an uncertain admission automatically. Its durable intent receipt owns replay.
    throw Object.assign(new TaskMutationError(504, 'Task dispatch result is unconfirmed. Inspect its current receipt before retrying.'), { code: 'outcome_unknown' });
  }
  if (!response.ok) {
    const message = reply.error || 'Task dispatch owner refused the operation.';
    const error = reply.errorClass === 'ControlPlaneLockTimeoutError'
      ? new ControlPlaneLockTimeoutError(reply.waitTimeoutMs ?? 0)
      : reply.errorClass === 'RuntimeSelectionError'
        ? new RuntimeSelectionError(response.status, message, reply.code === 'worker_not_enabled' ? 'worker_not_enabled' : 'invalid_runtime')
      : reply.errorClass === 'TaskMutationError' || (!reply.errorClass && response.status < 500)
        ? new TaskMutationError(response.status, message)
        : new Error(message);
    if (typeof reply.code === 'string') Object.assign(error, { code: reply.code });
    if (typeof reply.retryAfterMs === 'number') Object.assign(error, { retryAfterMs: reply.retryAfterMs });
    throw error;
  }
  if (reply.schema !== 'o8/task.mutation/v1' || reply.action !== 'dispatch' || typeof reply.taskId !== 'string') {
    throw Object.assign(new TaskMutationError(502, 'Task dispatch owner returned an invalid receipt. Inspect current state before retrying.'), { code: 'task_dispatch_owner_invalid_receipt' });
  }
  return reply;
}
