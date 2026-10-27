import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { isOrchestratorBackendId } from '../../../src/lib/lane/orchestrator-backends/types.js';
import { isThinkingEffort } from '../../../src/lib/orchestrator/thinking-effort.js';
import { apiFetch, CliError, EXIT } from '../api.js';
import { resolveConfig } from '../config.js';
import { readThread, type ThreadHistory } from '../chat/client.js';
import type { ChatRoute } from '../chat/state.js';

export const CHAT_HELP = `usage: o8 chat [options]

An interactive conversation with the local o8 orchestrator.
Requires a running o8 app or o8 serve.
Interactive chat requires a terminal; --check also works without one.

  --check            check the transport without opening a conversation
  --repo <path>       workspace (default: current directory)
  --resume <thread>   reopen a thoughts-* conversation
  --backend <id>      session-only backend override
  --model <id>        session-only model override
  --effort <tier>     session-only reasoning effort
  --plan             request the existing plan permission mode
  --execute          allow the existing full execution mode for this session
  --no-motion        disable the working animation

Enter sends · Ctrl+J newline · Esc interrupt · Ctrl+O tool details
Page Up/Down transcript · Ctrl+G latest · /attach <path> · /quit detach
Drop image/text file paths to stage attachments. /attachments lists them.
/remove <number|all> removes staged files. Enter sends the message and files.
Chat starts in plan mode unless --execute is supplied, including on resume.
Saved settings are never changed. Exiting does not stop an active turn.
`;

export function parseChatArgs(args: string[]) {
  const values: Record<string, string> = {};
  let plan = false;
  let execute = false;
  let noMotion = false;
  let check = false;
  const flags = new Set(['--repo', '--resume', '--backend', '--model', '--effort']);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--check') { check = true; continue; }
    if (arg === '--plan') { plan = true; continue; }
    if (arg === '--execute') { execute = true; continue; }
    if (arg === '--no-motion') { noMotion = true; continue; }
    const value = args[index + 1];
    if (!flags.has(arg) || !value || value.startsWith('--') || values[arg]) {
      throw new CliError('invalid_args', `Unknown or incomplete chat option: ${arg}`, EXIT.INVALID_ARGS, CHAT_HELP);
    }
    values[arg] = value;
    index += 1;
  }
  if (values['--backend'] && !isOrchestratorBackendId(values['--backend'])) {
    throw new CliError('invalid_args', 'Unknown orchestrator backend.', EXIT.INVALID_ARGS);
  }
  if (values['--effort'] && !isThinkingEffort(values['--effort'])) {
    throw new CliError('invalid_args', 'Unknown reasoning effort.', EXIT.INVALID_ARGS);
  }
  if (values['--resume'] && !/^thoughts-[a-zA-Z0-9_-]+$/.test(values['--resume'])) {
    throw new CliError('invalid_args', '--resume requires a thoughts-* thread id.', EXIT.INVALID_ARGS);
  }
  if (plan && execute) throw new CliError('invalid_args', 'Choose either --plan or --execute.', EXIT.INVALID_ARGS);
  if (check && (Object.keys(values).length || plan || execute || noMotion)) {
    throw new CliError('invalid_args', 'Use --check by itself to check the connection without opening a chat.', EXIT.INVALID_ARGS);
  }
  return { values, execute, noMotion, check };
}

export async function runChat(args: string[]): Promise<number> {
  const options = parseChatArgs(args);
  if (options.check) {
    const { checkChatConnection } = await import('../chat/check.js');
    await checkChatConnection(resolveConfig());
    process.stdout.write('Terminal chat transport is connected.\n');
    return 0;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.TERM === 'dumb') {
    throw new CliError('terminal_required', 'o8 chat needs an interactive terminal. Use o8 lead or o8 history for structured output.', EXIT.INVALID_ARGS);
  }
  const cfg = resolveConfig();
  const { values } = options;
  let history: ThreadHistory = {};
  const threadId = values['--resume'] ?? `thoughts-${randomUUID()}`;
  if (values['--resume']) {
    history = await readThread(cfg, threadId);
    if (!history.repoPath) throw new CliError('not_found', 'That conversation was not found.', EXIT.NOT_FOUND);
    if (values['--backend'] || values['--model'] || values['--effort']) {
      throw new CliError('invalid_args', 'Resume keeps the existing conversation routing. Start a new chat to override it.', EXIT.INVALID_ARGS);
    }
  }
  const repoPath = realpathSync(resolve(values['--repo'] ?? history.repoPath ?? process.cwd()));
  if (history.repoPath && realpathSync(history.repoPath) !== repoPath) {
    throw new CliError('repo_mismatch', 'The resumed conversation belongs to another workspace.', EXIT.CONFLICT);
  }
  const setup = !history.backend && !values['--backend']
    ? await apiFetch<{ choices?: Record<string, { value?: string }> }>(cfg, '/api/setup/agent', { timeoutMs: 10_000 })
    : null;
  const choices = setup?.data?.choices;
  const backend = history.backend ?? values['--backend'] ?? choices?.orchestratorBackend?.value;
  if (!isOrchestratorBackendId(backend)) throw new CliError('setup_required', 'Choose a chat backend with --backend, or finish o8 setup.', EXIT.INVALID_ARGS);
  const model = history.model ?? values['--model'] ?? (values['--backend'] ? undefined : choices?.orchestratorModel?.value);
  const route: ChatRoute = { repoPath, threadId, backend, model: model || undefined,
    agent: history.agent || undefined, effort: values['--effort'], permissionMode: options.execute ? 'full' : 'plan' };
  const { startChat } = await import('../chat/app.js');
  await startChat(cfg, route, history, options.noMotion || process.env.O8_REDUCED_MOTION === '1');
  return 0;
}
