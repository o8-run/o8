/**
 * `o8 terminal panes` — show every live o8 terminal in its own pane of the
 * terminal multiplexer the operator is already in.
 *
 * o8 keeps ownership of each terminal. A pane only runs the read-only
 * `o8 terminal observe <id>`, so closing a pane, or the multiplexer itself,
 * never touches the worker. The first supported multiplexer is Rex, found
 * through `REX_SESSION` and driven through its `rex` command.
 */

import { execFileSync } from 'node:child_process';

import { CliError, EXIT } from '../api.js';

export const PANE_LIMIT_DEFAULT = 8;
export const PANE_LIMIT_MAX = 16;
const PANE_LABEL_PREFIX = 'o8 ';
const TAB_LABEL = 'o8 workers';
/** A session ID is passed as one argument, never through a shell. This bounds what it may be. */
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,127}$/;
/** Routing the observer needs to reach the same o8 the caller reached. Never a credential. */
const ROUTING_ENV = ['O8_API_PORT', 'O8_WS_PORT', 'WS_PORT', 'O8_DATA_DIR'] as const;
const SAFE_ENV_VALUE = /^[A-Za-z0-9_./:@+-]{1,512}$/;

export type PaneExec = (file: string, args: string[]) => string;

export interface TerminalPanesInput {
  sessionIds: string[];
  limit: number;
  machineKey?: string | null;
  env: Readonly<Record<string, string | undefined>>;
  /** The command that starts this same CLI, such as `[node, /path/o8.mjs]`. */
  self: string[];
  exec?: PaneExec;
}

export interface TerminalPanesResult {
  multiplexer: 'rex';
  opened: Array<{ id: string; pane: string }>;
  /** Sessions that already had a pane in this multiplexer session. */
  existing: string[];
  /** Session IDs that are not safe to pass as a command argument. */
  skipped: string[];
  /** Live sessions left without a pane because of the limit. */
  remaining: string[];
}

function defaultExec(file: string, args: string[]): string {
  return execFileSync(file, args, {
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** A pane's label names its terminal, and its machine when the terminal is remote. */
function paneLabel(id: string, machineKey?: string | null): string {
  return machineKey ? `${PANE_LABEL_PREFIX}${machineKey}/${id}` : `${PANE_LABEL_PREFIX}${id}`;
}

function parseJson<T>(raw: string, what: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new CliError('multiplexer_error', `Rex returned an unreadable ${what}.`, EXIT.CONFLICT);
  }
}

function rex(exec: PaneExec, args: string[], what: string): string {
  try {
    return exec('rex', args);
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
    throw new CliError(
      missing ? 'multiplexer_required' : 'multiplexer_error',
      missing ? 'The `rex` command is not on PATH.' : `Rex could not ${what}.`,
      missing ? EXIT.INVALID_ARGS : EXIT.CONFLICT,
    );
  }
}

/** The command one pane runs: this CLI, observing one terminal, read-only. */
export function observeCommand(input: Pick<TerminalPanesInput, 'self' | 'env' | 'machineKey'>, id: string): string[] {
  const routing = ROUTING_ENV.flatMap((name) => {
    const value = input.env[name]?.trim();
    return value && SAFE_ENV_VALUE.test(value) ? [`${name}=${value}`] : [];
  });
  return [
    ...(routing.length > 0 ? ['env', ...routing] : []),
    ...input.self,
    '--human',
    'terminal',
    'observe',
    id,
    ...(input.machineKey ? ['--machine', input.machineKey] : []),
  ];
}

/**
 * Open one pane per live terminal that does not have one yet. Panes tile as a
 * binary tree: each new pane splits an earlier one, to the right, then below.
 */
export function openTerminalPanes(input: TerminalPanesInput): TerminalPanesResult {
  const session = input.env.REX_SESSION?.trim();
  if (!session) {
    throw new CliError(
      'multiplexer_required',
      'Run `o8 terminal panes` inside a Rex terminal.',
      EXIT.INVALID_ARGS,
      'Rex is the supported multiplexer. It sets REX_SESSION in every terminal it opens.',
    );
  }
  const exec = input.exec ?? defaultExec;
  const limit = Math.max(1, Math.min(PANE_LIMIT_MAX, Math.floor(input.limit) || PANE_LIMIT_DEFAULT));

  const safe = input.sessionIds.filter((id) => SAFE_SESSION_ID.test(id));
  const skipped = input.sessionIds.filter((id) => !SAFE_SESSION_ID.test(id));

  const listed = parseJson<{ blocks?: Array<{ block_id?: unknown; label?: unknown; placement?: unknown }> }>(
    rex(exec, ['block', 'ls', '-s', session, '--json'], 'list its panes'),
    'pane list',
  );
  const label = (id: string) => paneLabel(id, input.machineKey);
  const paneByLabel = new Map<string, string>();
  for (const block of listed.blocks ?? []) {
    if (typeof block.block_id !== 'string' || typeof block.label !== 'string') continue;
    if (block.placement !== undefined && block.placement !== 'placed') continue;
    if (block.label.startsWith(PANE_LABEL_PREFIX)) paneByLabel.set(block.label, block.block_id);
  }

  const existing = safe.filter((id) => paneByLabel.has(label(id)));
  const wanted = safe.filter((id) => !paneByLabel.has(label(id)));
  const panes = [...paneByLabel.values()];
  const room = Math.max(0, limit - panes.length);
  const opened: TerminalPanesResult['opened'] = [];

  for (const id of wanted.slice(0, room)) {
    const command = observeCommand(input, id);
    const run = ['--focus=false', '--keep-open', '--json', '--', ...command];
    let raw: string;
    if (panes.length === 0) {
      raw = rex(exec, ['window', 'new', '-s', session, TAB_LABEL, ...run], 'open a tab');
    } else {
      const index = panes.length;
      const anchor = panes[Math.floor((index - 1) / 2)];
      const direction = index % 2 === 1 ? 'right' : 'below';
      raw = rex(
        exec,
        ['split', '-s', session, '-b', anchor, `--split=${direction}`, '--label', label(id), ...run],
        'split a pane',
      );
    }
    const created = parseJson<{ block_ids?: unknown }>(raw, 'pane result');
    const pane = Array.isArray(created.block_ids) && typeof created.block_ids[0] === 'string' ? created.block_ids[0] : null;
    if (!pane) throw new CliError('multiplexer_error', 'Rex did not report the pane it opened.', EXIT.CONFLICT);
    if (panes.length === 0) {
      // A tab takes a name, not a pane label. Label its first pane so the next run finds it.
      rex(exec, ['block', 'rename', '-s', session, pane, label(id)], 'label a pane');
    }
    panes.push(pane);
    opened.push({ id, pane });
  }

  return {
    multiplexer: 'rex',
    opened,
    existing,
    skipped,
    remaining: wanted.slice(opened.length),
  };
}
