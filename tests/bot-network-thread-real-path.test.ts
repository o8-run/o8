import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
const root = mkdtempSync(join(tmpdir(), 'o8-network-thread-'));
const repo = join(root, 'repo'); mkdirSync(repo);
mkdirSync(join(root, 'profiles'));
const token = 'local-network-thread-fixture-0123456789';
writeFileSync(join(root, 'ws-token'), token);
Object.assign(process.env, { O8_DATA_DIR: root, CORTEX_IDE_DATA_DIR: root,
  CORTEX_IDE_DB_PATH: join(root, 'network.db'), O8_GROK_AGENT_DATA: join(root, 'profiles') });
const { getSqlite, closeDb } = await import('@/lib/db');
const { persistCanonicalChatHistoryRecord, readPersistedLlmChat, getCanonicalChatHistoryPath, withCanonicalChatHistoryLock } = await import('@/lib/llm/chat-history-store');
const { GET: HISTORY } = await import('@/app/api/mobile/history/route');
const { POST: COMPOSE, GET: QUEUE, DELETE: REMOVE, PATCH: RETRY } = await import('@/app/api/orchestrator/composer-queue/route');
const { DELETE: DELETE_HISTORY, GET: RECORD, PATCH: PATCH_HISTORY, POST: WRITE_HISTORY } = await import('@/app/api/v2/chat-history/route');
const { readProjectedThread, listMobileOrchestratorThreads } = await import('@/lib/mobile/orchestrator-thread-history');
const { POST: AGENT_MESSAGE } = await import('@/app/api/agents/message/route');
const { applyLocalBotMembershipCommand: membership } = await import('@/lib/agents/bot-membership-commands');
const { ensureAgentBusSchema, upsertAgentPresence, persistAgentMessage } = await import('@/lib/agents/store');
const { createNetworkThread, findNetworkThread, reserveNetworkSend } = await import('@/lib/bots/network-store');
const { projectNetworkThread } = await import('@/lib/bots/network-projection');
const { readAgentConversationMessages } = await import('@/lib/agents/message-history');
const { defaultLiveAgentPresenceSeams } = await import('@/lib/agents/live-presence');
const threadId = 'thoughts-network-fixture';
const author = { kind: 'bot', id: 'bot-peer', name: 'Original peer', agentId: 'source-peer' };
function request(path: string, body?: unknown, method?: string) {
  return new NextRequest(`http://localhost${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
beforeEach(() => {
  ensureAgentBusSchema(getSqlite());
  getSqlite().exec(`DELETE FROM bot_network_sends; DELETE FROM bot_network_threads;
    DELETE FROM bot_member_sources; DELETE FROM bot_member_bindings; DELETE FROM bot_members;
    DELETE FROM agent_messages; DELETE FROM agent_conversations; DELETE FROM agent_presence;`);
  persistCanonicalChatHistoryRecord(threadId, { source: 'bot-network', repoPath: repo, title: 'Peer exchange',
    messages: [{ id: 'network-message-fixture', role: 'user', content: 'A peer message', timestamp: 1, author }] });
  getSqlite().exec('DELETE FROM composer_send_queue');
});
afterAll(() => { closeDb(); rmSync(root, { recursive: true, force: true }); });

function localBinding(name = 'OriginalPeer', agentId = 'source-peer') {
  upsertAgentPresence({ agentId, name, repo, runtime: 'fixture-runtime', sessionKey: `fixture-session:${agentId}`,
    worktreePath: null, laneId: null, packetId: null, lastSeen: new Date(Date.now() - 20 * 60_000).toISOString() });
  const member = membership({ action: 'create', house: 'fixture', name });
  if (Array.isArray(member)) throw new Error('Expected a member');
  const bound = membership({ action: 'bind', memberId: member.id, agentId });
  if (Array.isArray(bound)) throw new Error('Expected a member');
  return { member: bound, binding: bound.bindings[0] };
}
function open() {
  const { member, binding } = localBinding();
  const thread = createNetworkThread({ bindingIds: [binding.id] });
  projectNetworkThread(thread.threadId);
  return { thread, member, binding };
}
function composerBody(id: string, thread: { threadId: string }, text = 'Plain human message') {
  return { repoPath: repo, threadId: thread.threadId, id, intent: 'send-next', payload: { text,
    wireMessage: `An orchestrator-only preamble that must not reach the peer\n\n${text}`, images: [],
    routing: { backend: 'claude', model: 'claude-code', effort: 'medium', permissionMode: 'plan', mode: 'single', pickedMode: 'solo', collide: false } } };
}
async function history(id: string) {
  const response = await HISTORY(request(`/api/mobile/history?sessionKey=llm-chat:${id}&page=1&limit=100`));
  expect(response.status).toBe(200);
  return (await response.json()).transcript as Array<Record<string, unknown>>;
}
async function agentMessage(body: unknown) {
  const response = await AGENT_MESSAGE(request('/api/agents/message', body));
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(201);
  return (await response.json()).message as import('@/lib/agents/types').AgentMessage;
}

it('the production native history route preserves peer authorship independently of role or model', async () => {
  const response = await HISTORY(request(`/api/mobile/history?sessionKey=llm-chat:${threadId}&page=1&limit=100`));
  expect(response.status).toBe(200);
  expect((await response.json()).transcript[0]).toMatchObject({ role: 'user', author });
});

it('a network peer message does not infer working activity from its user role', () => {
  expect(readProjectedThread(threadId)?.status).toBe('ready');
});

it('the production composer rejects an unavailable network binding without enqueuing orchestrator work', async () => {
  const response = await COMPOSE(request('/api/orchestrator/composer-queue', { repoPath: repo, threadId,
    id: 'network-send-fixture', intent: 'send-next', payload: { text: 'Reply to the peer', wireMessage: 'Reply to the peer', images: [],
      routing: { backend: 'claude', model: 'claude-code', effort: 'medium', permissionMode: 'plan', mode: 'single', pickedMode: 'solo', collide: false } } }));
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(getSqlite().prepare('SELECT id FROM composer_send_queue WHERE thread_id = ?').all(threadId)).toEqual([]);
});

it('native composer sends use the bus, preserve peer authorship and correlate the human reply', async () => {
  const { thread, member, binding } = open();
  const response = await COMPOSE(request('/api/orchestrator/composer-queue', composerBody('network-native-first', thread)));
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
  const first = (await response.json()).item.message as import('@/lib/agents/types').AgentMessage;
  expect(first).toMatchObject({ from: 'operator', to: binding.agentName, text: 'Plain human message', delivery: 'poll' });
  expect(getSqlite().prepare('SELECT id FROM composer_send_queue').all()).toEqual([]);
  const reply = await agentMessage({ repo, fromAgentId: binding.agentId, to: 'operator', text: 'Peer response', replyToId: first.id });
  const beforeRename = await history(thread.threadId);
  expect(beforeRename[1]).toMatchObject({ role: 'assistant', author: { kind: 'bot', id: member.id, agentId: binding.agentId,
    name: binding.agentName, runtime: binding.runtime, sessionKey: binding.sessionKey }, network: { messageId: reply.id, replyToId: first.id } });
  expect(beforeRename[1].model).toBeUndefined();
  membership({ action: 'rename', memberId: member.id, name: 'A renamed display name' });
  projectNetworkThread(thread.threadId);
  expect((await history(thread.threadId))[1].author).toEqual(beforeRename[1].author);
  const thirdResponse = await COMPOSE(request('/api/orchestrator/composer-queue', composerBody('network-native-third', thread, 'Correlated follow-up')));
  expect(thirdResponse.status, JSON.stringify(await thirdResponse.clone().json())).toBe(200);
  const third = (await thirdResponse.json()).item.message;
  expect(third.conversation).toMatchObject({ id: first.conversation!.id, replyToId: reply.id, turnIndex: 3 });
  const duplicate = await COMPOSE(request('/api/orchestrator/composer-queue', composerBody('network-native-third', thread, 'Correlated follow-up')));
  expect(duplicate.status).toBe(200);
  expect((await duplicate.json()).item.message.id).toBe(third.id);
  expect(readAgentConversationMessages(first.conversation!.id)).toHaveLength(3);
  const conflict = await COMPOSE(request('/api/orchestrator/composer-queue', composerBody('network-native-third', thread, 'Different text')));
  expect(conflict.status).toBe(409);
  expect(readProjectedThread(thread.threadId)?.status).toBe('ready');
}, 30_000);

it('replays projection after restart without duplicate messages or changing history preferences', async () => {
  const { thread } = open();
  const sent = await COMPOSE(request('/api/orchestrator/composer-queue', composerBody('network-restart-first', thread)));
  expect(sent.status).toBe(200);
  const record = readPersistedLlmChat(thread.threadId)!.history;
  persistCanonicalChatHistoryRecord(thread.threadId, { ...record, pinned: true, starred: true, title: 'Operator title', archivedAt: null });
  const previous = await history(thread.threadId);
  const path = getCanonicalChatHistoryPath(thread.threadId);
  const unchanged = statSync(path).mtimeMs;
  await history(thread.threadId); await history(thread.threadId);
  expect(statSync(path).mtimeMs).toBe(unchanged);
  closeDb();
  expect(await history(thread.threadId)).toEqual(previous);
  expect(readPersistedLlmChat(thread.threadId)!.history).toMatchObject({ pinned: true, starred: true, title: 'Operator title' });
  unlinkSync(path); closeDb();
  expect(await history(thread.threadId)).toEqual(previous);
  expect(getSqlite().prepare('SELECT id FROM agent_messages').all()).toHaveLength(1);
}, 30_000);

it('recovers a bus-accepted send when interruption precedes thread association and history projection', async () => {
  const { thread, binding } = open();
  const intent = reserveNetworkSend(thread.threadId, 'network-interrupted-send', 'Accepted before interruption');
  const accepted = await agentMessage({ repo, to: binding.agentName, text: intent.text, requestId: intent.requestId });
  expect(findNetworkThread(thread.threadId)?.conversationId).toBeNull();
  closeDb();
  expect((await history(thread.threadId))[0]).toMatchObject({ network: { messageId: accepted.id } });
  expect(findNetworkThread(thread.threadId)?.conversationId).toBe(accepted.conversation!.id);
  const retried = await COMPOSE(request('/api/orchestrator/composer-queue', composerBody(intent.clientId, thread, intent.text)));
  expect(retried.status).toBe(200);
  expect((await retried.json()).item.message.id).toBe(accepted.id);
  expect(getSqlite().prepare('SELECT id FROM agent_messages').all()).toHaveLength(1);
}, 30_000);

it('projects an explicitly bound peer exchange with two bot authors and never sends a human as either peer', async () => {
  const a = localBinding('PeerOne', 'source-one'); const b = localBinding('PeerTwo', 'source-two');
  const first = await agentMessage({ repo, fromAgentId: a.binding.agentId, to: b.binding.agentName, text: 'Peer to peer' });
  const thread = createNetworkThread({ bindingIds: [a.binding.id, b.binding.id], conversationId: first.conversation!.id });
  projectNetworkThread(thread.threadId);
  await agentMessage({ repo, fromAgentId: b.binding.agentId, to: a.binding.agentName, text: 'Correlated peer answer', replyToId: first.id });
  const transcript = await history(thread.threadId);
  expect(transcript.map(m => m.author)).toEqual([
    { kind: 'bot', name: a.binding.agentName, runtime: a.binding.runtime, sessionKey: a.binding.sessionKey, id: a.member.id, agentId: a.binding.agentId },
    { kind: 'bot', name: b.binding.agentName, runtime: b.binding.runtime, sessionKey: b.binding.sessionKey, id: b.member.id, agentId: b.binding.agentId },
  ]);
  expect(transcript.every(m => m.role === 'assistant')).toBe(true);
  const refused = await COMPOSE(request('/api/orchestrator/composer-queue', composerBody('network-peer-human-send', thread)));
  expect(refused.status).toBe(409);
  expect(readAgentConversationMessages(first.conversation!.id)).toHaveLength(2);
  expect(getSqlite().prepare('SELECT id FROM composer_send_queue').all()).toEqual([]);
}, 30_000);

it('ordinary chat composition retains its queue routing and role-based activity behavior', async () => {
  const ordinary = { threadId: 'thoughts-ordinary-fixture' };
  persistCanonicalChatHistoryRecord(ordinary.threadId, { repoPath: repo, backend: 'claude', model: 'claude-code',
    messages: [{ id: 'ordinary-user', role: 'user', content: 'An ordinary request', timestamp: Date.now() }] });
  const response = await COMPOSE(request('/api/orchestrator/composer-queue', composerBody('ordinary-native-send', ordinary)));
  expect(response.status).toBe(200);
  expect((await response.json()).item.status).toBe('queued');
  expect(getSqlite().prepare('SELECT id FROM composer_send_queue').all()).toEqual([{ id: 'ordinary-native-send' }]);
  expect(readProjectedThread(ordinary.threadId)?.status).toBe('busy');
  expect((await history(ordinary.threadId))[0].author).toBeUndefined();
});

it('a stale exact binding cannot be substituted with a live runtime alias', async () => {
  const { binding } = localBinding('fixture');
  upsertAgentPresence({ agentId: 'another-live-agent', name: 'AnotherPeer', repo, runtime: binding.runtime, sessionKey: 'another-session',
    worktreePath: null, laneId: null, packetId: null, lastSeen: new Date().toISOString() });
  const thread = createNetworkThread({ bindingIds: [binding.id] }); projectNetworkThread(thread.threadId);
  const response = await COMPOSE(request('/api/orchestrator/composer-queue', composerBody('network-exact-recipient', thread)));
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
  const message = (await response.json()).item.message;
  expect(message.to).toBe(binding.agentName);
  expect(message.refs.identities.to.sessionKey).toBe(binding.sessionKey);
});

it('rechecks recipient context after discovery and releases known nonacceptance for a fresh native retry', async () => {
  const { thread, binding } = open();
  const discovery = vi.spyOn(defaultLiveAgentPresenceSeams, 'discoverSessions').mockImplementationOnce(async () => {
    getSqlite().prepare('UPDATE agent_presence SET session_key = ? WHERE agent_id = ?').run('replacement-session', binding.agentId);
    return [];
  });
  try {
    const refused = await COMPOSE(request('/api/orchestrator/composer-queue', composerBody('network-replaced-target', thread)));
    expect(refused.status).toBe(409);
    expect((await refused.json()).networkSend).toMatchObject({ id: 'network-replaced-target', threadId: thread.threadId, status: 'rejected' });
    expect(getSqlite().prepare('SELECT id FROM agent_messages').all()).toEqual([]);
    expect(getSqlite().prepare('SELECT client_id,status FROM bot_network_sends').all()).toEqual([{ client_id: 'network-replaced-target', status: 'rejected' }]);
  } finally { discovery.mockRestore(); }
  getSqlite().prepare('UPDATE agent_presence SET session_key = ? WHERE agent_id = ?').run(binding.sessionKey, binding.agentId);
  const retried = await COMPOSE(request('/api/orchestrator/composer-queue', composerBody('network-fresh-native-id', thread)));
  expect(retried.status).toBe(200);
  expect(getSqlite().prepare('SELECT id FROM agent_messages').all()).toHaveLength(1);
});

it('network held sends can be retried or removed, and cancellation fences an in-flight pre-acceptance send', async () => {
  const { thread } = open();
  const held = reserveNetworkSend(thread.threadId, 'network-held-send', 'A held draft');
  const pending = await QUEUE(request(`/api/orchestrator/composer-queue?repoPath=${encodeURIComponent(repo)}&threadId=${thread.threadId}`));
  expect((await pending.json()).items[0].id).toBe(held.clientId);
  expect((await REMOVE(request('/api/orchestrator/composer-queue', { repoPath: repo, threadId: thread.threadId, id: held.clientId }, 'DELETE'))).status).toBe(200);
  const delayed = await COMPOSE(request('/api/orchestrator/composer-queue', composerBody(held.clientId, thread, held.text)));
  expect(delayed.status).toBe(409);
  expect((await delayed.json()).networkSend).toMatchObject({ id: held.clientId, threadId: thread.threadId, status: 'cancelled' });
  expect(getSqlite().prepare('SELECT status FROM bot_network_sends WHERE client_id = ?').get(held.clientId)).toEqual({ status: 'cancelled' });
  let release!: () => void; let discovering = false;
  const discovery = vi.spyOn(defaultLiveAgentPresenceSeams, 'discoverSessions').mockImplementationOnce(async () => {
    discovering = true; await new Promise<void>(resolve => { release = resolve; }); return [];
  });
  try {
    const posting = COMPOSE(request('/api/orchestrator/composer-queue', composerBody('network-cancel-inflight', thread)));
    await vi.waitFor(() => expect(discovering).toBe(true));
    expect((await REMOVE(request('/api/orchestrator/composer-queue', { repoPath: repo, threadId: thread.threadId, id: 'network-cancel-inflight' }, 'DELETE'))).status).toBe(200);
    const delayedInflight = await COMPOSE(request('/api/orchestrator/composer-queue', composerBody('network-cancel-inflight', thread)));
    expect(delayedInflight.status).toBe(409);
    release(); expect((await posting).status).toBe(409);
    expect(getSqlite().prepare('SELECT id FROM agent_messages').all()).toEqual([]);
  } finally { release?.(); discovery.mockRestore(); }
  reserveNetworkSend(thread.threadId, 'network-held-retry', 'Retry the stored text');
  const retried = await RETRY(request('/api/orchestrator/composer-queue', { repoPath: repo, threadId: thread.threadId, id: 'network-held-retry' }, 'PATCH'));
  expect(retried.status).toBe(200);
  expect((await retried.json()).item.message.text).toBe('Retry the stored text');
  expect((await REMOVE(request('/api/orchestrator/composer-queue', { repoPath: repo, threadId: thread.threadId, id: 'network-held-retry' }, 'DELETE'))).status).toBe(409);
});

it('an authoritative network binding blocks LLM dispatch even when its projection is missing', async () => {
  const { thread } = open(); unlinkSync(getCanonicalChatHistoryPath(thread.threadId));
  const { sendOrchestratorBackendTurn } = await import('@/lib/lane/orchestrator-send-entry');
  const { getOrchestratorBackend } = await import('@/lib/lane/orchestrator-backends/registry');
  const backend = getOrchestratorBackend('claude'); const execute = vi.spyOn(backend, 'sendTurn');
  try {
    await expect(sendOrchestratorBackendTurn(backend, repo, 'Must not run', () => {}, { threadId: thread.threadId }, 'single')).rejects.toThrow('network thread');
    expect(execute).not.toHaveBeenCalled();
  } finally { execute.mockRestore(); }
});

it('a failed projection preserves the ordinary catalog and readable history with explicit health; deletion reports its boundary', async () => {
  const { thread } = open();
  const ordinary = 'thoughts-unrelated-catalog';
  persistCanonicalChatHistoryRecord(ordinary, { repoPath: repo, messages: [], title: 'Unrelated chat' });
  const lock = `${getCanonicalChatHistoryPath(thread.threadId)}.lock`; writeFileSync(lock, 'fixture writer');
  try {
    const rows = listMobileOrchestratorThreads({ limit: 500 });
    expect(rows.find(r => r.id === ordinary)).toBeTruthy();
    expect(rows.find(r => r.id === thread.threadId)).toMatchObject({ status: 'failed', networkProjectionError: expect.any(String) });
    const readable = await RECORD(request(`/api/v2/chat-history?tabId=${thread.threadId}`));
    expect(readable.status).toBe(200);
    expect((await readable.json()).network.projectionError).toEqual(expect.any(String));
  } finally { unlinkSync(lock); }
  await history(thread.threadId);
  expect(readProjectedThread(thread.threadId)?.status).toBe('idle');
  const refused = await DELETE_HISTORY(request(`/api/v2/chat-history?tabId=${thread.threadId}`, undefined, 'DELETE'));
  expect(refused.status).toBe(409);
  expect((await refused.json()).error).toContain('Archive');
});

it('a second process reads the bus after acquiring the history lock and preserves inbox preferences/revisions', async () => {
  const { thread, binding } = open();
  const sent = await COMPOSE(request('/api/orchestrator/composer-queue', composerBody('network-lock-first-send', thread)));
  const first = (await sent.json()).item.message;
  const reply = await agentMessage({ repo, fromAgentId: binding.agentId, to: 'operator', text: 'Before the barrier', replyToId: first.id });
  const { inboxSubject, mutateInboxPreferences, readInboxState } = await import('@/lib/inbox/store');
  const subject = inboxSubject('conversation', thread.threadId, repo);
  mutateInboxPreferences(subject, { action: 'pin' }, () => {});
  const preferences = readInboxState(subject);
  const ready = join(root, 'projection-child-ready');
  let completed!: Promise<number | null>; let third!: import('@/lib/agents/types').AgentMessage;
  withCanonicalChatHistoryLock(thread.threadId, () => {
    const child = spawn(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx',
      'tests/fixtures/bot-network/project.ts', thread.threadId, ready], { env: { ...process.env }, stdio: 'ignore' });
    completed = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    const wait = new Int32Array(new SharedArrayBuffer(4)); const deadline = Date.now() + 10_000;
    while (!existsSync(ready) && Date.now() < deadline) Atomics.wait(wait, 0, 0, 10);
    expect(existsSync(ready), 'child completed boot before requesting the held history lock').toBe(true);
    Atomics.wait(wait, 0, 0, 150);
    third = persistAgentMessage({ from: 'operator', to: binding.agentName, repo, text: 'Accepted while history was locked', replyToId: reply.id,
      refs: { laneId: null, packetId: null, identities: { from: null, to: { runtime: binding.runtime, sessionKey: binding.sessionKey } } } }).message;
  });
  expect(await completed).toBe(0);
  expect(readPersistedLlmChat(thread.threadId)!.history.messages).toHaveLength(3);
  expect(readPersistedLlmChat(thread.threadId)!.history.messages.at(-1)!.network?.messageId).toBe(third.id);
  expect(readInboxState(subject)).toEqual(preferences);
}, 30_000);

it('a bus-accepted send survives a failed file replacement and same-identity retry projects it once', async () => {
  const { thread } = open(); const path = getCanonicalChatHistoryPath(thread.threadId);
  unlinkSync(path); mkdirSync(path);
  const body = composerBody('network-projection-failure', thread);
  const failed = await COMPOSE(request('/api/orchestrator/composer-queue', body));
  expect(failed.status).toBe(503);
  expect((await failed.json()).networkSend).toMatchObject({ id: body.id, threadId: thread.threadId, status: 'accepted' });
  expect(getSqlite().prepare('SELECT id FROM agent_messages').all()).toHaveLength(1);
  expect((await REMOVE(request('/api/orchestrator/composer-queue', { repoPath: repo, threadId: thread.threadId, id: body.id }, 'DELETE'))).status).toBe(409);
  rmSync(path, { recursive: true });
  const retry = await COMPOSE(request('/api/orchestrator/composer-queue', body));
  expect(retry.status).toBe(200);
  expect(await history(thread.threadId)).toHaveLength(1);
  expect(getSqlite().prepare('SELECT id FROM agent_messages').all()).toHaveLength(1);
});

it('the actual local configuration command creates a canonical network thread that can be the member home', async () => {
  const { member, binding } = localBinding();
  const command = spawnSync(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx',
    'scripts/bots-network-thread.ts'], { input: JSON.stringify({ bindingIds: [binding.id] }), env: { ...process.env },
    encoding: 'utf8', timeout: 20_000 });
  expect(command.status, `${command.error ?? ''}\n${command.stderr}`).toBe(0);
  const values = command.stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  expect(values).toHaveLength(1);
  const thread = values[0]; membership({ action: 'home', memberId: member.id, threadId: thread.threadId });
  const { GET: ROSTER } = await import('@/app/api/bots/route');
  const response = await ROSTER(request('/api/bots'));
  expect((await response.json()).bots.find((bot: { id: string }) => bot.id === member.id).mainThread).toEqual({ kind: 'o8-thread', id: thread.threadId });
  expect(readPersistedLlmChat(thread.threadId)!.history.source).toBe('bot-network');
}, 30_000);

it('the production settlement guard refuses a pending network intent and permits settlement after cancellation', async () => {
  const { thread } = open();
  const intent = reserveNetworkSend(thread.threadId, 'network-settle-pending', 'An unresolved network draft');
  const settle = () => PATCH_HISTORY(request('/api/v2/chat-history', { tabId: thread.threadId, inboxAction: 'settle' }, 'PATCH'));
  expect((await settle()).status).toBe(409);
  expect((await REMOVE(request('/api/orchestrator/composer-queue', { repoPath: repo, threadId: thread.threadId, id: intent.clientId }, 'DELETE'))).status).toBe(200);
  expect((await settle()).status).toBe(200);
  const { inboxSubject, readInboxState } = await import('@/lib/inbox/store');
  expect(readInboxState(inboxSubject('conversation', thread.threadId, repo)).settledOverride).toBe('settled');
});

it('generic history replacement cannot acknowledge a network message outside the authoritative bus', async () => {
  const { thread } = open();
  const response = await WRITE_HISTORY(request('/api/v2/chat-history', { tabId: thread.threadId, repoPath: repo,
    messages: [{ id: 'not-a-bus-message', role: 'user', content: 'Must not disappear after a false save acknowledgement', timestamp: Date.now() }] }));
  expect(response.status).toBe(409);
  expect(await history(thread.threadId)).toEqual([]);
  expect(getSqlite().prepare('SELECT id FROM agent_messages').all()).toEqual([]);
});

it('network configuration retries keep the existing binding and never overwrite an ordinary or damaged chat', () => {
  const { thread, binding } = open();
  expect(createNetworkThread({ threadId: thread.threadId, bindingIds: [binding.id] })).toEqual(thread);
  const occupied = 'thoughts-existing-damaged-chat'; const path = getCanonicalChatHistoryPath(occupied);
  writeFileSync(path, 'An existing damaged chat must be retained');
  expect(() => createNetworkThread({ threadId: occupied, bindingIds: [binding.id] })).toThrow('already exists');
  expect(readFileSync(path, 'utf8')).toBe('An existing damaged chat must be retained');
});
