import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

import { GET as getDiff } from '@/app/api/worktrees/diff/route';
import { GET as getDiffSummary } from '@/app/api/worktrees/diff-summary/route';
import { getOrCreateWsToken } from '@/lib/ws-auth';

const tempDirs: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeRepo(): string {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'o8-worktree-diff-'));
  tempDirs.push(cwd);
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.email', 'test@o8.dev');
  git(cwd, 'config', 'user.name', 'O8 Test');
  writeFileSync(path.join(cwd, 'tracked.txt'), 'base\n');
  git(cwd, 'add', '--', 'tracked.txt');
  git(cwd, 'commit', '-q', '-m', 'base');
  return cwd;
}

function request(route: 'diff' | 'diff-summary', params: Record<string, string>): NextRequest {
  const query = new URLSearchParams(params);
  // These routes now authorize via resolveRequestPrincipal (operator + device,
  // worker 403). Loopback alone is anonymous by design, so present the REAL
  // operator ws-token as a bearer — this drives the actual principal resolver
  // (not a mock) and proves the route accepts the operator principal.
  return new NextRequest(`http://127.0.0.1/api/worktrees/${route}?${query.toString()}`, {
    headers: { host: '127.0.0.1', authorization: `Bearer ${getOrCreateWsToken()}` },
  });
}

async function summary(cwd: string, baseBranch = 'main') {
  const response = await getDiffSummary(request('diff-summary', { worktreePath: cwd, baseBranch }));
  expect(response.status).toBe(200);
  return response.json();
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('bounded worktree diff transport', () => {
  it('reports exact branch plus dirty-tree metadata without double-counting files', async () => {
    const cwd = makeRepo();
    git(cwd, 'checkout', '-q', '-b', 'feature');
    appendFileSync(path.join(cwd, 'tracked.txt'), 'committed branch line\n');
    git(cwd, 'add', '--', 'tracked.txt');
    git(cwd, 'commit', '-q', '-m', 'branch work');
    appendFileSync(path.join(cwd, 'tracked.txt'), 'dirty line\n');
    writeFileSync(path.join(cwd, 'untracked.txt'), 'first\nsecond\n');

    const body = await summary(cwd);

    expect(body.headSha).toBe(git(cwd, 'rev-parse', 'HEAD'));
    expect(body.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(body.truncated).toBe(false);
    expect(body.files).toEqual([
      { path: 'tracked.txt', status: 'modified', additions: 2, deletions: 0 },
      { path: 'untracked.txt', status: 'untracked', additions: 2, deletions: 0 },
    ]);
    expect(body.fileCount).toBe(2);
    expect(body.additions).toBe(4);
    expect(body.deletions).toBe(0);

    const legacyResponse = await getDiff(request('diff', { worktreePath: cwd, baseBranch: 'main' }));
    const legacy = await legacyResponse.json();
    expect(legacyResponse.status).toBe(200);
    expect(legacy.additions).toBe(4);
    expect(legacy.diff).toContain('committed branch line');
    expect(legacy.diff).toContain('dirty line');
    expect(legacy.diff).toContain('first');
  });

  it('serves one HEAD-pinned file while preserving exact pathspec anchors', async () => {
    const cwd = makeRepo();
    writeFileSync(path.join(cwd, 'literal[1].txt'), 'base bracket\n');
    writeFileSync(path.join(cwd, 'literal1.txt'), 'base plain\n');
    git(cwd, 'add', '--', 'literal[1].txt', 'literal1.txt');
    git(cwd, 'commit', '-q', '-m', 'literal paths');
    appendFileSync(path.join(cwd, 'literal[1].txt'), 'bracket only\n');
    appendFileSync(path.join(cwd, 'literal1.txt'), 'plain only\n');
    const metadata = await summary(cwd);

    const response = await getDiff(request('diff', {
      worktreePath: cwd,
      baseBranch: 'main',
      file: 'literal[1].txt',
      headSha: metadata.headSha,
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.filePath).toBe('literal[1].txt');
    expect(body.headSha).toBe(metadata.headSha);
    expect(body.revision).toBe(metadata.revision);
    expect(body.diff).toContain('bracket only');
    expect(body.diff).not.toContain('plain only');
    expect(body.files.map((file: { path: string }) => file.path)).toEqual(['literal[1].txt']);
    expect(body.fileCount).toBe(1);
    expect(body.truncated).toBe(false);
  });

  it('rejects traversal and absolute selected-file paths before invoking git', async () => {
    const cwd = makeRepo();
    const traversal = await getDiff(request('diff', { worktreePath: cwd, file: '../secret' }));
    const absolute = await getDiff(request('diff', { worktreePath: cwd, file: '/etc/passwd' }));

    expect(traversal.status).toBe(400);
    await expect(traversal.json()).resolves.toEqual({ error: 'invalid_file_path', redaction: { version: 1, offsetEncoding: 'utf-8', spans: [] } });
    expect(absolute.status).toBe(400);
    await expect(absolute.json()).resolves.toEqual({ error: 'invalid_file_path', redaction: { version: 1, offsetEncoding: 'utf-8', spans: [] } });
  });

  it('returns a typed 409 when a selected diff is pinned to a stale HEAD', async () => {
    const cwd = makeRepo();
    appendFileSync(path.join(cwd, 'tracked.txt'), 'dirty\n');

    const response = await getDiff(request('diff', {
      worktreePath: cwd,
      file: 'tracked.txt',
      headSha: 'deadbeef',
    }));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      error: 'head_changed',
      expectedHeadSha: 'deadbeef',
      currentHeadSha: git(cwd, 'rev-parse', 'HEAD'),
    });
  });

  it('caps selected and legacy full bodies with explicit truncation metadata', async () => {
    const cwd = makeRepo();
    appendFileSync(path.join(cwd, 'tracked.txt'), `${'long changed line '.repeat(100)}\n`);
    const metadata = await summary(cwd);

    const selectedResponse = await getDiff(request('diff', {
      worktreePath: cwd,
      file: 'tracked.txt',
      headSha: metadata.headSha,
      maxBytes: '80',
    }));
    const selected = await selectedResponse.json();
    expect(selectedResponse.status).toBe(200);
    expect(selected.truncated).toBe(true);
    expect(selected.truncationReason).toBe('max_bytes');
    expect(selected.maxBytes).toBe(80);
    expect(Buffer.byteLength(selected.diff, 'utf8')).toBeLessThanOrEqual(80);
    expect(selected.diff).toMatch(/^\[redacted\]\n?$/);
    expect(selected.redaction.spans).toContainEqual({ path: '/diff', start: 0, end: 10, kind: 'credential' });
    expect(selected.sizeBytes).toBeGreaterThan(80);
    expect(selected.sizeBytesExact).toBe(false);

    // No file/head parameters is the legacy full-diff request shape.
    const legacyResponse = await getDiff(request('diff', {
      worktreePath: cwd,
      baseBranch: 'main',
      maxBytes: '80',
    }));
    const legacy = await legacyResponse.json();
    expect(legacyResponse.status).toBe(200);
    expect(legacy).toMatchObject({
      worktreePath: cwd,
      baseBranch: 'main',
      filePath: null,
      fileCount: 1,
      truncated: true,
      truncationReason: 'max_bytes',
      maxBytes: 80,
      sizeBytesExact: false,
    });
    expect(typeof legacy.diff).toBe('string');
    expect(Buffer.byteLength(legacy.diff, 'utf8')).toBeLessThanOrEqual(80);
    expect(legacy.diff).toMatch(/^\[redacted\]\n?$/);
    expect(legacy.redaction.spans).toContainEqual({ path: '/diff', start: 0, end: 10, kind: 'credential' });
  });

  it('keeps the legacy structured empty response for a missing worktree', async () => {
    const missing = path.join(os.tmpdir(), `o8-missing-${Date.now()}`);
    const response = await getDiff(request('diff', { worktreePath: missing }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      worktreePath: missing,
      diff: '',
      additions: 0,
      deletions: 0,
      fileCount: 0,
      files: [],
      truncated: false,
      error: 'worktree_path_missing',
    });
  });
});
