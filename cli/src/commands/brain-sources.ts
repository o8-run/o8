import { apiFetch, CliError, EXIT } from '../api.js';
import { resolveConfig } from '../config.js';
import { printJson, type OutputMode } from '../output.js';
export async function runBrainSources(mode: OutputMode, rest: string[]): Promise<number> {
  const [action = 'list', ...args] = rest;
  if (!['list', 'add', 'remove'].includes(action)) throw new CliError('invalid_args', 'Use o8 brain sources list|add <folder>|remove <id>.', EXIT.INVALID_ARGS);
  const body: Record<string, unknown> = { action };
  if (action === 'remove') body.id = args[0];
  if (action === 'add') {
    body.path = args.shift();
    for (let i = 0; i < args.length; i += 2) {
      const flag = args[i]; const value = args[i + 1];
      if (!value || !['--name', '--include', '--exclude'].includes(flag)) throw new CliError('invalid_args', 'Use --name, --include or --exclude with a value.', EXIT.INVALID_ARGS);
      body[flag.slice(2)] = flag === '--name' ? value : value.split(',').map(p => p.trim()).filter(Boolean);
    }
  }
  if (action !== 'list' && !body[action === 'add' ? 'path' : 'id']) throw new CliError('invalid_args', 'A folder or source ID is required.', EXIT.INVALID_ARGS);
  const result = await apiFetch<{ sources: Array<{ id: string; name: string; path: string; state: string; facts: number }> }>(resolveConfig(), '/api/cortex/sources', action === 'list' ? {} : { method: 'POST', body });
  if (mode.human) for (const source of result.data?.sources ?? []) process.stdout.write(`${source.id}  ${source.name}  ${source.path}  ${source.state}  ${source.facts} facts\n`);
  else printJson({ schema: 'o8/brain.sources/v1', ...result.data });
  return 0;
}
