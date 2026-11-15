/**
 * Program Status Protocol reports (OSC 7501, revision 0.4).
 *
 * A terminal that reads the sequence shows what the program in a tab is
 * doing: working, finished, or failed. Terminals that do not read it ignore
 * unknown OSC sequences. The sequence is written only to an interactive
 * human-mode terminal known to support it, so agent-facing output is never
 * changed.
 *
 * Reports carry a packet title and a fixed status phrase. They never carry
 * diff content, findings text, blocked reasons, or paths.
 */

import { createHash } from 'node:crypto';

import type { OutputMode } from './output.js';

export type TerminalStatusState = 'idle' | 'working' | 'done' | 'error' | 'clear';

export interface TerminalStatusReport {
  state: TerminalStatusState;
  title?: string | null;
  msg?: string | null;
  /** Addresses a per-packet child record (`o8/<packet>`) instead of o8's own record. */
  packetId?: string | null;
}

const APP = 'o8';
// Every report addresses o8's own record, never the root record, so o8 cannot
// overwrite or clear what the program hosting its terminal has reported.
const RECORD_ID = 'o8';
const TITLE_MAX_BYTES = 192;
const MSG_MAX_BYTES = 2048;
const SEQUENCE_MAX_BYTES = 4096;

// C0 controls, DEL, C1 controls, and the invisible direction, joiner, and
// formatting characters a terminal would otherwise have to disarm. Written as
// escapes so no invisible character lives in this file.
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

function truncateUtf8(text: string, maxBytes: number): string {
  let out = '';
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes) break;
    out += char;
    bytes += size;
  }
  return out;
}

/** One safe line: no control characters, collapsed whitespace, bounded bytes. */
export function sanitizeStatusText(raw: string | null | undefined, maxBytes: number): string {
  if (!raw) return '';
  const cleaned = raw.replace(UNSAFE_TEXT, ' ').replace(/\s+/g, ' ').trim();
  return truncateUtf8(cleaned, maxBytes).trim();
}

function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/**
 * The record id segment for one packet, or an empty string when the packet has
 * no usable id. A segment allows only `[A-Za-z0-9_.+-]` and 32 bytes. An id
 * that already fits is used as it is. Any other id keeps its last 23 safe
 * characters and gains a hash of the whole id, so two different packet ids
 * never share a record.
 */
export function packetRecordSegment(packetId: string | null | undefined): string {
  const id = packetId?.trim() ?? '';
  if (!id) return '';
  if (/^[A-Za-z0-9_.+-]{1,32}$/.test(id)) return id;
  const digest = createHash('sha256').update(id).digest('hex').slice(0, 8);
  return `${id.replace(/[^A-Za-z0-9_.+-]/g, '_').slice(-23)}.${digest}`;
}

/** The record a report addresses: `o8`, or `o8/<packet>` for one packet. */
export function statusRecordId(packetId?: string | null): string {
  const segment = packetRecordSegment(packetId);
  return segment ? `${RECORD_ID}/${segment}` : RECORD_ID;
}

/** Encode one report. Returns an empty string if it would break a protocol limit. */
export function encodeTerminalStatus(report: TerminalStatusReport): string {
  const id = statusRecordId(report.packetId);
  if (report.state === 'clear') return `\x1b]7501;state=clear:id=${id}\x1b\\`;
  const pairs = [`state=${report.state}`, `id=${id}`, `app=${APP}`];
  const title = sanitizeStatusText(report.title, TITLE_MAX_BYTES);
  if (title) pairs.push(`title=${base64(title)}`);
  const msg = sanitizeStatusText(report.msg, MSG_MAX_BYTES);
  if (msg) pairs.push(`msg=${base64(msg)}`);
  const sequence = `\x1b]7501;${pairs.join(':')}\x1b\\`;
  return Buffer.byteLength(sequence, 'utf8') <= SEQUENCE_MAX_BYTES ? sequence : '';
}

interface StatusStream {
  isTTY?: boolean;
  write(chunk: string): unknown;
}

/**
 * Where reports are written, or null when they are off.
 *
 * `O8_TERMINAL_STATUS=0` turns them off. Human output goes to stdout when it
 * is an interactive terminal known to read the sequence (Rex, detected through
 * `REX_SESSION`), or when `O8_TERMINAL_STATUS=1` forces it. JSON output never
 * gains a byte on stdout: forced reports go to stderr, and only when stderr is
 * an interactive terminal.
 */
export function terminalStatusStream(
  mode: OutputMode,
  env: NodeJS.ProcessEnv = process.env,
  stdout: StatusStream = process.stdout,
  stderr: StatusStream = process.stderr,
): StatusStream | null {
  const override = env.O8_TERMINAL_STATUS?.trim();
  if (override === '0') return null;
  const forced = override === '1';
  if (!mode.human) return forced && stderr.isTTY ? stderr : null;
  if (!stdout.isTTY) return null;
  return forced || env.REX_SESSION?.trim() ? stdout : null;
}

export interface TerminalStatusReporter {
  report(report: TerminalStatusReport): void;
}

/** A reporter that writes nothing when reports are off, and skips repeats. */
export function createTerminalStatusReporter(
  mode: OutputMode,
  env: NodeJS.ProcessEnv = process.env,
  stdout: StatusStream = process.stdout,
  stderr: StatusStream = process.stderr,
): TerminalStatusReporter {
  const stream = terminalStatusStream(mode, env, stdout, stderr);
  const last = new Map<string, string>();
  return {
    report(report) {
      if (!stream) return;
      const sequence = encodeTerminalStatus(report);
      if (!sequence) return;
      const id = statusRecordId(report.packetId);
      if (report.state === 'clear') {
        // A clear is always written and never remembered. Clearing o8's own
        // record also removes every per-packet record under it.
        if (id === RECORD_ID) last.clear();
        else last.delete(id);
      } else {
        if (last.get(id) === sequence) return;
        last.set(id, sequence);
      }
      stream.write(sequence);
    },
  };
}

const PACKET_STATUS_REPORTS: Record<string, { state: 'done' | 'error'; msg: string }> = {
  awaiting_review: { state: 'done', msg: 'Awaiting review' },
  released: { state: 'done', msg: 'Released' },
  failed: { state: 'error', msg: 'Failed' },
  blocked: { state: 'error', msg: 'Blocked: needs a decision' },
  archived: { state: 'error', msg: 'Archived without release' },
};

/** The report that stays in the tab once a packet reaches a review or terminal status. */
export function packetStatusReport(
  status: string | null | undefined,
  title: string | null | undefined,
): TerminalStatusReport | null {
  const mapped = status ? PACKET_STATUS_REPORTS[status] : undefined;
  return mapped ? { state: mapped.state, title, msg: mapped.msg } : null;
}

/** The report shown while a watcher is waiting on packets. */
export function watchingStatusReport(
  packets: Array<{ title?: string | null }>,
): TerminalStatusReport {
  const title = packets.length === 1 ? packets[0].title : packets.length > 1 ? `${packets.length} packets` : null;
  return { state: 'working', title, msg: 'Waiting for review' };
}

const PACKET_PROGRESS_PHRASES: Record<string, string> = {
  draft: 'Draft',
  queued: 'Queued',
  launching: 'Starting',
  idle: 'Idle',
  running: 'Running',
  recovering: 'Recovering',
};

/**
 * The most packets that get their own record in one terminal. A terminal must
 * keep at least 64 records and evicts the least recently updated past its cap,
 * so a larger mission keeps the summary and marks only its first packets.
 */
export const PACKET_RECORD_LIMIT = 60;

/**
 * One packet's line while a mission is tailed: its own record under o8's.
 * Returns null for a packet with no usable id, which would otherwise address
 * o8's own record.
 */
export function packetTailReport(packet: {
  id: string;
  status?: string | null;
  title?: string | null;
}): TerminalStatusReport | null {
  if (!packetRecordSegment(packet.id)) return null;
  const finished = packetStatusReport(packet.status, packet.title);
  if (finished) return { ...finished, packetId: packet.id };
  const msg = (packet.status && PACKET_PROGRESS_PHRASES[packet.status]) || 'In progress';
  return { state: 'working', packetId: packet.id, title: packet.title, msg };
}

/** The mission's own line while it is tailed: how many packets have finished. */
export function missionTailReport(
  packets: Array<{ status?: string | null }>,
): TerminalStatusReport {
  const outcomes = packets.map((packet) => packetStatusReport(packet.status, null));
  const settled = outcomes.filter((outcome) => outcome !== null).length;
  const failed = outcomes.filter((outcome) => outcome?.state === 'error').length;
  const title = packets.length === 1 ? '1 packet' : `${packets.length} packets`;
  if (packets.length === 0 || settled < packets.length) {
    return { state: 'working', title, msg: `${settled} of ${packets.length} finished` };
  }
  return failed > 0
    ? { state: 'error', title, msg: `${failed} of ${packets.length} failed, blocked, or archived` }
    : { state: 'done', title, msg: `All ${packets.length} ready for review or released` };
}
