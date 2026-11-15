import { readFile } from 'node:fs/promises';
import { apiFetch, CliError, EXIT } from '../api.js';
import { resolveConfig } from '../config.js';
import { printJson, type OutputMode } from '../output.js';

export async function runIntegrationQueue(_mode: OutputMode, action: string | undefined, rest: string[]): Promise<number> {
  const flag = (name: string) => { const index = rest.indexOf(name); return index < 0 ? '' : rest[index + 1] ?? ''; };
  const repoId = flag('--repo-id');
  if (!repoId || !['read', 'prepare'].includes(action ?? '')) throw new CliError('invalid_args', 'Use o8 integration-queue read|prepare --repo-id <id> [--spec <file.json>].', EXIT.INVALID_ARGS);
  let body: unknown;
  if (action === 'prepare') {
    if (!flag('--spec')) throw new CliError('invalid_args', 'Preparation requires --spec <file.json> with targetRef, changes and required checks.', EXIT.INVALID_ARGS);
    try { body = JSON.parse(await readFile(flag('--spec'), 'utf8')); }
    catch { throw new CliError('invalid_args', 'The integration queue specification is unreadable JSON.', EXIT.INVALID_ARGS); }
  }
  const result = await apiFetch(resolveConfig(), `/api/repos/${encodeURIComponent(repoId)}/integration-queue`, {
    method: action === 'prepare' ? 'POST' : 'GET', ...(body === undefined ? {} : { body }), timeoutMs: 2700000,
  });
  printJson(result.data);
  return EXIT.OK;
}
