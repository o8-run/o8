/** Scripted local MCP client -> production tools/needs-input/composer -> persisted bus; no live model claim. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { StdioJsonRpcPeer } from '@/lib/runtimes/shared/stdio-json-rpc';

const root = mkdtempSync(join(tmpdir(), 'o8-network-question-'));
const repo = join(root, 'repo'); mkdirSync(repo); mkdirSync(join(root, 'profiles'));
const token = 'scripted-local-question-fixture'; writeFileSync(join(root, 'ws-token'), token);
Object.assign(process.env, { O8_DATA_DIR: root, CORTEX_IDE_DATA_DIR: root,
  CORTEX_IDE_DB_PATH: join(root, 'questions.db'), O8_GROK_AGENT_DATA: join(root, 'profiles') });
const { getSqlite, closeDb } = await import('@/lib/db');
const { upsertAgentPresence } = await import('@/lib/agents/store');
const { applyLocalBotMembershipCommand: membership } = await import('@/lib/agents/bot-membership-commands');
const { GET: INBOX } = await import('@/app/api/panel/supervisor-inbox/route');
const { GET: THREADS } = await import('@/app/api/mobile/orchestrator/threads/route');
const { GET: HISTORY, PATCH: PREFERENCES } = await import('@/app/api/v2/chat-history/route');
const { POST: COMPOSE } = await import('@/app/api/orchestrator/composer-queue/route');
const peers: StdioJsonRpcPeer[] = [];
let bindingId: string;
beforeAll(() => {
  upsertAgentPresence({ agentId: 'question-source', name: 'LocalQuestionBot', repo, runtime: 'scripted-local',
    sessionKey: 'scripted-question-session', worktreePath: null, laneId: null, packetId: null,
    lastSeen: new Date(Date.now() - 20 * 60_000).toISOString() });
  membership({ action: 'create', id: 'bot-question', house: 'scripted-local', name: 'Question bot' });
  const member = membership({ action: 'bind', memberId: 'bot-question', agentId: 'question-source' });
  if (Array.isArray(member)) throw new Error('Expected one configured member');
  bindingId = member.bindings[0].id;
});
afterAll(async () => {
  await Promise.all(peers.map(peer => peer.close({ gracefulMs: 200 })));
  closeDb(); rmSync(root, { recursive: true, force: true });
});
async function session() {
  const peer = new StdioJsonRpcPeer({ command: process.execPath,
    args: ['--import', 'tsx', 'src/lib/mcp/operator-mcp-server.ts'], cwd: process.cwd(),
    env: { ...process.env, O8_OPERATOR_MCP_PROFILE: 'network', O8_NETWORK_BINDING_ID: bindingId,
      O8_MCP_TRANSPORT: 'stdio', O8_MCP_NODE22_CHECKED: '1' } }, 25_000);
  peers.push(peer);
  await peer.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'scripted-question-client', version: '1' } });
  return peer;
}
type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };
async function tool(peer: StdioJsonRpcPeer, name: string, args: Record<string, unknown> = {}) {
  const result = await peer.request<ToolResult>('tools/call', { name, arguments: args });
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return JSON.parse(result.content[0].text!);
}
function request(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  return new NextRequest(`http://localhost${path}`, { method, headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function row(id: string) {
  const response = await THREADS(request('/api/mobile/orchestrator/threads?limit=500'));
  expect(response.status).toBe(200);
  return (await response.json()).threads.find((item: { id: string }) => item.id === id);
}

it('a local MCP question appears in native needs-input and its correlated human answer survives a session restart', async () => {
  const peer = await session();
  const args = { question: 'Should I make the small local change?', requestId: 'question-restart-one' };
  const asked = await tool(peer, 'ask_user', args);
  expect(asked).toMatchObject({ schema: 'o8/network.question/v1', question: { status: 'pending', text: args.question },
    receipt: { stage: 'accepted', processing: 'unknown' }, projection: { state: 'ready' } });
  const threadId = asked.question.threadId as string;
  const pendingInbox = await (await INBOX(request('/api/panel/supervisor-inbox?includeQuestions=1&questionsOnly=1'))).json();
  expect(pendingInbox.questions).toEqual([expect.objectContaining({ id: asked.question.id, threadId, text: args.question, sessionKey: `llm-chat:${threadId}` })]);
  expect(await row(threadId)).toMatchObject({ id: threadId, source: 'bot-network', outcome: 'asked',
    status: 'ready', inboxSubject: { kind: 'conversation', id: threadId } });
  const duplicate = await tool(peer, 'ask_user', args);
  expect(duplicate.question.id).toBe(asked.question.id);
  expect(getSqlite().prepare('SELECT id FROM agent_messages').all()).toHaveLength(1);
  const before = await row(threadId);
  expect((await PREFERENCES(request('/api/v2/chat-history', {
    tabId: threadId, inboxAction: 'pin', inboxRevision: before.inboxRevision, orderKey: 'n',
  }, 'PATCH'))).status).toBe(200);
  const answer = await COMPOSE(request('/api/orchestrator/composer-queue', { repoPath: repo, threadId,
    id: 'question-native-answer', intent: 'send-next', payload: { text: 'Yes, use the small local change.',
      wireMessage: 'Yes, use the small local change.', images: [], routing: { source: 'bot-network' } } }));
  expect(answer.status, await answer.clone().text()).toBe(200);
  const accepted = (await answer.json()).item.message;
  expect(accepted).toMatchObject({ from: 'operator', to: 'LocalQuestionBot', text: 'Yes, use the small local change.',
    conversation: { replyToId: asked.question.messageId } });
  expect(getSqlite().prepare('SELECT id FROM composer_send_queue').all()).toEqual([]);
  const answered = await tool(peer, 'ask_user', args);
  expect(answered.question).toMatchObject({ id: asked.question.id, status: 'answered',
    answer: { messageId: accepted.id, text: accepted.text } });
  expect(await row(threadId)).toMatchObject({ pinnedAt: expect.any(String), status: 'ready', inboxRevision: 1 });
  expect(await row(threadId)).not.toHaveProperty('outcome');
  expect((await (await INBOX(request('/api/panel/supervisor-inbox?includeQuestions=1&questionsOnly=1'))).json()).questions).toEqual([]);
  await peer.close({ gracefulMs: 200 }); closeDb();
  const restarted = await session();
  const resumed = await tool(restarted, 'ask_user', args);
  expect(resumed.question).toEqual(answered.question);
  const inbox = await tool(restarted, 'check_inbox');
  expect(inbox.messages).toHaveLength(1);
  expect(inbox.messages[0]).toMatchObject({ id: accepted.id, text: accepted.text });
  const historyResponse = await HISTORY(request(`/api/v2/chat-history?tabId=${threadId}`));
  const history = await historyResponse.json();
  expect(history.messages.map((message: { role: string; author: { kind: string } }) => [message.role, message.author.kind]))
    .toEqual([['assistant', 'bot'], ['user', 'human']]);
  expect(getSqlite().prepare('SELECT id FROM agent_messages').all()).toHaveLength(2);
}, 60_000);

it('coalesces concurrent question retries and retains the answer after inbox acknowledgement', async () => {
  const a = await session(); const b = await session();
  const args = { question: 'Which small local option should I use?', requestId: 'question-concurrent' };
  const before = getSqlite().prepare('SELECT COUNT(*) AS n FROM agent_messages').get() as { n: number };
  const [one, two] = await Promise.all([tool(a, 'ask_user', args), tool(b, 'ask_user', args)]);
  expect(one.question.id).toBe(two.question.id);
  expect(getSqlite().prepare('SELECT COUNT(*) AS n FROM agent_messages').get()).toEqual({ n: before.n + 1 });
  const conflict = await a.request<ToolResult>('tools/call', { name: 'ask_user', arguments: { ...args, question: 'Different question' } });
  expect(conflict.isError).toBe(true);
  expect(JSON.parse(conflict.content[0].text!).error.code).toBe('network_question_conflict');
  const answer = await COMPOSE(request('/api/orchestrator/composer-queue', { repoPath: repo, threadId: one.question.threadId,
    id: 'question-concurrent-answer', intent: 'send-next', payload: { text: 'Use option one.', wireMessage: 'Use option one.', images: [] } }));
  expect(answer.status, await answer.clone().text()).toBe(200);
  const message = (await answer.json()).item.message;
  expect((await tool(b, 'check_inbox')).messages.some((m: { id: string }) => m.id === message.id)).toBe(true);
  expect((await tool(a, 'check_inbox')).messages.some((m: { id: string }) => m.id === message.id)).toBe(false);
  const resumed = await tool(a, 'ask_user', args);
  expect(resumed.question).toMatchObject({ status: 'answered', answer: { messageId: message.id, text: 'Use option one.' } });
}, 60_000);

it('rolls back a question if purpose persistence fails, then accepts one same-id retry', async () => {
  const peer = await session();
  const db = getSqlite();
  const before = db.prepare('SELECT COUNT(*) AS n FROM agent_messages').get();
  const beforeThreads = db.prepare('SELECT COUNT(*) AS n FROM bot_network_threads').get();
  const beforeQuestions = db.prepare('SELECT COUNT(*) AS n FROM bot_network_questions').get();
  const args = { question: 'Should I keep the local revision?', requestId: 'question-rollback' };
  db.exec("CREATE TRIGGER reject_question_fixture BEFORE INSERT ON bot_network_questions BEGIN SELECT RAISE(ABORT,'Fixture question write failed'); END");
  try {
    const result = await peer.request<ToolResult>('tools/call', { name: 'ask_user', arguments: args });
    expect(result.isError).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_messages').get()).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM bot_network_threads').get()).toEqual(beforeThreads);
    expect(db.prepare('SELECT COUNT(*) AS n FROM bot_network_questions').get()).toEqual(beforeQuestions);
  } finally { db.exec('DROP TRIGGER reject_question_fixture'); }
  const retried = await tool(peer, 'ask_user', args);
  expect(retried.question.status).toBe('pending');
  expect(db.prepare('SELECT COUNT(*) AS n FROM bot_network_questions').get()).toEqual({ n: (beforeQuestions as { n: number }).n + 1 });
}, 60_000);

it('repairs a lost canonical question file after restart without duplicating bus content', async () => {
  const { existsSync, unlinkSync } = await import('node:fs');
  const { getCanonicalChatHistoryPath } = await import('@/lib/llm/chat-history-store');
  const peer = await session();
  const args = { question: 'Can I use the local fallback?', requestId: 'question-recover-projection' };
  const asked = await tool(peer, 'ask_user', args);
  const path = getCanonicalChatHistoryPath(asked.question.threadId);
  expect(existsSync(path)).toBe(true); unlinkSync(path);
  const before = getSqlite().prepare('SELECT COUNT(*) AS n FROM agent_messages').get();
  await peer.close({ gracefulMs: 200 }); closeDb();
  // Catalog reconciliation repairs from the durable bus before a tool retry.
  expect(await row(asked.question.threadId)).toMatchObject({ outcome: 'asked' });
  expect(existsSync(path)).toBe(true);
  const restarted = await session();
  const recovered = await tool(restarted, 'ask_user', args);
  expect(recovered.question).toEqual(asked.question);
  expect(getSqlite().prepare('SELECT COUNT(*) AS n FROM agent_messages').get()).toEqual(before);
}, 60_000);

it('bounds the optional question feed, keeps full text in history and scopes workspace previews', async () => {
  const { askNetworkMcpUser } = await import('@/lib/bots/question-service');
  const questionText = 'x'.repeat(1199) + '😀' + 'Local question '.repeat(130);
  const long = await askNetworkMcpUser(bindingId, { question: questionText, requestId: 'question-preview-long' });
  for (let n = 0; n < 65; n++) await askNetworkMcpUser(bindingId, { question: `Local queue question ${n}`, requestId: `question-preview-${n}` });
  const feed = await (await INBOX(request('/api/panel/supervisor-inbox?includeQuestions=1&questionsOnly=1'))).json();
  expect(feed.questions).toHaveLength(64); expect(feed.questionsTruncated).toBe(true);
  const preview = feed.questions.find((q: { id: string }) => q.id === long.question.id);
  expect(preview.text).toBe('x'.repeat(1199) + '…');
  const complete = await HISTORY(request(`/api/v2/chat-history?tabId=${long.question.threadId}`));
  expect((await complete.json()).messages[0].content).toBe(long.question.text);
  const otherRepo = join(root, 'other-repo'); mkdirSync(otherRepo);
  upsertAgentPresence({ agentId: 'question-other-source', name: 'OtherQuestionBot', repo: otherRepo, runtime: 'scripted-local',
    sessionKey: 'scripted-question-other', worktreePath: null, laneId: null, packetId: null,
    lastSeen: new Date(Date.now() - 20 * 60_000).toISOString() });
  membership({ action: 'create', id: 'bot-question-other', house: 'scripted-local', name: 'Other question bot' });
  const member = membership({ action: 'bind', memberId: 'bot-question-other', agentId: 'question-other-source' });
  if (Array.isArray(member)) throw new Error('Expected other member');
  const other = await askNetworkMcpUser(member.bindings[0].id, { question: 'Use this workspace?', requestId: 'question-preview-long' });
  expect(other.question.id).not.toBe(long.question.id);
  const scoped = await (await INBOX(request(`/api/panel/supervisor-inbox?includeQuestions=1&questionsOnly=1&questionsRepoPath=${encodeURIComponent(otherRepo)}`))).json();
  expect(scoped.questions.map((q: { id: string }) => q.id)).toEqual([other.question.id]);
  expect(scoped.questionsTruncated).toBe(false);
}, 60_000);

it('recognizes an existing bus reply after a case-only participant-name change', async () => {
  const peer = await session();
  const args = { question: 'Is this local revision acceptable?', requestId: 'question-case-only' };
  const asked = await tool(peer, 'ask_user', args);
  const { findAgentPresence } = await import('@/lib/agents/store');
  const before = findAgentPresence({ agentId: 'question-source' })!;
  try {
    upsertAgentPresence({ ...before, name: before.name.toLowerCase() });
    const { POST: SEND } = await import('@/app/api/agents/message/route');
    const response = await SEND(request('/api/agents/message', { repo, to: before.name.toLowerCase(),
      text: 'Yes, that revision is acceptable.', replyToId: asked.question.messageId }));
    expect(response.status, await response.clone().text()).toBe(201);
    const message = (await response.json()).message;
    const answered = await tool(peer, 'ask_user', args);
    expect(answered.question).toMatchObject({ status: 'answered', answer: { messageId: message.id } });
    const feed = await (await INBOX(request('/api/panel/supervisor-inbox?includeQuestions=1&questionsOnly=1'))).json();
    expect(feed.questions.some((q: { id: string }) => q.id === asked.question.id)).toBe(false);
  } finally { upsertAgentPresence(before); }
}, 60_000);
