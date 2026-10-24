import { randomUUID } from 'node:crypto';
import { apiFetch, jsonResult, type McpTool } from './shared';

export const STANDING_LANE_ACTIONS = ['create', 'list', 'send', 'status', 'transcript', 'steer', 'stop', 'remove'] as const;
export const STANDING_LANE_TOOLS: McpTool[] = STANDING_LANE_ACTIONS.map(action => ({
  name: `o8_lane_${action}`,
  description: `${action} a standing worker lane. One pinned runtime session keeps context across sequential tasks and restarts. Each task gets a clean current-base branch, pull request and receipt. Lanes never merge. Stopped lanes reject tasks; remove retires the lane and preserves work.`,
  inputSchema: { type: 'object', additionalProperties: false, properties: action === 'create' ? {
    repoPath: { type: 'string' }, runtime: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, label: { type: 'string' }, idempotencyKey: { type: 'string' },
  } : action === 'list' ? {} : {
    laneId: { type: 'string' }, idempotencyKey: { type: 'string' }, ...(action === 'send' ? { task: { type: 'string' } } : {}),
    ...(action === 'steer' ? { message: { type: 'string' } } : {}),
  }, required: action === 'create' ? ['repoPath', 'runtime', 'model', 'effort']
    : action === 'list' ? [] : ['laneId', ...(action === 'send' ? ['task'] : action === 'steer' ? ['message'] : [])] },
}));

export const STANDING_LANE_HANDLERS = Object.fromEntries(STANDING_LANE_ACTIONS.map(action => [
  `o8_lane_${action}`, async (args: Record<string, unknown>) => jsonResult((await apiFetch('/api/orchestrator/standing-lanes', { method: 'POST', body: JSON.stringify({ ...args, action, idempotencyKey: args.idempotencyKey ?? randomUUID() }) }) as { result: unknown }).result),
]));
