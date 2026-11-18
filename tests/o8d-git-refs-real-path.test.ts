import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';
import { firstDifference, seedSessionFixture, startSessionServer } from '../scripts/o8d/parity';

const targetDir = join(process.cwd(), 'crates/o8d/target/session-reads');
const binary = process.env.O8D_TEST_BINARY ?? join(targetDir, 'debug', 'o8d');
beforeAll(async () => {
  if (!process.env.O8D_TEST_BINARY) await promisify(execFile)('cargo', ['build', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-session-reads', '--jobs', '1', '--target-dir', targetDir]);
}, 900_000);
const branches = '/api/panel/branches';
const commitRoute = '/api/panel/commits/[hash]';
const commitPath = (hash: string, root: string) => commitRoute.replace('[hash]', hash) + '?' + new URLSearchParams({ workspace: root });

it.skipIf(process.platform !== 'linux')('serves owned branches and commit details on the public socket with Next absent and legacy repository reads off', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-git-refs-')));
  let server: Awaited<ReturnType<typeof startSessionServer>> | undefined;
  try {
    await seedSessionFixture(directory);
    const token = readFileSync(join(directory, 'ws-token'), 'utf8').trim();
    const repo = join(directory, 'repo'); const worktree = join(directory, 'worktree'); const nonGit = join(directory, 'non-git');
    mkdirSync(repo); mkdirSync(nonGit);
    // Prevent Git from discovering a repository initialized in the fixture parent.
    writeFileSync(join(nonGit, '.git'), 'not a repository\n');
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
    const commit = (day: number, subject: string, body?: string) => execFileSync('git', ['-C', repo, 'commit', '-qm', subject, ...(body ? ['-m', body] : [])], { stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_DATE: `2020-01-0${day}T00:00:00Z`, GIT_COMMITTER_DATE: `2020-01-0${day}T00:00:00Z` } });
    git('init', '-q', '-b', 'main'); git('config', 'user.email', 'fixture@example.test'); git('config', 'user.name', 'Fixture');
    writeFileSync(join(repo, 'plain.txt'), 'before\n'); git('add', '.'); commit(1, 'base'); const base = git('rev-parse', 'HEAD');
    git('checkout', '-qb', 'remote-side'); writeFileSync(join(repo, 'remote.txt'), 'remote\n'); git('add', '.'); commit(2, 'remote side');
    git('update-ref', 'refs/remotes/origin/topic', git('rev-parse', 'HEAD'));
    git('checkout', '-qb', 'topic', base); writeFileSync(join(repo, 'plain.txt'), 'after\n' + token + '\n'); git('add', '.'); commit(3, 'topic change', 'Details\n\n' + token);
    const hash = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main'); git('branch', '-D', 'remote-side');
    git('update-ref', 'refs/remotes/origin/main', base); git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    git('worktree', 'add', '-qb', 'checked-out', worktree, base);
    const cases = [
      { path: branches + '?' + new URLSearchParams({ path: repo }), native: true },
      { path: branches + '?' + new URLSearchParams({ path: nonGit }), native: true }, { path: branches, native: true },
      ...[hash, hash.slice(0, 7), base].map(value => ({ path: commitPath(value, repo), native: true })),
      { path: commitPath('f'.repeat(40), repo), native: false }, { path: commitPath('--output', repo), native: true },
    ];
    const reference = await startParityReference({ directory, nativeHttp: true, o8d: false }); await reference.stopNext();
    server = { ...reference, origin: reference.url.replace('ws:', 'http:').replace('/ws', '') };
    const call = (path: string, bearer = token) => fetch(server!.origin + path, { headers: { authorization: `Bearer ${bearer}` } });
    const expected: { status: number; body: unknown }[] = [];
    for (const entry of cases) { const response = await call(entry.path); expected.push({ status: response.status, body: await response.json() }); }
    expect(expected[0].body).toMatchObject({ branches: expect.arrayContaining([expect.objectContaining({ name: 'topic', ahead: 1, behind: 1, additions: 2, deletions: 1 }), expect.objectContaining({ name: 'checked-out', isWorktree: true, worktreePath: worktree })]) });
    expect(expected[1]).toMatchObject({ status: 200, body: { isGitRepo: false, branches: [] } }); expect(expected[2].status).toBe(400);
    expect(expected[6].status).toBe(500); expect(expected[7].status).toBe(400);
    const auth = [];
    for (const path of [cases[0].path, cases[3].path]) { const response = await call(path, ''); auth.push({ status: response.status, body: await response.json() }); }
    expect(auth.map(result => result.status)).toEqual([401, 401]);
    const writes = [];
    for (const method of ['POST', 'DELETE']) {
      const response = await fetch(server.origin + branches, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
      writes.push({ status: response.status, body: await response.json() });
    }
    expect(writes.map(result => result.status)).toEqual([400, 405]);
    await server.stop(); server = undefined;
    const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    const stderrPath = join(directory, 'daemon-stderr'); const wrapper = join(directory, 'capture-o8d');
    writeFileSync(wrapper, '#!/bin/sh\nexec ' + quote(binary) + ' "$@" 2>' + quote(stderrPath) + '\n', { mode: 0o700 });
    server = await startSessionServer(directory, false, wrapper);
    for (const [index, entry] of cases.entries()) {
      const response = await call(entry.path);
      expect(response.headers.get('x-o8d-native') === '1', 'Native route was not reached: ' + entry.path).toBe(entry.native);
      expect(response.headers.get('content-type')).toBe('application/json');
      expect(firstDifference(expected[index], { status: response.status, body: await response.json() }), entry.path).toBeNull();
    }
    for (const [index, path] of [cases[0].path, cases[3].path].entries()) { const response = await call(path, ''); expect(response.headers.get('x-o8d-native')).toBeNull(); expect({ status: response.status, body: await response.json() }).toEqual(auth[index]); }
    const sensitive = await (await call(cases[3].path)).json(); expect(JSON.stringify(sensitive)).not.toContain(token); expect(sensitive.commit.diff).toContain('[redacted]');
    // Owned reads never select the existing branch writer methods.
    for (const [index, method] of ['POST', 'DELETE'].entries()) {
      const response = await fetch(server.origin + branches, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
      expect(response.headers.get('x-o8d-native')).toBeNull(); expect({ status: response.status, body: await response.json() }).toEqual(writes[index]);
    }
    expect(readFileSync(stderrPath, 'utf8') + readFileSync(join(directory, 'o8d-request-counts.jsonl'), 'utf8')).not.toContain(token);
  } finally { await server?.stop(); rmSync(directory, { recursive: true, force: true }); }
}, 180_000);
