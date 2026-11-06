import 'server-only';

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { readPersistedLlmChat } from '@/lib/llm/chat-history-store';
import { DISCOVERED_IMPORT_TAB_PREFIX } from '@/lib/llm/chat-history-title';
import { resolveCodexDiscoveredSessionHome } from '@/lib/codex/sessions';
import { codexRuntime } from '@/lib/runtimes/codex';
import { claudeCodeRuntime } from '@/lib/runtimes/claude-code';
import { matchesMutationWorkspace } from '@/lib/repos/mutation-workspace';

export interface DiscoveredImportSession {
  sessionKey: string;
  backend: 'codex' | 'claude';
  providerSessionId: string;
  title: string;
  repoPath: string;
  repoName: string;
  repoBranch: string | null;
}
export interface ImportedSession {
  sessionKey: string;
  tabId: string;
}

/** Explicit discovery, including historical sessions, never launches a provider turn. */
export async function discoverImportSessions(workspace: string | null | undefined): Promise<DiscoveredImportSession[]> {
  const sessions = (await Promise.all([codexRuntime, claudeCodeRuntime].map(runtime =>
    runtime.discoverSessions({ fresh: true, includeHistorical: true })))).flat();
  return sessions.flatMap(session => {
    if (session.ownership !== 'discovered' || !matchesMutationWorkspace(workspace, session.cwd)) return [];
    const match = /^(codex|claude-code):(.+)$/.exec(session.sessionKey);
    if (!match || session.sessionKey.startsWith('claude-code:live-')) return [];
    return [{ sessionKey: session.sessionKey, backend: match[1] === 'codex' ? 'codex' as const : 'claude' as const,
      providerSessionId: match[2], title: session.initialTask || session.displayName,
      repoPath: session.cwd, repoName: basename(session.cwd), repoBranch: session.branch || null }];
  }).sort((a, b) => a.sessionKey.localeCompare(b.sessionKey));
}

/** Inspect all saved bindings, including archived chats and single-row continuations. */
export function importedSessionBindings(workspace: string | null | undefined): Map<string, string> {
  const directory = join(getDataDir(), 'chat-history');
  let files: string[];
  try { files = readdirSync(directory).filter(file => file.endsWith('.json')).sort(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw error;
  }
  const bindings = new Map<string, string>();
  for (const file of files) {
    let record;
    try { record = JSON.parse(readFileSync(join(directory, file), 'utf8')); }
    catch { continue; } // A concurrent delete or an unrelated unreadable history is not a binding.
    if (!Array.isArray(record.messages) || !matchesMutationWorkspace(workspace, record.repoPath)) continue;
    for (const backend of ['codex', 'claude'] as const) {
      const id = record.orchestratorSessionIds?.[backend];
      if (typeof id !== 'string' || !id.trim()) continue;
      const key = `${backend === 'claude' ? 'claude-code' : backend}:${id.trim()}`;
      if (!bindings.has(key)) bindings.set(key, file.slice(0, -5));
    }
  }
  return bindings;
}

export function discoveredImportTabId(sessionKey: string): string {
  return `${DISCOVERED_IMPORT_TAB_PREFIX}${createHash('sha256').update(sessionKey).digest('hex')}`;
}

export function existingImportedSession(sessionKey: string, bindings: Map<string, string>, workspace: string | null | undefined): string | undefined {
  const bound = bindings.get(sessionKey);
  if (bound) return bound;
  // A continued chat may have switched provider sessions. Its import identity
  // remains stable, so a later import must never overwrite that conversation.
  const tabId = discoveredImportTabId(sessionKey);
  const saved = readPersistedLlmChat(tabId);
  return saved && matchesMutationWorkspace(workspace, saved.history.repoPath) ? tabId : undefined;
}

/** Reuse the same source-home/rollout resolver as discovered Continue/resume. */
export async function canImportDiscoveredSession(session: DiscoveredImportSession): Promise<boolean> {
  return session.backend !== 'codex' || Boolean(await resolveCodexDiscoveredSessionHome(session.sessionKey));
}
