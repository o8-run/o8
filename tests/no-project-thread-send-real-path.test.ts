import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ComposerQueuePayload } from '@/lib/orchestrator/composer-queue-types';

/**
 * A chat saved with no project sends through the composer queue route with no
 * repository. The queue resolves the chat's scratch folder under the data
 * directory, the dispatcher runs the agent there, and the saved chat keeps no
 * repository after its first message is recorded.
 */
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
const continuation = vi.hoisted(() => ({ calls: [] as Array<{ repoPath: string; message: string }> }));
vi.mock('@/lib/ws-server/bound-chat-continuation', () => ({
  runBoundChatContinuation: vi.fn(async (input: { repoPath: string; message: string; admit: () => boolean }) => {
    input.admit();
    continuation.calls.push({ repoPath: input.repoPath, message: input.message });
  }),
}));
const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'o8-no-project-')));
vi.stubEnv('O8_DATA_DIR', fixture); vi.stubEnv('CORTEX_IDE_DATA_DIR', fixture);
vi.stubEnv('CORTEX_IDE_DB_PATH', join(fixture, 'queue.db'));
mkdirSync(join(fixture, 'chat-history'), { recursive: true });
const thread = 'thoughts-next-no-project';
writeFileSync(join(fixture, 'chat-history', `${thread}.json`), JSON.stringify({ backend: 'codex', model: 'gpt-test', title: 'New conversation', messages: [] }));
const { getSqlite, closeDb } = await import('@/lib/db');
const { ensureV71ComposerQueueSchema } = await import('@/lib/db/v71-composer-queue-migration');
ensureV71ComposerQueueSchema(getSqlite());
const queue = await import('@/lib/orchestrator/composer-queue');
const { GET, POST } = await import('@/app/api/orchestrator/composer-queue/route');
const payload: ComposerQueuePayload = { text: 'Sketch a plan', wireMessage: 'Sketch a plan', images: [], routing: {
  backend: 'codex', model: 'gpt-test', effort: 'low', permissionMode: 'plan', mode: 'single', pickedMode: 'solo', collide: false,
} };
afterAll(() => { closeDb(); vi.unstubAllEnvs(); rmSync(fixture, { recursive: true, force: true }); });

describe('a chat with no project', () => {
  it('queues and dispatches from its scratch folder without gaining a repository', async () => {
    const response = await POST(new NextRequest('http://localhost/api/orchestrator/composer-queue', {
      method: 'POST', headers: { host: 'localhost', 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath: null, threadId: thread, id: 'no-project-first', intent: 'send-next', payload }),
    }));
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    const scratch = join(fixture, 'thread-scratch', thread);
    expect(existsSync(scratch)).toBe(true);
    expect(body.item).toMatchObject({ threadId: thread, repoPath: scratch, status: 'queued', payload });

    const listed = await GET(new NextRequest(`http://localhost/api/orchestrator/composer-queue?threadId=${thread}`, { headers: { host: 'localhost' } }));
    expect(listed.status).toBe(200);
    expect((await listed.json()).items.map((item: { id: string }) => item.id)).toEqual(['no-project-first']);

    const { getRepoDispatchAdmission } = await import('@/lib/lane/repo-preflight');
    expect(getRepoDispatchAdmission(scratch)).toEqual({ ok: true, repoPath: scratch });
    const { runQueuedComposerSend } = await import('@/lib/ws-server/composer-queue-heartbeat');
    await runQueuedComposerSend(queue.claimNextComposerSend({ repoPath: scratch, threadId: thread })!, { publish: () => {}, registerAbort: () => () => {} });
    expect(continuation.calls).toEqual([{ repoPath: scratch, message: 'Sketch a plan' }]);

    // The dispatcher records the user's message against the scratch folder; the chat stays unbound.
    const { appendMobileOrchestratorUserMessage } = await import('@/lib/mobile/orchestrator-thread-history');
    appendMobileOrchestratorUserMessage({ tabId: thread, repoPath: scratch, message: 'Sketch a plan', backend: 'codex' });
    const saved = JSON.parse(readFileSync(join(fixture, 'chat-history', `${thread}.json`), 'utf8'));
    expect(saved.repoPath ?? null).toBeNull();
    expect(saved.messages.at(-1)).toMatchObject({ role: 'user', content: 'Sketch a plan' });
  });

  it('still refuses a repository the chat was not saved with', async () => {
    const other = join(fixture, 'other'); mkdirSync(other, { recursive: true });
    const response = await POST(new NextRequest('http://localhost/api/orchestrator/composer-queue', {
      method: 'POST', headers: { host: 'localhost', 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath: other, threadId: thread, id: 'no-project-other', intent: 'send-next', payload }),
    }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('saved chat repository');
  });
});
