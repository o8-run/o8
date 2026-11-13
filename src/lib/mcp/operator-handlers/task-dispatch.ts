import { apiFetch } from './shared';
import { RuntimeSelectionError, validateRequestedRuntime } from '@/lib/agents/routing';
import { withToolRuntimeOwner } from '@/lib/runtime/owner-context';
import { dispatchTask } from '@/lib/tasks/actions';
import { lifecycleErrorResult } from './lifecycle-error';
import { jsonResult, textResult, McpInputError, optionalString, requiredString, type McpToolResult } from './shared';

export async function handleTaskDispatch(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const taskId = requiredString(args, 'taskId');
    if (taskId.startsWith('external-pr-')) {
      if (process.env.O8_WORKER_TOKEN) return textResult('Operator token required.', true);
      return jsonResult(await apiFetch(`/api/tasks/${encodeURIComponent(taskId)}/dispatch`, { method: 'POST', body: '{}' }));
    }
    const result = await withToolRuntimeOwner(() => dispatchTask(requiredString(args, 'taskId'), {
      waitForLaunch: false,
      actor: 'orchestrator',
      message: optionalString(args, 'message') || null,
      model: optionalString(args, 'model') || null,
      workerIntent: optionalString(args, 'workerIntent') || null,
      requestedProvider: optionalString(args, 'requestedProvider') || null,
      requestedRuntime: validateRequestedRuntime(args.requestedRuntime),
      projectId: optionalString(args, 'projectId') || null,
      repoPath: optionalString(args, 'repoPath') || null,
    }));
    if (!result.ok) return lifecycleErrorResult('o8_task_dispatch', { code: 'task_dispatch_failed', note: result.note }, result.packetId ?? args.taskId);
    return jsonResult(result);
  } catch (error) {
    return lifecycleErrorResult('o8_task_dispatch', error instanceof RuntimeSelectionError ? new McpInputError(error.message) : error, args.taskId);
  }
}

