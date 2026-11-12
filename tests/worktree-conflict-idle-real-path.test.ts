import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/worktree/materialization-execution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/worktree/materialization-execution')>();
  return {
    ...actual,
    materializationAwareExecFile: vi.fn(actual.materializationAwareExecFile),
  };
});

import { GET } from '@/app/api/worktrees/conflicts/route';
import { materializationAwareExecFile } from '@/lib/worktree/materialization-execution';
import { resolveWorktreeRootLayout } from '@/lib/worktree/root-layout';

const root = mkdtempSync(path.join(os.tmpdir(), 'o8-conflict-idle-'));
const probe = vi.mocked(materializationAwareExecFile);
const metadataRoots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [
    '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${root}`, ...args,
  ], { cwd, encoding: 'utf8', timeout: 10_000 }).trim();
}

function createRepo(repo: string): void {
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'user.email', 'fixture@example.test');
  writeFileSync(path.join(repo, 'shared.txt'), 'base\n');
  git(repo, 'add', 'shared.txt');
  git(repo, 'commit', '-qm', 'fixture');
}

async function report(repo: string) {
  const request = new NextRequest(`http://localhost/api/worktrees/conflicts?${new URLSearchParams({ repo })}`, {
    headers: { host: 'localhost' },
  });
  const response = await GET(request);
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  probe.mockClear();
});

afterAll(() => {
  for (const metadataRoot of metadataRoots) rmSync(metadataRoot, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('conflict route without a repository', () => {
  it('returns an empty report without spawning Git on repeated ordinary-folder polls', async () => {
    const folder = path.join(root, 'ordinary', 'server');
    mkdirSync(folder, { recursive: true });

    for (let index = 0; index < 4; index += 1) {
      const result = await report(folder);
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ files: [], mergeOrder: [], safe: true });
    }

    expect(probe).not.toHaveBeenCalled();
  });

  it('does not cache a negative result after the folder becomes a repository', async () => {
    const repo = path.join(root, 'initialized-later');
    mkdirSync(repo);
    expect((await report(repo)).status).toBe(200);
    expect(probe).not.toHaveBeenCalled();

    createRepo(repo);
    expect((await report(repo)).status).toBe(200);
    expect(probe.mock.calls.some(([file, args]) => file === 'git' && args[0] === 'worktree')).toBe(true);
  });

  it('keeps real conflicts visible for nested paths and linked repository markers', async () => {
    const repo = path.join(root, 'main-repo');
    const first = path.join(root, 'linked-first');
    const second = path.join(root, 'linked-second');
    createRepo(repo);
    git(repo, 'worktree', 'add', '-qb', 'first', first);
    git(repo, 'worktree', 'add', '-qb', 'second', second);
    writeFileSync(path.join(first, 'shared.txt'), 'first edit\n');
    writeFileSync(path.join(second, 'shared.txt'), 'second edit\n');
    const nested = path.join(repo, 'nested', 'server');
    mkdirSync(nested, { recursive: true });

    const nestedResult = await report(nested);
    expect(nestedResult.status).toBe(200);
    expect(nestedResult.body.files.some((entry: { file: string }) => entry.file === 'shared.txt')).toBe(true);
    expect(nestedResult.body.safe).toBe(false);

    const linkedResult = await report(first);
    expect(linkedResult.status).toBe(200);
    // The queried workspace itself is excluded by the existing inventory contract.
    expect(linkedResult.body.mergeOrder).toEqual(expect.arrayContaining([
      expect.objectContaining({ worktreeId: 'linked-second', fileCount: 1 }),
    ]));
  });

  it('still reads child-workspace metadata when the parent folder is not a repository', async () => {
    const folder = path.join(root, 'metadata-parent');
    mkdirSync(folder);
    const base = resolveWorktreeRootLayout(folder).primaryBase;
    expect(existsSync(base)).toBe(false);
    metadataRoots.push(base);
    const child = path.join(base, 'metadata-child');
    createRepo(child);
    writeFileSync(path.join(child, 'shared.txt'), 'uncommitted child edit\n');
    writeFileSync(path.join(base, '.meta.json'), JSON.stringify({
      version: 1,
      worktrees: {
        'metadata-child': {
          id: 'metadata-child', agentType: 'codex', baseBranch: 'main',
          createdAt: Date.now(), claudeManaged: false, taskName: 'fixture',
        },
      },
    }));

    const result = await report(folder);
    expect(result.status).toBe(200);
    expect(result.body.mergeOrder).toEqual(expect.arrayContaining([
      expect.objectContaining({ worktreeId: 'metadata-child' }),
    ]));
    expect(probe.mock.calls.some(([file, args, options]) => (
      file === 'git' && args.includes('--no-optional-locks') && args.includes('status') && args.includes('--porcelain=v1') && args.includes('-z') && options?.cwd === child
    ))).toBe(true);
    expect(probe.mock.calls.some(([file, args, options]) => (
      file === 'git' && args[0] === 'worktree' && options?.cwd === folder
    ))).toBe(false);
  });

  it('retains authentication refusal before any repository probe', async () => {
    const request = new NextRequest(`http://example.test/api/worktrees/conflicts?${new URLSearchParams({ repo: root })}`, {
      headers: { host: 'example.test', 'x-o8-client-addr': '203.0.113.5' },
    });
    expect((await GET(request)).status).toBe(401);
    expect(probe).not.toHaveBeenCalled();
  });
});
