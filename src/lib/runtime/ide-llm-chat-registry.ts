import { statSync } from 'node:fs';
import path from 'node:path';
import { getCanonicalChatHistoryPath, listPersistedLlmChats, readPersistedLlmChat } from '@/lib/llm/chat-history-store';
import { listCurrentIdeRepoPaths, readIdeTerminalStateFiles } from '@/lib/runtime/ide-terminal-state';

export interface IdeLlmChatDescriptor {
  tabId: string;
  sessionKey: string;
  label: string;
  model?: string;
  repoName?: string;
  repoPath?: string;
  scope: string;
  savedAt?: string;
  modifiedAt?: string;
  isCurrentSession: boolean;
  messageCount: number;
  lastMessage?: string;
}

type ChatListing = Pick<IdeLlmChatDescriptor, 'model' | 'repoName' | 'repoPath' | 'savedAt' | 'messageCount' | 'lastMessage'> & {
  title?: string;
  modifiedAt: string;
};

const CHAT_LISTING_LIMIT = 128;
const CHAT_LISTING_MAX_LENGTH = 8192;
const chatListings = new Map<string, { version: string; body: string }>();

function chatFileVersion(filePath: string): string | null {
  try {
    const stat = statSync(filePath, { bigint: true, throwIfNoEntry: false });
    return stat ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` : null;
  } catch {
    return null;
  }
}

function readChatListing(tabId: string): ChatListing | null {
  const filePath = getCanonicalChatHistoryPath(tabId);
  const version = chatFileVersion(filePath);
  const cached = chatListings.get(filePath);
  if (cached && cached.version === version) return JSON.parse(cached.body) as ChatListing;
  chatListings.delete(filePath);
  if (version === null) return null;

  const record = readPersistedLlmChat(tabId);
  if (!record) return null;
  const { model, title, repoName, repoPath, savedAt, messages } = record.history;
  const listing = {
    model, title, repoName, repoPath, savedAt,
    modifiedAt: record.modifiedAt,
    messageCount: messages.length,
    lastMessage: messages.findLast(entry => entry.content?.trim())?.content?.trim(),
  };
  // Keep bounded copies of listing fields so transcript strings can be collected.
  if (Object.values(listing).some(value => typeof value === 'string' && value.length > CHAT_LISTING_MAX_LENGTH)) {
    return listing;
  }
  const body = JSON.stringify(listing);
  if (body.length <= CHAT_LISTING_MAX_LENGTH && chatFileVersion(filePath) === version) {
    const oldest = chatListings.keys().next();
    if (chatListings.size === CHAT_LISTING_LIMIT && !oldest.done) chatListings.delete(oldest.value);
    chatListings.set(filePath, { version, body });
  }
  return listing;
}

function normalizeLabel(label?: string, repoName?: string, repoPath?: string) {
  const trimmed = label?.trim();
  if (trimmed && trimmed.toLowerCase() !== 'chat') return trimmed;
  const repoLabel = repoName?.trim() || (repoPath?.trim() ? path.basename(repoPath.trim()) : null);
  return repoLabel ? `${repoLabel} · Chat` : 'Chat';
}

export function listIdeLlmChatSessions(): IdeLlmChatDescriptor[] {
  const currentRepoPaths = new Set(listCurrentIdeRepoPaths());
  const descriptors = new Map<string, IdeLlmChatDescriptor>();
  const files = readIdeTerminalStateFiles();

  for (const file of files) {
    try {
      for (const tab of file.tabs ?? []) {
        if (tab.kind !== 'llm-chat') continue;
        if (!tab.id?.trim()) continue;

        const chat = readChatListing(tab.id);
        const next: IdeLlmChatDescriptor = {
          tabId: tab.id,
          sessionKey: `llm-chat:${tab.id}`,
          label: normalizeLabel(tab.label, tab.repoName, tab.repoPath),
          model: chat?.model,
          repoName: tab.repoName,
          repoPath: tab.repoPath,
          scope: file.scope,
          savedAt: file.savedAt,
          modifiedAt: chat?.modifiedAt,
          isCurrentSession: file.activeTabId === tab.id,
          messageCount: chat?.messageCount ?? 0,
          lastMessage: chat?.lastMessage,
        };

        const existing = descriptors.get(next.sessionKey);
        if (!existing) {
          descriptors.set(next.sessionKey, next);
          continue;
        }

        const existingTime = new Date(existing.modifiedAt ?? existing.savedAt ?? 0).getTime();
        const nextTime = new Date(next.modifiedAt ?? next.savedAt ?? 0).getTime();
        if (next.isCurrentSession && !existing.isCurrentSession) {
          descriptors.set(next.sessionKey, next);
          continue;
        }
        if (nextTime >= existingTime) {
          descriptors.set(next.sessionKey, next);
        }
      }
    } catch {
      continue;
    }
  }

  for (const tabId of listPersistedLlmChats()) {
    const sessionKey = `llm-chat:${tabId}`;
    if (descriptors.has(sessionKey)) continue;

    const chat = readChatListing(tabId);
    if (!chat) continue;
    descriptors.set(sessionKey, {
      tabId,
      sessionKey,
      label: normalizeLabel(chat.title, chat.repoName, chat.repoPath),
      model: chat.model,
      repoName: chat.repoName,
      repoPath: chat.repoPath,
      scope: 'chat-history',
      savedAt: chat.savedAt,
      modifiedAt: chat.modifiedAt,
      isCurrentSession: false,
      messageCount: chat.messageCount,
      lastMessage: chat.lastMessage,
    });
  }

  return [...descriptors.values()]
    .filter((session) => {
      if (currentRepoPaths.size === 0) return true;
      const repoPath = session.repoPath?.trim();
      const normalizedRepoPath = repoPath ? path.normalize(repoPath).toLowerCase() : null;
      if (!normalizedRepoPath) return false;
      return currentRepoPaths.has(normalizedRepoPath);
    })
    .sort((left, right) => {
      if (left.isCurrentSession && !right.isCurrentSession) return -1;
      if (!left.isCurrentSession && right.isCurrentSession) return 1;
      const leftTime = new Date(left.modifiedAt ?? left.savedAt ?? 0).getTime();
      const rightTime = new Date(right.modifiedAt ?? right.savedAt ?? 0).getTime();
      return rightTime - leftTime;
    });
}
