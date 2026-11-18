import { isNetworkThread } from '@/lib/bots/network-store';

/** Live classification only, never projection or a cached record. The existing
 * check includes both the bus binding and persisted source === 'bot-network'.
 * Any uncertainty leaves the original GET in charge of projection and errors. */
export function nativeChatHistoryAllowed(tabId: string | null): boolean {
  if (!tabId) return true; // The reader preserves GET's 400 tabId required.
  try { return !isNetworkThread(tabId); } catch { return false; }
}
