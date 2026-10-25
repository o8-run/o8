import { apiFetch, CliError, EXIT } from '../api.js';
import { resolveConfig } from '../config.js';
import { printJson, type OutputMode } from '../output.js';

/** Agent and operator clients use the same saved preview and selection as Settings. */
export async function runWorkspaceCleanup(mode: OutputMode, verb: string | undefined, args: string[]): Promise<number> {
  const values = (name: string) => args.flatMap((arg, index) => arg === name ? [args[index + 1] ?? ''] : []);
  const flag = (name: string) => values(name)[0] ?? '';
  const endpoint = '/api/orchestrator/workspace/maintenance';
  const cfg = resolveConfig();
  let data: unknown;
  if (verb === 'preview' && flag('--repo')) {
    data = (await apiFetch(cfg, endpoint, { method: 'POST', body: { action: 'preview', repoPath: flag('--repo') } })).data;
  } else if (verb === 'status' && flag('--plan')) {
    data = (await apiFetch(cfg, endpoint, { query: { planId: flag('--plan') } })).data;
  } else if (verb === 'execute' && flag('--plan') && flag('--approve') && values('--entry').length) {
    data = (await apiFetch(cfg, endpoint, { method: 'POST', body: { action: 'execute', planId: flag('--plan'),
      fingerprint: flag('--approve'), selection: values('--entry') } })).data;
  } else throw new CliError('invalid_args', 'Use workspace-cleanup preview --repo <path>, status --plan <id>, or execute --plan <id> --approve <fingerprint> --entry <id> [--entry <id>].', EXIT.INVALID_ARGS);
  if (mode.human) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  else printJson({ schema: 'o8/cli/workspace-cleanup/v1', ...data as object });
  return EXIT.OK;
}
