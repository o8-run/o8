/**
 * `o8 terminal panes` — show every live o8 terminal in its own pane of the
 * terminal multiplexer the operator is already in.
 *
 * o8 keeps ownership of each terminal. A pane only runs the read-only
 * `o8 terminal observe <id>`, so closing a pane, or the multiplexer itself,
 * never touches the worker, and a pane closes on its own when its terminal
 * ends. The first supported multiplexer is Rex, found through `REX_SESSION`
 * and driven through its `rex` command, which passes each command word to the
 * program unchanged.
 */

import { execFileSync } from 'node:child_process';

import { CliError, EXIT } from '../api.js';

export const PANE_LIMIT_DEFAULT = 8;
export const PANE_LIMIT_MAX = 16;
const TAB_LABEL = 'o8 workers';
/** Only a pane with exactly this label shape is treated as one this command opened. */
const PANE_LABEL_PREFIX = 'o8 terminal ';
/** A session ID is one command word and part of a label. This bounds what it may be. */
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,127}$/;
/** A saved machine's label or ID: one command word that can never read as a flag. */
const SAFE_MACHINE_KEY = /^[A-Za-z0-9][A-Za-z0-9 _.:@+-]{0,63}$/;
/** Routing the observer needs to reach the same o8 the caller reached. Never a credential. */
const ROUTING_ENV = ['O8_API_PORT', 'O8_WS_PORT', 'WS_PORT', 'O8_DATA_DIR'] as const;
const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/;

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
  /** Live terminals that already had a pane in this multiplexer session. */
  existing: string[];
  /** Session IDs that are not safe to pass as a command word. */
  skipped: string[];
  /** Live terminals left without a pane, because of the limit or a failure. */
  remaining: string[];
  /** Set when the multiplexer failed partway. Panes in `opened` still exist. */
  error: string | null;
}

function defaultExec(file: string, args: string[]): string {
  return execFileSync(file, args, {
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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

/** A pane's label names its terminal, and its machine when the terminal is remote. */
export function paneLabel(id: string, machineKey?: string | null): string {
  return machineKey ? `${PANE_LABEL_PREFIX}${machineKey}/${id}` : `${PANE_LABEL_PREFIX}${id}`;
}

/** The command one pane runs: this CLI, observing one terminal, read-only. */
export function observeCommand(input: Pick<TerminalPanesInput, 'self' | 'env' | 'machineKey'>, id: string): string[] {
  const routing = ROUTING_ENV.flatMap((name) => {
    const value = input.env[name];
    return value ? [`${name}=${value}`] : [];
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

function validate(input: TerminalPanesInput): string {
  const session = input.env.REX_SESSION?.trim();
  if (!session) {
    throw new CliError(
      'multiplexer_required',
      'Run `o8 terminal panes` inside a Rex terminal.',
      EXIT.INVALID_ARGS,
      'Rex is the supported multiplexer. It sets REX_SESSION in every terminal it opens.',
    );
  }
  if (input.machineKey && !SAFE_MACHINE_KEY.test(input.machineKey)) {
    throw new CliError(
      'invalid_args',
      'That machine label cannot be used for panes. Use the machine ID instead.',
      EXIT.INVALID_ARGS,
    );
  }
  if (input.self.length === 0 || input.self.some((word) => !word || CONTROL_CHARACTER.test(word))) {
    throw new CliError('invalid_args', 'Could not work out how to start o8 in a pane.', EXIT.INVALID_ARGS);
  }
  for (const name of ROUTING_ENV) {
    const value = input.env[name];
    if (value && CONTROL_CHARACTER.test(value)) {
      throw new CliError('invalid_args', `${name} holds a control character and cannot be passed to a pane.`, EXIT.INVALID_ARGS);
    }
  }
  return session;
}

/**
 * Open one pane per live terminal that does not have one yet. Panes tile as a
 * binary tree: each new pane splits an earlier one, to the right, then below.
 *
 * Only panes this command labeled count toward the limit or serve as split
 * anchors, so an unrelated pane is never split and never uses up room. A
 * multiplexer failure partway returns what was opened, with `error` set.
 */
export function openTerminalPanes(input: TerminalPanesInput): TerminalPanesResult {
  const session = validate(input);
  const exec = input.exec ?? defaultExec;
  const limit = Math.max(1, Math.min(PANE_LIMIT_MAX, Math.floor(input.limit) || PANE_LIMIT_DEFAULT));
  const label = (id: string) => paneLabel(id, input.machineKey);

  const unique = [...new Set(input.sessionIds)];
  const safe = unique.filter((id) => SAFE_SESSION_ID.test(id));
  const skipped = unique.filter((id) => !SAFE_SESSION_ID.test(id));

  const listed = parseJson<{ blocks?: Array<{ block_id?: unknown; label?: unknown; placement?: unknown }> }>(
    rex(exec, ['block', 'ls', '-s', session, '--json'], 'list its panes'),
    'pane list',
  );
  const panes: string[] = [];
  const paneByLabel = new Map<string, string>();
  for (const block of listed.blocks ?? []) {
    if (typeof block.block_id !== 'string' || typeof block.label !== 'string') continue;
    if (block.placement !== undefined && block.placement !== 'placed') continue;
    if (!block.label.startsWith(PANE_LABEL_PREFIX)) continue;
    panes.push(block.block_id);
    paneByLabel.set(block.label, block.block_id);
  }

  const existing = safe.filter((id) => paneByLabel.has(label(id)));
  const wanted = safe.filter((id) => !paneByLabel.has(label(id)));
  const opened: TerminalPanesResult['opened'] = [];
  let error: string | null = null;

  for (const id of wanted) {
    if (panes.length >= limit) break;
    try {
      const run = ['--label', label(id), '--focus=false', '--json', '--', ...observeCommand(input, id)];
      const first = panes.length === 0;
      const index = panes.length;
      const raw = first
        ? rex(exec, ['run', '-s', session, ...run], 'open a tab')
        : rex(exec, [
          'split', '-s', session, '-b', panes[Math.floor((index - 1) / 2)],
          `--split=${index % 2 === 1 ? 'right' : 'below'}`, ...run,
        ], 'split a pane');
      const created = parseJson<{ block_ids?: unknown; window_id?: unknown }>(raw, 'pane result');
      const pane = Array.isArray(created.block_ids) && typeof created.block_ids[0] === 'string' ? created.block_ids[0] : null;
      if (!pane) throw new CliError('multiplexer_error', 'Rex did not report the pane it opened.', EXIT.CONFLICT);
      panes.push(pane);
      opened.push({ id, pane });
      if (first && typeof created.window_id === 'string') {
        // Naming the tab is a courtesy. The pane already carries its label.
        try { exec('rex', ['window', 'rename', '-s', session, created.window_id, TAB_LABEL]); } catch { /* keep the default name */ }
      }
    } catch (caught) {
      error = caught instanceof CliError ? caught.message : 'Rex failed while opening a pane.';
      break;
    }
  }

  const placed = new Set(opened.map((pane) => pane.id));
  return {
    multiplexer: 'rex',
    opened,
    existing,
    skipped,
    remaining: wanted.filter((id) => !placed.has(id)),
    error,
  };
}

const PANES_USAGE = 'Use `terminal panes [--limit 1..16] [--machine <label-or-id>]`.';

/** Parse `terminal panes` flags. Each flag may appear once and needs a value. */
export function parsePanesArgs(rest: string[]): { limit: number; machineKey: string | null } {
  let machineKey: string | null = null;
  let limit: number | null = null;
  if (rest.length % 2 !== 0) throw new CliError('invalid_args', PANES_USAGE, EXIT.INVALID_ARGS);
  for (let i = 0; i < rest.length; i += 2) {
    const value = rest[i + 1] ?? '';
    if (rest[i] === '--machine' && machineKey === null && SAFE_MACHINE_KEY.test(value)) {
      machineKey = value;
    } else if (rest[i] === '--limit' && limit === null && /^\d{1,2}$/.test(value)
      && Number(value) >= 1 && Number(value) <= PANE_LIMIT_MAX) {
      limit = Number(value);
    } else {
      throw new CliError('invalid_args', PANES_USAGE, EXIT.INVALID_ARGS);
    }
  }
  return { limit: limit ?? PANE_LIMIT_DEFAULT, machineKey };
}
