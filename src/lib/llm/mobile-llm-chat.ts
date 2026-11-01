import type { MobileHistoryResponse } from '@/lib/mobile/types';
import { mapLlmHistoryToMobileTranscript, readPersistedLlmChat } from '@/lib/llm/chat-history-store';
import { projectNetworkThread } from '@/lib/bots/network-projection';

export function loadMobileLlmChatHistory(sessionKey: string, limit?: number): MobileHistoryResponse {
  const tabId = sessionKey.replace(/^llm-chat:/, '');
  try { projectNetworkThread(tabId, undefined, { waitForLock: false }); } catch { /* Return readable history with failed projection health. */ }
  const record = readPersistedLlmChat(tabId);
  if (!record) {
    return {
      sessionKey,
      transcript: [],
    };
  }

  return {
    sessionKey,
    transcript: mapLlmHistoryToMobileTranscript(
      record.history.messages,
      limit,
      record.history.pendingTurnWorkers,
    ),
  };
}
