import { getDb, getSqlite } from '@/lib/db';
import { approximateSearchResult, boundedTypoSelect, matchedTextSnippet, toFts5Query, toTypoFts5Query } from '@/lib/search/fts';
import type { SearchResult } from '@/lib/search/types';

interface ChatMessage {
  role?: string;
  content?: string;
}

export interface SearchableChatHistoryRecord {
  messages?: unknown;
  model?: unknown;
  savedAt?: unknown;
  starred?: unknown;
  title?: unknown;
  planText?: unknown;
  repoName?: unknown;
  repoPath?: unknown;
  repoBranch?: unknown;
  remoteUrl?: unknown;
}

interface ChatSearchRow {
  tab_id: string;
  messages_json: string;
  title: string | null;
  repo_name: string | null;
  repo_path: string | null;
  repo_branch: string | null;
  remote_url: string | null;
  modified_at: string;
  snippet?: string;
  rank?: number;
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function messagesFrom(value: unknown): ChatMessage[] {
  return Array.isArray(value)
    ? value.filter((message): message is ChatMessage => Boolean(message) && typeof message === 'object')
    : [];
}

export function syncChatHistorySearchRecord(
  tabId: string,
  record: SearchableChatHistoryRecord,
  modifiedAt = new Date().toISOString(),
): void {
  if (!getDb()) return;
  const messages = messagesFrom(record.messages);
  getSqlite().prepare(`
    INSERT INTO chat_history (
      tab_id, messages_json, model, saved_at, modified_at, starred, title,
      plan_text, repo_name, repo_path, repo_branch, remote_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tab_id) DO UPDATE SET
      messages_json = excluded.messages_json,
      model = excluded.model,
      saved_at = excluded.saved_at,
      modified_at = excluded.modified_at,
      starred = excluded.starred,
      title = excluded.title,
      plan_text = excluded.plan_text,
      repo_name = excluded.repo_name,
      repo_path = excluded.repo_path,
      repo_branch = excluded.repo_branch,
      remote_url = excluded.remote_url
  `).run(
    tabId,
    JSON.stringify(messages),
    textOrNull(record.model),
    textOrNull(record.savedAt),
    modifiedAt,
    record.starred === true ? 1 : 0,
    textOrNull(record.title),
    textOrNull(record.planText),
    textOrNull(record.repoName),
    textOrNull(record.repoPath),
    textOrNull(record.repoBranch),
    textOrNull(record.remoteUrl),
  );
}

export function deleteChatHistorySearchRecord(tabId: string): void {
  if (!getDb()) return;
  getSqlite().prepare('DELETE FROM chat_history WHERE tab_id = ?').run(tabId);
}

function rowTitle(row: ChatSearchRow, messages: ChatMessage[]): string {
  if (row.title?.trim()) return row.title;
  const firstUser = messages.find((message) => message.role === 'user' && message.content?.trim());
  return firstUser?.content?.replace(/\s+/g, ' ').slice(0, 60) || 'Untitled conversation';
}

function rowSnippet(messages: ChatMessage[], query: string): string {
  const lowered = query.toLowerCase();
  const tokens = lowered.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const matched = messages.find((message) => {
    const content = message.content?.toLowerCase() ?? '';
    return content.includes(lowered) || tokens.every((token) => content.includes(token));
  });
  const fallback = messages[messages.length - 1];
  return matchedTextSnippet(matched?.content ?? fallback?.content ?? '', query);
}

function resultFromRow(row: ChatSearchRow, query: string, browse: boolean): SearchResult | null {
  let messages: ChatMessage[];
  try {
    messages = messagesFrom(JSON.parse(row.messages_json));
  } catch {
    return null;
  }
  if (messages.length === 0) return null;
  const title = rowTitle(row, messages);
  const snippet = browse ? rowSnippet(messages, query) : row.snippet?.trim() ?? '';
  const modified = Date.parse(row.modified_at);
  return {
    kind: 'chat',
    id: `chat:${row.tab_id}`,
    title,
    detail: snippet || row.repo_name || '',
    target: {
      chatTabId: row.tab_id,
      ...(row.repo_name ? { chatRepoName: row.repo_name } : {}),
      ...(row.repo_path ? { chatRepoPath: row.repo_path } : {}),
      ...(row.repo_branch ? { chatRepoBranch: row.repo_branch } : {}),
      ...(row.remote_url ? { chatRemoteUrl: row.remote_url } : {}),
    },
    score: browse
      ? (Number.isFinite(modified) ? modified : 0)
      : 80 - (row.rank ?? 0) + (title.toLowerCase().includes(query.toLowerCase()) ? 20 : 0),
  };
}

export async function searchConversations(query: string, browse = false): Promise<SearchResult[]> {
  if (!getDb()) return [];
  const sqlite = getSqlite();
  let rows: ChatSearchRow[];
  let recovered: ChatSearchRow[] = [];
  if (browse) {
    rows = sqlite.prepare(`
      SELECT tab_id, messages_json, title, repo_name, repo_path, repo_branch,
        remote_url, modified_at
      FROM chat_history
      WHERE messages_json <> '[]'
      ORDER BY datetime(modified_at) DESC
      LIMIT 8
    `).all() as ChatSearchRow[];
  } else {
    const ftsQuery = toFts5Query(query);
    if (!ftsQuery) return [];
    const select = `
      SELECT ch.tab_id, ch.messages_json, ch.title, ch.repo_name, ch.repo_path,
        ch.repo_branch, ch.remote_url, ch.modified_at,
        snippet(chat_history_fts, 4, char(1), char(2), ' … ', 24) AS snippet,
        bm25(chat_history_fts, 0.0, 8.0, 2.0, 2.0, 1.0) AS rank
      FROM chat_history_fts
      JOIN chat_history ch ON ch.tab_id = chat_history_fts.tab_id
      WHERE chat_history_fts MATCH ?
    `;
    const run = (match: string, recovery = false) => sqlite.prepare(`
      ${recovery ? boundedTypoSelect(select) : select}
      ORDER BY rank, datetime(modified_at) DESC
      LIMIT 8
    `).all(match) as ChatSearchRow[];
    rows = run(ftsQuery);
    const recoveryQuery = toTypoFts5Query(sqlite, 'chat_history_fts', query, rows.length);
    if (recoveryQuery) recovered = run(recoveryQuery, true);
  }
  const strictResults = rows
    .map((row) => resultFromRow(row, query, browse))
    .filter((result): result is SearchResult => result !== null);
  const seen = new Set(strictResults.map(result => result.id));
  return [...strictResults, ...recovered.flatMap(row => {
    const result = resultFromRow(row, query, false);
    if (!result || seen.has(result.id)) return [];
    seen.add(result.id);
    return [approximateSearchResult(result)];
  })].slice(0, 8);
}
