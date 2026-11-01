/**
 * File mailbox for a bot's main thread: `<dataDir>/bots/<house>/<botId>/thread.jsonl`.
 * One JSON object per line: `{ "id", "role": "user"|"bot"|"system", "text", "at" (ISO) }`.
 * The bot (or a mirror job it runs) appends bot lines; o8 appends the operator's
 * `user` replies, which the bot reads on its next pass. Unknown or
 * malformed lines are skipped so a partial write never breaks the view.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

export interface MailboxMessage {
  id: string;
  role: 'user' | 'bot' | 'system';
  text: string;
  at: string | null;
}

const SAFE = /^[a-zA-Z0-9_-]{1,160}$/;
export const MAILBOX_LIMIT = 500;

export function mailboxPath(house: string, botId: string, dataDir = getDataDir()): string | null {
  if (!SAFE.test(house) || !SAFE.test(botId)) return null;
  return join(dataDir, 'bots', house, botId, 'thread.jsonl');
}

export function mailboxUpdatedAt(path: string | null): number | null {
  if (!path || !existsSync(path)) return null;
  return statSync(path).mtimeMs;
}

export function readMailbox(path: string | null, limit = MAILBOX_LIMIT): MailboxMessage[] {
  if (!path || !existsSync(path)) return [];
  const out: MailboxMessage[] = [];
  readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      const role = raw.role === 'user' || raw.role === 'bot' || raw.role === 'system' ? raw.role : null;
      if (!role || typeof raw.text !== 'string') return;
      out.push({
        id: typeof raw.id === 'string' ? raw.id.slice(0, 160) : `line-${index + 1}`,
        role,
        text: raw.text.slice(0, 20_000),
        at: typeof raw.at === 'string' ? raw.at.slice(0, 40) : null,
      });
    } catch {
      // Skip a torn or foreign line.
    }
  });
  return out.slice(-limit);
}

/** Append one operator reply to the mailbox and return it. */
export function appendMailbox(path: string, text: string, now = new Date()): MailboxMessage {
  const message: MailboxMessage = { id: `o8-${randomUUID()}`, role: 'user', text: text.slice(0, 20_000), at: now.toISOString() };
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(message)}\n`);
  return message;
}
