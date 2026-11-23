import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCanonicalChatHistoryPath, writePersistedLlmChat } from '@/lib/llm/chat-history-store';
import { loadMobileLlmChatHistory } from '@/lib/llm/mobile-llm-chat';
import { isNetworkThread } from '@/lib/bots/network-store';
import { validateComposerQueueTarget } from '@/lib/orchestrator/composer-queue';

afterEach(() => vi.restoreAllMocks());

let sequence = 0;
function chat(source?: string, repoPath?: string) {
  const tabId = `thoughts-version-cache-${++sequence}`;
  writePersistedLlmChat(tabId, { ...(repoPath ? { repoPath } : {}), messages: [
    { id: 'm1', role: 'user', content: 'first', timestamp: 1 },
    { id: 'm2', role: 'assistant', content: 'x'.repeat(50_000), timestamp: 2 },
  ], ...(source ? { source } : {}) } as never);
  return tabId;
}
const parsesOf = (parse: ReturnType<typeof vi.spyOn>, tabId: string) => {
  const raw = readFileSync(getCanonicalChatHistoryPath(tabId), 'utf8');
  return parse.mock.calls.filter(([value]: unknown[]) => value === raw).length;
};

describe('chat files read on every poll', () => {
  it('parses an unchanged chat once to answer whether it is a network thread', () => {
    const tabId = chat('bot-network');
    const parse = vi.spyOn(JSON, 'parse');
    for (let index = 0; index < 5; index += 1) expect(isNetworkThread(tabId)).toBe(true);
    expect(parsesOf(parse, tabId)).toBe(1);
    writePersistedLlmChat(tabId, { messages: [], source: 'desktop' } as never, { replace: true });
    expect(isNetworkThread(tabId)).toBe(false);
  });

  it('maps an unchanged chat once for history polls and hands each caller its own copy', () => {
    const tabId = chat();
    const parse = vi.spyOn(JSON, 'parse');
    const first = loadMobileLlmChatHistory(`llm-chat:${tabId}`, 18);
    first.transcript.pop();
    for (let index = 0; index < 5; index += 1) {
      expect(loadMobileLlmChatHistory(`llm-chat:${tabId}`, 18).transcript.map((entry) => entry.id)).toEqual(['m1', 'm2']);
    }
    expect(parsesOf(parse, tabId)).toBe(1);
    writePersistedLlmChat(tabId, { messages: [{ id: 'm3', role: 'user', content: 'third', timestamp: 3 }] } as never);
    expect(loadMobileLlmChatHistory(`llm-chat:${tabId}`, 18).transcript.map((entry) => entry.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('checks a queued message target without parsing the unchanged chat again', () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'o8-version-cache-repo-')));
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'o8-version-cache-other-')));
    const tabId = chat(undefined, repo);
    const parse = vi.spyOn(JSON, 'parse');
    for (let index = 0; index < 5; index += 1) {
      expect(validateComposerQueueTarget({ threadId: tabId, repoPath: repo }).threadId).toBe(tabId);
    }
    expect(parsesOf(parse, tabId)).toBe(1);
    expect(() => validateComposerQueueTarget({ threadId: tabId, repoPath: other })).toThrow(/saved chat repository/);
  });
});
