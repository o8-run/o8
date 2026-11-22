import { mkdirSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/mobile/inbox/route';
import { getCanonicalChatHistoryPath } from '@/lib/llm/chat-history-store';
import type { MobileInboxSnapshot } from '@/lib/mobile/types';

const io = vi.hoisted(() => ({ reads: new Map<string, number>() }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      if (typeof args[0] === 'string' && io.reads.has(args[0])) {
        io.reads.set(args[0], (io.reads.get(args[0]) ?? 0) + 1);
      }
      return fs.readFileSync(...args);
    },
  };
});
vi.mock('@/lib/runtime/inventory', () => ({
  getRuntimeInventorySnapshot: async () => ({ agents: [], events: [], meta: { mode: 'live', sourceLabel: 'fixture' } }),
}));

const tabId = 'inbox-cache-fixture';
const sessionKey = 'llm-chat:' + tabId;

afterEach(() => {
  for (const file of io.reads.keys()) {
    rmSync(file, { force: true });
    rmSync(file + '.tmp', { force: true });
  }
  rmSync(getCanonicalChatHistoryPath('primary-chat-fixture'), { force: true });
  io.reads.clear();
});

async function readSnapshot() {
  const response = await GET(new NextRequest('http://localhost/api/mobile/inbox?fresh=1&workspaceReview=0'));
  expect(response.status).toBe(200);
  return await response.json() as MobileInboxSnapshot;
}

async function readInbox() {
  return (await readSnapshot()).sessions.find(session => session.sessionKey === sessionKey);
}

it('reuses a saved chat preview on fresh inbox reads and notices same-mtime replacement and deletion', async () => {
  const filePath = getCanonicalChatHistoryPath(tabId);
  const mtime = new Date('2026-01-01T10:00:00Z');
  mkdirSync(dirname(filePath), { recursive: true });
  io.reads.set(filePath, 0);
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
  expect(io.reads.get(filePath)).toBe(1);

  writeFileSync(filePath + '.tmp', history('Second reply'));
  utimesSync(filePath + '.tmp', mtime, mtime);
  renameSync(filePath + '.tmp', filePath);
  expect(await readInbox()).toMatchObject({ currentTask: 'Second reply' });
  expect(io.reads.get(filePath)).toBe(2);

  writeFileSync(filePath, history('word \n\t'.repeat(2_000)));
  utimesSync(filePath, mtime, mtime);
  const preview = `${'word '.repeat(36).slice(0, 177)}…`;
  expect(await readInbox()).toMatchObject({ currentTask: preview });
  expect(await readInbox()).toMatchObject({ currentTask: preview });
  expect(io.reads.get(filePath)).toBe(3);

  unlinkSync(filePath);
  expect(await readInbox()).toBeUndefined();
  expect(io.reads.get(filePath)).toBe(3);
});

it('does not reread the primary saved transcript on fresh snapshots and sees its replacement', async () => {
  const path = getCanonicalChatHistoryPath('primary-chat-fixture');
  const mtime = new Date('2026-01-01T10:00:00Z');
  mkdirSync(dirname(path), { recursive: true });
  const history = (content: string) => JSON.stringify({
    title: 'Primary saved chat',
    messages: [{ id: 'primary-message', role: 'assistant', timestamp: 1, content }],
  });
  io.reads.set(path, 0);
  writeFileSync(path, history('First note'));
  utimesSync(path, mtime, mtime);

  const first = await readSnapshot();
  expect(first.primarySessionKey).toBe('llm-chat:primary-chat-fixture');
  expect(JSON.stringify(first.items)).toContain('Latest: First note');
  const readsAfterFirst = io.reads.get(path);
  const second = await readSnapshot();
  expect(second.items).toEqual(first.items);
  expect(io.reads.get(path)).toBe(readsAfterFirst);

  writeFileSync(path + '.tmp', history('Other note'));
  utimesSync(path + '.tmp', mtime, mtime);
  renameSync(path + '.tmp', path);
  expect(JSON.stringify((await readSnapshot()).items)).toContain('Latest: Other note');

  writeFileSync(path, history('long reply '.repeat(2_000)));
  const latest = `Latest: ${'long reply '.repeat(17).slice(0, 177)}…`;
  expect(JSON.stringify((await readSnapshot()).items)).toContain(latest);
  const readsAfterLongReply = io.reads.get(path);
  expect(JSON.stringify((await readSnapshot()).items)).toContain(latest);
  expect(io.reads.get(path)).toBe(readsAfterLongReply);

  unlinkSync(path);
  expect((await readSnapshot()).primarySessionKey).toBeUndefined();
});
