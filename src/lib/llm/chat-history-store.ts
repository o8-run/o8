import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { mergeChatMessages } from '@/lib/llm/merge-chat-messages';
import {
  deleteChatHistorySearchRecord,
  syncChatHistorySearchRecord,
  type SearchableChatHistoryRecord,
} from '@/lib/search/conversations';
import type {
  MobilePendingTurnWorkers,
  MobileTranscriptEntry,
  MobileTranscriptMedia,
  MobileTranscriptSource,
  MobileTranscriptThinkingStep,
  MobileTranscriptToolCall,
} from '@/lib/mobile/types';
import { consumePendingTurnWorkers } from '@/lib/mobile/turn-receipt';

const HISTORY_DIR = join(getDataDir(), 'chat-history');
const heldHistoryLocks = new Set<string>();
const HISTORY_LOCK_TIMEOUT_MS = 5_000;
const HISTORY_STALE_LOCK_MS = 30_000;
const historyLockWaiter = new Int32Array(new SharedArrayBuffer(4));

export interface PersistedLlmChatMessage {
  steerAnchor?: import('@/lib/transcripts/steer-anchor').SteerTranscriptAnchor;

  id: string;
  role: MobileTranscriptEntry['role'];
  content: string;
  type?: MobileTranscriptEntry['type'];
  media?: MobileTranscriptMedia[];
  backend?: MobileTranscriptEntry['backend'];
  model?: string;
  receipt?: MobileTranscriptEntry['receipt'];
  tokens?: { input: number; output: number };
  costUsd?: number;
  inferenceRoute?: { provider: 'chatgpt-plan'; billing: 'subscription'; allowanceUse: 'unknown'; meter: 'provider-tokens' };
  timestamp: number;
  timestampLabel?: string;
  toolCalls?: MobileTranscriptToolCall[];
  sources?: MobileTranscriptSource[];
  thinking?: string;
  thinkingSteps?: MobileTranscriptThinkingStep[];
  thinkingDurationMs?: number;
  isError?: boolean;
  recalledFacts?: number;
  command?: MobileTranscriptEntry['command'];
  handoff?: MobileTranscriptEntry['handoff'];
  isCompaction?: boolean;
  compactedCount?: number;
  isPartial?: boolean;
  compaction?: MobileTranscriptEntry['compaction'];
}

export interface PersistedLlmChatHistory {
  messages: PersistedLlmChatMessage[];
  model?: string;
  savedAt?: string;
  starred?: boolean;
  title?: string;
  planText?: string;
  repoName?: string;
  repoPath?: string;
  repoBranch?: string;
  remoteUrl?: string | null;
  pendingTurnWorkers?: MobilePendingTurnWorkers;
}

export interface PersistedLlmChatRecord {
  history: PersistedLlmChatHistory;
  modifiedAt: string;
}

function ensureDir() {
  mkdirSync(HISTORY_DIR, { recursive: true });
}

export function getCanonicalChatHistoryPath(tabId: string): string {
  const safe = tabId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(HISTORY_DIR, `${safe}.json`);
}

export type CanonicalChatHistoryRecord = SearchableChatHistoryRecord & {
  [key: string]: unknown;
};

/** Serialize chat-history read/modify/write cycles across the WS and API processes. */
export function withCanonicalChatHistoryLock<T>(tabId: string, task: () => T): T {
  ensureDir();
  const lockPath = `${getCanonicalChatHistoryPath(tabId)}.lock`;
  if (heldHistoryLocks.has(lockPath)) return task();

  const deadline = Date.now() + HISTORY_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > HISTORY_STALE_LOCK_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring chat-history lock for ${tabId}.`);
      }
      Atomics.wait(historyLockWaiter, 0, 0, 10);
    }
  }

  heldHistoryLocks.add(lockPath);
  try {
    return task();
  } finally {
    heldHistoryLocks.delete(lockPath);
    try {
      unlinkSync(lockPath);
    } catch {
      // A stale-lock recovery may already have removed it.
    }
  }
}

export function persistCanonicalChatHistoryRecordUnlocked(
  tabId: string,
  record: CanonicalChatHistoryRecord,
  modifiedAt: string,
): void {
  syncChatHistorySearchRecord(tabId, record, modifiedAt);
  const filePath = getCanonicalChatHistoryPath(tabId);
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporaryPath, JSON.stringify(record));
    renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    } catch {
      // Preserve the original file when temporary cleanup also fails.
    }
    throw error;
  }
}

/**
 * The only canonical chat-history write seam. SQLite is authoritative and is
 * updated first; the file replacement is atomic, so search can never lag a
 * successful durable history write.
 */
export function persistCanonicalChatHistoryRecord(
  tabId: string,
  record: CanonicalChatHistoryRecord,
  modifiedAt = new Date().toISOString(),
): void {
  withCanonicalChatHistoryLock(tabId, () => {
    persistCanonicalChatHistoryRecordUnlocked(tabId, record, modifiedAt);
  });
}

export function deleteCanonicalChatHistoryRecord(tabId: string): void {
  deleteChatHistorySearchRecord(tabId);
  const filePath = getCanonicalChatHistoryPath(tabId);
  if (existsSync(filePath)) unlinkSync(filePath);
}

function stripImages(message: PersistedLlmChatMessage): PersistedLlmChatMessage {
  return {
    ...message,
    content: typeof message.content === 'string'
      ? message.content.replace(/!\[[^\]]*\]\(data:[^)]+\)/g, '[image]')
      : message.content,
  };
}

function normalizePlanText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function readPersistedLlmChat(tabId: string): PersistedLlmChatRecord | null {
  const filePath = getCanonicalChatHistoryPath(tabId);
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const stat = statSync(filePath);
    const history = JSON.parse(raw) as PersistedLlmChatHistory;
    if (!Array.isArray(history.messages)) return null;
    return {
      history,
      modifiedAt: stat.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

export function writePersistedLlmChat(
  tabId: string,
  history: PersistedLlmChatHistory,
  opts?: { replace?: boolean },
) {
  return withCanonicalChatHistoryLock(tabId, () => {
    const filePath = getCanonicalChatHistoryPath(tabId);
    let starred = false;
    let title: string | undefined;
    let planText: string | undefined;
    let existingPendingTurnWorkers: MobilePendingTurnWorkers | undefined;
    let existingMessages: PersistedLlmChatMessage[] = [];
    let sessionMetadata: Record<string, unknown> = {};
    try {
      const existing = JSON.parse(readFileSync(filePath, 'utf-8')) as PersistedLlmChatHistory & Record<string, unknown>;
      existingMessages = Array.isArray(existing.messages) ? existing.messages : [];
      starred = existing.starred || false;
      title = existing.title;
      planText = normalizePlanText(existing.planText);
      existingPendingTurnWorkers = existing.pendingTurnWorkers;
      sessionMetadata = { codexSessionHandoff: existing.codexSessionHandoff,
        orchestratorSessionIds: existing.orchestratorSessionIds,
        orchestratorSessionUpdatedAt: existing.orchestratorSessionUpdatedAt };
    } catch {
      // no existing history
    }

  // #1282 — non-destructive store: merge onto the on-disk transcript so a partial
  // write, or a stale read-modify-write racing a concurrent writer (e.g. the
  // desktop ws-server upserting a reply), can never drop a stored turn. This is
  // the second write path alongside the /api/v2/chat-history route. Pass
  // replace:true only for an intentional truncation (none today).
    const mergedMessages = opts?.replace === true
      ? history.messages
      : mergeChatMessages(existingMessages, history.messages);

    const selectedPendingTurnWorkers = Object.prototype.hasOwnProperty.call(history, 'pendingTurnWorkers')
      ? history.pendingTurnWorkers
      : existingPendingTurnWorkers;
    const consumed = consumePendingTurnWorkers(
      selectedPendingTurnWorkers,
      mergedMessages.map(stripImages),
    );
    const persistedRecord = {
      ...history,
      ...sessionMetadata,
      messages: consumed.messages,
      savedAt: new Date().toISOString(),
      starred: history.starred ?? starred,
      title: history.title ?? title,
      planText: normalizePlanText(history.planText) ?? planText,
      pendingTurnWorkers: consumed.pending,
    };
    persistCanonicalChatHistoryRecordUnlocked(tabId, persistedRecord, new Date().toISOString());
  });
}

export function deletePersistedLlmChat(tabId: string) {
  try {
    deleteCanonicalChatHistoryRecord(tabId);
  } catch {
    // ignore
  }
}

export function listPersistedLlmChats() {
  try {
    if (!existsSync(HISTORY_DIR)) return [];
    return readdirSync(HISTORY_DIR)
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

export function mapLlmHistoryToMobileTranscript(
  messages: PersistedLlmChatMessage[],
  limit?: number,
  pendingTurnWorkers?: MobilePendingTurnWorkers,
): MobileTranscriptEntry[] {
  const withPendingWorkers = consumePendingTurnWorkers(pendingTurnWorkers, messages).messages;
  const filtered = withPendingWorkers
    .filter((message) => !message.isPartial)
    .slice(limit ? -limit : undefined);

  return filtered.map((message) => ({
    id: message.id,
    role: message.role,
    text: message.content,
    type: message.type ?? (message.compaction || message.isCompaction ? 'compaction' : 'message'),
    media: message.media,
    timestamp: message.timestamp,
    timestampLabel: message.timestampLabel ?? (message.timestamp
      ? new Date(message.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      : ''),
    backend: message.backend,
    model: message.model,
    receipt: message.receipt,
    tokens: message.tokens,
    costUsd: message.costUsd,
    toolCalls: message.toolCalls,
    sources: message.sources,
    thinking: message.thinking,
    thinkingSteps: message.thinkingSteps,
    thinkingDurationMs: message.thinkingDurationMs,
    recalledFacts: message.recalledFacts,
    command: message.command,
    handoff: message.handoff,
    steerAnchor: message.steerAnchor,
    compaction: message.compaction,
  }));
}
