/**
 * `o8 packet transcript` — read, or follow, what a packet's worker is doing:
 * the tools it calls, what it says, steers it received, and how it ended.
 *
 * `o8 packet log` shows lane bookkeeping. This shows the work itself, and it
 * works for every worker, including one that has no terminal to attach to.
 */

import { apiFetch, CliError, EXIT } from '../../api.js';
import { resolveConfig, type ResolvedConfig } from '../../config.js';
import { printHumanHeading, printJson, type OutputMode } from '../../output.js';
import { parsePacketArguments, requirePacketId, resolvePacketTarget } from './target.js';

export type TranscriptEvent =
  | { seq: number; ts: string; type: 'tool_call'; callId?: string; tool: string; args: string; summary: string }
  | { seq: number; ts: string; type: 'tool_result'; callId?: string; tool: string; ok: boolean; summary: string }
  | { seq: number; ts: string; type: 'assistant'; text: string }
  | { seq: number; ts: string; type: 'steer'; source: string; text: string; failed?: boolean; note?: string }
  | { seq: number; ts: string; type: 'error'; message: string }
  | { seq: number; ts: string; type: 'done'; exitCode: number };

interface TranscriptPage {
  packetId: string;
  events: TranscriptEvent[];
  nextCursor: number | null;
  terminalReason: { code?: string | null; cause?: string | null } | null;
}

export const TRANSCRIPT_LIMIT_DEFAULT = 50;
export const TRANSCRIPT_LIMIT_MAX = 200;
const FOLLOW_POLL_MS = 2_000;
/** Failed reads in a row before a follow gives up. */
const FOLLOW_RETRIES = 5;
const DETAIL_MAX = 110;
const TEXT_MAX = 1_200;
/** Argument names that say what a tool call is about, most telling first. */
const DETAIL_KEYS = ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description', 'prompt'] as const;
const PATH_KEYS = new Set(['file_path', 'path']);

export interface TranscriptArgs { target: string | null; follow: boolean; limit: number }

export function parseTranscriptArgs(rest: string[]): TranscriptArgs {
  const args = parsePacketArguments(rest, {
    command: 'transcript',
    valueFlags: ['limit'],
    booleanFlags: ['follow'],
    aliases: { '-f': '--follow' },
  });
  let limit = TRANSCRIPT_LIMIT_DEFAULT;
  if (args.values.limit !== undefined) {
    if (!/^\d{1,3}$/.test(args.values.limit) || Number(args.values.limit) < 1 || Number(args.values.limit) > TRANSCRIPT_LIMIT_MAX) {
      throw new CliError('invalid_args', `--limit must be between 1 and ${TRANSCRIPT_LIMIT_MAX}.`, EXIT.INVALID_ARGS);
    }
    limit = Number(args.values.limit);
  }
  return { target: args.target, follow: args.booleans.has('follow'), limit };
}

/**
 * Transcript text comes from a worker and from the files and pages it read, so
 * it is untrusted. Control, invisible and text-direction characters never
 * reach the terminal. With `lines`, line breaks are kept.
 */
export function plainText(raw: unknown, max: number, lines = false): string {
  const text = typeof raw === 'string' ? raw : '';
  const clean = lines
    ? text.replace(/\r\n?/g, '\n').replace(/[^\P{C}\n]+/gu, ' ').replace(/[^\S\n]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    : text.replace(/\p{C}+/gu, ' ').replace(/\s+/g, ' ').trim();
  const characters = [...clean];
  return characters.length <= max ? clean : `${characters.slice(0, max - 1).join('').trimEnd()}…`;
}

/**
 * A packet's worktree sits under a long generated directory. In a command or a
 * path it reads as `.`, which is where the worker is.
 */
function withoutWorktree(text: string): string {
  return text.replace(/[^\s"'=:]*[\\/]\.cortex-worktrees[\\/][^\\/\s"']+/g, '.');
}

/** The last two parts of a path: enough to recognise the file without the worktree prefix. */
function shortPath(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`;
}

/** What a tool call is about, in a few words, taken from its arguments. */
export function toolDetail(event: Extract<TranscriptEvent, { type: 'tool_call' }>): string {
  let parsed: unknown;
  try { parsed = JSON.parse(event.args); } catch { parsed = null; }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const args = parsed as Record<string, unknown>;
    for (const key of DETAIL_KEYS) {
      const value = args[key];
      if (typeof value === 'string' && value.trim()) {
        const local = withoutWorktree(value.trim());
        return plainText(PATH_KEYS.has(key) ? shortPath(local) : local, DETAIL_MAX);
      }
    }
  }
  // Arguments that were cut short, or that name nothing we know, fall back to the summary.
  return plainText(withoutWorktree(event.summary || event.args), DETAIL_MAX);
}

function clock(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  const two = (value: number) => String(value).padStart(2, '0');
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

/**
 * The lines one event prints for a person. A tool result that worked prints
 * nothing: the call line already said what ran.
 */
export function transcriptLines(event: TranscriptEvent, time: (ts: string) => string = clock): string[] {
  const at = time(event.ts);
  const indent = ' '.repeat(at.length + 2);
  switch (event.type) {
    case 'tool_call': {
      const detail = toolDetail(event);
      return [`${at}  ${plainText(event.tool, 32) || 'tool'}${detail ? `  ${detail}` : ''}`];
    }
    case 'tool_result':
      return event.ok ? [] : [`${indent}failed: ${plainText(event.summary, DETAIL_MAX * 2) || 'no details'}`];
    case 'assistant': {
      const text = plainText(event.text, TEXT_MAX, true);
      if (!text) return [];
      return text.split('\n').map((line, index) => (index === 0 ? `${at}  ${line}` : `${indent}${line}`));
    }
    case 'steer':
      return [`${at}  steer from ${plainText(event.source, 40) || 'operator'}${event.failed ? ' (not delivered)' : ''}: ${plainText(event.text, TEXT_MAX)}`];
    case 'error':
      return [`${at}  error: ${plainText(event.message, TEXT_MAX)}`];
    case 'done':
      return [`${at}  finished (exit ${Number.isFinite(event.exitCode) ? event.exitCode : '?'})`];
    default:
      return [];
  }
}

function isEvent(value: unknown): value is TranscriptEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as { seq?: unknown; ts?: unknown; type?: unknown };
  return typeof event.seq === 'number' && typeof event.ts === 'string' && typeof event.type === 'string';
}

async function fetchPage(
  cfg: ResolvedConfig,
  packetId: string,
  query: { recent?: true; cursor?: number; limit: number },
): Promise<TranscriptPage> {
  const response = await apiFetch<{ events?: unknown; nextCursor?: unknown; terminalReason?: unknown }>(
    cfg,
    '/api/orchestrator/packet-transcript',
    {
      query: {
        packetId,
        limit: query.limit,
        // The newest events, numbered as in the whole transcript. Without `history`
        // the server numbers a window on its own, and a cursor from it points nowhere.
        tail: query.recent ? '1' : undefined,
        history: query.recent ? 'complete' : undefined,
        cursor: query.cursor,
      },
    },
  );
  const data = response.data;
  if (!data || !Array.isArray(data.events)) {
    throw new CliError('invalid_response', 'The transcript endpoint returned an invalid response.', EXIT.CONFLICT);
  }
  const reason = data.terminalReason && typeof data.terminalReason === 'object'
    ? data.terminalReason as TranscriptPage['terminalReason']
    : null;
  return {
    packetId,
    events: data.events.filter(isEvent),
    nextCursor: typeof data.nextCursor === 'number' ? data.nextCursor : null,
    terminalReason: reason,
  };
}

function writeEvents(events: TranscriptEvent[], mode: OutputMode): void {
  for (const event of events) {
    if (mode.human) {
      const lines = transcriptLines(event);
      if (lines.length > 0) process.stdout.write(`${lines.join('\n')}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    }
  }
}

/** Lane states in which a worker is, or is about to be, working. */
const WORKING_STATES = new Set(['launching', 'running']);
/** Quiet pages before the packet's state is checked, and between checks. */
const QUIET_PAGES_PER_CHECK = 3;

/**
 * Whether a follow should stop after this page. The worker's own `done` event
 * ends it at once. Otherwise it ends when the transcript has gone quiet and
 * the packet's lane is no longer working, so the last events are never cut
 * off. `state` is the lane's state when it was just checked, `null` when the
 * packet has no lane any more, and `undefined` when it was not checked.
 */
export function followIsOver(
  page: Pick<TranscriptPage, 'events'>,
  quietPages: number,
  state?: string | null,
): boolean {
  if (page.events.some((event) => event.type === 'done')) return true;
  if (page.events.length > 0 || quietPages < QUIET_PAGES_PER_CHECK || state === undefined) return false;
  return state === null || !WORKING_STATES.has(state);
}

/** The state of the packet's newest lane, or `null` when it has none. */
async function laneState(cfg: ResolvedConfig, packetId: string): Promise<string | null> {
  const response = await apiFetch<{ lanes?: Array<{ packetId?: unknown; status?: unknown }> }>(cfg, '/api/lanes', {
    query: { active: 'false' },
  });
  const lanes = (response.data?.lanes ?? []).filter((lane) => lane.packetId === packetId);
  const state = lanes[lanes.length - 1]?.status;
  return typeof state === 'string' ? state : null;
}

async function follow(cfg: ResolvedConfig, packetId: string, start: number, mode: OutputMode): Promise<number> {
  let cursor = start;
  let quietPages = 0;
  let failures = 0;
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    while (!stopped) {
      let page: TranscriptPage;
      let state: string | null | undefined;
      try {
        page = await fetchPage(cfg, packetId, { cursor, limit: TRANSCRIPT_LIMIT_MAX });
        quietPages = page.events.length === 0 ? quietPages + 1 : 0;
        if (quietPages > 0 && quietPages % QUIET_PAGES_PER_CHECK === 0) state = await laneState(cfg, packetId);
        failures = 0;
      } catch (error) {
        failures += 1;
        if (failures >= FOLLOW_RETRIES) throw error;
        await new Promise((resolve) => setTimeout(resolve, FOLLOW_POLL_MS));
        continue;
      }
      writeEvents(page.events, mode);
      if (page.nextCursor !== null) cursor = Math.max(cursor, page.nextCursor);
      if (followIsOver(page, quietPages, state)) {
        if (mode.human && state !== undefined) {
          process.stdout.write(`The worker stopped. The packet is ${state ? plainText(state, 40).replace(/_/g, ' ') : 'gone'}.\n`);
        }
        break;
      }
      // A full page means more is waiting, so read on without a pause.
      if (page.events.length < TRANSCRIPT_LIMIT_MAX) await new Promise((resolve) => setTimeout(resolve, FOLLOW_POLL_MS));
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
  return EXIT.OK;
}

export async function runPacketTranscript(mode: OutputMode, rest: string[]): Promise<number> {
  const args = parseTranscriptArgs(rest);
  const packetId = requirePacketId(await resolvePacketTarget(args.target), 'transcript');
  const cfg = resolveConfig();
  const recent = await fetchPage(cfg, packetId, { recent: true, limit: args.limit });

  if (!args.follow) {
    if (mode.human) {
      printHumanHeading(`packet transcript ${packetId}`);
      writeEvents(recent.events, mode);
      if (recent.events.length === 0) process.stdout.write('No transcript yet.\n');
    } else {
      printJson({ schema: 'o8/cli/packet.transcript/v1', ...recent });
    }
    return EXIT.OK;
  }

  writeEvents(recent.events, mode);
  if (followIsOver(recent, 0)) return EXIT.OK;
  return follow(cfg, packetId, recent.nextCursor ?? 0, mode);
}
