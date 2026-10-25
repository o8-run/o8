import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, expect, it } from 'vitest';
let host: ChildProcess;
let origin = '';
let workspace = '';
const token = 'fixture-inline-operator';
beforeAll(async () => {
  host = spawn(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx', 'scripts/next/dev-server.ts', '--inline'], {
    env: { ...process.env, O8_NEXT_API_TOKEN: token }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  for await (const line of createInterface({ input: host.stdout! })) {
    try { origin = (JSON.parse(line) as { origin?: string }).origin || origin; } catch { continue; }
    if (origin) break;
  }
  const data = await (await request('/api/mobile/orchestrator/threads')).json() as { threads: Array<{ repoPath: string }> };
  workspace = realpathSync(data.threads[0].repoPath);
}, 30_000);
afterAll(async () => { if (host?.exitCode === null) { host.kill('SIGTERM'); await once(host, 'exit'); } });
function request(path: string, body?: object, credential = token) {
  return fetch(origin + path, { method: body ? 'POST' : 'GET', headers: {
    authorization: `Bearer ${credential}`, 'content-type': 'application/json',
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
it('reads real worktree hunks and preserves authentication and revision refusals', async () => {
  const path = '/api/worktrees/diff?' + new URLSearchParams({ worktreePath: workspace, baseBranch: 'main' });
  const response = await request(path); expect(response.status).toBe(200);
  const data = await response.json() as { diff: string; headSha: string; truncated: boolean };
  expect(data.diff).toContain('@@'); expect(data.headSha).toMatch(/^[a-f0-9]{40}$/); expect(data.truncated).toBe(false);
  expect((await request(path, undefined, 'fixture-invalid')).status).toBe(401);
  expect((await request(path + '&headSha=' + '0'.repeat(40))).status).toBe(409);
});
it('uses the production merge route and its body/idempotency refusals', async () => {
  expect((await request('/api/orchestrator/merge', {})).status).toBe(400);
  expect((await request('/api/orchestrator/merge', { packetId: 'next-inline' })).status).toBe(400);
  expect((await request('/api/orchestrator/merge', { packetId: 'next-inline', idempotencyKey: 'fixture-inline-decision' }, 'fixture-invalid')).status).toBe(401);
});
