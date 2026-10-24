import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, expect, it } from 'vitest';

let server: ChildProcess;
let origin: string;
let repoPath: string;
const headers = { authorization: 'Bearer fixture-brain-operator', 'Content-Type': 'application/json' };
beforeAll(async () => {
  server = spawn(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx',
    'scripts/next/dev-server.ts', '--brain'], {
    env: { ...process.env, O8_NEXT_API_TOKEN: 'fixture-brain-operator' }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  const lines = createInterface({ input: server.stdout! });
  for await (const line of lines) {
    try { origin = JSON.parse(line).origin; } catch { continue; }
    if (origin) { lines.close(); break; }
  }
  expect(origin).toBeTruthy();
  const list = await fetch(`${origin}/api/mobile/orchestrator/threads`, { headers });
  repoPath = (await list.json()).threads[0].repoPath;
}, 30_000);
afterAll(async () => {
  if (server?.exitCode === null) { const exited = once(server, 'exit'); server.kill('SIGTERM'); await exited; }
});

it('uses production Brain SSE, retrieval, citations, operator auth and read-only runtime', async () => {
  const url = `${origin}/api/cortex/ask`;
  const body = JSON.stringify({ repoPath, conversation: true, preferredRuntime: 'codex', question: 'What is the fixture memory rule?' });
  for (const authorization of [undefined, 'Bearer invalid-fixture']) {
    const denied = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorization ? { authorization } : {}) }, body });
    expect(denied.status).toBe(401);
  }
  const response = await fetch(url, { method: 'POST', headers, body });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const stream = await response.text();
  for (const event of ['route', 'sources', 'token', 'citation', 'done']) expect(stream).toContain(`event: ${event}\n`);
  expect(stream).toContain('Fixture memory rule');
  expect(stream).toContain('read-only');
  expect(stream).not.toContain('event: error');
}, 30_000);

it('keeps validation and runtime error responses on the production route', async () => {
  const empty = await fetch(`${origin}/api/cortex/ask`, { method: 'POST', headers, body: JSON.stringify({ question: ' ' }) });
  expect(empty.status).toBe(400);
  const response = await fetch(`${origin}/api/cortex/ask`, { method: 'POST', headers,
    body: JSON.stringify({ repoPath, conversation: true, question: 'Fixture runtime error' }) });
  const text = await response.text();
  expect(text).toContain('event: error');
  expect(text).toContain('could not answer');
  expect(text).not.toContain('private fixture failure');
});
