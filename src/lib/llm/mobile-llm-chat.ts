import type { MobileHistoryResponse } from '@/lib/mobile/types';
import { getCanonicalChatHistoryPath, getChatHistoryFileVersion, mapLlmHistoryToMobileTranscript, readPersistedLlmChat } from '@/lib/llm/chat-history-store';
import { projectNetworkThread } from '@/lib/bots/network-projection';
import { summarizeTranscript } from '@/lib/llm/transcript-preview';

type Transcript = MobileHistoryResponse['transcript'];
const inboxTails = new Map<string, { version: string; transcript: Transcript }>();
const MAX_CACHED_TAILS = 16;
const MAX_TAIL_CHARS = 16_384;
export const INBOX_LLM_TRANSCRIPT_LIMIT = 3;

function refreshNetworkProjection(tabId: string): void {
  try { projectNetworkThread(tabId, undefined, { waitForLock: false }); } catch { /* Return readable history with failed projection health. */ }
}

function readTranscript(tabId: string, limit?: number): Transcript {
  const record = readPersistedLlmChat(tabId);
  return record ? mapLlmHistoryToMobileTranscript(record.history.messages, limit, record.history.pendingTurnWorkers) : [];
}

export function loadMobileLlmInboxTail(sessionKey: string): Transcript {
  const tabId = sessionKey.replace(/^llm-chat:/, '');
  refreshNetworkProjection(tabId);
  const path = getCanonicalChatHistoryPath(tabId);
  const version = getChatHistoryFileVersion(path);
  const cached = inboxTails.get(path);
  if (cached && cached.version === version) return cached.transcript;
  inboxTails.delete(path);
  // The inbox merges by id and timestamp and displays a preview. Keep the
  // same ordering while leaving full transcript fields to the history route.
  const transcript = readTranscript(tabId, INBOX_LLM_TRANSCRIPT_LIMIT).map(({ id, role, text, timestamp }) => ({
    id, role, text: summarizeTranscript(text ?? ''), timestamp, timestampLabel: '',
  }));
  const serialized = JSON.stringify(transcript);
  if (version !== null && serialized.length <= MAX_TAIL_CHARS && getChatHistoryFileVersion(path) === version) {
    const oldest = inboxTails.keys().next();
    if (inboxTails.size === MAX_CACHED_TAILS && !oldest.done) inboxTails.delete(oldest.value);
    inboxTails.set(path, { version, transcript: JSON.parse(serialized) as Transcript });
  }
  return transcript;
}

export function loadMobileLlmChatHistory(sessionKey: string, limit?: number): MobileHistoryResponse {
  const tabId = sessionKey.replace(/^llm-chat:/, '');
  refreshNetworkProjection(tabId);
  return { sessionKey, transcript: readTranscript(tabId, limit) };
}
