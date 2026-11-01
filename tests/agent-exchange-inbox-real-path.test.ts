import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { AgentMessage } from '@/lib/agents/types';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-exchange-inbox-'));
const token = 'exchange-inbox-operator-fixture-0123456789';
const priorEnvironment = Object.fromEntries(['O8_DATA_DIR', 'CORTEX_IDE_DATA_DIR', 'CORTEX_IDE_DB_PATH']
  .map(key => [key, process.env[key]]));
writeFileSync(join(dataDir, 'ws-token'), `${token}\n`, { mode: 0o600 });
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DB_PATH = join(dataDir, 'fixture.db');

const { closeDb, getSqlite } = await import('@/lib/db');
const { ensureAgentBusSchema, getAgentConversation, persistAgentMessage } = await import('@/lib/agents/store');
const conversationRoute = await import('@/app/api/agents/conversation/route');
const { matchNativeHttpRoute } = await import('@/lib/ws-server/native-http-registry');
const { handleNativeHttp } = await import('@/lib/ws-server/native-http-routes');

type Conversation = NonNullable<ReturnType<typeof getAgentConversation>> & { revision?: number };
type ConversationBody = {
  schema?: string;
  conversations?: Conversation[];
  conversation?: Conversation;
  messages?: AgentMessage[];
  nextCursor?: string | null;
  undo?: unknown;
};

function request(query = '', body?: unknown) {
  return new NextRequest(`http://localhost:3001/api/agents/conversation${query}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { host: 'localhost:3001', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function read(query: Record<string, string>) {
  const response = await conversationRoute.GET(request(`?${new URLSearchParams(query)}`));
  return { status: response.status, body: await response.json() as ConversationBody };
}

async function change(body: Record<string, unknown>) {
  const response = await conversationRoute.POST(request('', body));
  return { status: response.status, body: await response.json() as ConversationBody };
}

function message(repo: string, text: string, replyTo?: AgentMessage, close = false) {
  const reverse = replyTo?.to === 'Birch';
  return persistAgentMessage({
    repo, text, from: reverse ? 'Birch' : 'Aster', to: reverse ? 'Aster' : 'Birch',
    refs: { laneId: null, packetId: null, identities: {
      from: { runtime: 'poll', sessionKey: reverse ? 'poll:birch-original' : 'poll:aster-original' },
      to: { runtime: 'poll', sessionKey: reverse ? 'poll:aster-original' : 'poll:birch-original' },
    } },
    ...(replyTo ? { replyToId: replyTo.id } : {}), close,
  }).message;
}

function stored(id: string): Conversation {
  const value = getAgentConversation(id);
  expect(value, 'the production bus must persist this exchange').not.toBeNull();
  return value!;
}

function unchanged(conversation: Conversation) {
  return { participants: conversation.participants, turnCount: conversation.turnCount, turnLimit: conversation.turnLimit,
    remainingTurns: conversation.remainingTurns, lastMessageId: conversation.lastMessageId, summary: conversation.summary };
}

function messages(id: string) {
  return getSqlite().prepare('SELECT * FROM agent_messages WHERE conversation_id = ? ORDER BY sequence')
    .all(id);
}

async function manualClose(repo: string, id: string, clientMutationId: string) {
  const before = stored(id);
  const result = await change({ repo, id, action: 'close', undoable: true, clientMutationId, expectedRevision: before.revision });
  expect(result.status).toBe(200);
  expect(result.body.conversation?.status).toBe('closed');
  expect(result.body.undo, 'only a confirmed manual transition can provide its exact Undo receipt').toBeTruthy();
  return result.body;
}

beforeEach(() => {
  ensureAgentBusSchema();
  const db = getSqlite();
  db.prepare('DELETE FROM agent_messages').run();
  db.prepare('DELETE FROM agent_conversations').run();
});

afterAll(() => {
  closeDb();
  for (const [key, value] of Object.entries(priorEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe('agent exchange Inbox through the production bus routes', () => {
  it('keeps an old open exchange beyond the recent closed tail and enumerates every open identity once', async () => {
    const repo = join(dataDir, 'open-inventory');
    const first = message(repo, 'Old exchange still needs attention.');
    const second = message(repo, 'A separate exchange between the same peers.');
    const third = message(repo, 'A third open exchange.');
    const expected = [first, second, third].map(item => item.conversation!.id).sort();
    getSqlite().prepare('UPDATE agent_conversations SET updated_at = ?').run('2001-01-01T00:00:00.000Z');
    for (let index = 0; index < 105; index++) {
      const closed = message(repo, `Newer closed exchange ${index}.`);
      expect((await change({ repo, id: closed.conversation!.id, action: 'close' })).status).toBe(200);
    }
    const ids: string[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const result = await read({ repo, status: 'open', limit: '2', ...(cursor ? { cursor } : {}) });
      expect(result.status).toBe(200);
      expect(result.body.conversations?.every(item => item.status === 'open'), 'closed rows must not consume the open inventory limit').toBe(true);
      ids.push(...(result.body.conversations ?? []).map(item => item.id));
      cursor = result.body.nextCursor ?? null;
      if (!cursor) break;
      expect(cursors.has(cursor), 'pagination must advance').toBe(false);
      cursors.add(cursor);
    }
    expect(ids.sort()).toEqual(expected);
    expect(new Set(ids).size).toBe(ids.length);
    // Legacy callers still receive their existing schema/default recent limit.
    const legacy = await read({ repo });
    expect(legacy.status).toBe(200);
    expect(legacy.body.schema).toBe('o8/agents.conversations/v1');
    expect(legacy.body.conversations).toHaveLength(50);
  });

  it('enumerates all repositories explicitly without changing repository-scoped defaults', async () => {
    const firstRepo = join(dataDir, 'scope-first');
    const secondRepo = join(dataDir, 'scope-second');
    const first = message(firstRepo, 'First repository exchange.');
    const second = message(secondRepo, 'Second repository exchange.');
    const all = await read({ scope: 'all', status: 'open', limit: '100' });
    expect(all.status, 'all-repository Inbox enumeration must be an explicit supported query').toBe(200);
    expect(all.body.conversations?.map(item => [item.repo, item.id]).sort()).toEqual([
      [stored(first.conversation!.id).repo, first.conversation!.id], [stored(second.conversation!.id).repo, second.conversation!.id],
    ].sort());
    const scoped = await read({ repo: firstRepo });
    expect(scoped.status).toBe(200);
    expect(scoped.body.conversations?.map(item => item.id)).toEqual([first.conversation!.id]);
  });

  it('reads the exact ordered transcript after unrelated traffic and restart without importing a network binding', async () => {
    const repo = join(dataDir, 'exact-transcript');
    const first = message(repo, 'Original exchange opening.');
    const reply = message(repo, 'Original peer response.', first);
    for (let index = 0; index < 60; index++) message(repo, `Unrelated exchange ${index}.`);
    const id = first.conversation!.id;
    const before = stored(id);
    closeDb();
    const result = await read({ repo, id });
    expect(result.status).toBe(200);
    expect(result.body.conversation).toMatchObject({ id, repo: before.repo, status: 'open', turnCount: 2 });
    expect(result.body.messages?.map(item => item.id)).toEqual([first.id, reply.id]);
    expect(result.body.messages?.map(item => item.text)).toEqual(['Original exchange opening.', 'Original peer response.']);
    expect(result.body.messages?.map(item => item.refs.identities?.from?.sessionKey)).toEqual(['poll:aster-original', 'poll:birch-original']);
    expect(result.body.messages?.every(item => item.conversation?.id === id)).toBe(true);
    expect(unchanged(stored(id))).toEqual(unchanged(before));
  });

  it('undoes only the exact confirmed manual close without changing budget, messages or summary', async () => {
    const repo = join(dataDir, 'manual-undo');
    const first = message(repo, 'Keep the exchange and its remaining budget.');
    const id = first.conversation!.id;
    getSqlite().prepare('UPDATE agent_conversations SET summary = ? WHERE id = ?').run('Preserve this existing summary.', id);
    const before = stored(id);
    const beforeMessages = messages(id);
    const closed = await manualClose(repo, id, 'manual-close-one');
    const duplicate = await change({ repo, id, action: 'close', undoable: true, clientMutationId: 'manual-close-one', expectedRevision: before.revision });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.undo).toEqual(closed.undo);
    expect(unchanged(stored(id))).toEqual(unchanged(before));
    const undo = await change({ repo, id, action: 'undo-close', undo: closed.undo });
    expect(undo.status).toBe(200);
    expect(stored(id)).toMatchObject({ status: 'open', closedReason: null });
    expect(unchanged(stored(id))).toEqual(unchanged(before));
    expect(messages(id)).toEqual(beforeMessages);
    closeDb();
    expect(stored(id).status).toBe('open');
    expect(unchanged(stored(id))).toEqual(unchanged(before));
  });

  it('refuses a stale Undo receipt after a new message and a later manual close', async () => {
    const repo = join(dataDir, 'stale-undo');
    const first = message(repo, 'Initial exchange.');
    const id = first.conversation!.id;
    const firstClose = await manualClose(repo, id, 'stale-close-one');
    expect((await change({ repo, id, action: 'undo-close', undo: firstClose.undo })).status).toBe(200);
    message(repo, 'A newer accepted reply.', first);
    const secondClose = await manualClose(repo, id, 'stale-close-two');
    const beforeStale = stored(id);
    const beforeMessages = messages(id);
    const stale = await change({ repo, id, action: 'undo-close', undo: firstClose.undo });
    expect(stale.status).toBe(409);
    expect(stored(id)).toEqual(beforeStale);
    expect(messages(id)).toEqual(beforeMessages);
    expect((await change({ repo, id, action: 'undo-close', undo: secondClose.undo })).status).toBe(200);
    expect(stored(id).status).toBe('open');
  });

  it('maps final and exhausted exchanges to closed without turning a no-op Settle into an extension', async () => {
    const repo = join(dataDir, 'automatic-close');
    const control = message(repo, 'Manual receipt from another exchange.');
    const receipt = (await manualClose(repo, control.conversation!.id, 'automatic-control')).undo;
    const opening = message(repo, 'Please check the result.');
    const final = message(repo, 'Final response.', opening, true);
    let exhausted = message(repo, 'Budget turn 1.');
    for (let turn = 2; turn <= 8; turn++) exhausted = message(repo, `Budget turn ${turn}.`, exhausted);
    for (const end of [final, exhausted]) {
      const id = end.conversation!.id;
      const before = stored(id);
      expect(before.status).toBe('closed');
      const noOp = await change({ repo, id, action: 'close', undoable: true, clientMutationId: `closed-${id}` });
      expect(noOp.status).toBe(200);
      expect(noOp.body.undo ?? null).toBeNull();
      expect((await change({ repo, id, action: 'undo-close', undo: receipt })).status).toBe(409);
      expect(stored(id)).toEqual(before);
    }
  });

  it('reaches the real bus GET and POST handlers through native HTTP dispatch and persisted state', async () => {
    const repo = join(dataDir, 'native-dispatch');
    const opening = message(repo, 'Native HTTP must read and close this durable exchange.');
    const id = opening.conversation!.id;
    const before = stored(id);
    const beforeMessages = messages(id);
    // Establish the existing isolated principal/data fixture before crossing the native dispatcher.
    expect((await read({ repo })).status).toBe(200);
    const server = createServer(async (req, res) => {
      if (!await handleNativeHttp(req, res)) res.writeHead(404).end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Native HTTP fixture did not bind');
      const url = new URL('/api/agents/conversation', `http://127.0.0.1:${address.port}`);
      url.search = new URLSearchParams({ repo }).toString();
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
      const listed = await fetch(url, { headers, signal: AbortSignal.timeout(5_000) });
      expect(listed.status, 'native dispatch must reach the bus handler; the baseline has no conversation registration').toBe(200);
      expect(await listed.json()).toMatchObject({
        schema: 'o8/agents.conversations/v1', conversations: [expect.objectContaining({ id, status: 'open' })],
      });
      const closed = await fetch(url, {
        method: 'POST', headers, body: JSON.stringify({ repo, id, action: 'close' }), signal: AbortSignal.timeout(5_000),
      });
      expect(closed.status).toBe(200);
      expect(await closed.json()).toMatchObject({
        schema: 'o8/agents.conversation/v1', ok: true, conversation: { id, status: 'closed', closedReason: 'operator_stop' },
      });
      expect(stored(id).status).toBe('closed');
      expect(unchanged(stored(id))).toEqual(unchanged(before));
      expect(messages(id)).toEqual(beforeMessages);
      const refreshed = await fetch(url, { headers, signal: AbortSignal.timeout(5_000) });
      expect(refreshed.status).toBe(200);
      expect(await refreshed.json()).toMatchObject({ conversations: [expect.objectContaining({ id, status: 'closed' })] });
      // Supplemental catalog assertion follows actual dispatch and persistence proof.
      expect(matchNativeHttpRoute('/api/agents/conversation', 'GET')).toBeDefined();
      expect(matchNativeHttpRoute('/api/agents/conversation', 'POST')).toBeDefined();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
