import { randomUUID } from 'node:crypto';
import { apiFetch, CliError, EXIT } from '../api.js';
import { resolveConfig } from '../config.js';
import { printJson, type OutputMode } from '../output.js';

export const STANDING_LANE_ACTIONS = ['create', 'list', 'send', 'status', 'transcript', 'steer', 'stop', 'remove'];

export async function runStandingLane(_mode: OutputMode, action: string, rest: string[]): Promise<number> {
  if (!STANDING_LANE_ACTIONS.includes(action)) throw new CliError('invalid_args', 'Usage: o8 lane create|list|send|status|transcript|steer|stop|remove', EXIT.INVALID_ARGS);
  const input: Record<string, unknown> = { action, idempotencyKey: randomUUID() };
  const flags: Record<string, string> = { '--repo': 'repoPath', '--runtime': 'runtime', '--model': 'model', '--effort': 'effort', '--label': 'label', '--task': 'task', '--message': 'message', '--idempotency-key': 'idempotencyKey' };
  for (let i = 0; i < rest.length; i++) {
    const key = flags[rest[i]];
    if (key) {
      const value = rest[++i];
      if (!value) throw new CliError('invalid_args', `${key} requires a value.`, EXIT.INVALID_ARGS);
      input[key] = value;
    } else if (!rest[i].startsWith('-') && !input.laneId) input.laneId = rest[i];
    else throw new CliError('invalid_args', `Unknown lane argument: ${rest[i]}`, EXIT.INVALID_ARGS);
  }
  const response = await apiFetch<{ result: unknown }>(resolveConfig(), '/api/orchestrator/standing-lanes', { method: 'POST', body: input });
  printJson(response.data?.result);
  return 0;
}
