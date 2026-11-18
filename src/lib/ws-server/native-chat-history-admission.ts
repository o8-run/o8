import { hasMissionCardsByThread } from '@/lib/task-artifacts/store';
import { isNetworkThread } from '@/lib/bots/network-store';

/** Live classification only, never projection or a cached record. The existing
 * check includes both the bus binding and persisted source === 'bot-network'.
 * Any uncertainty leaves the original GET in charge of projection and errors. */
export function nativeChatHistoryAllowed(tabId: string | null): boolean {
  if (!tabId) return true; // The reader preserves GET's 400 tabId required.
  try { return !isNetworkThread(tabId); } catch { return false; }
}

/** Mobile runtime tails and mission-card views stay with the original handler. */
export function nativeMobileHistoryAllowed(sessionKey: string | null): boolean {
  const key = sessionKey?.trim();
  if (!key?.startsWith('llm-chat:')) return false;
  const id = key.slice('llm-chat:'.length);
  try { return nativeChatHistoryAllowed(id) && !hasMissionCardsByThread(id); } catch { return false; }
}
