import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

let server: Awaited<ReturnType<typeof startParityReference>>;
let origin: string;
let repo: string;
const device = 'branch-create-fixture-device';
const worker = 'branch-create-fixture-worker';
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
beforeAll(async () => {
  server = await startParityReference({ o8d: true, nativeHttp: true, nativeRepositoryReads: true });
  await server.stopNext();
  origin = server.url.replace('ws:', 'http:').replace('/ws', '');
  repo = join(server.directory, 'repo');
  mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'fixture');
  writeFileSync(join(server.directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(server.directory, 'worker-token'), worker);
}, 120_000);
afterAll(async () => { await server?.stop(); });
const post = (body: unknown, token = server.token) => fetch(`${origin}/api/panel/branches`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
    'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1', 'x-o8-client-addr': '127.0.0.1' }, body: JSON.stringify(body),
});
it('creates a branch and worktree through o8d with Next stopped, preserving repository reads', async () => {
  const response = await post({ path: repo, branch: 'fixture-created' });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ created: 'fixture-created', isWorktree: false });
  expect(git('rev-parse', 'fixture-created')).toBe(git('rev-parse', 'main'));
  const worktree = await post({ path: repo, branch: 'fixture-worktree', worktree: true });
  expect(worktree.status).toBe(200);
  const body = await worktree.json();
  expect(body).toMatchObject({ created: 'fixture-worktree', isWorktree: true });
  expect(existsSync(join(body.worktreePath, '.git'))).toBe(true);
  expect(readFileSync(join(body.worktreePath, '.git'), 'utf8')).toContain(repo);
  const listing = await fetch(`${origin}/api/panel/branches?path=${encodeURIComponent(repo)}`, {
    headers: { authorization: `Bearer ${server.token}` },
  });
  expect(listing.status).toBe(200);
  expect((await listing.json()).branches.map((branch: { name: string }) => branch.name)).toContain('fixture-worktree');
});
it('refuses anonymous loopback, device and worker writes before creating a branch', async () => {
  for (const [token, status] of [['', 401], ['wrong-token', 401], [device, 403], [worker, 403]] as const) {
    expect((await post({ path: repo, branch: 'forbidden' }, token)).status).toBe(status);
  }
  expect(git('branch', '--list', 'forbidden')).toBe('');
});
it('retains validation and unregistered destructive methods', async () => {
  expect((await post({ path: repo, branch: '--invalid' })).status).toBe(400);
  expect((await fetch(`${origin}/api/panel/branches`, { method: 'DELETE', headers: {
    authorization: `Bearer ${server.token}`, 'content-type': 'application/json',
  }, body: JSON.stringify({ path: repo, branch: 'fixture-created', force: true }) })).status).toBe(405);
});
