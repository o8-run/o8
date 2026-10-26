export const dynamic = 'force-dynamic';

/**
 * GET/POST/DELETE /api/v2/chat-history — persist LLM chat messages per tab
 *
 * Stored at ~/.o8/chat-history/{tabId}.json
 */

import { NextRequest, NextResponse } from 'next/server';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { getDataDir } from '@/lib/data-dir-migration';
import { extractPlanFromTranscript } from '@/lib/llm/plan-extractor';
import { isOrchestratorBackendId, type OrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import { mergeChatMessages } from '@/lib/llm/merge-chat-messages';
import {
  OrchestratorThreadProjectError,
  resolveOrchestratorThreadProjectId,
} from '@/lib/mobile/orchestrator-thread-project';
import { maybeQueueThreadAutoTitle } from '@/lib/llm/thread-auto-title';
import {
  deleteCanonicalChatHistoryRecord,
  getCanonicalChatHistoryPath,
  persistCanonicalChatHistoryRecord,
  readPersistedLlmChat,
  withCanonicalChatHistoryLock,
} from '@/lib/llm/chat-history-store';
import { resolveRepoGithubIdentity } from '@/lib/repos/github-identity';
import { resolveThreadRepoMetadata } from '@/lib/llm/thread-repo-metadata';
import { matchesMutationWorkspace, mutationWorkspace } from '@/lib/repos/mutation-workspace';
import { normalizePersistedChatTitle, resolvePersistedChatHistoryTitle } from '@/lib/llm/chat-history-title';
import type { MobilePendingTurnWorkers } from '@/lib/mobile/types';
import { consumePendingTurnWorkers } from '@/lib/mobile/turn-receipt';
import {
  chatHistoryRevision,
  ensureStableChatMessageIds,
  pageChatHistoryMessages,
  parseChatHistoryPageRequest,
} from '@/lib/llm/chat-history-pagination';

const HISTORY_DIR = join(getDataDir(), 'chat-history');

function ensureDir() {
  mkdirSync(HISTORY_DIR, { recursive: true });
}

function safePath(tabId: string): string {
  return getCanonicalChatHistoryPath(tabId);
}

function normalizePlanText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeNullableDate(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** The orchestrator backend that produced this thread, if the client tagged it. */
function normalizeBackend(value: unknown): OrchestratorBackendId | undefined {
  return isOrchestratorBackendId(value) ? value : undefined;
}

/** The openclaw agent id that produced this thread, if the client tagged it. */
function normalizeAgent(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 128) : undefined;
}

function normalizeSessionIds(value: unknown): Record<string, string | null> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
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
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeModel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 128) : undefined;
}

function normalizeTitle(value: unknown): string | undefined {
  return normalizePersistedChatTitle(value);
}

function isThoughtsThread(tabId: unknown): tabId is string {
  return typeof tabId === 'string' && tabId.startsWith('thoughts-');
}

function inferBackendFromModel(model: string | undefined): OrchestratorBackendId | undefined {
  const normalized = model?.toLowerCase();
  if (!normalized) return undefined;
  if (normalized.includes('openclaw')) return 'openclaw';
  if (normalized.includes('claude')) return 'claude';
  if (normalized.includes('codex') || normalized.startsWith('gpt')) return 'codex';
  return undefined;
}

function inferBackendFromSessionIds(
  sessionIds: Record<string, string | null> | undefined,
): 'codex' | 'claude' | undefined {
  if (sessionIds?.claude) return 'claude';
  if (sessionIds?.codex) return 'codex';
  return undefined;
}

function defaultModelForBackend(
  backend: OrchestratorBackendId | undefined | null,
): string | undefined {
  if (backend === 'claude') return 'claude-code';
  if (backend === 'codex') return 'codex';
  if (backend === 'openclaw') return 'openclaw';
  if (backend === 'hermes') return 'hermes';
  return undefined;
}

function emptyHistoryRecord(): Record<string, unknown> {
  return {
    messages: [],
    model: null,
    savedAt: null,
    starred: false,
    title: null,
    planText: null,
    repoName: null,
    repoPath: null,
    repoBranch: null,
    projectId: null,
    githubOwner: null,
    githubRepo: null,
    remoteUrl: null,
    backend: null,
    agent: null,
    archivedAt: null,
    orchestratorSessionIds: null,
    orchestratorSessionUpdatedAt: null,
    exists: false,
  };
}

function serverTimingHeader(startedAt: number): Record<string, string> {
  return { 'Server-Timing': `total;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)}` };
}

export async function GET(request: NextRequest) {
  const startedAt = performance.now();
  const tabId = request.nextUrl.searchParams.get('tabId');
  if (!tabId) return NextResponse.json({ error: 'tabId required' }, { status: 400, headers: serverTimingHeader(startedAt) });

  const filePath = safePath(tabId);
  let parsed: Record<string, unknown>;
  try {
    const data = readFileSync(filePath, 'utf-8');
    parsed = JSON.parse(data) as Record<string, unknown>;
  } catch {
    parsed = emptyHistoryRecord();
  }

  const stableRecord = {
    ...parsed,
    messages: ensureStableChatMessageIds(Array.isArray(parsed.messages) ? parsed.messages : []),
    projectId: typeof parsed.projectId === 'string' && parsed.projectId.trim()
      ? parsed.projectId.trim()
      : null,
  };
  const pageRequest = parseChatHistoryPageRequest(
    request.nextUrl.searchParams.get('limit'),
    request.nextUrl.searchParams.get('before'),
  );
  let responseRecord: Record<string, unknown> = stableRecord;
  if (pageRequest) {
    const revision = chatHistoryRevision(stableRecord);
    const result = pageChatHistoryMessages(stableRecord.messages, pageRequest, revision);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, currentRevision: result.currentRevision },
        { status: 409, headers: serverTimingHeader(startedAt) },
      );
    }
    responseRecord = {
      ...stableRecord,
      messages: result.messages,
      page: result.page,
    };
  }

  const githubIdentity = resolveRepoGithubIdentity(responseRecord.repoPath, responseRecord.remoteUrl);
  return NextResponse.json({
    ...responseRecord,
    githubOwner: githubIdentity.githubOwner,
    githubRepo: githubIdentity.githubRepo,
  }, { headers: serverTimingHeader(startedAt) });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body?.tabId || !body?.messages) {
    return NextResponse.json({ error: 'tabId and messages required' }, { status: 400 });
  }

  return withCanonicalChatHistoryLock(body.tabId, () => {
  ensureDir();
  const filePath = safePath(body.tabId);

  const workspace = mutationWorkspace(request);
  const prior = readPersistedLlmChat(body.tabId);
  if ((existsSync(filePath) && !matchesMutationWorkspace(workspace, prior?.history.repoPath))
    || ((body.repoPath !== undefined || !prior) && !matchesMutationWorkspace(workspace, body.repoPath))) {
    return NextResponse.json({ error: 'History was not found' }, { status: 404 });
  }

  // Don't save images in history (too large) — strip data URIs
  const messages = ensureStableChatMessageIds(body.messages.map((m: Record<string, unknown>) => ({
    ...m,
    images: undefined, // strip image data URIs from persistence
    // Strip data URIs from content too (they'd be huge)
    content: typeof m.content === 'string'
      ? (m.content as string).replace(/!\[[^\]]*\]\(data:[^)]+\)/g, '[image]')
      : m.content,
  })));
  // Preserve starred status from existing file
  let starred = false;
  let pinned = false;
  let title: string | undefined;
  let titleSource: 'code' | 'llm' | 'operator' | undefined;
  let autoTitledAtCount: number | undefined;
  let planText: string | undefined;
  let repoName: string | undefined;
  let repoPath: string | undefined;
  let repoBranch: string | undefined;
  let existingProjectId: unknown = null;
  let remoteUrl: string | null | undefined;
  let backend: OrchestratorBackendId | undefined;
  let agent: string | undefined;
  let archivedAt: string | null | undefined;
  let orchestratorVisible: boolean | undefined;
  let mobileCreatedAt: string | null | undefined;
  let mobileRevealRequestedAt: string | null | undefined;
  let orchestratorSessionIds: Record<string, string | null> | undefined;
  let orchestratorSessionUpdatedAt: string | null | undefined;
  let codexSessionHandoff: unknown;
  let pendingTurnWorkers: MobilePendingTurnWorkers | undefined;
  let model: string | undefined;
  let existingMessages: Array<Record<string, unknown>> = [];
  try {
    const existing = JSON.parse(readFileSync(filePath, 'utf-8'));
    existingMessages = ensureStableChatMessageIds(Array.isArray(existing.messages) ? existing.messages : []);
    starred = existing.starred || false;
    pinned = existing.pinned === true;
    model = normalizeModel(existing.model);
    title = normalizeTitle(existing.title);
    // Title provenance and refresh state are server-owned, never taken from body.
    titleSource = existing.titleSource === 'code' || existing.titleSource === 'llm'
      || existing.titleSource === 'operator' ? existing.titleSource : undefined;
    autoTitledAtCount = typeof existing.autoTitledAtCount === 'number'
      && Number.isInteger(existing.autoTitledAtCount) && existing.autoTitledAtCount >= 0
      ? existing.autoTitledAtCount : undefined;
    planText = normalizePlanText(existing.planText);
    repoName = existing.repoName;
    repoPath = existing.repoPath;
    repoBranch = existing.repoBranch;
    existingProjectId = existing.projectId;
    remoteUrl = existing.remoteUrl;
    backend = normalizeBackend(existing.backend);
    agent = normalizeAgent(existing.agent);
    archivedAt = normalizeNullableDate(existing.archivedAt);
    orchestratorVisible = existing.orchestratorVisible === true ? true : undefined;
    mobileCreatedAt = normalizeNullableDate(existing.mobileCreatedAt);
    mobileRevealRequestedAt = normalizeNullableDate(existing.mobileRevealRequestedAt);
    orchestratorSessionIds = normalizeSessionIds(existing.orchestratorSessionIds);
    orchestratorSessionUpdatedAt = normalizeNullableDate(existing.orchestratorSessionUpdatedAt);
    codexSessionHandoff = existing.codexSessionHandoff;
    pendingTurnWorkers = existing.pendingTurnWorkers;
  } catch { /* new file */ }

  // #1282 — non-destructive by default: merge the inbound transcript onto the
  // stored one so a partial/stale POST (e.g. a client that missed a streamed
  // reply) can never drop a stored turn. Intentional truncation (edit-and-resend
  // / delete in the single-writer Assistant tab) passes `replace: true` for a
  // full replace, since a shorter array can't be told apart from a partial here.
  const finalMessages = ensureStableChatMessageIds(body.replace === true
    ? messages
    : mergeChatMessages(existingMessages, messages));
  const selectedPendingTurnWorkers = Object.prototype.hasOwnProperty.call(body, 'pendingTurnWorkers')
    ? body.pendingTurnWorkers as MobilePendingTurnWorkers | undefined
    : pendingTurnWorkers;
  const consumed = consumePendingTurnWorkers(selectedPendingTurnWorkers, finalMessages);
  const extractedPlanText = extractPlanFromTranscript(consumed.messages.map((m: Record<string, unknown>) => ({
    role: typeof m.role === 'string' ? m.role : undefined,
    content: m.content,
    toolCalls: m.toolCalls,
  })));

  const nextArchivedAt = body.archivedAt !== undefined
    ? normalizeNullableDate(body.archivedAt) ?? null
    : archivedAt ?? null;
  const nextSessionIds = normalizeSessionIds(body.orchestratorSessionIds) ?? orchestratorSessionIds ?? {};
  const explicitBackend = normalizeBackend(body.backend);
  const nextBackend = explicitBackend
    ?? backend
    ?? inferBackendFromSessionIds(nextSessionIds)
    ?? inferBackendFromModel(normalizeModel(body.model) ?? model)
    ?? (isThoughtsThread(body.tabId) ? 'claude' : undefined)
    ?? null;
  const nextModel = normalizeModel(body.model)
    ?? model
    ?? defaultModelForBackend(nextBackend)
    ?? (isThoughtsThread(body.tabId) && nextBackend !== 'openclaw' ? 'claude-code' : undefined);
  const repoMetadata = resolveThreadRepoMetadata({
    tabId: body.tabId,
    existingRepoPath: repoPath,
    existingRepoName: repoName,
    existingRepoBranch: repoBranch,
    bodyRepoPath: body.repoPath,
    bodyRepoName: body.repoName,
    bodyRepoBranch: body.repoBranch,
  });
  let projectId: string | null;
  try {
    projectId = resolveOrchestratorThreadProjectId(existingProjectId, body.projectId);
  } catch (error) {
    if (error instanceof OrchestratorThreadProjectError) {
      return NextResponse.json({ error: error.toPayload() }, { status: 422 });
    }
    throw error;
  }

  const persistedRecord = {
    messages: consumed.messages,
    model: nextModel,
    savedAt: new Date().toISOString(),
    starred: body.starred ?? starred,
    pinned: body.pinned ?? pinned,
    title: resolvePersistedChatHistoryTitle({
      tabId: body.tabId,
      existingTitle: title,
      incomingTitle: body.title,
    }),
    titleSource,
    autoTitledAtCount,
    planText: normalizePlanText(body.planText) ?? planText ?? extractedPlanText,
    repoName: repoMetadata.repoName,
    repoPath: repoMetadata.repoPath,
    repoBranch: repoMetadata.repoBranch,
    projectId,
    remoteUrl: body.remoteUrl ?? remoteUrl ?? null,
    backend: nextBackend,
    agent: normalizeAgent(body.agent) ?? agent ?? null,
    archivedAt: nextArchivedAt,
    orchestratorVisible,
    mobileCreatedAt,
    mobileRevealRequestedAt,
    orchestratorSessionIds: nextSessionIds,
    orchestratorSessionUpdatedAt: normalizeNullableDate(body.orchestratorSessionUpdatedAt) ?? orchestratorSessionUpdatedAt ?? null,
    codexSessionHandoff,
    pendingTurnWorkers: consumed.pending,
  };
  try {
    persistCanonicalChatHistoryRecord(body.tabId, persistedRecord);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'chat persist failed';
    console.error('[chat-history] POST failed', { tabId: body.tabId, message });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }

  // Once the thread has a real exchange, queue optional model titling with a
  // deterministic code fallback. This never blocks the history save.
  if (consumed.messages.length >= 2) maybeQueueThreadAutoTitle(filePath);

  return NextResponse.json({ ok: true });
  });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body?.tabId) return NextResponse.json({ error: 'tabId required' }, { status: 400 });

  // Full read-modify-write: hold the history lock like POST does, or a PATCH
  // racing a turn-receipt write would put the pre-race snapshot back on disk.
  return withCanonicalChatHistoryLock(body.tabId, () => {
  ensureDir();

  const saved = readPersistedLlmChat(body.tabId);
  const workspace = mutationWorkspace(request);
  // The composer selects a repository before its first transcript save. Only
  // that explicit selection may create a record; unknown archive/pin ids may not.
  const selectionFields = new Set(['tabId', 'repoPath', 'repoName', 'repoBranch', 'remoteUrl']);
  const newSelection = !saved && typeof body.tabId === 'string' && body.tabId.startsWith('thoughts-')
    && !existsSync(safePath(body.tabId))
    && typeof body.repoPath === 'string' && isAbsolute(body.repoPath)
    && Object.keys(body).every(key => selectionFields.has(key))
    && matchesMutationWorkspace(workspace, body.repoPath);
  if ((!saved && !newSelection) || (saved && !matchesMutationWorkspace(workspace, saved.history.repoPath))
    || (body.repoPath !== undefined && !matchesMutationWorkspace(workspace, body.repoPath))) {
    return NextResponse.json({ error: 'History was not found' }, { status: 404 });
  }
  const data: Record<string, unknown> = saved ? { ...saved.history }
    : { messages: [], savedAt: new Date().toISOString(), starred: false, projectId: null };

  if (body.starred !== undefined) data.starred = body.starred;
  if (body.pinned !== undefined) data.pinned = body.pinned;
  if (body.title !== undefined) {
    data.title = body.title;
    // Operator rename is sacred — the auto-titler never overwrites it.
    data.titleSource = 'operator';
  }
  if (body.planText !== undefined) data.planText = normalizePlanText(body.planText) ?? null;
  if (body.repoName !== undefined) data.repoName = body.repoName;
  if (body.repoPath !== undefined) data.repoPath = body.repoPath;
  if (body.repoBranch !== undefined) data.repoBranch = body.repoBranch;
  if (body.remoteUrl !== undefined) data.remoteUrl = body.remoteUrl;
  if (body.backend !== undefined) data.backend = normalizeBackend(body.backend) ?? null;
  if (body.agent !== undefined) data.agent = normalizeAgent(body.agent) ?? null;
  if (body.archivedAt !== undefined) data.archivedAt = normalizeNullableDate(body.archivedAt) ?? null;
  if (body.orchestratorSessionIds !== undefined) data.orchestratorSessionIds = normalizeSessionIds(body.orchestratorSessionIds) ?? {};
  if (body.orchestratorSessionUpdatedAt !== undefined) {
    data.orchestratorSessionUpdatedAt = normalizeNullableDate(body.orchestratorSessionUpdatedAt) ?? null;
  }

  try {
    persistCanonicalChatHistoryRecord(body.tabId, data as { messages: unknown[]; [key: string]: unknown });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'chat update failed';
    console.error('[chat-history] PATCH failed', { tabId: body.tabId, message });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
  });
}

export async function DELETE(request: NextRequest) {
  const tabId = request.nextUrl.searchParams.get('tabId');
  if (!tabId) return NextResponse.json({ error: 'tabId required' }, { status: 400 });

  return withCanonicalChatHistoryLock(tabId, () => {
  try {
    const saved = readPersistedLlmChat(tabId);
    if (!saved || !matchesMutationWorkspace(mutationWorkspace(request), saved.history.repoPath)) {
      return NextResponse.json({ error: 'History was not found' }, { status: 404 });
    }
    deleteCanonicalChatHistoryRecord(tabId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    // Surface the actual failure so the client can show a toast and
    // skip the optimistic UI removal. Silent-catch + 200 OK used to
    // make the deleted item reappear after the next list refetch.
    const message = error instanceof Error ? error.message : 'unlink failed';
    console.error('[chat-history] DELETE failed', { tabId, message });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
  });
}
