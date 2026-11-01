/** Scripted local MCP -> production question/Inbox/composer routes. No live vendor session. */
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { StdioJsonRpcPeer } from '@/lib/runtimes/shared/stdio-json-rpc';

const root = mkdtempSync(join(tmpdir(), 'o8-native-question-'));
async function main() {
  const repo = join(root, 'repo'); mkdirSync(repo); mkdirSync(join(root, 'profiles'));
  const token = 'native-question-fixture'; writeFileSync(join(root, 'ws-token'), token);
  Object.assign(process.env, { O8_DATA_DIR: root, CORTEX_IDE_DATA_DIR: root,
    CORTEX_IDE_DB_PATH: join(root, 'questions.db'), O8_GROK_AGENT_DATA: join(root, 'profiles') });
  const { closeDb, getSqlite } = await import('@/lib/db');
  const { upsertAgentPresence } = await import('@/lib/agents/store');
  const { applyLocalBotMembershipCommand: member } = await import('@/lib/agents/bot-membership-commands');
  upsertAgentPresence({ agentId: 'scripted-ui-source', name: 'ScriptedQuestionBot', repo, runtime: 'scripted-native',
    sessionKey: 'scripted-question-ui', worktreePath: null, laneId: null, packetId: null,
    lastSeen: new Date(Date.now() - 20 * 60_000).toISOString() });
  member({ action: 'create', id: 'bot-question-ui', name: 'Scripted question bot', house: 'scripted-local' });
  const bound = member({ action: 'bind', memberId: 'bot-question-ui', agentId: 'scripted-ui-source' });
  if (Array.isArray(bound)) throw new Error('Expected configured member');
  const bindingId = bound.bindings[0].id;
  const questionText = process.argv.includes('--unicode-preview')
    ? 'x'.repeat(1199) + String.fromCodePoint(0x1f600) + 'Local question '.repeat(130)
    : 'Should I use the small local change?';
  const args = { question: questionText, requestId: 'native-question-one' };
  const session = async () => {
    const peer = new StdioJsonRpcPeer({ command: process.execPath, args: ['--import', 'tsx', 'src/lib/mcp/operator-mcp-server.ts'],
      cwd: process.cwd(), env: { ...process.env, O8_OPERATOR_MCP_PROFILE: 'network', O8_NETWORK_BINDING_ID: bindingId,
        O8_MCP_TRANSPORT: 'stdio', O8_MCP_NODE22_CHECKED: '1' } }, 25_000);
    await peer.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'scripted-native-question', version: '1' } });
    return peer;
  };
  let peer = await session();
  const ticket = async () => {
    const result = await peer.request<{ content: Array<{ text: string }>; isError?: boolean }>('tools/call', { name: 'ask_user', arguments: args });
    if (result.isError) throw new Error(JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  const question = (await ticket()).question;
  const { persistCanonicalChatHistoryRecord } = await import('@/lib/llm/chat-history-store');
  const other = { threadId: 'thoughts-question-other' };
  persistCanonicalChatHistoryRecord(other.threadId, { repoPath: repo, title: 'A separate local thread',
    backend: 'claude', model: 'claude-code', orchestratorVisible: true,
    messages: [{ id: 'other-fixture-scene', role: 'assistant', content: 'A separate local conversation.', timestamp: Date.now() }] });
  const threads = await import('@/app/api/mobile/orchestrator/threads/route');
  const history = await import('@/app/api/mobile/history/route');
  const record = await import('@/app/api/v2/chat-history/route');
  const list = await import('@/app/api/v2/chat-history/list/route');
  const composer = await import('@/app/api/orchestrator/composer-queue/route');
  const inbox = await import('@/app/api/panel/supervisor-inbox/route');
  let fullDelay = false;
  let unexpectedDispatches = 0;
  const requests: Array<{ path: string; query?: string; status?: number; error?: string }> = [];
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, 'http://127.0.0.1');
      requests.push({ path: url.pathname, query: url.search });
      let body = ''; for await (const chunk of req) body += chunk;
      const request = new NextRequest(url, { method: req.method, headers: {
        authorization: req.headers.authorization ?? '', 'content-type': 'application/json' }, ...(body ? { body } : {}) });
      let response: Response;
      switch (url.pathname) {
        case '/api/mobile/orchestrator/threads': response = await threads.GET(request); break;
        case '/api/mobile/history': response = await history.GET(request); break;
        case '/api/v2/chat-history': response = await record.GET(request); break;
        case '/api/v2/chat-history/list': response = await list.GET(request); break;
        case '/api/orchestrator/composer-queue': response = req.method === 'POST' ? await composer.POST(request) : await composer.GET(request); break;
        case '/api/panel/supervisor-inbox':
          if (fullDelay && url.searchParams.get('questionsOnly') !== '1') await new Promise(resolve => setTimeout(resolve, 400));
          response = await inbox.GET(request); break;
        case '/api/panel/repos':
        case '/api/panel/projects': response = Response.json({ error: 'Fixture uses the session-only project contract' }, { status: 404 }); break;
        case '/fixture/slow-full': fullDelay = true; response = Response.json({ ok: true }); break;
        case '/api/panel/approvals': response = Response.json({ approvals: [] }); break;
        case '/api/orchestrator/state': response = Response.json({ mission: { packets: [] }, pool: { tasks: [] } }); break;
        case '/api/runtime/inventory': response = Response.json({ agents: [] }); break;
        case '/api/bots': response = Response.json({ bots: [] }); break;
        case '/fixture/ticket': response = Response.json(await ticket()); break;
        case '/fixture/restart': {
          const previousPid = peer.pid; await peer.close({ gracefulMs: 200 }); closeDb(); peer = await session();
          response = Response.json({ ...await ticket(), previousPid, pid: peer.pid }); break;
        }
        case '/fixture/state': response = Response.json({ unexpectedDispatches, requests,
          messages: getSqlite().prepare('SELECT id,from_agent,to_agent,text,reply_to_id FROM agent_messages ORDER BY sequence').all(),
          queue: getSqlite().prepare('SELECT id FROM composer_send_queue').all() }); break;
        default:
          if (req.method !== 'GET') unexpectedDispatches++;
          response = Response.json({ items: [], projects: [], models: [], agents: [], values: {} });
      }
      const last = requests.findLast(item => item.path === url.pathname && item.status === undefined);
      if (last) last.status = response.status;
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { requests.push({ path: req.url ?? '', error: String(error) }); res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(error) })); }
  });
  server.listen(0, '127.0.0.1', () => {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    process.stdout.write(JSON.stringify({ origin: `http://127.0.0.1:${address.port}`, root, repo,
      threadId: question.threadId, questionId: question.id, otherId: other.threadId }) + '\n');
  });
  process.on('SIGTERM', () => { void (async () => {
    await peer.close({ gracefulMs: 200 }); server.closeAllConnections();
    server.close(() => { closeDb(); rmSync(root, { recursive: true, force: true }); process.exit(0); });
  })(); });
}
main().catch(error => { console.error(error); rmSync(root, { recursive: true, force: true }); process.exit(1); });
