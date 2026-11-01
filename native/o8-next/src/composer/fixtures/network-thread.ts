/** Independent persisted fixture, using PR3 APIs so it also runs against the regression baseline. */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

const root = mkdtempSync(join(tmpdir(), 'o8-native-network-'));
const repo = join(root, 'repo'); mkdirSync(repo); mkdirSync(join(root, 'profiles'));
writeFileSync(join(root, 'ws-token'), 'native-network-fixture');
Object.assign(process.env, { O8_DATA_DIR: root, CORTEX_IDE_DATA_DIR: root,
  CORTEX_IDE_DB_PATH: join(root, 'fixture.db'), O8_GROK_AGENT_DATA: join(root, 'profiles') });
async function main() {
const { getSqlite, closeDb } = await import('@/lib/db');
const { ensureAgentBusSchema, persistAgentMessage, upsertAgentPresence, listRecentAgentMessages } = await import('@/lib/agents/store');
const { applyLocalBotMembershipCommand: membership } = await import('@/lib/agents/bot-membership-commands');
const { persistCanonicalChatHistoryRecord } = await import('@/lib/llm/chat-history-store');
ensureAgentBusSchema(getSqlite());
const source = upsertAgentPresence({ agentId: 'source-native-peer', name: 'OriginalPeer', repo, runtime: 'fixture-runtime',
  sessionKey: 'fixture:original-session', worktreePath: null, laneId: null, packetId: null,
  lastSeen: new Date(Date.now() - 20 * 60_000).toISOString() });
const member = membership({ action: 'create', id: 'bot-native-peer', house: 'fixture', name: 'Native peer' });
if (Array.isArray(member)) throw new Error('Expected member');
const bound = membership({ action: 'bind', memberId: member.id, agentId: source.agentId });
if (Array.isArray(bound)) throw new Error('Expected bound member');
const binding = bound.bindings[0];
const threadId = 'thoughts-network-native';
getSqlite().exec(`CREATE TABLE IF NOT EXISTS bot_network_threads (
  thread_id TEXT PRIMARY KEY, repo_path TEXT NOT NULL, conversation_id TEXT UNIQUE,
  participants_json TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS bot_network_sends (
    thread_id TEXT NOT NULL REFERENCES bot_network_threads(thread_id), client_id TEXT NOT NULL,
    bus_request_id TEXT NOT NULL UNIQUE, text TEXT NOT NULL, reply_to_id TEXT, agent_message_id TEXT,
    created_at INTEGER NOT NULL, PRIMARY KEY(thread_id,client_id));`);
const identity = { runtime: binding.runtime, sessionKey: binding.sessionKey };
const first = persistAgentMessage({ from: 'operator', to: source.name, repo, text: 'Original request',
  refs: { laneId: null, packetId: null, identities: { from: null, to: identity } } }).message;
const reply = persistAgentMessage({ from: source.name, to: 'operator', repo, text: 'Original peer reply', replyToId: first.id,
  refs: { laneId: null, packetId: null, identities: { from: identity, to: null } } }).message;
const { live: _live, createdAt: _createdAt, ...snapshot } = binding;
getSqlite().prepare('INSERT INTO bot_network_threads VALUES (?,?,?,?,?,?)')
  .run(threadId, repo, first.conversation!.id, JSON.stringify([snapshot]), source.name, first.timestamp);
persistCanonicalChatHistoryRecord(threadId, { source: 'bot-network', repoPath: repo, title: source.name,
  backend: 'claude', model: 'claude-code', network: { conversationId: first.conversation!.id, memberIds: [member.id], canReply: true },
  messages: [{ id: `agent-message-${first.id}`, role: 'user', content: first.text, timestamp: Date.parse(first.timestamp),
    author: { kind: 'human', id: 'operator', name: 'You' } },
  { id: `agent-message-${reply.id}`, role: 'user', content: reply.text, timestamp: Date.parse(reply.timestamp),
    author: { kind: 'bot', id: member.id, name: source.name, agentId: source.agentId, ...identity } }] });
const { GET: threads } = await import('@/app/api/mobile/orchestrator/threads/route');
const { GET: history } = await import('@/app/api/mobile/history/route');
const { GET: record } = await import('@/app/api/v2/chat-history/route');
const { GET: queue, POST: send, PATCH: retry, DELETE: remove } = await import('@/app/api/orchestrator/composer-queue/route');
const { POST: agentSend } = await import('@/app/api/agents/message/route');
let unexpectedDispatches = 0;
let failNext = false;
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url!, 'http://127.0.0.1');
    let body = ''; for await (const chunk of req) body += chunk;
    const request = new NextRequest(url, { method: req.method, headers: {
      authorization: req.headers.authorization ?? '', 'content-type': 'application/json' }, ...(body ? { body } : {}) });
    let response: Response;
    switch (url.pathname) {
      case '/api/mobile/orchestrator/threads': response = await threads(request); break;
      case '/api/mobile/history': response = await history(request); break;
      case '/api/v2/chat-history': response = await record(request); break;
      case '/api/orchestrator/composer-queue': {
        if (req.method === 'POST' && failNext) {
          failNext = false; const value = JSON.parse(body); const id = value.id as string;
          const requestId = `network:${createHash('sha256').update(JSON.stringify([threadId, id])).digest('hex')}`;
          const latest = listRecentAgentMessages(repo, 1)[0];
          // Fault at the durable-intent/bus boundary; the acceptance outcome is still unknown to the native client.
          getSqlite().prepare('INSERT INTO bot_network_sends(thread_id,client_id,bus_request_id,text,reply_to_id,created_at) VALUES (?,?,?,?,?,?)')
            .run(threadId, id, requestId, value.payload.text.trim(), latest.id, Date.now());
          response = Response.json({ error: 'Acceptance is unconfirmed.' }, { status: 503 });
        } else response = req.method === 'POST' ? await send(request) : req.method === 'PATCH' ? await retry(request) : req.method === 'DELETE' ? await remove(request) : await queue(request);
        break;
      }
      case '/api/orchestrator/state': response = Response.json({ mission: { packets: [] }, pool: { tasks: [] } }); break;
      case '/fixture/disconnect': getSqlite().prepare('DELETE FROM agent_presence WHERE agent_id = ?').run(source.agentId); response = Response.json({ ok: true }); break;
      case '/fixture/reconnect': upsertAgentPresence(source); response = Response.json({ ok: true }); break;
      case '/fixture/fail-next': failNext = true; response = Response.json({ ok: true }); break;
      case '/fixture/answer': {
        const latest = listRecentAgentMessages(repo, 1)[0];
        response = await agentSend(new NextRequest('http://127.0.0.1/api/agents/message', { method: 'POST',
          headers: { authorization: 'Bearer native-network-fixture', 'content-type': 'application/json' },
          body: JSON.stringify({ repo, fromAgentId: source.agentId, to: 'operator', text: 'Reply after the recovered send', replyToId: latest.id }) }));
        break;
      }
      case '/fixture/held': {
        const id = 'network-held-native';
        const requestId = `network:${createHash('sha256').update(JSON.stringify([threadId, id])).digest('hex')}`;
        getSqlite().prepare('INSERT INTO bot_network_sends(thread_id,client_id,bus_request_id,text,reply_to_id,created_at) VALUES (?,?,?,?,?,?)')
          .run(threadId, id, requestId, 'Recovered held send', reply.id, Date.now());
        response = Response.json({ ok: true }); break;
      }
      case '/fixture/state': response = Response.json({ messages: listRecentAgentMessages(repo, 50).reverse(),
        queue: getSqlite().prepare('SELECT id FROM composer_send_queue').all(), intents: getSqlite().prepare('SELECT client_id,status FROM bot_network_sends').all(), unexpectedDispatches }); break;
      default:
        if (req.method !== 'GET') unexpectedDispatches++;
        response = Response.json({ items: [], models: [], agents: [], values: {} });
    }
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(error) })); }
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  console.log(JSON.stringify({ origin: `http://127.0.0.1:${address.port}`, threadId }));
});
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(() => {
  closeDb(); rmSync(root, { recursive: true, force: true }); process.exit(0);
}); });

}
main().catch(error => { console.error(error); rmSync(root, { recursive: true, force: true }); process.exitCode = 1; });
