import { mkdirSync, renameSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { NextRequest } from 'next/server';
import { expect, it, vi } from 'vitest';
import { GET } from '@/app/api/mobile/inbox/route';
import { getCanonicalChatHistoryPath } from '@/lib/llm/chat-history-store';
import type { MobileInboxSnapshot } from '@/lib/mobile/types';

const io = vi.hoisted(() => ({ historyPath: '', historyReads: 0 }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] === io.historyPath) io.historyReads++;
      return fs.readFileSync(...args);
    },
  };
});
vi.mock('@/lib/runtime/inventory', () => ({
  getRuntimeInventorySnapshot: async () => ({ agents: [], events: [], meta: { mode: 'live', sourceLabel: 'fixture' } }),
}));

const tabId = 'inbox-cache-fixture';
const sessionKey = 'llm-chat:' + tabId;

async function readInbox() {
  const response = await GET(new NextRequest('http://localhost/api/mobile/inbox?fresh=1&workspaceReview=0'));
  expect(response.status).toBe(200);
  const snapshot: MobileInboxSnapshot = await response.json();
  return snapshot.sessions.find(session => session.sessionKey === sessionKey);
}

it('reuses a saved chat preview on fresh inbox reads and notices same-mtime replacement and deletion', async () => {
  const filePath = getCanonicalChatHistoryPath(tabId);
  const mtime = new Date('2026-01-01T10:00:00Z');
  mkdirSync(dirname(filePath), { recursive: true });
  io.historyPath = filePath;
  io.historyReads = 0;
  const history = (content: string) => JSON.stringify({
    title: 'Saved chat fixture',
    messages: [{ id: 'm1', role: 'assistant', timestamp: 1, content }],
  });
  writeFileSync(filePath, history('Initial text'));
  utimesSync(filePath, mtime, mtime);
  // The inbox separately reads the primary transcript. Keep that read on a different chat.
  writeFileSync(getCanonicalChatHistoryPath('primary-chat-fixture'), history('Primary chat'));

  const initial = await readInbox();
  expect(initial).toMatchObject({ currentTask: 'Initial text', name: 'Saved chat fixture' });
  expect(await readInbox()).toEqual(initial);
  expect(io.historyReads).toBe(1);

  writeFileSync(filePath + '.tmp', history('Second reply'));
  utimesSync(filePath + '.tmp', mtime, mtime);
  renameSync(filePath + '.tmp', filePath);
  expect(await readInbox()).toMatchObject({ currentTask: 'Second reply' });
  expect(io.historyReads).toBe(2);

  unlinkSync(filePath);
  expect(await readInbox()).toBeUndefined();
  expect(io.historyReads).toBe(2);
});
