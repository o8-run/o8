import { apiFetch, CliError, EXIT } from '../api.js';
import { resolveConfig } from '../config.js';
import { printJson, type OutputMode } from '../output.js';
export async function runThreads(mode: OutputMode, action: string | undefined, rest: string[]): Promise<number> {
  if (action !== 'list' && action !== 'show') throw new CliError('invalid_args', 'Use o8 threads list [--repo path] [--state waiting|review|working|resolved], or threads show <id> --repo path.', EXIT.INVALID_ARGS);
  const query = new URLSearchParams();
  const flags = new Map([['--repo', 'repoPath'], ['--project', 'projectId'], ['--state', 'state'], ['--offset', 'offset'], ['--limit', 'limit'], ['--revision', 'revision'], ['--model', 'model']]);
  if (action === 'show') {
    if (!rest[0] || rest[0].startsWith('--')) throw new CliError('invalid_args', 'threads show requires a thread ID.', EXIT.INVALID_ARGS);
    query.set('taskId', rest.shift()!);
  }
  for (let index = 0; index < rest.length; index += 2) {
    const name = flags.get(rest[index]); const value = rest[index + 1];
    if (!name || !value || value.startsWith('--')) throw new CliError('invalid_args', 'Use --repo, --project, --state, --model, --offset, --revision or --limit with a value.', EXIT.INVALID_ARGS);
    query.set(name, value);
  }
  const { data } = await apiFetch(resolveConfig(), `/api/panel/threads?${query}`);
  if (mode.human) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  else printJson(data);
  return EXIT.OK;
}
