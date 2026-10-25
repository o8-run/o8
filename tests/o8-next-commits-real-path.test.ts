import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { realpathSync, readFileSync, writeFileSync, symlinkSync, unlinkSync, chmodSync } from 'node:fs';
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

async function comparison(path = 'changed.ts') {
  return request(`/api/panel/commits/${hash}/file?` + new URLSearchParams({ workspace, path, preview: '1' }));
}
it.each(['save', 'commit'])('refuses stale %s after a desktop branch switch', async (action) => {
  git('checkout', '-B', `before-${action}`);
  const loaded = await (await comparison()).json() as { file: Record<string, unknown> };
  const before = git('rev-parse', 'HEAD');
  git('checkout', '-b', `after-${action}`);
  // Even a same-HEAD branch switch changes the mutation target.
  const response = await request(action === 'save' ? '/api/v2/files' : '/api/review/commit', {
    workspace, path: 'changed.ts', content: 'stale draft', message: 'stale commit',
    expectedHeadSha: loaded.file.headSha ?? before, expectedBranch: loaded.file.branch ?? `refs/heads/before-${action}`,
    expectedHash: loaded.file.workspaceHash ?? 'missing-revision', expectedWorkspaceRevision: loaded.file.workspaceRevision,
  });
  expect(response.status).toBe(409);
  expect(git('rev-parse', 'HEAD')).toBe(before);
  expect(readFileSync(join(workspace, 'changed.ts'), 'utf8')).not.toBe('stale draft');
});
it.each(['save', 'commit'])('refuses stale %s after desktop edits the read file', async (action) => {
  const loaded = await (await comparison()).json() as { file: Record<string, unknown> };
  writeFileSync(join(workspace, 'changed.ts'), `desktop ${action}\n`);
  const before = git('rev-parse', 'HEAD');
  const response = await request(action === 'save' ? '/api/v2/files' : '/api/review/commit', {
    workspace, path: 'changed.ts', content: 'stale draft', message: 'stale commit',
    expectedHeadSha: loaded.file.headSha ?? before, expectedBranch: loaded.file.branch ?? git('symbolic-ref', 'HEAD'),
    expectedHash: loaded.file.workspaceHash ?? 'missing-revision', expectedWorkspaceRevision: loaded.file.workspaceRevision,
  });
  expect(response.status).toBe(409);
  expect(readFileSync(join(workspace, 'changed.ts'), 'utf8')).toBe(`desktop ${action}\n`);
  expect(git('rev-parse', 'HEAD')).toBe(before);
});
it('refuses comparison symlinks, parent traversal and absolute paths without disclosing an owned canary', async () => {
  const canary = ['owned', 'comparison', 'canary'].join('-');
  const outside = join(workspace, '..', 'outside.txt');
  writeFileSync(outside, canary);
  const link = join(workspace, 'outside-link.txt');
  symlinkSync(outside, link);
  for (const path of ['outside-link.txt', '../outside.txt', outside]) {
    const response = await comparison(path);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.text()).not.toContain(canary);
  }
  unlinkSync(link);
});

it('resolves duplicate subjects by immutable commit ID and keeps commit-hook gates', async () => {
  git('add', '-A'); git('commit', '-qm', 'duplicate subject');
  const first = git('rev-parse', 'HEAD');
  writeFileSync(join(workspace, 'changed.ts'), 'second duplicate\n');
  git('add', '-A'); git('commit', '-qm', 'duplicate subject');
  const second = git('rev-parse', 'HEAD');
  expect(second).not.toBe(first);
  for (const id of [first, second]) {
    const response = await request(`/api/panel/commits/${id}?` + new URLSearchParams({ workspace }));
    expect(await response.json()).toMatchObject({ commit: { hash: id, subject: 'duplicate subject' } });
  }
  const loaded = await (await comparison()).json() as { file: Record<string, unknown> };
  writeFileSync(join(workspace, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(workspace, '.git/hooks/pre-commit'), 0o755);
  writeFileSync(join(workspace, 'changed.ts'), 'hook must refuse\n');
  const current = await (await comparison()).json() as { file: Record<string, unknown> };
  const response = await request('/api/review/commit', { workspace, path: 'changed.ts', message: 'blocked by hook',
    expectedHeadSha: current.file.headSha, expectedBranch: current.file.branch, expectedHash: current.file.workspaceHash,
    expectedWorkspaceRevision: current.file.workspaceRevision });
  expect(response.status).toBe(500);
  expect(git('rev-parse', 'HEAD')).toBe(second);
  expect(loaded.file.headSha).toBe(second);
  unlinkSync(join(workspace, '.git/hooks/pre-commit'));
});
it('reports raw binary and bounded large comparison states without lossy editor content', async () => {
  writeFileSync(join(workspace, 'binary.dat'), Buffer.from([0xff, 0xfe]));
  const binary = await (await comparison('binary.dat')).json() as { file: Record<string, unknown> };
  expect(binary.file.binary).toBe(true);
  writeFileSync(join(workspace, 'large.txt'), 'x'.repeat(2 * 1024 * 1024));
  const large = await (await comparison('large.txt')).json() as { file: { truncated: boolean; workspaceContent: string } };
  expect(large.file.truncated).toBe(true);
  expect(large.file.workspaceContent.length).toBeLessThanOrEqual(100000);
});

it('keeps a read workspace revision valid across staging-only changes', async () => {
  writeFileSync(join(workspace, 'staging-only.txt'), 'unchanged working bytes\n');
  const before = await (await comparison()).json() as { file: Record<string, unknown> };
  git('add', '-A');
  const after = await (await comparison()).json() as { file: Record<string, unknown> };
  expect(after.file.workspaceRevision).toBe(before.file.workspaceRevision);
});

it('keeps desktop comparisons complete while native preview requests remain bounded', async () => {
  const content = 'x'.repeat(2 * 1024 * 1024);
  writeFileSync(join(workspace, 'desktop-large.txt'), content);
  const query = new URLSearchParams({ workspace, path: 'desktop-large.txt' });
  const desktop = await (await request(`/api/panel/commits/${hash}/file?${query}`)).json() as { file: { workspaceContent: string } };
  expect(desktop.file.workspaceContent.length).toBe(content.length);
  const native = await (await request(`/api/panel/commits/${hash}/file?${query}&preview=1`)).json() as { file: { workspaceContent: string; truncated: boolean } };
  expect(native.file.truncated).toBe(true);
  expect(native.file.workspaceContent.length).toBeLessThanOrEqual(100000);
});
