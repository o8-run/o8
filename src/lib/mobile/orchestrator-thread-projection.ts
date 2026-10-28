import { basename } from 'node:path';
import { orchestratorErrorText } from '@/lib/transcripts/orchestrator-error';
import { isOrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import type {
  MobileOrchestratorBackend,
  MobileOrchestratorThread,
  MobilePendingTurnWorkers,
  MobileTranscriptEntry,
} from '@/lib/mobile/types';
import {
  ORCHESTRATOR_RUNTIME_IDS,
  isOrchestratorRuntime,
} from '@/lib/orchestrator/runtime-capabilities';
import { orchestratorDisplayTitle, stableOrchestratorThreadTitleForId } from '@/lib/orchestrator/thread-title';
import { resolveRepoGithubIdentity } from '@/lib/repos/github-identity';

const DEFAULT_MODEL = 'claude-code';

export type ChatHistoryMessage = {
  steerAnchor?: import('@/lib/transcripts/steer-anchor').SteerTranscriptAnchor;

  id?: string;
  role?: string;
  content?: string;
  media?: MobileTranscriptEntry['media'];
  timestamp?: number;
  persistedVersion?: number;
  /**
   * Which backend + model produced THIS message.
   *
   * The record-level `backend`/`model` are "what runs next" and are overwritten
   * on every turn, so once a thread changes hands they describe the newest
   * agent and silently re-attribute every earlier turn to it. Per-message
   * stamping is the only thing that keeps a mixed-agent transcript honest, and
   * it cannot be backfilled — an unstamped turn is unattributable forever.
   *
   * Absent on messages written before 2026-08-04 and on user messages (a human
   * wrote those). Readers must treat undefined as "unknown", never as "the
   * thread's current backend".
   */
  backend?: string;
  model?: string;
  receipt?: MobileTranscriptEntry['receipt'];
  type?: MobileTranscriptEntry['type'];
  pinned?: boolean;
  compaction?: MobileTranscriptEntry['compaction'];
  handoff?: MobileTranscriptEntry['handoff'];
  toolCalls?: MobileTranscriptEntry['toolCalls'];
  tokens?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
};

export interface OrchestratorAssistantUpsertInput {
  tabId: string | null | undefined;
  repoPath: string;
  messageId: string;
  content: string;
  backend?: MobileOrchestratorBackend | null;
  agent?: string | null;
  sessionId?: string | null;
  model?: string | null;
  receipt?: MobileTranscriptEntry['receipt'];
  tokens?: ChatHistoryMessage['tokens'];
  timestampMs?: number;
}

export type OrchestratorHistoryRecord = {
  messages?: ChatHistoryMessage[];
  model?: string | null;
  savedAt?: string | null;
  title?: string | null;
  titleSource?: 'code' | 'llm' | 'operator' | null;
  autoTitledAtCount?: number | null;
  projectId?: string | null;
  repoPath?: string | null;
  repoName?: string | null;
  repoBranch?: string | null;
  remoteUrl?: string | null;
  backend?: string | null;
  agent?: string | null;
  archivedAt?: string | null;
  starred?: boolean;
  pinned?: boolean;
  orchestratorVisible?: boolean;
  mobileCreatedAt?: string | null;
  mobileRevealRequestedAt?: string | null;
  orchestratorTerminalStatus?: 'failed' | null;
  orchestratorTerminalError?: string | null;
  orchestratorTerminalAt?: string | null;
  orchestratorSessionIds?: Record<string, string | null>;
  orchestratorSessionUpdatedAt?: string | null;
  pendingTurnWorkers?: MobilePendingTurnWorkers;
};

export function normalizeSessionIds(value: unknown): Record<string, string | null> {
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

/** Fable is a Claude REPL lead and binds the same native telemetry session. */
export function updateNativeSessionId(value: unknown, backend: MobileOrchestratorBackend, sessionId: unknown) {
  const ids = normalizeSessionIds(value);
  const native = backend === 'fable' ? 'claude' : backend;
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  const touched = (native === 'claude' || native === 'codex') && !!id && ids[native] !== id;
  if (touched) ids[native] = id;
  return { ids, touched };
}

export function normalizeBackend(value: unknown): MobileOrchestratorBackend | null {
  return isOrchestratorBackendId(value) ? value : null;
}

export function normalizeAgent(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 128) : null;
}

export function normalizeErrorMessage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? orchestratorErrorText(trimmed).slice(0, 500) : null;
}

function inferRuntime(model: string | undefined | null): MobileOrchestratorThread['runtime'] {
  if (!model) return 'unknown';
  const lower = model.toLowerCase();
  if (isOrchestratorRuntime(lower)) return lower;
  if (lower.includes('claude')) return 'claude-code';
  if (lower.includes('gemini')) return 'gemini';
  if (lower.includes('opencode')) return 'opencode';
  if (lower.includes('codex') || lower.startsWith('gpt')) return 'codex';
  const matchedRuntime = ORCHESTRATOR_RUNTIME_IDS.find((runtime) => lower.includes(runtime));
  if (matchedRuntime) return matchedRuntime;
  return 'unknown';
}

export function inferBackendFromSessionIds(record: OrchestratorHistoryRecord): MobileOrchestratorBackend | null {
  const sessionIds = normalizeSessionIds(record.orchestratorSessionIds);
  if (sessionIds.claude) return 'claude';
  if (sessionIds.codex) return 'codex';
  return null;
}

export function modelForBackend(backend: MobileOrchestratorBackend | null): string | null {
  if (backend === 'claude') return 'claude-code';
  if (backend === 'codex') return 'codex';
  if (backend === 'openclaw') return 'openclaw';
  if (backend === 'hermes') return 'hermes';
  return null;
}

export function effectiveBackend(record: OrchestratorHistoryRecord): MobileOrchestratorBackend | null {
  return normalizeBackend(record.backend) ?? inferBackendFromSessionIds(record);
}

function effectiveModel(tabId: string, record: OrchestratorHistoryRecord): string | null {
  if (typeof record.model === 'string' && record.model.trim()) return record.model.trim();
  const backendModel = modelForBackend(effectiveBackend(record));
  if (backendModel) return backendModel;
  return tabId.startsWith('thoughts-') ? DEFAULT_MODEL : null;
}

export function trimTitle(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, 80);
}

export function repoNameFromPath(repoPath: string | null): string | null {
  if (!repoPath) return null;
  const name = basename(repoPath.replace(/[/\\]+$/, ''));
  return name || null;
}

export function projectOrchestratorThread(
  tabId: string,
  record: OrchestratorHistoryRecord,
  modifiedAt: string,
): MobileOrchestratorThread {
  const messages = Array.isArray(record.messages) ? record.messages : [];
  const lastMessage = messages[messages.length - 1];
  const fallbackTitle = stableOrchestratorThreadTitleForId(tabId, record.savedAt || modifiedAt);
  const repoPath = typeof record.repoPath === 'string' ? record.repoPath : null;
  const githubIdentity = resolveRepoGithubIdentity(repoPath, record.remoteUrl);
  const lastSpokeMs = messages.reduce((max, message) => (
    Number.isFinite(message?.timestamp) && (message.timestamp as number) > max
      ? (message.timestamp as number)
      : max
  ), 0);

  return {
    id: tabId,
    title: trimTitle(orchestratorDisplayTitle(record.title, fallbackTitle), fallbackTitle),
    lastMessageAt: lastSpokeMs > 0 ? new Date(lastSpokeMs).toISOString() : (record.savedAt || modifiedAt),
    runtime: inferRuntime(effectiveModel(tabId, record)),
    status: record.orchestratorTerminalStatus === 'failed'
      ? 'failed'
      : messages.length === 0
        ? 'idle'
        : lastMessage?.role === 'user' || (lastMessage?.role === 'assistant' && !(lastMessage.content ?? '').trim())
          ? 'busy'
          : 'ready',
    messageCount: messages.length,
    projectId: typeof record.projectId === 'string' && record.projectId.trim()
      ? record.projectId.trim()
      : null,
    repoPath,
    repoName: typeof record.repoName === 'string' && record.repoName.trim()
      ? record.repoName
      : repoNameFromPath(repoPath),
    repoBranch: typeof record.repoBranch === 'string' ? record.repoBranch : null,
    githubOwner: githubIdentity.githubOwner,
    githubRepo: githubIdentity.githubRepo,
    backend: effectiveBackend(record),
    agent: normalizeAgent(record.agent),
    pinned: record.pinned === true,
  };
}
