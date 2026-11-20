import { installComposerOwnerFixture } from './fixtures/composer-queue-owner';
import { fixtureComposerClaim, fixtureComposerToken } from './fixtures/composer-queue-attempt';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import type { RealtimeMutationPublishRequest } from '@/lib/realtime/types';

vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => null }));
vi.mock('@/lib/repos/repo-path-registry', () => ({ resolveRepoPathFromRegistry: async (repoRoot: string) => ({ ok: true, repoRoot }) }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => true) }));
const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-compaction-status-')));
const repoPath = join(directory, 'repo'); mkdirSync(repoPath);
vi.stubEnv('O8_DATA_DIR', directory); vi.stubEnv('CORTEX_IDE_DATA_DIR', directory);
vi.stubEnv('CORTEX_IDE_DB_PATH', join(directory, 'queue.db'));
const { persistCanonicalChatHistoryRecord, readPersistedLlmChat } = await import('@/lib/llm/chat-history-store');
const historyRoute = await import('@/app/api/v2/chat-history/route');
const compactRoute = await import('@/app/api/orchestrator/compact/route');
const queueRoute = await import('@/app/api/orchestrator/composer-queue/route');
const queue = await import('@/lib/orchestrator/composer-queue');
const { getSqlite, closeDb } = await import('@/lib/db');
const { ensureV71ComposerQueueSchema } = await import('@/lib/db/v71-composer-queue-migration');
const { withLiveCompaction } = await import('@/lib/orchestrator/live-compaction');
const { publishRealtimeMutation } = await import('@/lib/realtime/publisher');
ensureV71ComposerQueueSchema(getSqlite());

// The browser chat list and composer that rendered compaction state are gone.
// These cases assert the persisted receipt through the real status route.
const threadId = 'thoughts-compaction-status';
const scope = { repoPath, threadId };
let entries: MobileTranscriptEntry[];
let captured: RealtimeMutationPublishRequest['mutation'][];
async function loadHistory() {
  const response = await historyRoute.GET(new NextRequest(`http://localhost/api/v2/chat-history?tabId=${threadId}`));
  const data = await response.json();
  entries = data.messages.map((message: { content: string; [key: string]: unknown }) => ({ ...message, text: message.content }));
  return entries;
}
async function phase() {
  const response = await status();
  expect(response.status).toBe(200);
  return (await response.json()).operation?.phase as string | undefined;
}
async function status() {
  const get = Reflect.get(compactRoute, 'GET');
  return typeof get === 'function' ? get(new NextRequest(`http://localhost/api/orchestrator/compact?repoPath=${encodeURIComponent(repoPath)}&threadId=${threadId}`))
    : Response.json({}, { status: 405 });
}
async function start() {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const running = new Promise<void>(resolve => { entered = resolve; });
  const job = withLiveCompaction(scope, async () => { entered(); await gate; });
  await running;
  return { release, job };
}
beforeEach(async () => {
  getSqlite().exec('DELETE FROM composer_send_queue');
  rmSync(join(directory, 'compaction-status'), { recursive: true, force: true });
  entries = [{ id: 'question', role: 'user', text: 'Inspect the sample.', timestamp: Date.now() - 2000 },
    { id: 'answer', role: 'assistant', text: 'The inspection is running.', timestamp: Date.now() - 1000 }];
  persistCanonicalChatHistoryRecord(threadId, { repoPath, backend: 'codex', messages: entries.map(entry => ({ ...entry, content: entry.text })) });
  captured = [];
  vi.mocked(publishRealtimeMutation).mockImplementation(async request => {
    captured.push(request.mutation);
    return true;
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
afterAll(() => { closeDb(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

it('settles a compaction whose terminal event is lost and delivers a queued follow-up once', async () => {
  const operation = await start();
  try {
    const payload = { text: 'Keep this follow-up.', wireMessage: 'Keep this follow-up.', images: [], routing: {
      backend: 'codex', model: 'default', effort: 'high', permissionMode: 'plan', mode: 'single', pickedMode: 'solo', collide: false } };
    const response = await queueRoute.POST(new NextRequest('http://localhost/api/orchestrator/composer-queue', { method: 'POST',
      headers: { host: 'localhost', 'Content-Type': 'application/json' }, body: JSON.stringify({ ...scope, id: 'follow-up', intent: 'send-next', payload }) }));
    expect(response.status).toBe(200);
    expect((await queue.listComposerTranscriptSends(scope)).filter(item => item.id === 'follow-up')).toHaveLength(1);
    operation.release(); await operation.job;
    expect(await phase()).toBe('complete');
    const claimed = (await fixtureComposerClaim(queue.claimNextComposerSend(scope)))!; expect(claimed.id).toBe('follow-up');
    expect((await queue.admitComposerSend(claimed.id, fixtureComposerToken(claimed.id)))).toBe(true);
    const record = readPersistedLlmChat(threadId)!.history;
    persistCanonicalChatHistoryRecord(threadId, { ...record, messages: [...record.messages,
      { id: 'composer-queued-follow-up', role: 'user', content: payload.text, timestamp: Date.now() }] });
    (await queue.settleComposerSend(claimed.id, { status: 'applied' }, fixtureComposerToken(claimed.id)));
    expect((await loadHistory()).filter(entry => entry.text === payload.text)).toHaveLength(1);
    expect((await fixtureComposerClaim(queue.claimNextComposerSend(scope)))).toBeNull();
  } finally { operation.release(); await operation.job; }
});

it('keeps compaction independent when the assistant turn completes before compaction', async () => {
  const operation = await start();
  try {
    const record = readPersistedLlmChat(threadId)!.history;
    persistCanonicalChatHistoryRecord(threadId, { ...record, messages: [...record.messages,
      { id: 'turn-complete', role: 'assistant', content: 'The turn finished.', timestamp: Date.now() }] });
    await loadHistory();
    expect(await phase()).toBe('compacting');
  } finally { operation.release(); await operation.job; }
});

it('records requested, started and terminal times separately with one operation and exact conversation identity', async () => {
  const operation = await start();
  operation.release(); await operation.job;
  expect(captured.map(mutation => mutation.status)).toEqual(['queued', 'pending', 'completed']);
  expect(new Set(captured.map(mutation => mutation.mutationId)).size).toBe(1);
  expect(captured.every(mutation => mutation.repoPath === repoPath && mutation.surfaceId === threadId)).toBe(true);
  const response = await status(); expect(response.status).toBe(200);
  const snapshot = (await response.json()).operation;
  expect(snapshot.phase).toBe('complete');
  expect(snapshot.requestedAt).toBeLessThanOrEqual(snapshot.startedAt);
  expect(snapshot.startedAt).toBeLessThanOrEqual(snapshot.settledAt);
});

it.each(['failed', 'cancelled'] as const)('settles %s work in the persisted receipt', async expected => {
  await expect(withLiveCompaction(scope, async () => {
    const error = new Error('Fixture compaction stopped');
    if (expected === 'cancelled') error.name = 'AbortError';
    throw error;
  })).rejects.toThrow('Fixture compaction stopped');
  expect(await phase()).toBe(expected);
});

it('restores an active operation from the status route', async () => {
  const operation = await start();
  try {
    expect(await phase()).toBe('compacting');
  } finally { operation.release(); await operation.job; }
});

it('reconciles a missing terminal receipt as uncertain even while its old owner process is alive', async () => {
  const operation = await start();
  operation.release(); await operation.job;
  const pending = captured.find(mutation => mutation.status === 'pending')!;
  // Model the last durable receipt left behind when terminal persistence fails.
  const receipt = { ...scope, operationId: pending.mutationId, phase: 'compacting' as const,
    requestedAt: Date.now() - 50_000, startedAt: Date.now() - 49_000, updatedAt: Date.now() - 46_000, ownerPid: process.pid };
  const key = createHash('sha256').update(JSON.stringify([repoPath, threadId])).digest('hex');
  const dir = join(directory, 'compaction-status', key); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${receipt.operationId}.json`), JSON.stringify(receipt));
  expect(await phase()).toBe('uncertain');
});

it('refreshes a long-running operation receipt while its runtime still works', async () => {
  const operation = await start();
  try {
    const initial = (await (await status()).json()).operation;
    expect(initial?.phase).toBe('compacting');
    const later = Date.now() + 46_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    await new Promise(resolve => setTimeout(resolve, 6300));
    const refreshed = (await (await status()).json()).operation;
    expect(refreshed.updatedAt).toBeGreaterThanOrEqual(later);
    expect(refreshed.phase).toBe('compacting');
  } finally { operation.release(); await operation.job; }
});

installComposerOwnerFixture();
