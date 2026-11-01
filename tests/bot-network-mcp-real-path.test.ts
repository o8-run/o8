import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { StdioJsonRpcPeer } from '@/lib/runtimes/shared/stdio-json-rpc';
import type { sendNetworkMcpMessage } from '@/lib/bots/network-mcp-service';

// These are scripted local protocol clients, not live Claude Code or Grok sessions.
const root = mkdtempSync(join(tmpdir(), 'o8-network-mcp-'));
const repo = join(root, 'repo'); mkdirSync(repo);
Object.assign(process.env, { O8_DATA_DIR: root, CORTEX_IDE_DATA_DIR: root,
  CORTEX_IDE_DB_PATH: join(root, 'network.db') });
const { closeDb, getSqlite } = await import('@/lib/db');
const { upsertAgentPresence } = await import('@/lib/agents/store');
const { applyLocalBotMembershipCommand: membership } = await import('@/lib/agents/bot-membership-commands');
const { readPersistedLlmChat, getCanonicalChatHistoryPath } = await import('@/lib/llm/chat-history-store');
const { listNetworkThreads } = await import('@/lib/bots/network-store');
const { getAgentInboxCursor, findAgentPresence } = await import('@/lib/agents/store');
const { postAgentMessage } = await import('@/lib/agents/service');
const { createNetworkThread } = await import('@/lib/bots/network-store');
const { projectNetworkThread } = await import('@/lib/bots/network-projection');
type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };
const peers: StdioJsonRpcPeer[] = [];
const bindings: string[] = [];
let activeA: StdioJsonRpcPeer;
let activeB: StdioJsonRpcPeer;
beforeAll(() => {
  for (const suffix of ['a', 'b']) {
    const agentId = `scripted-source-${suffix}`;
    upsertAgentPresence({ agentId, name: `Local${suffix.toUpperCase()}`, repo, runtime: 'scripted-mcp',
      sessionKey: `scripted-local:${suffix}`, worktreePath: null, laneId: null, packetId: null,
      lastSeen: new Date(Date.now() - 20 * 60_000).toISOString() });
    membership({ action: 'create', id: `bot-mcp-${suffix}`, house: 'scripted-local', name: `Local ${suffix}` });
    const member = membership({ action: 'bind', memberId: `bot-mcp-${suffix}`, agentId });
    if (Array.isArray(member)) throw new Error('Expected the configured member');
    bindings.push(member.bindings[0].id);
  }
});
afterAll(async () => {
  await Promise.all(peers.map(peer => peer.close({ gracefulMs: 200 })));
  closeDb(); rmSync(root, { recursive: true, force: true });
});
async function session(bindingId: string, preloadConsole = false) {
  const peer = new StdioJsonRpcPeer({ command: process.execPath,
    args: ['--import', 'tsx', ...(preloadConsole ? ['--import', './src/lib/mcp/stdio-console.ts'] : []),
      'src/lib/mcp/operator-mcp-server.ts'], cwd: process.cwd(),
    env: { ...process.env, O8_OPERATOR_MCP_PROFILE: 'network', O8_NETWORK_BINDING_ID: bindingId,
      O8_MCP_TRANSPORT: 'stdio', O8_MCP_NODE22_CHECKED: '1' } }, 25_000);
  peers.push(peer);
  await peer.request('initialize', { protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'scripted-local-network-client', version: '1' } });
  return peer;
}

it('the actual network stdio entrypoint keeps diagnostics out of protocol frames', async () => {
  const a = await session(bindings[0]);
  expect(a.running).toBe(true);
});

it('two independently bound stdio sessions discover the implemented local network tools', async () => {
  // The existing bootstrap isolates catalog behavior from PR4's stdout diagnostic defect.
  const a = await session(bindings[0], true);
  const b = await session(bindings[1], true);
  activeA = a; activeB = b;
  expect(a.pid).not.toBe(b.pid);
  for (const peer of [a, b]) {
    const result = await peer.request<{ tools: Array<{ name: string }> }>('tools/list', {});
    expect(result.tools.map(tool => tool.name).sort()).toEqual([
      'check_inbox', 'list_team', 'o8_result_page', 'send_message',
    ]);
  }
  expect(getSqlite().prepare('SELECT COUNT(*) AS count FROM bot_members').get()).toMatchObject({ count: 2 });
});

function call(peer: StdioJsonRpcPeer, name: string, args: Record<string, unknown> = {}) {
  return peer.request<ToolResult>('tools/call', { name, arguments: args });
}
function body(result: ToolResult) {
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return JSON.parse(result.content[0].text!);
}
async function complete(peer: StdioJsonRpcPeer, result: ToolResult) {
  let value = body(result);
  if (value.schema !== 'o8/mcp/result-page/v1') return value;
  let serialized = '';
  for (;;) {
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(20_000);
    serialized += value.text;
    if (!value.nextArguments) break;
    result = await call(peer, 'o8_result_page', value.nextArguments);
    value = body(result);
  }
  return body(JSON.parse(serialized));
}
async function run(peer: StdioJsonRpcPeer, name: string, args: Record<string, unknown> = {}) {
  return complete(peer, await call(peer, name, args));
}
async function drain(peer: StdioJsonRpcPeer) {
  let page;
  do { page = await run(peer, 'check_inbox'); } while (page.hasMore);
}

it('A discovers B, sends once, and receives B\'s correlated reply through two actual stdio processes', async () => {
  const team = await run(activeA, 'list_team');
  expect(team.self).toEqual({ memberId: 'bot-mcp-a', bindingId: bindings[0] });
  expect(team.members.find((member: { id: string }) => member.id === 'bot-mcp-b').bindings[0])
    .toMatchObject({ id: bindings[1], agentId: 'scripted-source-b', live: false });
  const args = { to: bindings[1], text: 'A asks B', requestId: 'scripted-a-first' };
  const sent = await run(activeA, 'send_message', args);
  expect(sent.receipt).toMatchObject({ stage: 'accepted', delivery: 'poll', processing: 'unknown' });
  const retry = await run(activeA, 'send_message', args);
  expect(retry.message.id).toBe(sent.message.id);
  expect(retry.message.sequence).toBe(sent.message.sequence);
  const inboxB = await run(activeB, 'check_inbox');
  expect(inboxB.messages).toHaveLength(1);
  expect(inboxB.messages[0]).toMatchObject({ id: sent.message.id, from: 'LocalA', to: 'LocalB', delivery: 'native',
    refs: { identities: { from: { runtime: 'scripted-mcp', sessionKey: 'scripted-local:a' } } } });
  expect(inboxB.acknowledgement).toMatchObject({ stage: 'target-session-inbox-read', processing: 'unknown' });
  membership({ action: 'rename', memberId: 'bot-mcp-a', name: 'A renamed display name' });
  const reply = await run(activeB, 'send_message', { to: bindings[0], text: 'B answers A',
    requestId: 'scripted-b-reply', replyToId: sent.message.id });
  expect(reply.message.conversation).toMatchObject({ id: sent.message.conversation.id, replyToId: sent.message.id, turnIndex: 2 });
  expect(reply.projection.threadId).toBe(sent.projection.threadId);
  const inboxA = await run(activeA, 'check_inbox');
  expect(inboxA.messages).toHaveLength(1);
  expect(inboxA.messages[0].id).toBe(reply.message.id);
  const history = readPersistedLlmChat(sent.projection.threadId)!.history;
  expect(history.source).toBe('bot-network');
  expect(history.messages.map(message => message.author)).toMatchObject([
    { kind: 'bot', id: 'bot-mcp-a', name: 'LocalA', agentId: 'scripted-source-a', sessionKey: 'scripted-local:a' },
    { kind: 'bot', id: 'bot-mcp-b', name: 'LocalB', agentId: 'scripted-source-b', sessionKey: 'scripted-local:b' },
  ]);
  expect(history.messages.every(message => message.role === 'assistant' && message.model === undefined)).toBe(true);
  expect(getSqlite().prepare('SELECT COUNT(*) AS count FROM composer_send_queue').get()).toMatchObject({ count: 0 });
  expect(listNetworkThreads().filter(thread => thread.conversationId === sent.message.conversation.id)).toHaveLength(1);
});

it('keeps bus conflict, latest-reply and closed-exchange semantics without changing source ids', async () => {
  const first = await run(activeA, 'send_message', { to: bindings[1], text: 'Bounded exchange', requestId: 'bounded-first' });
  const conflict = await call(activeA, 'send_message', { to: bindings[1], text: 'Different text', requestId: 'bounded-first' });
  expect(conflict.isError).toBe(true);
  expect(JSON.parse(conflict.content[0].text!).error.code).toBe('agent_request_conflict');
  const closed = await run(activeB, 'send_message', { to: bindings[0], text: 'Final answer', requestId: 'bounded-close',
    replyToId: first.message.id, close: true });
  expect(closed.message.conversation.status).toBe('closed');
  const late = await call(activeA, 'send_message', { to: bindings[1], text: 'Too late', requestId: 'bounded-late', replyToId: closed.message.id });
  expect(late.isError).toBe(true);
  expect(JSON.parse(late.content[0].text!).error.code).toBe('agent_conversation_closed');
  expect((await run(activeA, 'send_message', { to: bindings[1], text: 'Bounded exchange', requestId: 'bounded-first' })).message.id).toBe(first.message.id);
});

it('replies to an existing operator exchange using its canonical thread without exposing ask_user', async () => {
  const first = await postAgentMessage({ to: 'LocalB', repo, text: 'An existing human conversation', requestId: 'operator-existing' }, { role: 'operator' });
  const thread = createNetworkThread({ bindingIds: [bindings[1]], conversationId: first.conversation!.id });
  projectNetworkThread(thread.threadId);
  const reply = await run(activeB, 'send_message', { to: 'operator', replyToId: first.id, text: 'The bot answers the user', requestId: 'operator-reply' });
  expect(reply.message).toMatchObject({ from: 'LocalB', to: 'operator', conversation: { replyToId: first.id } });
  expect(reply.projection.threadId).toBe(thread.threadId);
  expect(readPersistedLlmChat(thread.threadId)!.history.messages.map(message => message.author)).toMatchObject([
    { kind: 'human', id: 'operator' }, { kind: 'bot', id: 'bot-mcp-b', agentId: 'scripted-source-b' },
  ]);
  expect((await call(activeB, 'send_message', { to: 'operator', text: 'No exchange', requestId: 'operator-new' })).isError).toBe(true);
});

it('rolls back acceptance when durable thread binding fails, then accepts the same request once after repair', async () => {
  const before = getSqlite().prepare('SELECT COUNT(*) AS count FROM agent_messages').get();
  getSqlite().exec("CREATE TRIGGER fixture_reject_network_binding BEFORE INSERT ON bot_network_threads BEGIN SELECT RAISE(ABORT, 'deliberate binding failure'); END");
  const args = { to: bindings[1], text: 'Atomic SQLite binding', requestId: 'atomic-binding' };
  try {
    const failed = await call(activeA, 'send_message', args);
    expect(failed.isError).toBe(true);
    expect(JSON.parse(failed.content[0].text!).receipt).toBeUndefined();
    expect(getSqlite().prepare('SELECT COUNT(*) AS count FROM agent_messages').get()).toEqual(before);
  } finally { getSqlite().exec('DROP TRIGGER fixture_reject_network_binding'); }
  const repaired = await run(activeA, 'send_message', args);
  expect(repaired.receipt.stage).toBe('accepted');
  expect((await run(activeA, 'send_message', args)).message.id).toBe(repaired.message.id);
});

it('persists inbox acknowledgements across independent process and database restart, with honest cursor paging', async () => {
  await drain(activeB);
  const sent = [];
  for (let i = 0; i < 3; i++) sent.push(await run(activeA, 'send_message', { to: bindings[1], text: `Cursor ${i}`, requestId: `cursor-${i}` }));
  const first = await run(activeB, 'check_inbox', { limit: 1 });
  expect(first.hasMore).toBe(true);
  expect(first.messages.map((message: { id: string }) => message.id)).toEqual([sent[0].message.id]);
  const previousPid = activeB.pid;
  await activeB.close({ gracefulMs: 200 }); closeDb();
  activeB = await session(bindings[1]);
  expect(activeB.pid).not.toBe(previousPid);
  const remaining = await run(activeB, 'check_inbox', { cursor: first.cursor, limit: 2 });
  expect(remaining.messages.map((message: { id: string }) => message.id)).toEqual(sent.slice(1).map(value => value.message.id));
  expect(remaining.hasMore).toBe(false);
  expect((await run(activeB, 'check_inbox')).messages).toEqual([]);
  expect((await run(activeB, 'check_inbox', { cursor: Buffer.from('0').toString('base64url') })).messages).toEqual([]);
});

it('pages a large acknowledged inbox without repeating the source action or claiming peer processing', async () => {
  await drain(activeB);
  for (let i = 0; i < 6; i++) await run(activeA, 'send_message', { to: bindings[1], text: '平'.repeat(3900), requestId: `large-${i}` });
  const page = await call(activeB, 'check_inbox', { limit: 100 });
  const first = body(page);
  expect(first.schema).toBe('o8/mcp/result-page/v1');
  const presence = findAgentPresence({ agentId: 'scripted-source-b' })!;
  const acknowledged = getAgentInboxCursor(presence);
  upsertAgentPresence({ ...presence, sessionKey: 'scripted-local:page-replacement' });
  let original;
  try {
    expect((await call(activeB, 'check_inbox')).isError).toBe(true);
    original = await complete(activeB, page);
  } finally { upsertAgentPresence(presence); }
  expect(original.messages).toHaveLength(6);
  expect(original.acknowledgement.processing).toBe('unknown');
  expect(getAgentInboxCursor(presence)).toBe(acknowledged);
  expect((await run(activeB, 'check_inbox')).messages).toEqual([]);
  expect((await call(activeA, 'o8_result_page', { resultId: first.resultId })).isError).toBe(true);
});

it('rebuilds a failed file projection after restart and same-id retry without resending the accepted bus message', async () => {
  await drain(activeB);
  const directory = dirname(getCanonicalChatHistoryPath('thoughts-fixture-probe'));
  const backup = `${directory}.fixture-backup`;
  renameSync(directory, backup); writeFileSync(directory, 'A deliberate real file replacement failure');
  const args = { to: bindings[1], text: 'Survives projection failure', requestId: 'projection-restart' };
  let accepted: Awaited<ReturnType<typeof sendNetworkMcpMessage>>;
  try {
    accepted = await run(activeA, 'send_message', args);
    expect(accepted.receipt).toMatchObject({ stage: 'accepted', delivery: 'poll', processing: 'unknown' });
    expect(accepted.projection.state).toBe('pending');
    expect(listNetworkThreads().find(thread => thread.threadId === accepted.projection.threadId)?.conversationId).toBe(accepted.message.conversation!.id);
  } finally { rmSync(directory); renameSync(backup, directory); }
  const before = getSqlite().prepare('SELECT COUNT(*) AS count FROM agent_messages').get();
  const previousPid = activeA.pid;
  await activeA.close({ gracefulMs: 200 }); closeDb(); activeA = await session(bindings[0]);
  expect(activeA.pid).not.toBe(previousPid);
  const recovered = await run(activeA, 'send_message', args);
  expect(recovered.message.id).toBe(accepted.message.id);
  expect(recovered.projection).toEqual({ threadId: accepted.projection.threadId, state: 'ready' });
  expect(getSqlite().prepare('SELECT COUNT(*) AS count FROM agent_messages').get()).toEqual(before);
  expect(existsSync(getCanonicalChatHistoryPath(recovered.projection.threadId))).toBe(true);
  expect(readPersistedLlmChat(recovered.projection.threadId)!.history.messages).toHaveLength(1);
});

it('negotiates legacy and stateless MCP revisions and validates the narrow implemented catalog', async () => {
  const _meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
  expect(await activeA.request('server/discover', { _meta })).toMatchObject({ resultType: 'complete', supportedVersions: ['2026-07-28', '2024-11-05'] });
  const catalog = await activeA.request<{ tools: Array<{ name: string }>; resultType: string }>('tools/list', { _meta });
  expect(catalog.resultType).toBe('complete');
  expect(catalog.tools.map(tool => tool.name)).not.toContain('ask_user');
  expect(catalog.tools.map(tool => tool.name)).not.toContain('message_status');
  await expect(activeA.request('server/discover', { _meta: { ..._meta, 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } })).rejects.toMatchObject({ code: -32022 });
  await expect(activeA.request('initialize', { _meta })).rejects.toMatchObject({ code: -32601 });
  await expect(activeA.request('tools/call', { _meta, name: 'send_message', arguments: null })).rejects.toMatchObject({ code: -32602 });
  const list = await activeA.request<ToolResult & { resultType: string }>('tools/call', { _meta, name: 'list_team', arguments: {} });
  expect(list.resultType).toBe('complete'); expect(body(list).self.bindingId).toBe(bindings[0]);
  for (const args of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { cursor: false }, { cursor: 'not-a-cursor' }]) {
    expect((await call(activeA, 'check_inbox', args)).isError).toBe(true);
  }
  expect((await call(activeA, 'list_team', { bindingId: bindings[1] })).isError).toBe(true);
  expect((await call(activeA, 'send_message', { to: bindings[1], text: 'No idempotency id' })).isError).toBe(true);
  expect((await call(activeA, 'o8_msg_send', { to: 'LocalB', text: 'Other profile' })).isError).toBe(true);
});

it('keeps the operator HTTP catalog and ordinary profiles separate and refuses network HTTP transport', async () => {
  const { handleOperatorMcpMessage, operatorToolsForProfile } = await import('@/lib/mcp/operator-mcp-host');
  expect(operatorToolsForProfile().map(tool => tool.name)).toEqual(expect.arrayContaining(['o8_msg_agents', 'o8_msg_send', 'o8_msg_inbox']));
  expect(operatorToolsForProfile().map(tool => tool.name)).not.toContain('send_message');
  expect(operatorToolsForProfile('network')).toEqual([]);
  const narrowed = await handleOperatorMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'network');
  expect(narrowed?.result).toEqual({ tools: [] });
  const http = spawnSync(process.execPath, ['--import', 'tsx', 'src/lib/mcp/operator-mcp-server.ts', '--transport', 'http'], {
    cwd: process.cwd(), env: { ...process.env, O8_OPERATOR_MCP_PROFILE: 'network', O8_NETWORK_BINDING_ID: bindings[0], O8_MCP_NODE22_CHECKED: '1' },
    timeout: 20_000, encoding: 'utf8' });
  expect(http.status, http.stderr).toBe(2);
  expect(http.stderr).toContain('stdio only');
});

it('requires the exact existing local session context and never automatically enrolls or substitutes it', async () => {
  const originalArgs = { to: bindings[1], text: 'Accepted before target replacement', requestId: 'accepted-before-replacement' };
  const accepted = await run(activeA, 'send_message', originalArgs);
  const before = getSqlite().prepare('SELECT COUNT(*) AS count FROM agent_messages').get();
  upsertAgentPresence({ agentId: 'scripted-source-b', name: 'LocalB', repo, runtime: 'scripted-mcp',
    sessionKey: 'scripted-local:replacement', worktreePath: null, laneId: null, packetId: null,
    lastSeen: new Date(Date.now() - 20 * 60_000).toISOString() });
  const refused = await call(activeA, 'send_message', { to: bindings[1], text: 'Must refuse stale binding', requestId: 'stale-binding' });
  expect(refused.isError).toBe(true);
  expect(JSON.parse(refused.content[0].text!).error.code).toBe('network_binding_unavailable');
  expect((await call(activeB, 'check_inbox')).isError).toBe(true);
  const recovered = await run(activeA, 'send_message', originalArgs);
  expect(recovered.message.id).toBe(accepted.message.id);
  expect(recovered.message.sequence).toBe(accepted.message.sequence);
  expect(recovered.receipt.stage).toBe('accepted');
  expect((await call(activeA, 'send_message', { ...originalArgs, text: 'Changed after replacement' })).isError).toBe(true);
  getSqlite().prepare('DELETE FROM agent_presence WHERE agent_id = ?').run('scripted-source-b');
  expect((await run(activeA, 'send_message', originalArgs)).message.id).toBe(accepted.message.id);
  expect(getSqlite().prepare('SELECT COUNT(*) AS count FROM agent_messages').get()).toEqual(before);
  expect(getSqlite().prepare('SELECT COUNT(*) AS count FROM bot_members').get()).toMatchObject({ count: 2 });
});
