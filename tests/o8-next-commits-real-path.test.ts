import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { realpathSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, expect, it } from 'vitest';
let host: ChildProcess;
let origin = '';
let workspace = '';
let hash = '';
const token = 'fixture-commits-operator';
const git = (...args: string[]) => execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8' }).trim();
beforeAll(async () => {
  host = spawn(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx', 'scripts/next/dev-server.ts', '--commits'], {
    env: { ...process.env, O8_NEXT_API_TOKEN: token }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  for await (const line of createInterface({ input: host.stdout! })) {
    try { origin = (JSON.parse(line) as { origin?: string }).origin || origin; } catch { continue; }
    if (origin) break;
  }
  expect(origin).toBeTruthy();
  const data = await (await request('/api/mobile/orchestrator/threads')).json() as { threads: Array<{ repoPath: string }> };
  workspace = realpathSync(data.threads[0].repoPath);
  // Red hosts do not seed commits yet; keep the test on real Git and handlers.
  git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  writeFileSync(join(workspace, 'changed.ts'), 'export const value = 1;\n');
  git('add', '.'); git('commit', '-qm', 'fixture base');
  writeFileSync(join(workspace, 'changed.ts'), 'export const value = 2;\n');
  git('add', '.'); git('commit', '-qm', 'fixture selected'); hash = git('rev-parse', 'HEAD');
}, 30_000);
afterAll(async () => { if (host?.exitCode === null) { host.kill('SIGTERM'); await once(host, 'exit'); } });
function request(path: string, body?: object, credential = token) {
  return fetch(origin + path, { method: body ? 'POST' : 'GET', headers: {
    authorization: `Bearer ${credential}`, 'content-type': 'application/json',
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
it('reads commit details and current workspace comparisons through authenticated production routes', async () => {
  const query = '?workspace=' + encodeURIComponent(workspace);
  const detail = await request(`/api/panel/commits/${hash}${query}`);
  expect(detail.status).toBe(200);
  expect(await detail.json()).toMatchObject({ commit: { hash, subject: 'fixture selected', files: [{ path: 'changed.ts' }] } });
  const compare = await request(`/api/panel/commits/${hash}/file${query}&path=changed.ts`);
  expect(compare.status).toBe(200);
  expect(await compare.json()).toMatchObject({ file: { commitContent: 'export const value = 2;\n', workspaceExists: true } });
  expect((await request(`/api/panel/commits/${hash}${query}`, undefined, 'fixture-invalid')).status).toBe(401);
});
it('saves workspace edits and stages/commits with the same production actions', async () => {
  expect((await request('/api/v2/files', { workspace, path: 'changed.ts', content: 'export const value = 3;\n' })).status).toBe(200);
  expect(readFileSync(join(workspace, 'changed.ts'), 'utf8')).toContain('value = 3');
  expect((await request('/api/review/commit', { workspace, message: 'fixture action' })).status).toBe(200);
  expect(git('log', '-1', '--format=%s')).toBe('fixture action');
  expect((await request('/api/review/commit', { workspace, message: '' })).status).toBe(400);
});
it('pushes only to an owned local bare fixture and preserves the no-remote refusal', async () => {
  expect((await request('/api/review/push', { workspace })).status).toBe(400);
  const remote = join(workspace, '..', 'fixture-remote.git');
  execFileSync('git', ['init', '--bare', '-q', remote]); git('remote', 'add', 'origin', remote);
  expect((await request('/api/review/push', { workspace })).status).toBe(200);
  expect(execFileSync('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/' + git('branch', '--show-current')], { encoding: 'utf8' }).trim()).toBe(git('rev-parse', 'HEAD'));
});
