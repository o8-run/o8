/**
 * `o8 terminal needs-you` — move Rex's focus to the next o8 pane that needs
 * you, so a tab marked "needs you" is one key away from the pane that raised it.
 *
 * Each o8 pane reports its state to Rex through the Program Status Protocol.
 * This reads those reports back from Rex, pane by pane, and focuses an o8
 * pane that is blocked or failed: the most urgent first, then each of the
 * others in turn as it is pressed again. The watcher pane is skipped: it only
 * counts the others.
 */

import { execFileSync } from 'node:child_process';

import { CliError, EXIT } from '../api.js';
import { WATCHER_LABEL, type PaneExec } from './terminal-panes.js';

const TERMINAL = 'com.superlogical.terminal';
const APP = 'o8';
/** Blocked panes come before failed ones. */
const RANK: Record<string, number> = { blocked: 0, error: 1 };
const USAGE = 'Use `terminal needs-you [--session <id>] [--from <block>]`.';
const ID = /^[A-Za-z0-9:_.-]{1,128}$/;

export interface NeedsYouArgs { session: string | null; from: string | null }

export function parseNeedsYouArgs(rest: string[]): NeedsYouArgs {
  const args: NeedsYouArgs = { session: null, from: null };
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if ((flag !== '--session' && flag !== '--from') || value === undefined) {
      throw new CliError('invalid_args', USAGE, EXIT.INVALID_ARGS);
    }
    // An action with no focused pane passes an empty `--from`.
    if (value !== '' && !ID.test(value)) throw new CliError('invalid_args', USAGE, EXIT.INVALID_ARGS);
    if (flag === '--session') args.session = value || null;
    else args.from = value || null;
  }
  return args;
}

export interface NeedsYouResult {
  /** The pane focused, or `null` when no o8 pane needs you. */
  block: string | null;
  label: string | null;
  /** What the pane reported, such as `Needs you: same error 3x`. */
  msg: string | null;
  /** How many o8 panes need you in this session, the focused one included. */
  waiting: number;
}

interface Block { block_id?: unknown; label?: unknown; creator_name?: unknown; placement?: unknown }
interface StatusRecord { state?: unknown; app?: unknown; effective_app?: unknown; msg?: unknown }

function defaultExec(file: string, args: string[]): string {
  return execFileSync(file, args, { encoding: 'utf8', timeout: 10_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

function readJson<T>(raw: string): T | null {
  try { return JSON.parse(raw) as T; } catch { return null; }
}

/** The most urgent o8 report a pane holds, or `null` when it needs nothing. */
export function paneNeed(records: readonly StatusRecord[]): { rank: number; msg: string | null } | null {
  let best: { rank: number; msg: string | null } | null = null;
  for (const record of records) {
    const app = typeof record.effective_app === 'string' ? record.effective_app : record.app;
    const rank = typeof record.state === 'string' ? RANK[record.state] : undefined;
    if (app !== APP || rank === undefined) continue;
    if (!best || rank < best.rank) best = { rank, msg: typeof record.msg === 'string' ? record.msg : null };
  }
  return best;
}

/**
 * The pane to focus. From a pane that needs nothing, the most urgent one,
 * and among equals the first after `from` in Rex's order. From a pane that
 * needs you, the next one in Rex's order, wrapping around, so pressing again
 * visits each in turn and a failed pane is never left behind a blocked one.
 */
export function pickPane<T extends { block: string; rank: number }>(waiting: readonly T[], order: readonly string[], from: string | null): T | null {
  if (waiting.length === 0) return null;
  const start = from ? order.indexOf(from) : -1;
  const position = (pane: T) => {
    const at = order.indexOf(pane.block);
    return at > start ? at - start : at - start + order.length;
  };
  const cycling = waiting.some((pane) => pane.block === from);
  const top = Math.min(...waiting.map((pane) => pane.rank));
  const choices = cycling ? waiting : waiting.filter((pane) => pane.rank === top);
  return [...choices].sort((a, b) => position(a) - position(b))[0];
}

export function focusNeedsYou(input: {
  args: NeedsYouArgs;
  env: Readonly<Record<string, string | undefined>>;
  exec?: PaneExec;
}): NeedsYouResult {
  const exec = input.exec ?? defaultExec;
  const session = input.args.session ?? input.env.REX_SESSION ?? null;
  const from = input.args.from ?? input.env.REX_BLOCK ?? null;
  if (!session) throw new CliError('multiplexer_required', 'Run this in a Rex pane, or pass --session.', EXIT.INVALID_ARGS);
  const rex = (args: string[], what: string): string => {
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
  };
  const listed = readJson<{ blocks?: Block[] }>(rex(['block', 'ls', '-s', session, '--json'], 'list its panes'));
  if (!Array.isArray(listed?.blocks)) throw new CliError('multiplexer_error', 'Rex returned an unreadable pane list.', EXIT.CONFLICT);
  const panes = listed.blocks.filter((block): block is Block & { block_id: string } =>
    typeof block.block_id === 'string' && ID.test(block.block_id)
    && block.creator_name === TERMINAL
    && (block.placement === undefined || block.placement === 'placed'));
  const waiting: Array<{ block: string; rank: number; msg: string | null; label: string | null }> = [];
  for (const pane of panes) {
    if (pane.label === WATCHER_LABEL) continue;
    let records: StatusRecord[] = [];
    try {
      // A pane that closed between the two calls has nothing to report.
      records = readJson<{ records?: StatusRecord[] }>(exec('rex', ['block', 'call', '-s', session, '-b', pane.block_id, 'program_status']))?.records ?? [];
    } catch { /* skip it */ }
    const need = paneNeed(Array.isArray(records) ? records : []);
    if (need) waiting.push({ block: pane.block_id, ...need, label: typeof pane.label === 'string' ? pane.label : null });
  }
  const picked = pickPane(waiting, panes.map((pane) => pane.block_id), from);
  if (!picked) return { block: null, label: null, msg: null, waiting: 0 };
  rex(['focus', '-s', session, picked.block], 'focus the pane');
  return { block: picked.block, label: picked.label, msg: picked.msg, waiting: waiting.length };
}
