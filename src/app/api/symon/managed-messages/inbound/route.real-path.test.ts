import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ensureV56ManagedSymonMessagesSchema } from '@/lib/db/v56-managed-symon-messages-migration';
import { ManagedSymonMessagesStore } from '@/lib/symon/managed-messages-store';

const h = vi.hoisted(() => ({ store: null as unknown, generateShared: vi.fn(), readPlanner: vi.fn(), pollTurn: vi.fn(), model: 'auto', codexReady: true }));

vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => null }));
vi.mock('@/lib/symon/managed-messages-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/symon/managed-messages-store')>(),
  getManagedSymonMessagesStore: () => h.store,
}));
vi.mock('@/lib/chat/gateway-client', () => ({ generateSharedSymonText: h.generateShared }));
vi.mock('@/lib/mobile/symon-text-bridge-client', () => ({
  readSymonTextPlannerInfo: h.readPlanner,
  pollSymonTextTurn: h.pollTurn,
}));

vi.mock('@/lib/auth/principal', () => ({ resolveRequestPrincipal: () => 'operator' }));
vi.mock('@/lib/mobile/symon-agent-context', () => ({
  readSymonAgentContext: async () => ({ model: h.model }),
  resolveSymonAgentScope: async () => ({ workspaceMode: 'o8', repoId: null, repoPath: null }),
}));
vi.mock('@/lib/runtimes/shared/auth-detect', () => ({
  getRuntimeAuthSnapshotForClaudeCarrier: async () => ({ statuses: {
    claude: { installed: true, ready: true }, codex: { installed: true, ready: h.codexReady },
  } }),
}));
import { POST as mintTextSession } from '@/app/api/mobile/symon/text-session/route';
import { POST as runTextTurn } from '@/lib/symon/http/text-turn';

import { POST } from '@/lib/symon/http/managed-inbound';
import { createSymonTextSession, loadSymonTextSession } from '@/lib/mobile/symon-text-session-store';
let dataDir: string;
let previousDataDir: string | undefined;

let sqlite: Database.Database;
let store: ManagedSymonMessagesStore;

beforeEach(() => {
  previousDataDir = process.env.CORTEX_IDE_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'symon-managed-text-'));
  process.env.CORTEX_IDE_DATA_DIR = dataDir;
  sqlite = new Database(':memory:');
  ensureV56ManagedSymonMessagesSchema(sqlite);
  store = new ManagedSymonMessagesStore(sqlite);
  h.store = store;
  h.model = 'auto';
  h.codexReady = true;
  h.generateShared.mockReset().mockResolvedValue('The date is a working plan.');
  h.readPlanner.mockReset();
  h.pollTurn.mockReset();
});

afterEach(() => {
  sqlite.close();
  rmSync(dataDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = previousDataDir;
});

function request(overrides: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/symon/managed-messages/inbound', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      eventId: 'imessage:message-1',
      conversationId: 'shared-imessage:group-1',
      messageId: 'message-1',
      sender: '+15555550102',
      recipient: 'imessage',
      text: 'Is the date booked?',
      context: 'Current state: the date is tentative.',
      ...overrides,
    }),
  });
}

it('persists a shared reply through the route and never invokes a native planner', async () => {
  const first = await POST(request());
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ ok: true, state: 'done', text: 'The date is a working plan.' });
  expect(h.readPlanner).not.toHaveBeenCalled();
  expect(h.pollTurn).not.toHaveBeenCalled();
  expect(store.getConversation('shared-imessage:group-1').transcript).toEqual([
    { role: 'user', text: expect.stringContaining('Is the date booked?') },
    { role: 'assistant', text: 'The date is a working plan.' },
  ]);

  const replay = await POST(request());
  expect(await replay.json()).toEqual({ ok: true, state: 'done', text: 'The date is a working plan.' });
  expect(h.generateShared).toHaveBeenCalledTimes(1);
  expect(sqlite.prepare('SELECT COUNT(*) AS count FROM managed_symon_turns').get()).toEqual({ count: 1 });
});

it('scopes a shared follow-up to the newest question while retaining conversation history', async () => {
  await POST(request());
  h.generateShared.mockResolvedValueOnce('The venue is selected.');

  const response = await POST(request({
    eventId: 'imessage:message-2',
    messageId: 'message-2',
    text: 'What is the venue?',
    context: 'Current state: the venue is selected, while the date remains tentative.',
  }));

  expect(response.status).toBe(200);
  const prompt = h.generateShared.mock.calls[1][0] as string;
  expect(prompt).toContain('Recent conversation:');
  expect(prompt).toContain('Is the date booked?');
  expect(prompt).toContain('Newest message from');
  expect(prompt).toContain('What is the venue?');
  expect(prompt).toContain('Answer the newest question');
  expect(prompt).toContain('Do not repeat unrelated facts from earlier turns');
  expect(store.getConversation('shared-imessage:group-1').transcript).toHaveLength(4);
});

it.each(['direct-chat', 'full-imessage:group-1'])(
  'persists the effective default for %s before its next native turn', async (conversationId) => {
    h.readPlanner.mockResolvedValue({ available: true, engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', allowDefaultFallback: true, tools: [] });
    h.pollTurn.mockResolvedValue({ state: 'done', result: { status: 'done', text: 'Ready.', model: 'gpt-5.6-sol', effort: 'high' } });
    const first = await POST(request({ conversationId }));
    expect(first.status).toBe(200);
    expect(h.pollTurn.mock.calls[0][0].planner).toEqual({ engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', allowDefaultFallback: true });
    const sessionId = store.getConversation(conversationId).sessionId!;
    expect(loadSymonTextSession(sessionId)).toMatchObject({ model: 'gpt-5.6-sol', effort: 'high', allowDefaultFallback: false });
    await POST(request({ conversationId, eventId: 'imessage:next', messageId: 'next', text: 'Which model?' }));
    expect(h.pollTurn.mock.calls[1][0].planner).toMatchObject({ model: 'gpt-5.6-sol', allowDefaultFallback: false });
    expect(h.pollTurn.mock.calls[1][0].prompt).toContain('model gpt-5.6-sol, effort high');
    expect(h.readPlanner).toHaveBeenCalledTimes(1);
    expect(h.generateShared).not.toHaveBeenCalled();
  },
);

it.each(['gpt-5.6-sol', 'gpt-6-sol', 'gpt-6.1-sol'])(
  'preserves an existing or explicitly pinned %s session from disk', async (model) => {
    const session = createSymonTextSession({ subject: 'operator', deviceId: null,
      engine: 'codex', model, effort: 'high', workspaceMode: 'o8', repoId: null, repoPath: null, allowedTools: [] });
    store.getOrCreateTurn({ eventId: 'seed', conversationId: 'direct-chat', providerMessageId: 'seed', senderHandle: '+15555550102', recipientHandle: 'imessage', text: 'Hello', now: Date.now() });
    store.appendConversation({ conversationId: 'direct-chat', sessionId: session.sessionId, entries: [], now: Date.now() });
    h.pollTurn.mockResolvedValue({ state: 'done', result: { status: 'done', text: 'Ready.', model: 'gpt-5.6-sol' } });
    await POST(request({ conversationId: 'direct-chat' }));
    expect(h.readPlanner).not.toHaveBeenCalled();
    expect(h.pollTurn.mock.calls[0][0].planner).toMatchObject({ model, allowDefaultFallback: false });
    expect(loadSymonTextSession(session.sessionId)?.model).toBe(model);
  },
);

it('mints phone Auto from native planner-info and binds the effective model through the turn route', async () => {
  h.readPlanner.mockResolvedValue({ available: true, engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', allowDefaultFallback: true, tools: [] });
  const minted = await mintTextSession(request());
  const { session } = await minted.json();
  expect(h.readPlanner).toHaveBeenCalledWith(undefined);
  expect(session).toMatchObject({ model: 'gpt-6.1-sol', effort: 'high' });
  h.pollTurn.mockResolvedValue({ state: 'done', result: { status: 'done', text: 'Ready.', model: 'gpt-5.6-sol', effort: 'high' } });
  const response = await runTextTurn(new NextRequest('http://localhost/api/mobile/symon/text-turn', {
    method: 'POST', body: JSON.stringify({ sessionId: session.sessionId, turnId: 'phone-turn', prompt: 'Hello', planner: session }),
  }));
  expect((await response.json()).result.model).toBe('gpt-5.6-sol');
  expect(h.pollTurn.mock.calls[0][0].planner.allowDefaultFallback).toBe(true);
  expect(loadSymonTextSession(session.sessionId)).toMatchObject({ model: 'gpt-5.6-sol', allowDefaultFallback: false });
});

it('keeps a phone model pin explicit and rejects an unavailable pin before minting', async () => {
  h.model = 'codex-sol-xhigh';
  h.readPlanner.mockResolvedValue({ available: true, engine: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', allowDefaultFallback: false, tools: [] });
  const minted = await mintTextSession(request());
  const { session } = await minted.json();
  expect(h.readPlanner).toHaveBeenCalledWith({ engine: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh' });
  expect(loadSymonTextSession(session.sessionId)?.allowDefaultFallback).toBe(false);
  h.codexReady = false;
  h.readPlanner.mockClear();
  expect((await mintTextSession(request())).status).toBe(503);
  expect(h.readPlanner).not.toHaveBeenCalled();
});

it('consumes new-session retry eligibility after a failed native turn', async () => {
  h.readPlanner.mockResolvedValue({ available: true, engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', allowDefaultFallback: true });
  h.pollTurn.mockResolvedValue({ state: 'error', detail: 'Failure after partial execution mentions gpt-5.6-sol/high' });
  await POST(request({ conversationId: 'direct-chat' }));
  const sessionId = store.getConversation('direct-chat').sessionId!;
  expect(loadSymonTextSession(sessionId)).toMatchObject({ model: 'gpt-6.1-sol', allowDefaultFallback: false });
  await POST(request({ conversationId: 'direct-chat', eventId: 'next', messageId: 'next' }));
  expect(h.pollTurn.mock.calls[1][0].planner.allowDefaultFallback).toBe(false);
});

it.each(['error', 'interrupted'] as const)(
  'binds fallback after %s through persisted phone and managed routes', async (status) => {
    h.readPlanner.mockResolvedValue({ available: true, engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', allowDefaultFallback: true, tools: [] });
    const terminal = { state: status === 'error' ? 'error' : 'done', detail: 'Planner connection lost after a tool',
      result: { status, text: '', model: 'gpt-5.6-sol', effort: 'high' } };
    h.pollTurn.mockResolvedValue(terminal);
    await POST(request({ conversationId: 'direct-chat' }));
    const managedId = store.getConversation('direct-chat').sessionId!;
    expect(loadSymonTextSession(managedId)).toMatchObject({ model: 'gpt-5.6-sol', effort: 'high', allowDefaultFallback: false });
    await POST(request({ conversationId: 'direct-chat' }));
    expect(h.pollTurn).toHaveBeenCalledTimes(1); // terminal delivery does not replay execution
    await POST(request({ conversationId: 'direct-chat', eventId: 'next', messageId: 'next' }));
    expect(h.pollTurn.mock.calls[1][0].planner).toMatchObject({ model: 'gpt-5.6-sol', effort: 'high', allowDefaultFallback: false });
    const { session } = await (await mintTextSession(request())).json();
    const phoneRequest = (turnId: string, planner: unknown) => new NextRequest('http://localhost/api/mobile/symon/text-turn', {
      method: 'POST', body: JSON.stringify({ sessionId: session.sessionId, turnId, prompt: 'Hello', planner }),
    });
    await runTextTurn(phoneRequest('phone-first', session));
    const bound = loadSymonTextSession(session.sessionId)!;
    expect(bound).toMatchObject({ model: 'gpt-5.6-sol', effort: 'high', allowDefaultFallback: false });
    await runTextTurn(phoneRequest('phone-next', bound));
    expect(h.pollTurn.mock.calls[3][0].planner).toMatchObject({ model: 'gpt-5.6-sol', effort: 'high', allowDefaultFallback: false });
  },
);

it.each([
  ['phone', 'error'], ['phone', 'interrupted'],
  ['managed', 'error'], ['managed', 'interrupted'],
])('carries %s %s metadata through the real eval/client bridge into disk', async (surface, status) => {
  const nativeRun = vi.fn(async (..._args: unknown[]) => ({
    status, text: '', model: 'gpt-5.6-sol', effort: 'high', detail: 'fixture planner failure',
  }));
  const context = { window: { __o8SymonAgent: { text: { runTurn: nativeRun } } } };
  const clientGlobal = globalThis as typeof globalThis & { __o8SymonTextClient?: unknown };
  const previousClient = clientGlobal.__o8SymonTextClient;
  clientGlobal.__o8SymonTextClient = { evalJs: async (code: string) => ({ result: runInNewContext(code, context) }) };
  const actual = await vi.importActual<typeof import('@/lib/mobile/symon-text-bridge-client')>('@/lib/mobile/symon-text-bridge-client');
  h.pollTurn.mockImplementation(actual.pollSymonTextTurn);
  h.readPlanner.mockResolvedValue({ available: true, engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', allowDefaultFallback: true, tools: [] });
  try {
    let sessionId: string;
    if (surface === 'phone') {
      const { session } = await (await mintTextSession(request())).json();
      sessionId = session.sessionId;
      const phone = (turnId: string) => new NextRequest('http://localhost/api/mobile/symon/text-turn', {
        method: 'POST', body: JSON.stringify({ sessionId, turnId, prompt: 'Hello', planner: loadSymonTextSession(sessionId) }),
      });
      const first = await (await runTextTurn(phone('first'))).json();
      expect(first.state).toBe(status === 'error' ? 'error' : 'done');
      if (status === 'error') expect(first.detail).toBe('fixture planner failure');
      expect(first.result).toMatchObject({ status, model: 'gpt-5.6-sol', effort: 'high' });
      await runTextTurn(phone('first'));
      expect(nativeRun).toHaveBeenCalledTimes(1);
      await runTextTurn(phone('next'));
    } else {
      const first = await (await POST(request({ conversationId: 'direct-chat' }))).json();
      expect(first.text).toContain(status === 'error' ? 'fixture planner failure' : 'I stopped');
      sessionId = store.getConversation('direct-chat').sessionId!;
      await POST(request({ conversationId: 'direct-chat' }));
      expect(nativeRun).toHaveBeenCalledTimes(1);
      await POST(request({ conversationId: 'direct-chat', eventId: 'next', messageId: 'next' }));
    }
    expect(loadSymonTextSession(sessionId)).toMatchObject({ model: 'gpt-5.6-sol', effort: 'high', allowDefaultFallback: false });
    expect(nativeRun.mock.calls[1][3]).toMatchObject({ model: 'gpt-5.6-sol', effort: 'high', allowDefaultFallback: false });
  } finally {
    if (previousClient === undefined) delete clientGlobal.__o8SymonTextClient;
    else clientGlobal.__o8SymonTextClient = previousClient;
  }
});
