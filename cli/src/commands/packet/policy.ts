import { apiFetch, CliError, EXIT } from '../../api.js';
import { resolveConfig } from '../../config.js';
import { printJson, type OutputMode } from '../../output.js';
import { parsePacketArguments, resolvePacketTarget } from './target.js';

export async function runPacketPolicy(_mode: OutputMode, rest: string[]): Promise<number> {
  const args = parsePacketArguments(rest, { command: 'policy' });
  const target = await resolvePacketTarget(args.target);
  const result = await apiFetch(resolveConfig(), `/api/lanes/${encodeURIComponent(target.laneId)}/policy`);
  if (!result.data) throw new CliError('invalid_response', 'Server returned an empty effective policy.', EXIT.INVALID_ARGS);
  printJson(result.data);
  return 0;
}
