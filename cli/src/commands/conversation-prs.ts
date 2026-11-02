import { apiFetch, CliError, EXIT } from '../api.js';
import { resolveConfig } from '../config.js';
import { printJson, type OutputMode } from '../output.js';

export async function runConversationPrs(mode: OutputMode, args: string[]): Promise<number> {
  const action = args[0];
  if (!['list', 'add', 'remove', 'reverse'].includes(action)) throw new CliError('invalid_args', 'Usage: o8 conversation-prs list|add|remove|reverse [--thread ID] [--repo owner/repo --number N] [--kind context|review|import] [--after N --limit N]. Immutable --repository-id and --pr-id can replace --repo.', EXIT.INVALID_ARGS);
  const values: Record<string, string> = {};
  const allowed = ['thread', 'repo', 'number', 'kind', 'after', 'limit', 'repository-id', 'pr-id'];
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || !allowed.includes(key) || !args[i + 1] || args[i + 1].startsWith('--') || key in values) throw new CliError('invalid_args', `Invalid conversation-prs argument: ${args[i]}`, EXIT.INVALID_ARGS);
    values[key] = args[i + 1];
  }
  const cfg = resolveConfig();
  const endpoint = '/api/orchestrator/pull-request-context';
  const query: Record<string, string | number> = {};
  if (action === 'list') query.threadId = values.thread ?? '';
  else {
    query.number = values.number ?? '';
    if (values.repo) query.repo = values.repo;
    if (values['repository-id'] || values['pr-id']) {
      query.host = 'github.com'; query.repositoryId = values['repository-id'] ?? ''; query.pullRequestId = values['pr-id'] ?? '';
    }
  }
  let data: unknown;
  if (action === 'add' || action === 'remove') {
    let identity: Record<string, unknown>;
    if (values.repo) {
      const resolved = await apiFetch<{ result: { identity: Record<string, unknown> } }>(cfg, endpoint, { query: { ...query, resolve: '1', ...(action === 'add' ? { refresh: '1' } : {}) } });
      if (!resolved.data?.result?.identity) {
        throw new CliError('invalid_response', 'Conversation PR identity resolution returned no identity.', EXIT.INVALID_ARGS);
      }
      identity = resolved.data.result.identity;
    } else identity = { host: 'github.com', repositoryId: Number(values['repository-id']), pullRequestId: Number(values['pr-id']), number: Number(values.number) };
    data = (await apiFetch(cfg, endpoint, { method: action === 'add' ? 'POST' : 'DELETE', body: { ...identity, threadId: values.thread, kind: values.kind ?? 'context' } })).data;
  } else {
    for (const key of ['after', 'limit']) if (values[key] !== undefined) query[key] = values[key];
    data = (await apiFetch(cfg, endpoint, { query })).data;
  }
  if (mode.human) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  else printJson(data);
  return 0;
}
