import { projectModelContext } from '@/lib/transcripts/model-context';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { readdir as readdirAsync, stat as statAsync } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { persistCanonicalChatHistoryRecord, withCanonicalChatHistoryLock } from '@/lib/llm/chat-history-store';
import type { MobileOrchestratorBackend, MobileOrchestratorThread, MobileTranscriptEntry } from '@/lib/mobile/types';
import { truncateBoundaryWithHandoff } from './orchestrator-handoff-history';
import { appendUserHistoryMessage } from './orchestrator-thread-user-message';
import { ensureOrchestratorHistoryDir as ensureHistoryDir, ORCHESTRATOR_HISTORY_DIR, safeOrchestratorHistoryPath } from './orchestrator-thread-path';
import { resolveOrchestratorThreadProjectId } from './orchestrator-thread-project';
import { buildProjectBoundThreadRecord, type BindOrchestratorThreadProjectInput } from './orchestrator-thread-project-binding';
import { nextOrchestratorThreadId } from './orchestrator-thread-id';
import { isSavedConnectivityCheck } from '@/lib/orchestrator/connectivity-check';
import { repairComposerPreambleHistory, repairFlippedTranscriptHistory } from './orchestrator-thread-history-repair';
import { consumePendingTurnWorkers, mergeMobileTurnReceipts } from './turn-receipt';
import { threadSummaryCache } from './orchestrator-thread-summary-cache';
import {
  inferBackendFromSessionIds,
  modelForBackend,
  normalizeAgent,
  normalizeBackend,
  normalizeErrorMessage,
  normalizeSessionIds,
  updateNativeSessionId,
  projectOrchestratorThread as projectThread,
  repoNameFromPath,
  trimTitle,
  type ChatHistoryMessage,
  type OrchestratorAssistantUpsertInput,
  type OrchestratorHistoryRecord,
} from './orchestrator-thread-projection';
export { ORCHESTRATOR_HISTORY_DIR, safeOrchestratorHistoryPath } from './orchestrator-thread-path';
const MAX_THREADS = 20;
const DEFAULT_MODEL = 'claude-code';
const DEFAULT_BACKEND: MobileOrchestratorBackend = 'claude';
export interface OrchestratorThreadRevealRequest {
  requestedAt: string;
  thread: MobileOrchestratorThread;
}

type OrchestratorHistoryFileStat = {
  file: string;
  filePath: string;
  tabId: string;
  mtimeMs: number;
  size: number;
  modifiedAt: string;
};

let historyWriteVersion = 0;

function readHistoryRecord(tabId: string): OrchestratorHistoryRecord | null {
  ensureHistoryReady();
  try {
    return JSON.parse(readFileSync(safeOrchestratorHistoryPath(tabId), 'utf-8')) as OrchestratorHistoryRecord;
  } catch {
    return null;
  }
}

/**
 * Read ordered user/assistant messages with retained summary context, which
 * the free `o8` orchestrator backend replays to the gateway
 * each turn (it holds no session of its own). Empty (never null) when the thread
 * has no file yet or no usable turns. Reads straight from disk so it reflects
 * the user message ws-server persists just before calling the backend.
 */
/**
 * One message with its attribution — who actually produced it.
 *
 * `backend`/`model` are undefined for user messages (a human wrote them) and
 * for assistant messages written before per-message stamping landed
 * (2026-08-04). Undefined means UNKNOWN. Do not substitute the thread's
 * current backend: that value moves with the newest agent, and using it as a
 * fallback re-creates the exact mis-attribution the stamp prevents.
 */
export interface AttributedThreadMessage {
  role: 'user' | 'assistant';
  content: string;
  backend?: string;
  model?: string;
}

/**
 * The thread's messages WITH attribution, plus the indices where the
 * responding agent changed — the seams a handoff renders at.
 *
 * A seam is only reported between two messages that both carry attribution.
 * An unstamped legacy turn adjacent to a stamped one is not a handoff; it is
 * missing data, and drawing a seam there would invent an event.
 */
export function readAttributedThreadMessages(
  tabId: string | null | undefined,
): { messages: AttributedThreadMessage[]; seams: number[] } {
  if (!tabId) return { messages: [], seams: [] };
  const record = readHistoryRecord(tabId);
  if (!record?.messages) return { messages: [], seams: [] };

  const messages: AttributedThreadMessage[] = [];
  for (const message of record.messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    if (typeof message.content !== 'string' || message.content.trim().length === 0) continue;
    messages.push({
      role: message.role,
      content: message.content,
      backend: typeof message.backend === 'string' && message.backend ? message.backend : undefined,
      model: typeof message.model === 'string' && message.model ? message.model : undefined,
    });
  }

  const seams: number[] = [];
  let previous: { backend?: string; model?: string } | null = null;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== 'assistant' || !message.backend) continue;
    if (previous?.backend && (previous.backend !== message.backend || previous.model !== message.model)) {
      seams.push(index);
    }
    previous = { backend: message.backend, model: message.model };
  }
  return { messages, seams };
}

export function readOrchestratorThreadMessages(
  tabId: string | null | undefined,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  if (!tabId) return [];
  const record = readHistoryRecord(tabId);
  if (!record?.messages) return [];
  const out: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
  for (const message of projectModelContext(record.messages)) {
    if (message.compaction?.source === 'summary' && message.compaction.summary) {
      out.push({ role: 'system', content: message.compaction.summary });
      continue;
    }
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    if (typeof message.content !== 'string' || message.content.trim().length === 0) continue;
    out.push({ role: message.role, content: message.content });
  }
  return out;
}
function writeHistoryRecord(tabId: string, record: OrchestratorHistoryRecord) {
  ensureHistoryDir();
  const filePath = safeOrchestratorHistoryPath(tabId);
  persistCanonicalChatHistoryRecord(tabId, record);
  threadSummaryCache.delete(filePath);
  historyWriteVersion += 1;
}
export function repairFlippedOrchestratorTranscripts(): void {
  repairFlippedTranscriptHistory(ORCHESTRATOR_HISTORY_DIR, writeHistoryRecord);
}
let historyReady = false;
function ensureHistoryReady(): void {
  if (historyReady) return;
  historyReady = true;
  repairFlippedOrchestratorTranscripts();
  repairComposerPreamblePollution();
}
export function repairComposerPreamblePollution(): void {
  repairComposerPreambleHistory(ORCHESTRATOR_HISTORY_DIR, (tabId, record, filePath) => {
    persistCanonicalChatHistoryRecord(tabId, record);
    threadSummaryCache.delete(filePath);
    historyWriteVersion += 1;
  });
}

export function readProjectedThread(tabId: string): MobileOrchestratorThread | null {
  const record = readHistoryRecord(tabId);
  if (!record) return null;
  try {
    const stat = statSync(safeOrchestratorHistoryPath(tabId));
    return projectThread(tabId, record, stat.mtime.toISOString());
  } catch {
    return projectThread(tabId, record, new Date().toISOString());
  }
}

function listThoughtHistoryFileStats(): OrchestratorHistoryFileStat[] {
  ensureHistoryReady();
  if (!existsSync(ORCHESTRATOR_HISTORY_DIR)) {
    threadSummaryCache.clear();
    return [];
  }

  const stats: OrchestratorHistoryFileStat[] = [];
  const livePaths = new Set<string>();
  const files = readdirSync(ORCHESTRATOR_HISTORY_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort();
  for (const file of files) {
    const tabId = basename(file, '.json');
    if (!tabId.startsWith('thoughts-')) continue;
    try {
      const filePath = join(ORCHESTRATOR_HISTORY_DIR, file);
      const stat = statSync(filePath);
      livePaths.add(filePath);
      stats.push({
        file,
        filePath,
        tabId,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      });
    } catch {
      // skip files that moved during the scan
    }
  }

  for (const filePath of threadSummaryCache.keys()) {
    if (!livePaths.has(filePath)) threadSummaryCache.delete(filePath);
  }
  return stats;
}

export function mobileOrchestratorThreadHistoryStatToken(): string {
  const fileToken = listThoughtHistoryFileStats()
    .map((fileStat) => `${fileStat.file}:${fileStat.mtimeMs}:${fileStat.size}`)
    .join('|');
  return `${historyWriteVersion}:${fileToken}`;
}

// Async mirror of listThoughtHistoryFileStats for the ws-server's 1Hz poll,
// which runs on the event loop that streams agent output — the sync version's
// readdirSync + per-file statSync blocked that loop every second. Same
// filtering, sorting, and parse-cache eviction; only the fs calls are async.
async function listThoughtHistoryFileStatsAsync(): Promise<OrchestratorHistoryFileStat[]> {
  ensureHistoryReady();
  let entries: string[];
  try {
    entries = await readdirAsync(ORCHESTRATOR_HISTORY_DIR);
  } catch {
    // Dir absent/unreadable — mirror the sync path's !existsSync branch.
    threadSummaryCache.clear();
    return [];
  }

  const stats: OrchestratorHistoryFileStat[] = [];
  const livePaths = new Set<string>();
  const files = entries.filter((file) => file.endsWith('.json')).sort();
  for (const file of files) {
    const tabId = basename(file, '.json');
    if (!tabId.startsWith('thoughts-')) continue;
    try {
      const filePath = join(ORCHESTRATOR_HISTORY_DIR, file);
      const stat = await statAsync(filePath);
      livePaths.add(filePath);
      stats.push({
        file,
        filePath,
        tabId,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      });
    } catch {
      // skip files that moved during the scan
    }
  }

  for (const filePath of threadSummaryCache.keys()) {
    if (!livePaths.has(filePath)) threadSummaryCache.delete(filePath);
  }
  return stats;
}

// Async form of mobileOrchestratorThreadHistoryStatToken — identical token
// value, no sync fs. Used by the 1Hz ws-server poll.
export async function mobileOrchestratorThreadHistoryStatTokenAsync(): Promise<string> {
  const fileToken = (await listThoughtHistoryFileStatsAsync())
    .map((fileStat) => `${fileStat.file}:${fileStat.mtimeMs}:${fileStat.size}`)
    .join('|');
  return `${historyWriteVersion}:${fileToken}`;
}

export function listMobileOrchestratorThreads(options: {
  backend?: MobileOrchestratorBackend | null;
  limit?: number;
  offset?: number;
} = {}): MobileOrchestratorThread[] {
  const backendFilter = options.backend ?? null;
  const limit = options.limit ?? MAX_THREADS;
  const threads: MobileOrchestratorThread[] = [];

  for (const fileStat of listThoughtHistoryFileStats()) {
    try {
      const thread = threadSummaryCache.read(fileStat);
      // Archived threads are off the active list — the operator archived them to
      // declutter; they must not reappear in the orchestrator history/past-thread
      // surfaces (which is where they were leaking back in).
      if (!thread) continue;
      const threadBackend = thread.backend;
      if (backendFilter ? threadBackend !== backendFilter : threadBackend === 'openclaw') {
        continue;
      }
      threads.push(thread);
    } catch {
      // skip unreadable files
    }
  }

  threads.sort((left, right) => (
    new Date(right.lastMessageAt).getTime() - new Date(left.lastMessageAt).getTime()
  ));
  const offset = options.offset ?? 0;
  return threads.slice(offset, offset + limit);
}

/**
 * The `thoughts-*` ids the operator has archived (record.archivedAt set).
 *
 * The restore pipeline cross-references this so an archived thread's persisted
 * workspace tab does NOT resurrect on reload — archiving removes the thread from
 * the active surfaces and the tab must follow. Unlike listMobileOrchestratorThreads
 * this has NO recency cap and ignores the backend split: it returns EVERY
 * archived id so the client only ever drops genuinely-archived tabs (a top-20
 * or backend-filtered live list would false-positive and strip valid tabs).
 */
export function listArchivedOrchestratorThreadIds(): string[] {
  const ids: string[] = [];
  if (!existsSync(ORCHESTRATOR_HISTORY_DIR)) return ids;

  let files: string[] = [];
  try {
    files = readdirSync(ORCHESTRATOR_HISTORY_DIR).filter((file) => file.endsWith('.json'));
  } catch {
    return ids;
  }

  for (const file of files) {
    const tabId = basename(file, '.json');
    if (!tabId.startsWith('thoughts-')) continue;
    try {
      const record = JSON.parse(
        readFileSync(join(ORCHESTRATOR_HISTORY_DIR, file), 'utf-8'),
      ) as OrchestratorHistoryRecord;
      if (record.archivedAt) ids.push(tabId);
    } catch {
      // skip unreadable files
    }
  }
  return ids;
}

export function createMobileOrchestratorThread(input: {
  repoPath: string;
  projectId?: unknown;
  title?: string | null;
  repoName?: string | null;
  repoBranch?: string | null;
  backend?: MobileOrchestratorBackend | null;
  agent?: string | null;
  reveal?: boolean;
}): MobileOrchestratorThread {
  const repoPath = input.repoPath.trim();
  if (!repoPath) {
    throw new Error('repoPath is required');
  }

  const now = new Date().toISOString();
  const tabId = nextOrchestratorThreadId((candidate) => existsSync(safeOrchestratorHistoryPath(candidate)));
  const backend = input.backend ?? DEFAULT_BACKEND;
  const projectId = resolveOrchestratorThreadProjectId(null, input.projectId);
  const record: OrchestratorHistoryRecord = {
    messages: [],
    model: modelForBackend(backend) ?? DEFAULT_MODEL,
    savedAt: now,
    starred: false,
    pinned: false,
    title: trimTitle(input.title, 'New chat'),
    projectId,
    repoPath,
    repoName: trimTitle(input.repoName, repoNameFromPath(repoPath) ?? 'Project'),
    repoBranch: typeof input.repoBranch === 'string' && input.repoBranch.trim() ? input.repoBranch.trim() : null,
    remoteUrl: null,
    backend,
    agent: normalizeAgent(input.agent),
    archivedAt: null,
    orchestratorVisible: true,
    mobileCreatedAt: now,
    mobileRevealRequestedAt: input.reveal === false ? null : now,
    orchestratorTerminalStatus: null,
    orchestratorTerminalError: null,
    orchestratorTerminalAt: null,
    orchestratorSessionIds: {},
    orchestratorSessionUpdatedAt: null,
  };

  writeHistoryRecord(tabId, record);
  return projectThread(tabId, record, now);
}

export function bindMobileOrchestratorThreadProject(
  input: BindOrchestratorThreadProjectInput,
): MobileOrchestratorThread | null {
  if (!input.tabId.startsWith('thoughts-')) return null;
  writeHistoryRecord(input.tabId, buildProjectBoundThreadRecord(readHistoryRecord(input.tabId), input));
  return readProjectedThread(input.tabId);
}

export function appendMobileOrchestratorUserMessage(input: {
  tabId: string | null | undefined;
  repoPath: string;
  projectId?: unknown;
  message: string;
  messageId?: string;
  media?: MobileTranscriptEntry['media'];
  backend?: MobileOrchestratorBackend | null;
  agent?: string | null;
  timestampMs?: number;
  handoff?: MobileTranscriptEntry['handoff'];
  steerAnchor?: MobileTranscriptEntry['steerAnchor'];
}): MobileOrchestratorThread | null {
  const tabId = input.tabId;
  if (!tabId?.startsWith('thoughts-')) return null;
  const content = input.message.trim();
  if (!content) return readProjectedThread(tabId);
  const timestamp = typeof input.timestampMs === 'number' && Number.isFinite(input.timestampMs)
    ? input.timestampMs
    : Date.now();
  const now = new Date(timestamp);
  const nowIso = now.toISOString();
  const existing: OrchestratorHistoryRecord = readHistoryRecord(tabId) ?? {
    messages: [],
    savedAt: nowIso,
    model: modelForBackend(input.backend ?? DEFAULT_BACKEND) ?? DEFAULT_MODEL,
    starred: false,
    pinned: false,
    title: null,
    repoPath: input.repoPath,
    repoName: repoNameFromPath(input.repoPath),
    backend: input.backend ?? DEFAULT_BACKEND,
    agent: normalizeAgent(input.agent),
    archivedAt: null,
    orchestratorVisible: true,
    orchestratorSessionIds: {},
    orchestratorSessionUpdatedAt: null,
  };
  const projectId = resolveOrchestratorThreadProjectId(existing.projectId, input.projectId);
  const nextMessages = appendUserHistoryMessage({
    messages: Array.isArray(existing.messages) ? existing.messages : [],
    content, messageId: input.messageId, media: input.media,
    handoff: input.handoff, steerAnchor: input.steerAnchor, timestamp,
  });
  writeHistoryRecord(tabId, {
    ...existing,
    messages: nextMessages,
    model: existing.model ?? modelForBackend(input.backend ?? DEFAULT_BACKEND) ?? DEFAULT_MODEL,
    savedAt: nowIso,
    projectId,
    title: typeof existing.title === 'string' && existing.title.trim() ? existing.title.trim() : null,
    repoPath: typeof existing.repoPath === 'string' && existing.repoPath.trim()
      ? existing.repoPath
      : input.repoPath,
    repoName: typeof existing.repoName === 'string' && existing.repoName.trim()
      ? existing.repoName
      : repoNameFromPath(input.repoPath),
    backend: normalizeBackend(existing.backend) ?? input.backend ?? DEFAULT_BACKEND,
    agent: normalizeAgent(input.agent) ?? normalizeAgent(existing.agent),
    orchestratorTerminalStatus: null,
    orchestratorTerminalError: null,
    orchestratorTerminalAt: null,
    mobileRevealRequestedAt: existing.mobileRevealRequestedAt ?? null,
    orchestratorVisible: true,
  });

  return readProjectedThread(tabId);
}

/**
 * Remove an undone turn from durable history, including any partial assistant
 * or tool entries persisted after its user message. Exact message ids keep a
 * rapid pair of identical prompts from truncating the wrong turn.
 */
export function truncateMobileOrchestratorThreadFromMessage(input: {
  tabId: string | null | undefined;
  messageId: string;
}): MobileOrchestratorThread | null {
  const tabId = input.tabId;
  const messageId = input.messageId.trim();
  if (!tabId?.startsWith('thoughts-') || !messageId) return null;
  const existing = readHistoryRecord(tabId);
  if (!existing) return null;
  const messages = Array.isArray(existing.messages) ? existing.messages : [];
  const boundary = messages.findIndex((message) => message.id === messageId);
  if (boundary < 0) return readProjectedThread(tabId);
  const truncateBoundary = truncateBoundaryWithHandoff(messages, boundary);
  writeHistoryRecord(tabId, {
    ...existing,
    messages: messages.slice(0, truncateBoundary),
    savedAt: new Date().toISOString(),
    orchestratorTerminalStatus: null,
    orchestratorTerminalError: null,
    orchestratorTerminalAt: null,
  });
  return readProjectedThread(tabId);
}

export function upsertMobileOrchestratorAssistantMessage(input: OrchestratorAssistantUpsertInput): MobileOrchestratorThread | null {
  const tabId = input.tabId;
  if (!tabId?.startsWith('thoughts-')) return null;
  const content = input.content;
  if ((!content || !content.trim()) && !input.receipt) return null;
  return withCanonicalChatHistoryLock(tabId, () => {
    const existing = readHistoryRecord(tabId);
    if (!existing) {
      // The user-message helper writes the record first. If it's missing here,
      // we skip rather than orphan an assistant-only record on disk.
      return null;
    }
    const now = new Date();
    const nowIso = now.toISOString();
    const messages = Array.isArray(existing.messages) ? existing.messages : [];
    // The caller (ws-server) freezes the assistant timestamp at turn START, which
    // can be a millisecond BEFORE the user message is persisted — that inverts the
    // pair so the timestamp-sorted transcript renders the reply above the question
    // (#transcript-flip). Clamp the assistant strictly after the most recent
    // existing message (the user it's answering) so the turn always reads in order.
    const baseTimestamp = typeof input.timestampMs === 'number' ? input.timestampMs : now.getTime();
    const lastTimestamp = messages.length > 0 ? (messages[messages.length - 1]?.timestamp ?? 0) : 0;
    const timestamp = Math.max(baseTimestamp, lastTimestamp + 1);
    // Attribution for THIS turn. Deliberately the explicit inputs only: falling
    // back to `existing.backend` would stamp the previous agent's identity onto a
    // message it did not write, which is precisely the mis-attribution this
    // stamping exists to prevent. Unknown stays undefined.
    const turnBackend = normalizeBackend(input.backend) ?? undefined;
    const turnModel = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : undefined;
    const existingIndex = messages.findIndex((m) => m?.id === input.messageId);
    let nextMessages: ChatHistoryMessage[];
    if (existingIndex >= 0) {
      nextMessages = messages.slice();
      nextMessages[existingIndex] = {
        ...nextMessages[existingIndex],
        role: 'assistant',
        content,
        persistedVersion: (nextMessages[existingIndex]?.persistedVersion ?? 0) + 1,
        // Streaming upserts re-enter here many times per turn; keep whatever was
        // stamped first rather than letting a later call with no backend blank it.
        backend: nextMessages[existingIndex]?.backend ?? turnBackend,
        model: nextMessages[existingIndex]?.model ?? turnModel,
        receipt: mergeMobileTurnReceipts(nextMessages[existingIndex]?.receipt, input.receipt),
        ...(input.tokens ? { tokens: input.tokens } : {}),
      };
    } else {
      // Defensive: if the most recent assistant message has identical content,
      // a full chat client likely POSTed the same turn already. Don't append a
      // duplicate; just refresh metadata via the savedAt write below.
      const last = messages[messages.length - 1];
      if (last?.role === 'assistant' && last.content === content) {
        nextMessages = messages;
      } else {
        nextMessages = [
          ...messages,
          {
            id: input.messageId,
            role: 'assistant',
            content,
            timestamp,
            persistedVersion: 1,
            backend: turnBackend,
            model: turnModel,
            ...(input.receipt ? { receipt: input.receipt } : {}),
            ...(input.tokens ? { tokens: input.tokens } : {}),
          },
        ];
      }
    }
    const explicitBackend = normalizeBackend(input.backend);
    const nextBackend = explicitBackend
      ?? normalizeBackend(existing.backend)
      ?? inferBackendFromSessionIds(existing)
      ?? DEFAULT_BACKEND;

    const { ids: nextSessionIds, touched: sessionIdsTouched } = updateNativeSessionId(
      existing.orchestratorSessionIds, nextBackend, input.sessionId,
    );

    const explicitModel = typeof input.model === 'string' && input.model.trim()
      ? input.model.trim()
      : null;
    const nextModel = explicitModel
      ?? (typeof existing.model === 'string' && existing.model.trim() ? existing.model.trim() : null)
      ?? modelForBackend(nextBackend)
      ?? DEFAULT_MODEL;

    const consumed = consumePendingTurnWorkers(existing.pendingTurnWorkers, nextMessages);
    writeHistoryRecord(tabId, {
      ...existing,
      messages: consumed.messages,
      pendingTurnWorkers: consumed.pending,
      model: nextModel,
      backend: nextBackend,
      agent: normalizeAgent(input.agent) ?? normalizeAgent(existing.agent),
      orchestratorTerminalStatus: null,
      orchestratorTerminalError: null,
      orchestratorTerminalAt: null,
      savedAt: nowIso,
      repoPath: typeof existing.repoPath === 'string' && existing.repoPath.trim()
        ? existing.repoPath
        : input.repoPath,
      repoName: typeof existing.repoName === 'string' && existing.repoName.trim()
        ? existing.repoName
        : repoNameFromPath(input.repoPath),
      orchestratorSessionIds: nextSessionIds,
      orchestratorSessionUpdatedAt: sessionIdsTouched ? nowIso : existing.orchestratorSessionUpdatedAt ?? null,
      orchestratorVisible: existing.orchestratorVisible === false ? false : true,
    });

    return readProjectedThread(tabId);
  });
}

export function markMobileOrchestratorThreadFailed(input: {
  tabId: string | null | undefined;
  repoPath: string;
  error: string;
  assistantMessageId?: string | null;
  backend?: MobileOrchestratorBackend | null;
  agent?: string | null;
  timestampMs?: number;
}): MobileOrchestratorThread | null {
  const tabId = input.tabId;
  if (!tabId?.startsWith('thoughts-')) return null;
  const now = new Date(
    typeof input.timestampMs === 'number' && Number.isFinite(input.timestampMs)
      ? input.timestampMs
      : Date.now(),
  ).toISOString();
  const existing = readHistoryRecord(tabId) ?? {
    messages: [],
    savedAt: now,
    model: modelForBackend(input.backend ?? DEFAULT_BACKEND) ?? DEFAULT_MODEL,
    starred: false,
    pinned: false,
    title: null,
    repoPath: input.repoPath,
    repoName: repoNameFromPath(input.repoPath),
    backend: input.backend ?? DEFAULT_BACKEND,
    agent: normalizeAgent(input.agent),
    archivedAt: null,
    orchestratorVisible: true,
    orchestratorSessionIds: {},
    orchestratorSessionUpdatedAt: null,
  };

  writeHistoryRecord(tabId, {
    ...existing,
    // Receipts reserve a row before any text arrives. A failed turn must not
    // leave that placeholder behind; preserve partial replies and other turns.
    messages: (Array.isArray(existing.messages) ? existing.messages : []).filter(message =>
      !input.assistantMessageId || message.id !== input.assistantMessageId || message.role !== 'assistant'
      || !!message.content?.trim() || !!message.toolCalls?.length || !!message.media?.length),
    model: existing.model ?? modelForBackend(input.backend ?? DEFAULT_BACKEND) ?? DEFAULT_MODEL,
    savedAt: now,
    repoPath: typeof existing.repoPath === 'string' && existing.repoPath.trim()
      ? existing.repoPath
      : input.repoPath,
    repoName: typeof existing.repoName === 'string' && existing.repoName.trim()
      ? existing.repoName
      : repoNameFromPath(input.repoPath),
    backend: normalizeBackend(existing.backend) ?? input.backend ?? DEFAULT_BACKEND,
    agent: normalizeAgent(input.agent) ?? normalizeAgent(existing.agent),
    orchestratorTerminalStatus: 'failed',
    orchestratorTerminalError: normalizeErrorMessage(input.error) ?? 'Orchestrator failed.',
    orchestratorTerminalAt: now,
    orchestratorVisible: true,
  });

  return readProjectedThread(tabId);
}

export function readOrchestratorBackendSessionId(
  tabId: string | null | undefined,
  backend: 'claude' | 'codex',
): string | null {
  if (!tabId?.startsWith('thoughts-')) return null;
  const record = readHistoryRecord(tabId);
  if (!record) return null;
  const sessionIds = normalizeSessionIds(record.orchestratorSessionIds);
  const sessionId = sessionIds[backend];
  return typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null;
}

export function writeOrchestratorBackendSessionId(
  tabId: string | null | undefined,
  backend: 'claude' | 'codex',
  sessionId: string | null,
): void {
  if (!tabId?.startsWith('thoughts-')) return;
  const now = new Date().toISOString();
  const existing = readHistoryRecord(tabId) ?? { messages: [], savedAt: now };
  const nextSessionIds = normalizeSessionIds(existing.orchestratorSessionIds);
  if (sessionId?.trim()) {
    nextSessionIds[backend] = sessionId.trim();
  } else {
    delete nextSessionIds[backend];
  }
  writeHistoryRecord(tabId, {
    ...existing,
    messages: Array.isArray(existing.messages) ? existing.messages : [],
    model: existing.model ?? modelForBackend(backend) ?? DEFAULT_MODEL,
    savedAt: existing.savedAt ?? now,
    backend: normalizeBackend(existing.backend) ?? backend,
    orchestratorSessionIds: nextSessionIds,
    orchestratorSessionUpdatedAt: now,
  });
}

export function clearOrchestratorBackendSessionIds(tabId: string | null | undefined): void {
  if (!tabId?.startsWith('thoughts-')) return;
  const existing = readHistoryRecord(tabId);
  if (!existing) return;
  writeHistoryRecord(tabId, {
    ...existing,
    orchestratorSessionIds: {},
    orchestratorSessionUpdatedAt: new Date().toISOString(),
  });
}

export function requestMobileOrchestratorReveal(tabId: string): OrchestratorThreadRevealRequest | null {
  if (!tabId.startsWith('thoughts-')) return null;
  const record = readHistoryRecord(tabId);
  if (!record) return null;
  const now = new Date().toISOString();
  writeHistoryRecord(tabId, {
    ...record,
    orchestratorVisible: true,
    mobileRevealRequestedAt: now,
  });
  const thread = readProjectedThread(tabId);
  return thread ? { requestedAt: now, thread } : null;
}

export function listMobileOrchestratorRevealRequests(since: string | null): OrchestratorThreadRevealRequest[] {
  const sinceMs = since ? Date.parse(since) : 0;
  const requests: OrchestratorThreadRevealRequest[] = [];
  if (!existsSync(ORCHESTRATOR_HISTORY_DIR)) return requests;
  const files = readdirSync(ORCHESTRATOR_HISTORY_DIR).filter((file) => file.endsWith('.json'));

  for (const file of files) {
    const tabId = basename(file, '.json');
    if (!tabId.startsWith('thoughts-')) continue;
    try {
      const filePath = join(ORCHESTRATOR_HISTORY_DIR, file);
      const stat = statSync(filePath);
      const record = JSON.parse(readFileSync(filePath, 'utf-8')) as OrchestratorHistoryRecord;
      if (isSavedConnectivityCheck(record)) continue;
      const requestedAt = typeof record.mobileRevealRequestedAt === 'string' ? record.mobileRevealRequestedAt : null;
      if (!requestedAt) continue;
      const requestedMs = Date.parse(requestedAt);
      if (!Number.isFinite(requestedMs) || requestedMs <= sinceMs) continue;
      requests.push({
        requestedAt,
        thread: projectThread(tabId, record, stat.mtime.toISOString()),
      });
    } catch {
      // skip unreadable files
    }
  }

  requests.sort((left, right) => Date.parse(left.requestedAt) - Date.parse(right.requestedAt));
  return requests.slice(-10);
}
