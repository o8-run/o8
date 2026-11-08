import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, expect, it, vi } from 'vitest';

// Terminal View's mark and import through the registered native handlers,
// from a Claude Code session file.
const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'o8-native-terminal-turns-')));
const repo = path.join(root, 'repo');
const claudeHome = path.join(root, 'claude');
mkdirSync(repo);
mkdirSync(path.join(claudeHome, 'projects', '-fixture-repo'), { recursive: true });
vi.stubEnv('O8_DATA_DIR', path.join(root, 'data'));
vi.stubEnv('CLAUDE_HOME', claudeHome);
const session = '44444444-4444-4444-8444-444444444444';
const sessionFile = path.join(claudeHome, 'projects', '-fixture-repo', `${session}.jsonl`);
const line = (value: unknown) => `${JSON.stringify(value)}\n`;

const { matchNativeHttpRoute, nativeSurfaceRoutes } = await import('@/lib/ws-server/native-http-registry');
type Post = (request: NextRequest) => Promise<Response>;
const handler = async (routePath: string) => ((await nativeSurfaceRoutes.session
  .find(route => route.path === routePath)!.load()) as { POST: Post }).POST;

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const post = (url: string, body: unknown) => new NextRequest(`http://localhost${url}`, {
  method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
});

it('registers the production Terminal View POST for the native thread view', async () => {
  const route = nativeSurfaceRoutes.session.find(route => route.path === '/api/v2/chat-history/terminal-turns');
  expect(route, 'session terminal-turns registration').toBeDefined();
  expect(route!.methods).toEqual(['POST']);
  const { POST } = await import('@/app/api/v2/chat-history/terminal-turns/route');
  expect(await route!.load()).toMatchObject({ POST });
  for (const method of ['GET', 'PATCH', 'PUT', 'DELETE']) {
    expect(matchNativeHttpRoute('/api/v2/chat-history/terminal-turns', method)).toBeUndefined();
  }
});

it('copies a terminal turn into the chat once through the registered handlers', async () => {
  const tabId = 'thoughts-native-terminal';
  const save = await handler('/api/v2/chat-history');
  const turns = await handler('/api/v2/chat-history/terminal-turns');
  writeFileSync(sessionFile, line({ type: 'user', uuid: 'u0', message: { role: 'user', content: 'Ran from chat' } }));
  expect((await save(post('/api/v2/chat-history', { tabId, repoPath: repo, backend: 'claude',
    orchestratorSessionIds: { claude: session }, messages: [{ id: 'user-1', role: 'user', content: 'Ran from chat', timestamp: 1 }] }))).status).toBe(200);
  expect(await (await turns(post('/api/v2/chat-history/terminal-turns', { tabId, action: 'mark' }))).json())
    .toEqual({ marked: true, turns: 0 });
  appendFileSync(sessionFile, [
    line({ type: 'user', uuid: 'u1', timestamp: '2026-11-08T10:00:00Z', message: { role: 'user', content: 'Typed in the terminal' } }),
    line({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'Terminal answer.' }] } }),
  ].join(''));
  expect(await (await turns(post('/api/v2/chat-history/terminal-turns', { tabId, action: 'import' }))).json())
    .toEqual({ turns: 1, more: false });
  expect(await (await turns(post('/api/v2/chat-history/terminal-turns', { tabId, action: 'import' }))).json())
    .toEqual({ turns: 0, more: false });
  const { GET } = await import('@/app/api/v2/chat-history/route');
  const saved = await (await GET(new NextRequest(`http://localhost/api/v2/chat-history?tabId=${tabId}`))).json() as
    { messages: Array<{ content: string }>; orchestratorSessionIds: Record<string, string> };
  expect(saved.messages.map(message => message.content)).toEqual(['Ran from chat', 'Typed in the terminal', 'Terminal answer.']);
  expect(saved.orchestratorSessionIds).toEqual({ claude: session });
});
