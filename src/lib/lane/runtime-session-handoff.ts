import { readFileSync } from 'node:fs';
import {
  getCanonicalChatHistoryPath,
  persistCanonicalChatHistoryRecord,
  withCanonicalChatHistoryLock,
  type CanonicalChatHistoryRecord,
} from '@/lib/llm/chat-history-store';

export interface RuntimeSessionHandoff {
  previousThreadId: string;
  replacementThreadId: string | null;
  inputAccepted: boolean;
}

function readRecord(threadId: string): CanonicalChatHistoryRecord {
  return JSON.parse(readFileSync(getCanonicalChatHistoryPath(threadId), 'utf8'));
}

export function readRuntimeSessionHandoff(threadId: string | null): RuntimeSessionHandoff | null {
  if (!threadId) return null;
  try {
    const state = readRecord(threadId).codexSessionHandoff as RuntimeSessionHandoff | undefined;
    return state && typeof state.previousThreadId === 'string' && state.previousThreadId
      && (state.replacementThreadId === null || typeof state.replacementThreadId === 'string')
      && typeof state.inputAccepted === 'boolean' ? state : null;
  } catch {
    return null;
  }
}

/** Save the handoff and the resumable binding together, before publishing acceptance. */
export function persistRuntimeSessionHandoff(threadId: string | null, state: RuntimeSessionHandoff): void {
  if (!threadId) return;
  withCanonicalChatHistoryLock(threadId, () => {
    const record = readRecord(threadId);
    const ids = record.orchestratorSessionIds as Record<string, string> | undefined;
    persistCanonicalChatHistoryRecord(threadId, {
      ...record,
      codexSessionHandoff: state,
      orchestratorSessionIds: {
        ...ids,
        codex: state.inputAccepted ? state.replacementThreadId : state.previousThreadId,
      },
      orchestratorSessionUpdatedAt: new Date().toISOString(),
    });
  });
}

export function clearRuntimeSessionHandoff(threadId: string): void {
  if (!readRuntimeSessionHandoff(threadId)) return;
  withCanonicalChatHistoryLock(threadId, () => {
    const record = readRecord(threadId);
    delete record.codexSessionHandoff;
    persistCanonicalChatHistoryRecord(threadId, record);
  });
}

export function noteRuntimeSessionHandoff(
  threadId: string | null,
  state: RuntimeSessionHandoff | undefined,
  replacementThreadId: string | null,
  inputAccepted = state?.inputAccepted ?? false,
): void {
  if (!state || !replacementThreadId
    || (state.replacementThreadId === replacementThreadId && state.inputAccepted === inputAccepted)) return;
  const next = { ...state, replacementThreadId, inputAccepted };
  persistRuntimeSessionHandoff(threadId, next);
  Object.assign(state, next);
}
