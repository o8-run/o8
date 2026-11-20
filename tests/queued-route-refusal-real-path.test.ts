import { installComposerOwnerFixture } from './fixtures/composer-queue-owner';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';

// #6533: a queued composer turn whose route refuses it before any runtime
// starts must not leave the chat reading as Working. The Codex binary is a
// fixture that records every call; the queue, heartbeat, Codex route, effort
// pin and transcript store are real.
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => true) }));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-queued-refusal-')));
const data = join(root, 'data'), repo = join(root, 'repo'), bin = join(root, 'codex'), calls = join(root, 'calls.log');
mkdirSync(join(data, 'chat-history'), { recursive: true }); mkdirSync(repo);
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
execFileSync('git', ['-C', repo, '-c', 'user.name=o8 test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
for (const [key, value] of Object.entries({ HOME: root, O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data,
  CORTEX_IDE_DB_PATH: join(data, 'cortex-ide.db'), CORTEX_IDE_OWNED_CODEX_ROOT: join(data, 'owned-codex'),
  O8_CODEX_BIN: bin, O8_CRASH_SURVIVABLE_WORKERS: '0' })) vi.stubEnv(key, value);
writeFileSync(bin, `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv.includes('--version')) { console.log('codex-cli 1.0.0'); process.exit(0); }
process.exit(1);
`); chmodSync(bin, 0o755);

const refused = 'thoughts-refused-route', other = 'thoughts-other-working';
const earlier = [{ id: 'user-1', role: 'user', content: 'Earlier ask', timestamp: 1 },
  { id: 'assistant-1', role: 'assistant', content: 'Earlier answer', timestamp: 2 }];
writeFileSync(join(data, 'chat-history', `${refused}.json`), JSON.stringify({ repoPath: repo, backend: 'codex', model: 'gpt-5.5', messages: earlier }));
// Another chat whose turn is genuinely in flight keeps its own state.
writeFileSync(join(data, 'chat-history', `${other}.json`), JSON.stringify({ repoPath: repo, backend: 'codex', model: 'gpt-5.5',
  messages: [{ id: 'user-2', role: 'user', content: 'Still running', timestamp: 3 }] }));

const { addRepo } = await import('@/lib/repos/registry');
await addRepo(repo);
const { getSqlite, closeDb } = await import('@/lib/db');
const { ensureV71ComposerQueueSchema } = await import('@/lib/db/v71-composer-queue-migration');
ensureV71ComposerQueueSchema(getSqlite());
const queue = await import('@/lib/orchestrator/composer-queue');
const { createComposerQueueHeartbeat } = await import('./fixtures/composer-queue-executor');
const { readProjectedThread } = await import('@/lib/mobile/orchestrator-thread-history');
const { readPersistedLlmChat } = await import('@/lib/llm/chat-history-store');

afterAll(() => { closeDb(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

it('records a route refusal as the turn failure, with its reason, and starts nothing', async () => {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const threads: Array<{ id: string; status: string }> = [];
  const id = 'queued-max-on-gpt-5-5';
  (await queue.enqueueComposerSend({ repoPath: repo, threadId: refused, id, intent: 'send-next', payload: {
    text: 'Count the files', wireMessage: 'Count the files', images: [],
    routing: { backend: 'codex', model: 'gpt-5.5', effort: 'max', permissionMode: 'full', mode: 'single', pickedMode: 'solo', collide: false },
  } }));
  createComposerQueueHeartbeat({ isBusy: () => false, readTranscript: async () => [], registerAbort: () => () => {},
    publish: (_thread, _session, event, payload) => events.push({ event, data: payload }),
    publishThread: thread => threads.push(thread) })();
  await vi.waitFor(async () => expect((await queue.readComposerSend(id))?.status).toBe('held'), { timeout: 20_000 });

  // The reason surfaces as the route's own answer, not as a binary failure.
  const reason = /cannot honor effort "max" for runtime "codex" model "gpt-5\.5"/;
  expect(events).toContainEqual(expect.objectContaining({ event: 'error', data: expect.objectContaining({ error: expect.stringMatching(reason) }) }));
  expect(JSON.stringify(events)).not.toContain('Failed to resolve Codex binary');
  expect((await queue.readComposerSend(id))?.reason).toMatch(reason);

  // Only the refused turn settles: failed, earlier turns intact, no empty placeholder left behind.
  const projected = readProjectedThread(refused)!;
  expect(projected.status).toBe('failed');
  expect(threads).toContainEqual(expect.objectContaining({ id: refused, status: 'failed' }));
  const history = readPersistedLlmChat(refused)!.history as { orchestratorTerminalError?: string; messages: Array<{ id: string; role: string; content?: string }> };
  expect(history.orchestratorTerminalError).toMatch(reason);
  expect(history.messages.slice(0, 2)).toEqual(earlier.map(message => expect.objectContaining({ id: message.id, content: message.content })));
  expect(history.messages.at(-1)).toMatchObject({ role: 'user', content: 'Count the files' });
  expect(history.messages.some(message => message.role === 'assistant' && !message.content?.trim())).toBe(false);
  expect(readProjectedThread(other)!.status).toBe('busy');

  // Nothing ran: the fixture binary was at most asked for its version, and no worker exists.
  const invoked = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]) : [];
  expect(invoked.filter(args => !args.includes('--version'))).toEqual([]);
  expect(existsSync(join(data, 'owned-codex')) ? readdirSync(join(data, 'owned-codex')) : []).toEqual([]);
});

installComposerOwnerFixture();
