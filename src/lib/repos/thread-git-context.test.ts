import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clearThreadGitContextCache, remoteSlug, threadGitContext } from './thread-git-context';

describe('thread git context', () => {
  it('parses common remote forms', () => {
    expect(remoteSlug('git@github.com:o8-run/o8.git')).toBe('o8-run/o8');
    expect(remoteSlug('https://github.com/o8-run/o8')).toBe('o8-run/o8');
    expect(remoteSlug('ssh://git@host:22/team/app.git/')).toBe('team/app');
    expect(remoteSlug('/srv/bare')).toBeNull();
  });
  it('reads branch and origin from a repo and a linked worktree, and falls back to the folder', () => {
    clearThreadGitContextCache();
    const root = mkdtempSync(join(tmpdir(), 'o8-gitctx-'));
    const repo = join(root, 'main');
    mkdirSync(join(repo, '.git', 'worktrees', 'wt'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(repo, '.git', 'config'), '[core]\n\tbare = false\n[remote "upstream"]\n\turl = git@github.com:up/x.git\n[remote "origin"]\n\turl = https://github.com/o8-run/o8.git\n');
    const wt = join(root, 'wt');
    mkdirSync(join(wt, 'sub'), { recursive: true });
    writeFileSync(join(wt, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'wt')}\n`);
    writeFileSync(join(repo, '.git', 'worktrees', 'wt', 'HEAD'), 'ref: refs/heads/feature/rows\n');
    writeFileSync(join(repo, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
    const plain = join(root, 'plain-folder');
    mkdirSync(plain);
    expect(threadGitContext(repo)).toEqual({ repoSlug: 'o8-run/o8', repoSlugFromRemote: true, branch: 'main' });
    expect(threadGitContext(join(wt, 'sub'))).toEqual({ repoSlug: 'o8-run/o8', repoSlugFromRemote: true, branch: 'feature/rows' });
    expect(threadGitContext(plain).repoSlugFromRemote).toBe(false);
    expect(threadGitContext(null)).toEqual({ repoSlug: null, repoSlugFromRemote: false, branch: null });
  });
});
