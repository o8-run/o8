/**
 * Turns typed in a thread's Terminal View (#5309), copied into its chat.
 *
 * Opening Terminal View marks how far the CLI's session file reaches; leaving
 * it imports what the CLI wrote after the mark. Session files are append-only,
 * so the mark is a byte offset, and each imported message is keyed by the
 * offset of the line it starts at: importing twice adds nothing. Turns o8 ran
 * from chat in between are never imported, because the next mark moves past
 * them. The chat keeps its provider session; no new one is started.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getCodexRolloutPath } from '@/lib/codex/sessions';
import { getDataDir } from '@/lib/data-dir-migration';
import { readPersistedLlmChat, withCanonicalChatHistoryLock } from '@/lib/llm/chat-history-store';
import { appendMobileOrchestratorUserMessage, upsertMobileOrchestratorAssistantMessage } from '@/lib/mobile/orchestrator-thread-history';

/** One import copies at most this many messages, read from at most this many bytes. */
export const TERMINAL_IMPORT_MAX_MESSAGES = 100;
export const TERMINAL_IMPORT_MAX_BYTES = 2_000_000;
/** Imported messages keep this prefix, so chat-side checks can tell them apart. */
export const TERMINAL_MESSAGE_PREFIX = 'cli-';

type Cli = 'claude' | 'codex';
interface Binding { cli: Cli; sessionId: string; repoPath: string }
/** `open` until the view closes; a mark left open (the app quit in Terminal
 * View) is imported before the next mark moves past it. */
interface Mark { cli: Cli; sessionId: string; file: string | null; offset: number; open?: boolean }
export interface TerminalTurn { id: string; role: 'user' | 'assistant'; text: string; timestampMs?: number }

const TAB_ID = /^thoughts-[A-Za-z0-9_-]{1,120}$/;
const SESSION_ID = /^[A-Za-z0-9._-]{1,200}$/;

function markPath(tabId: string) {
  return join(getDataDir(), 'terminal-turns', `${tabId}.json`);
}

/** The CLI session a thread resumes in Terminal View, as the native view reads it. */
function binding(tabId: string): Binding | null {
  if (!TAB_ID.test(tabId)) return null;
  const history = readPersistedLlmChat(tabId)?.history as Record<string, unknown> | undefined;
  if (!history || typeof history.repoPath !== 'string') return null;
  const ids = (history.orchestratorSessionIds ?? {}) as Record<string, unknown>;
  const backend = typeof history.backend === 'string' ? history.backend : null;
  const cli: Cli | null = backend === 'claude' || backend === 'fable' ? 'claude'
    : backend === 'codex' ? 'codex'
    : backend ? null
    : typeof ids.claude === 'string' ? 'claude' : typeof ids.codex === 'string' ? 'codex' : null;
  if (!cli) return null;
  const raw = typeof ids[cli] === 'string' ? (ids[cli] as string).trim().replace(/^claude-code:/, '') : '';
  return SESSION_ID.test(raw) ? { cli, sessionId: raw, repoPath: history.repoPath } : null;
}

async function sessionFile(cli: Cli, sessionId: string): Promise<string | null> {
  if (cli === 'codex') return getCodexRolloutPath(`codex:${sessionId}`).catch(() => null);
  const projects = join(process.env.CLAUDE_HOME || join(homedir(), '.claude'), 'projects');
  try {
    for (const dir of readdirSync(projects)) {
      const candidate = join(projects, dir, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  } catch { /* no projects yet */ }
  return null;
}

function readMark(tabId: string): Mark | null {
  try {
    const mark = JSON.parse(readFileSync(markPath(tabId), 'utf8')) as Mark;
    return Number.isSafeInteger(mark.offset) && mark.offset >= 0 ? mark : null;
  } catch {
    return null;
  }
}

function writeMark(tabId: string, mark: Mark) {
  mkdirSync(join(getDataDir(), 'terminal-turns'), { recursive: true });
  writeFileSync(markPath(tabId), JSON.stringify(mark));
}

/** Terminal View opened: later lines of the session file are the terminal's. */
export async function markTerminalTurns(tabId: string): Promise<{ marked: boolean; turns: number }> {
  const bound = binding(tabId);
  if (!bound) return { marked: false, turns: 0 };
  let turns = 0;
  for (let round = 0; readMark(tabId)?.open && round < 20; round += 1) {
    const caught = await importTerminalTurns(tabId);
    turns += caught.turns;
    if (!caught.more) break;
  }
  const file = await sessionFile(bound.cli, bound.sessionId);
  writeMark(tabId, { cli: bound.cli, sessionId: bound.sessionId, file, offset: file ? statSync(file).size : 0, open: true });
  return { marked: true, turns };
}

function text(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part): part is { type: string; text: string } => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text).join('\n');
}

function time(value: unknown) {
  const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : undefined;
}

/** The user and assistant messages one session-file line holds. */
export function terminalLine(cli: Cli, line: string): Omit<TerminalTurn, 'id'> | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (cli === 'codex') {
    const payload = (parsed.payload ?? {}) as Record<string, unknown>;
    if (parsed.type !== 'event_msg' || typeof payload.message !== 'string' || !payload.message.trim()) return null;
    const role = payload.type === 'user_message' ? 'user' : payload.type === 'agent_message' ? 'assistant' : null;
    return role ? { role, text: payload.message.trim(), timestampMs: time(parsed.timestamp) } : null;
  }
  if ((parsed.type !== 'user' && parsed.type !== 'assistant') || parsed.isSidechain || parsed.isMeta) return null;
  const message = (parsed.message ?? {}) as Record<string, unknown>;
  const body = text(message.content).trim();
  // Slash-command echoes and tool results are the CLI's, not a turn.
  if (!body || body.startsWith('<command-') || body.startsWith('<local-command-')) return null;
  return { role: parsed.type, text: body, timestampMs: time(parsed.timestamp) };
}

/** Complete lines from `offset`, as turns keyed by where they start. Consecutive
 * assistant lines are one reply. Returns the offset after the last line read. */
export function readTerminalTurns(cli: Cli, file: string, offset: number) {
  const size = statSync(file).size;
  const length = Math.min(size - offset, TERMINAL_IMPORT_MAX_BYTES);
  if (length <= 0) return { turns: [] as TerminalTurn[], next: Math.min(offset, size), more: false };
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buffer, 0, length, offset);
  } finally {
    closeSync(fd);
  }
  const turns: TerminalTurn[] = [];
  let start = 0;
  let next = offset;
  let more = offset + length < size;
  for (let end = buffer.indexOf(10); end !== -1; end = buffer.indexOf(10, start)) {
    const at = offset + start;
    const line = terminalLine(cli, buffer.subarray(start, end).toString('utf8'));
    start = end + 1;
    if (line) {
      const last = turns[turns.length - 1];
      if (line.role === 'assistant' && last?.role === 'assistant') {
        last.text = `${last.text}\n\n${line.text}`;
        last.timestampMs = line.timestampMs ?? last.timestampMs;
      } else if (turns.length >= TERMINAL_IMPORT_MAX_MESSAGES) {
        more = true;
        break;
      } else {
        turns.push({ id: `${TERMINAL_MESSAGE_PREFIX}${cli}-${at}`, ...line });
      }
    }
    next = offset + start;
  }
  return { turns, next, more };
}

/** Terminal View closed: copy what the CLI wrote since the mark into the chat. */
export async function importTerminalTurns(tabId: string): Promise<{ turns: number; more: boolean }> {
  const bound = binding(tabId);
  const mark = readMark(tabId);
  if (!bound || !mark) return { turns: 0, more: false };
  // The chat moved to another session: start over from where that one ends.
  if (mark.cli !== bound.cli || mark.sessionId !== bound.sessionId) {
    const file = await sessionFile(bound.cli, bound.sessionId);
    writeMark(tabId, { cli: bound.cli, sessionId: bound.sessionId, file, offset: file ? statSync(file).size : 0 });
    return { turns: 0, more: false };
  }
  const file = mark.file ?? await sessionFile(bound.cli, bound.sessionId);
  if (!file || !existsSync(file)) {
    writeMark(tabId, { ...mark, open: false });
    return { turns: 0, more: false };
  }
  // One import at a time per chat, and none while the chat itself saves.
  return withCanonicalChatHistoryLock(tabId, () => copyTurns(tabId, bound, readMark(tabId) ?? mark, file));
}

function copyTurns(tabId: string, bound: Binding, mark: Mark, file: string) {
  // A file shorter than the mark was replaced; its lines are not new turns.
  if (statSync(file).size < mark.offset) {
    writeMark(tabId, { ...mark, file, offset: statSync(file).size, open: false });
    return { turns: 0, more: false };
  }
  const { turns, next, more } = readTerminalTurns(bound.cli, file, mark.offset);
  const known = new Set((readPersistedLlmChat(tabId)?.history.messages ?? [])
    .map(message => (message as { id?: unknown }).id).filter(id => typeof id === 'string'));
  let users = 0;
  for (const turn of turns) {
    if (known.has(turn.id)) continue;
    if (turn.role === 'user') {
      appendMobileOrchestratorUserMessage({ tabId, repoPath: bound.repoPath, message: turn.text,
        messageId: turn.id, backend: bound.cli, timestampMs: turn.timestampMs });
      users += 1;
    } else {
      upsertMobileOrchestratorAssistantMessage({ tabId, repoPath: bound.repoPath, messageId: turn.id,
        content: turn.text, backend: bound.cli, timestampMs: turn.timestampMs });
    }
  }
  writeMark(tabId, { ...mark, file, offset: next, open: more });
  return { turns: users, more };
}
