export const dynamic = 'force-dynamic';

/**
 * GET /api/v2/chat-history/list — List all saved LLM chat conversations
 * Optional: ?q=search for full-text search across conversations
 *
 * Returns: { conversations: ChatHistoryEntry[] }
 */

import { NextRequest, NextResponse } from 'next/server';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { performance } from 'node:perf_hooks';
import { getDataDir } from '@/lib/data-dir-migration';
import { orchestratorDisplayTitle, stableNewThreadTitle, stableOrchestratorThreadTitleForId } from '@/lib/orchestrator/thread-title';
import { isOrchestratorBackendId, type OrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import { deleteCanonicalChatHistoryRecord } from '@/lib/llm/chat-history-store';
import { createInboxReadContext, inboxListingState, type inboxProjection, inboxSubject } from '@/lib/inbox/store';
import { isSavedConnectivityCheck } from '@/lib/orchestrator/connectivity-check';

// Empty placeholder files (#597 mint-on-open pattern) get garbage-collected
// after this window — gives the operator time to come back to a fresh tab
// and type, while preventing indefinite accumulation. Pinned / starred
// empties are exempt and never deleted.
const EMPTY_FILE_GC_MS = 60 * 60 * 1000; // 1 hour

const HISTORY_DIR = join(getDataDir(), 'chat-history');

interface ChatHistoryEntry extends ReturnType<typeof inboxProjection> {
  tabId: string;
  title: string;
  preview: string;
  empty: boolean;
  messageCount: number;
  model: string;
  savedAt: string;
  modifiedAt: string;
  starred: boolean;
  pinned: boolean;
  planText?: string | null;
  firstUserMessage?: string | null;
  projectId: string | null;
  repoName?: string | null;
  repoPath?: string | null;
  repoBranch?: string | null;
  remoteUrl?: string | null;
  backend?: OrchestratorBackendId | null;
  agent?: string | null;
  archivedAt?: string | null;
}

function normalizeSessionIds(value: unknown): Record<string, string | null> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized: Record<string, string | null> = {};
  for (const [key, rawSessionId] of Object.entries(value as Record<string, unknown>)) {
    if (!key) continue;
    if (rawSessionId === null) {
      normalized[key] = null;
      continue;
    }
    if (typeof rawSessionId !== 'string') continue;
    const sessionId = rawSessionId.trim();
    if (sessionId) normalized[key] = sessionId;
  }
  return normalized;
}

function inferOrchestratorModel(tabId: string, data: Record<string, unknown>): string {
  if (typeof data.model === 'string' && data.model.trim()) return data.model.trim();
  const backend = typeof data.backend === 'string' ? data.backend : '';
  if (backend === 'claude') return 'claude-code';
  if (backend === 'codex') return 'codex';
  if (backend === 'openclaw') return 'openclaw';
  if (backend === 'hermes') return 'hermes';
  const sessionIds = normalizeSessionIds(data.orchestratorSessionIds);
  if (sessionIds.claude) return 'claude-code';
  if (sessionIds.codex) return 'codex';
  return tabId.startsWith('thoughts-') ? 'claude-code' : 'unknown';
}

export async function GET(request: NextRequest) {
  const startedAt = performance.now();
  const searchQuery = request.nextUrl.searchParams.get('q')?.toLowerCase();
  const includeOrchestrator = request.nextUrl.searchParams.get('include') === 'orchestrator';
  const archivedParam = request.nextUrl.searchParams.get('archived');
  const includeArchived = archivedParam === 'include' || archivedParam === 'true' || archivedParam === '1';
  const onlyArchived = archivedParam === 'only';
  // surface=mobile-assistant restricts the list to mobile-chat-* files where
  // the model is NOT an orchestrator brand. The mobile Assistant tab uses
  // this so desktop LLM tabs (llm-*), orchestrator threads (thoughts-*),
  // legacy mobile-orchestrator-*, and o8-operator-modeled files don't
  // pollute the conversations list.
  const surface = request.nextUrl.searchParams.get('surface');
  const isMobileAssistantOnly = surface === 'mobile-assistant';

  try {
    const files = readdirSync(HISTORY_DIR).filter(f => f.endsWith('.json'));
    const conversations: ChatHistoryEntry[] = [];
    const inbox = createInboxReadContext('conversation');
    // Empty files older than EMPTY_FILE_GC_MS get deleted at the end —
    // can't unlink mid-loop without surprising readdirSync.
    const filesToDelete: string[] = [];

    for (const file of files) {
      try {
        const filePath = join(HISTORY_DIR, file);
        const stat = statSync(filePath);
        const raw = readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw);
        if (isSavedConnectivityCheck(data)) continue;

        if (!data.messages) continue;

        // Skip orchestrator threads unless explicitly requested
        const tabId = basename(file, '.json');
        if (!includeOrchestrator && tabId.startsWith('thoughts-')) continue;

        if (isMobileAssistantOnly) {
          // Only mobile-chat-* files for the mobile Assistant tab.
          if (!tabId.startsWith('mobile-chat-')) continue;
          // Skip any file whose model brand reads as orchestrator (the
          // o8-operator brand string is the orchestrator label) so even
          // a mistitled mobile-chat- file with that model gets excluded.
          const model = typeof data.model === 'string' ? data.model : '';
          if (model === 'o8-operator' || model === 'claude-code') continue;
        }

        const messages = (data.messages ?? []) as { role: string; content: string; timestamp?: number }[];
        const firstUserMsg = messages.find(m => m.role === 'user');
        const lastMsg = messages[messages.length - 1];
        // "Last spoke", not "last touched" (Q ruling 2026-07-16): merely
        // OPENING a thread re-persists its file, so mtime-ordered rails bumped
        // every clicked thread to the top. The newest message timestamp is the
        // truthful recency; mtime remains the fallback for messages that
        // predate timestamps and for empty threads.
        const lastSpokeMs = messages.reduce((max, m) => (
          Number.isFinite(m.timestamp) && (m.timestamp as number) > max ? (m.timestamp as number) : max
        ), 0);
        const isEmpty = messages.length === 0;
        const archivedAt = typeof data.archivedAt === 'string' && data.archivedAt.trim()
          ? data.archivedAt
          : null;
        // Hide empty threads from the list unconditionally — the upfront
        // placeholder-mint pattern (#597) creates one file per opened
        // orchestrator/chat tab, even before the operator types. Those
        // threads are noise in the left rail until they have content.
        // Pinned / starred empties stay visible (operator explicitly cared).
        const explicitlyKept = data.pinned === true
          || data.starred === true
          || (includeOrchestrator && data.orchestratorVisible === true);
        if (isEmpty && !explicitlyKept) {
          // Garbage-collect long-orphaned empty placeholders so they don't
          // accumulate on disk forever. Anything newer than the TTL stays
          // around in case the operator returns to the open tab and types.
          if (Date.now() - stat.mtime.getTime() > EMPTY_FILE_GC_MS) {
            filesToDelete.push(filePath);
          }
          continue;
        }
        if (onlyArchived) {
          if (!archivedAt) continue;
        } else if (!includeArchived && archivedAt) {
          continue;
        }

        // Placeholder title for empty threads (created via + New but not typed into yet).
        // Orchestrator threads keep a neutral fallback instead of using prompt text.
        const saved = data.savedAt ? new Date(data.savedAt) : stat.birthtime ?? stat.mtime;
        const placeholderTitle = tabId.startsWith('thoughts-')
          ? stableOrchestratorThreadTitleForId(tabId, saved)
          : stableNewThreadTitle(saved);

        const title = tabId.startsWith('thoughts-')
          ? orchestratorDisplayTitle(data.title, placeholderTitle)
          : data.title || (firstUserMsg
            ? firstUserMsg.content.slice(0, 60).replace(/\n/g, ' ') + (firstUserMsg.content.length > 60 ? '...' : '')
            : isEmpty ? placeholderTitle : 'Untitled conversation');

        // Preview from last message (empty threads show nothing).
        const preview = lastMsg
          ? lastMsg.content.slice(0, 100).replace(/\n/g, ' ') + (lastMsg.content.length > 100 ? '...' : '')
          : '';

        // Full-text search
        if (searchQuery) {
          const allText = messages.map(m => m.content).join(' ').toLowerCase();
          const repoText = [data.repoName, data.repoPath, data.repoBranch].filter(Boolean).join(' ').toLowerCase();
          if (!allText.includes(searchQuery) && !title.toLowerCase().includes(searchQuery) && !repoText.includes(searchQuery)) {
            continue;
          }
        }

        const subject = inboxSubject('conversation', tabId, data.repoPath, data.projectId, inbox.workspaces);
        const settlement = inboxListingState(subject, inbox);
        conversations.push({
          tabId,
          title,
          preview,
          empty: isEmpty,
          messageCount: messages.length,
          model: inferOrchestratorModel(tabId, data),
          savedAt: data.savedAt || stat.mtime.toISOString(),
          modifiedAt: lastSpokeMs > 0 ? new Date(lastSpokeMs).toISOString() : stat.mtime.toISOString(),
          starred: data.starred || false,
          pinned: data.pinned === true,
          planText: typeof data.planText === 'string' && data.planText.trim() ? data.planText : null,
          firstUserMessage: firstUserMsg ? firstUserMsg.content.slice(0, 500) : null,
          projectId: typeof data.projectId === 'string' && data.projectId.trim() ? data.projectId.trim() : null,
          repoName: data.repoName || null,
          repoPath: data.repoPath || null,
          repoBranch: data.repoBranch || null,
          remoteUrl: data.remoteUrl || null,
          backend: isOrchestratorBackendId(data.backend) ? data.backend : null,
          agent: typeof data.agent === 'string' && data.agent.trim() ? data.agent.trim() : null,
          archivedAt,
          inboxSubject: subject,
          parentInboxSubject: null,
          settledOverride: settlement?.settledOverride ?? null,
          settledAt: settlement?.settledAt ?? null,
          unsettledAt: settlement?.unsettledAt ?? null,
        });
      } catch { /* skip bad files */ }
    }

    // Sort: pinned/starred first, then by date descending.
    conversations.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (a.starred !== b.starred) return a.starred ? -1 : 1;
      return new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime();
    });

    // Opportunistic disk cleanup of orphan empty placeholders. Best-effort —
    // a failure here is silent because the list itself still rendered correctly.
    for (const path of filesToDelete) {
      try { deleteCanonicalChatHistoryRecord(basename(path, '.json')); } catch { /* ignore */ }
    }

    return NextResponse.json({ conversations }, { headers: { 'Server-Timing': `total;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)}` } });
  } catch {
    return NextResponse.json({ conversations: [] }, { headers: { 'Server-Timing': `total;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)}` } });
  }
}
