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
const TAB_LABEL = 'o8 terminals';
/**
 * A pane's label reads `o8: <title> [<id>]`, with the title first so it stays
 * visible when the pane header is cut short. Only a label of exactly this
 * shape is treated as a pane this command opened, and the bracketed part
 * identifies the terminal.
 */
const PANE_LABEL_PREFIX = 'o8: ';
const PANE_LABEL = /^o8: (?:.* )?\[([A-Za-z0-9][A-Za-z0-9 _.:@+/-]*)\]$/;
const TITLE_MAX = 48;
/** A session ID is one command word and part of a label. This bounds what it may be. */
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,127}$/;
/** A saved machine's label or ID: one command word that can never read as a flag. */
const SAFE_MACHINE_KEY = /^[A-Za-z0-9][A-Za-z0-9 _.:@+-]{0,63}$/;
/** Routing the observer needs to reach the same o8 the caller reached. Never a credential. */
const ROUTING_ENV = ['O8_API_PORT', 'O8_WS_PORT', 'WS_PORT', 'O8_DATA_DIR'] as const;
const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/;

export type PaneExec = (file: string, args: string[]) => string;

/** A live terminal to show: its session ID, and a title when o8 knows one. */
export interface PaneTerminal {
  id: string;
  title?: string | null;
}

export interface TerminalPanesInput {
  terminals: PaneTerminal[];
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
  /** Terminals whose new pane closed right away, because its observer could not attach. */
  closed: string[];
  /** Set when the multiplexer failed partway or a pane closed right away. Panes in `opened` still exist. */
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

/** The part of a label that identifies a terminal: its ID, and its machine when remote. */
function paneKey(id: string, machineKey?: string | null): string {
  return machineKey ? `${machineKey}/${id}` : id;
}

/** One plain, short line. A title can come from a packet, so it is treated as untrusted text. */
function paneTitle(raw: string | null | undefined): string {
  const plain = (raw ?? '').replace(/[\x00-\x1f\x7f-\x9f\[\]]+/g, ' ').replace(/\s+/g, ' ').trim();
  return plain.length > TITLE_MAX ? `${plain.slice(0, TITLE_MAX - 1).trimEnd()}…` : plain;
}

/** A pane's label: the terminal's title, then the key that identifies it. */
export function paneLabel(terminal: PaneTerminal, machineKey?: string | null): string {
  const title = paneTitle(terminal.title);
  return `${PANE_LABEL_PREFIX}${title ? `${title} ` : ''}[${paneKey(terminal.id, machineKey)}]`;
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
  // `env NAME=value program` reads a program path holding `=` as one more assignment.
  if (input.self.length === 0 || input.self[0].includes('=')
    || input.self.some((word) => !word || CONTROL_CHARACTER.test(word))) {
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
  const key = (id: string) => paneKey(id, input.machineKey);

  const titles = new Map<string, string | null | undefined>();
  for (const terminal of input.terminals) {
    if (!titles.has(terminal.id) || (terminal.title && !titles.get(terminal.id))) titles.set(terminal.id, terminal.title);
  }
  const unique = [...titles.keys()];
  const safe = unique.filter((id) => SAFE_SESSION_ID.test(id));
  const skipped = unique.filter((id) => !SAFE_SESSION_ID.test(id));

  const listed = parseJson<{ blocks?: Array<{ block_id?: unknown; label?: unknown; placement?: unknown }> }>(
    rex(exec, ['block', 'ls', '-s', session, '--json'], 'list its panes'),
    'pane list',
  );
  const panes: string[] = [];
  const paneByKey = new Map<string, string>();
  for (const block of listed.blocks ?? []) {
    if (typeof block.block_id !== 'string' || typeof block.label !== 'string') continue;
    if (block.placement !== undefined && block.placement !== 'placed') continue;
    const match = PANE_LABEL.exec(block.label);
    if (!match) continue;
    panes.push(block.block_id);
    paneByKey.set(match[1], block.block_id);
  }

  const existing = safe.filter((id) => paneByKey.has(key(id)));
  const wanted = safe.filter((id) => !paneByKey.has(key(id)));
  const opened: TerminalPanesResult['opened'] = [];
  let error: string | null = null;

  for (const id of wanted) {
    if (panes.length >= limit) break;
    try {
      const run = ['--label', paneLabel({ id, title: titles.get(id) }, input.machineKey), '--focus=false', '--json', '--', ...observeCommand(input, id)];
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
    closed: [],
    error,
  };
}

/**
 * A pane closes as soon as its observer exits, so one that could not attach
 * vanishes without a message. Call this a moment after opening: it moves every
 * new pane that is already gone from `opened` to `closed` and says so.
 */
export function confirmOpenedPanes(
  result: TerminalPanesResult,
  env: Readonly<Record<string, string | undefined>>,
  exec: PaneExec = defaultExec,
): TerminalPanesResult {
  const session = env.REX_SESSION?.trim();
  if (!session || result.opened.length === 0) return result;
  let alive: Set<string>;
  try {
    const listed = parseJson<{ blocks?: Array<{ block_id?: unknown }> }>(
      rex(exec, ['block', 'ls', '-s', session, '--json'], 'list its panes'),
      'pane list',
    );
    alive = new Set((listed.blocks ?? []).flatMap((block) => typeof block.block_id === 'string' ? [block.block_id] : []));
  } catch {
    return result;
  }
  const closed = result.opened.filter((pane) => !alive.has(pane.pane)).map((pane) => pane.id);
  if (closed.length === 0) return result;
  return {
    ...result,
    opened: result.opened.filter((pane) => alive.has(pane.pane)),
    closed,
    error: result.error
      ?? `${closed.length === 1 ? 'A pane' : `${closed.length} panes`} closed right away. Run \`o8 terminal observe <id>\` to see why.`,
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
