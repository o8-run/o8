/**
 * File mailbox for a bot's main thread: `<dataDir>/bots/<house>/<botId>/thread.jsonl`.
 * One JSON object per line: `{ "id", "role": "user"|"bot"|"system", "text", "at" (ISO) }`.
 * The bot (or a mirror job it runs) appends; o8 only reads in v1. Unknown or
 * malformed lines are skipped so a partial write never breaks the view.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
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
