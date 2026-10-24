import { apiFetch, CliError, EXIT } from '../api.js';
import { resolveConfig } from '../config.js';
import { printJson, type OutputMode } from '../output.js';
export async function runPrStack(mode: OutputMode, rest: string[]): Promise<number> {
  const flag = (name: string) => { const index = rest.indexOf(name); return index < 0 ? '' : rest[index + 1] ?? ''; };
  const repo = flag('--repo'); const number = Number(flag('--number'));
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isSafeInteger(number) || number < 1) throw new CliError('invalid_args', 'Use o8 pr-stack --repo owner/repo --number N.', EXIT.INVALID_ARGS);
  const { data } = await apiFetch<Record<string, unknown>>(resolveConfig(), '/api/panel/pr-stack', { query: { repo, number } });
  if (!mode.human) printJson({ ok: true, result: data });
  else process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  return EXIT.OK;
}
