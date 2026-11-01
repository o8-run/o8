/**
 * File mailbox for a bot's main thread: `<dataDir>/bots/<house>/<botId>/thread.jsonl`.
 * One JSON object per line: `{ "id", "role": "user"|"bot"|"system", "text", "at" (ISO) }`.
 * The bot (or a mirror job it runs) appends; o8 only reads in v1. Unknown or
 * malformed lines are skipped so a partial write never breaks the view.
 */
import { existsSync, statSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

export interface MailboxMessage {
  id: string;
  /** Server-owned record identity; source ids and legacy byte offsets are separate namespaces. */
  key: string;
  role: 'user' | 'bot' | 'system';
  text: string;
  at: string | null;
}

const SAFE = /^[a-zA-Z0-9_-]{1,160}$/;
export const MAILBOX_LIMIT = 500;
export const MAILBOX_READ_BYTES = 1024 * 1024;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function mailboxPath(house: string, botId: string, dataDir = getDataDir()): string | null {
  if (!SAFE.test(house) || !SAFE.test(botId)) return null;
  return join(dataDir, 'bots', house, botId, 'thread.jsonl');
}

export function mailboxUpdatedAt(path: string | null): number | null {
  if (!path || !existsSync(path)) return null;
  return statSync(path).mtimeMs;
}

function timestamp(at: string | null): number | null {
  if (!at || !ISO_TIMESTAMP.test(at)) return null;
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTail(bytes: Buffer, start: number, limit: number): MailboxMessage[] {
  // When cropped, the first byte is boundary context, within the I/O budget.
  // The payload starts one byte later; decode only records beginning after a LF.
  let offset = start > 0 ? bytes.indexOf(10) + 1 : 0;
  if (start > 0 && offset === 0) return [];
  const seen = new Set<string>();
  const out: Array<{ message: MailboxMessage; timestamp: number | null }> = [];
  for (let end = bytes.indexOf(10, offset); end >= 0; end = bytes.indexOf(10, offset)) {
    const position = start + offset;
    const line = bytes.toString('utf8', offset, end);
    offset = end + 1;
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      const role = raw.role === 'user' || raw.role === 'bot' || raw.role === 'system' ? raw.role : null;
      if (!role || typeof raw.text !== 'string') continue;
      const suppliedId = typeof raw.id === 'string' && raw.id.length ? raw.id : null;
      const key = suppliedId === null ? `byte:${position}` : `id:${suppliedId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const message: MailboxMessage = {
        id: suppliedId ?? `byte-${position}`,
        key,
        role,
        text: raw.text.slice(0, 20_000),
        at: typeof raw.at === 'string' ? raw.at.slice(0, 40) : null,
      };
      out.push({ message, timestamp: timestamp(message.at) });
    } catch {
      // Skip a torn or foreign line.
    }
  }
  // Mixed/legacy timestamps cannot establish chronology. Keep append order then;
  // otherwise stable sort preserves the first complete append for equal times.
  if (out.every(row => row.timestamp !== null)) {
    out.sort((a, b) => a.timestamp! - b.timestamp!);
  }
  return out.slice(-limit).map(row => row.message);
}

/** Read at most 1 MiB from one descriptor, bounded to its initially observed size. */
export async function readMailbox(path: string | null, limit = MAILBOX_LIMIT): Promise<MailboxMessage[]> {
  const count = Math.min(MAILBOX_LIMIT, Math.max(0, Math.trunc(limit)));
  if (!path || !count) return [];
  let file: FileHandle;
  try {
    file = await open(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  try {
    const { size } = await file.stat();
    const start = Math.max(0, size - MAILBOX_READ_BYTES);
    const bytes = Buffer.alloc(Math.min(size, MAILBOX_READ_BYTES));
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, start + length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    return parseTail(bytes.subarray(0, length), start, count);
  } finally {
    await file.close();
  }
}
