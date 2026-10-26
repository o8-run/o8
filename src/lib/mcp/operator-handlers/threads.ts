import { readProjectThreads } from '@/lib/threads/project';
import type { ThreadGrouping } from '@/lib/threads/grouping';
import type { ThreadState } from '@/lib/threads/types';
import { jsonResult, textResult, type McpTool } from './shared';
export const THREAD_TOOLS: McpTool[] = [{
  name: 'o8_threads_list',
  description: 'Read project threads grouped as waiting, review, working or resolved. Projects missions, packets, inbox items and sessions without dispatching work. Pass taskId for exact recorded evidence; pagination is explicit. Review and steering still use their existing governed tools.',
  inputSchema: { type: 'object', properties: {
    model: { type: 'string', enum: ['A', 'B', 'C'] }, repoPath: { type: 'string' }, projectId: { type: 'string' }, state: { type: 'string', enum: ['waiting', 'review', 'working', 'resolved'] },
    taskId: { type: 'string' }, revision: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 250 },
  }, additionalProperties: false },
}];
export async function handleThreadsList(args: Record<string, unknown>) {
  try {
    const result = await readProjectThreads({ repoPaths: typeof args.repoPath === 'string' ? [args.repoPath] : [],
      model: args.model as ThreadGrouping | undefined, projectId: typeof args.projectId === 'string' ? args.projectId : null, state: args.state as ThreadState | undefined,
      taskId: typeof args.taskId === 'string' ? args.taskId : undefined, revision: typeof args.revision === 'string' ? args.revision : undefined, offset: args.offset === undefined ? 0 : Number(args.offset), limit: args.limit === undefined ? 50 : Number(args.limit) });
    if (args.taskId && !result.task) return textResult('Thread unavailable in this scope.', true);
    return jsonResult(result);
  } catch { return textResult('Unable to read threads. Check the scope, state and page bounds.', true); }
}
