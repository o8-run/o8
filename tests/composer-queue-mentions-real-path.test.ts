import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComposerMention, ComposerQueuePayload } from '@/lib/orchestrator/composer-queue-types';

// #5305: a sent message's pills are saved with it, so a restarted app reads them back.
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'o8-composer-mentions-')));
const repo = join(fixture, 'repo'); mkdirSync(repo);
vi.stubEnv('O8_DATA_DIR', fixture); vi.stubEnv('CORTEX_IDE_DATA_DIR', fixture);
vi.stubEnv('CORTEX_IDE_DB_PATH', join(fixture, 'queue.db'));
mkdirSync(join(fixture, 'chat-history'), { recursive: true });
const { getSqlite, closeDb } = await import('@/lib/db');
const { ensureV71ComposerQueueSchema } = await import('@/lib/db/v71-composer-queue-migration');
ensureV71ComposerQueueSchema(getSqlite());
const queue = await import('@/lib/orchestrator/composer-queue');
const { POST } = await import('@/app/api/orchestrator/composer-queue/route');
const history = await import('@/app/api/mobile/history/route');
const target = { repoPath: repo, threadId: 'thoughts-mentions' };
const mentions: ComposerMention[] = [
  { label: 'test', title: 'test', lines: ['Script · vitest run'], jump: { kind: 'script', target: 'test' } },
  { label: 'feature', title: join(fixture, 'feature'), lines: ['Worktree · feature'], jump: { kind: 'worktree', target: join(fixture, 'feature') } },
  { label: 'shell', title: 'shell-session', lines: [], jump: { kind: 'terminal', target: 'shell-session' } },
  { label: 'Fix the build', title: 'Fix the build', lines: ['Thread · ready'], open: 'thoughts-other' },
];
const payload: ComposerQueuePayload = { text: 'Run @test in @feature, see @shell and @Fix the build', wireMessage: 'Run it',
  images: [], mentions, routing: { backend: 'pi', model: 'pi', effort: 'low', permissionMode: 'plan', mode: 'single', pickedMode: 'solo', collide: false } };
function post(id: string, body: Partial<ComposerQueuePayload> & Record<string, unknown>, intent = 'send-next') {
  return POST(new NextRequest('http://localhost/api/orchestrator/composer-queue', { method: 'POST',
    headers: { host: 'localhost', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...target, id, intent, payload: { ...payload, ...body } }) }));
}
beforeEach(() => {
  getSqlite().exec('DELETE FROM composer_send_queue');
  writeFileSync(join(fixture, 'chat-history', `${target.threadId}.json`), JSON.stringify({ repoPath: repo, backend: 'pi', messages: [{ id: 'assistant', role: 'assistant', content: 'Working', timestamp: 1 }] }));
});
afterAll(() => { closeDb(); vi.unstubAllEnvs(); rmSync(fixture, { recursive: true, force: true }); });

describe('composer queue mentions', () => {
  it('saves a message\'s pills with it and echoes them in the receipt', async () => {
    const response = await post('queue-mentions-saved', {});
    expect(response.status).toBe(200);
    expect((await response.json()).item.payload.mentions).toEqual(mentions);
    closeDb(); ensureV71ComposerQueueSchema(getSqlite());
    expect(queue.readComposerSend('queue-mentions-saved')?.payload.mentions).toEqual(mentions);
    // A message without pills saves no field at all.
    const plain = await post('queue-mentions-none', { mentions: undefined });
    expect((await plain.json()).item.payload).not.toHaveProperty('mentions');
  });

  it.each([
    ['terminal output', { ...mentions[2], lines: ['secret line'] }],
    ['an unknown jump', { ...mentions[0], jump: { kind: 'browser', target: 'x' } }],
    ['an empty label', { ...mentions[0], label: ' ' }],
    ['a 300-character label', { ...mentions[0], label: 'l'.repeat(300) }],
    ['an empty thread', { ...mentions[3], open: '' }],
    ['not a pill', 'x'],
  ])('keeps the message and drops a pill with %s', async (name, bad) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response = await post(`queue-mentions-bad-${name.replace(/\W/g, '')}`, { mentions: [bad, mentions[1]] as ComposerMention[] });
    expect(response.status).toBe(200);
    expect((await response.json()).item.payload).toMatchObject({ text: payload.text, mentions: [mentions[1]] });
    // The log counts what was dropped and never repeats it.
    expect(warn).toHaveBeenCalledWith('[composer-queue] Dropped 1 mention(s) that could not be saved.');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret line');
    warn.mockRestore();
  });

  it('delivers a message with 21 pills and a 300-character label, keeping 20 pills', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const many = [{ ...mentions[0], label: 'l'.repeat(300) },
      ...Array.from({ length: 21 }, (_, index) => ({ ...mentions[1], label: `tree-${index}` }))];
    const backend = (await import('@/lib/lane/orchestrator-backends/registry')).getOrchestratorBackend('pi');
    const native = vi.spyOn(backend, 'liveSteer').mockImplementation(async (_repo, _message, options) => {
      options.beforeAdmit(); return { accepted: true };
    });
    try {
      const response = await post('queue-mentions-many', { mentions: many }, 'steer-now');
      expect(response.status).toBe(200);
      const saved = (await response.json()).item.payload.mentions as ComposerMention[];
      expect(saved.map(mention => mention.label)).toEqual(Array.from({ length: 20 }, (_, index) => `tree-${index}`));
      const { runQueuedComposerSteer } = await import('@/lib/ws-server/composer-queue-heartbeat');
      await runQueuedComposerSteer(queue.claimComposerSteer('queue-mentions-many')!);
    } finally { native.mockRestore(); warn.mockRestore(); }
    const delivered = (await import('@/lib/llm/chat-history-store')).readPersistedLlmChat(target.threadId)!
      .history.messages.find(message => message.id === 'composer-steer-queue-mentions-many');
    expect(delivered).toMatchObject({ role: 'user', content: payload.text });
    expect(delivered?.mentions).toHaveLength(20);
  });

  it('puts the pills on the delivered user message the app reads after a restart', async () => {
    const backend = (await import('@/lib/lane/orchestrator-backends/registry')).getOrchestratorBackend('pi');
    const native = vi.spyOn(backend, 'liveSteer').mockImplementation(async (_repo, _message, options) => {
      options.beforeAdmit(); return { accepted: true };
    });
    try {
      expect((await post('queue-mentions-steer', {}, 'steer-now')).status).toBe(200);
      const { runQueuedComposerSteer } = await import('@/lib/ws-server/composer-queue-heartbeat');
      await runQueuedComposerSteer(queue.claimComposerSteer('queue-mentions-steer')!);
      expect(queue.readComposerSend('queue-mentions-steer')?.status).toBe('applied');
    } finally { native.mockRestore(); }
    const response = await history.GET(new NextRequest(`http://localhost/api/mobile/history?sessionKey=${encodeURIComponent(`llm-chat:${target.threadId}`)}&limit=100`));
    expect(response.status).toBe(200);
    const transcript = (await response.json()).transcript as Array<{ id: string; role: string; text: string; mentions?: ComposerMention[] }>;
    const sent = transcript.find(entry => entry.id === 'composer-steer-queue-mentions-steer');
    expect(sent).toMatchObject({ role: 'user', text: payload.text, mentions });
    expect(transcript.find(entry => entry.id === 'assistant')).not.toHaveProperty('mentions');
  });
});
