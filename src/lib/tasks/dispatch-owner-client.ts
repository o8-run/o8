import { getWsBase } from '@/lib/panel/api-port';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { TaskMutationError, type TaskDispatchInput, type TaskMutationResult } from './actions';

/** All admission and deferred callbacks are constructed by the WS owner from this data. */
export async function callTaskDispatchOwner(taskId: string, input: TaskDispatchInput): Promise<TaskMutationResult> {
  let response: Response;
  let reply: TaskMutationResult & { error?: string };
  try {
    response = await fetch(`${getWsBase().replace(/^ws:/, 'http:')}/api/tasks/dispatch-owner`, {
      method: 'POST', cache: 'no-store',
      headers: { authorization: `Bearer ${getOrCreateWsToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ taskId, input }),
    });
    reply = await response.json();
  } catch {
    // Never retry an uncertain admission automatically. Its durable intent receipt owns replay.
    throw new TaskMutationError(504, 'Task dispatch result is unconfirmed. Inspect its current receipt before retrying.');
  }
  if (!response.ok) throw new TaskMutationError(response.status, reply.error || 'Task dispatch owner refused the operation.');
  if (reply.schema !== 'o8/task.mutation/v1' || reply.action !== 'dispatch' || typeof reply.taskId !== 'string') {
    throw new TaskMutationError(502, 'Task dispatch owner returned an invalid receipt. Inspect current state before retrying.');
  }
  return reply;
}
