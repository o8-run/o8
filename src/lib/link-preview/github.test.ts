import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { cachedGitHubPreview, parseGitHubLink, readGitHubPreview } from './github';

describe('GitHub link previews', () => {
  it('reads repository, issue and pull request links and nothing else', () => {
    expect(parseGitHubLink('https://github.com/o8-run/o8')).toEqual({ kind: 'repo', repo: 'o8-run/o8' });
    expect(parseGitHubLink('https://github.com/o8-run/o8.git')).toEqual({ kind: 'repo', repo: 'o8-run/o8' });
    expect(parseGitHubLink('https://github.com/o8-run/o8/issues/12#top')).toEqual({ kind: 'issue', repo: 'o8-run/o8', number: 12 });
    expect(parseGitHubLink('https://github.com/o8-run/o8/pull/6261/files')).toEqual({ kind: 'pull', repo: 'o8-run/o8', number: 6261 });
    for (const url of [
      'http://github.com/o8-run/o8',
      'https://gist.github.com/a/b',
      'https://github.com.evil.test/o8-run/o8',
      'https://user:pw@github.com/o8-run/o8',
      'https://github.com/o8-run',
      'https://github.com/o8-run/o8/blob/main/README.md',
      'https://github.com/o8-run/o8/issues/0',
      'https://github.com/o8-run/o8/issues/12/extra',
      'https://github.com/../o8',
      'not a url',
    ]) expect(parseGitHubLink(url), url).toBeNull();
  });

  it('shapes a repository card from the API answer', async () => {
    const fetch = vi.fn(async () => ({ full_name: 'o8-run/o8', description: ' Review layer ', stargazers_count: 60, forks_count: 11, language: 'TypeScript' }));
    await expect(readGitHubPreview({ kind: 'repo', repo: 'o8-run/o8' }, fetch)).resolves.toEqual({
      kind: 'repo', repo: 'o8-run/o8', description: 'Review layer', stars: 60, forks: 11, language: 'TypeScript',
    });
    expect(fetch).toHaveBeenCalledWith('repos/o8-run/o8');
  });

  it('tells issues from open, closed and merged pull requests', async () => {
    const answer = (extra: object) => async () => ({ title: 'Fix it', state: 'closed', user: { login: 'q' }, comments: 3, ...extra });
    const link = { kind: 'issue' as const, repo: 'o8-run/o8', number: 7 };
    await expect(readGitHubPreview(link, answer({}))).resolves.toMatchObject({ kind: 'issue', state: 'closed', author: 'q', comments: 3 });
    await expect(readGitHubPreview(link, answer({ pull_request: { merged_at: '2026-11-16T00:00:00Z' } }))).resolves.toMatchObject({ kind: 'pull', state: 'merged' });
    await expect(readGitHubPreview(link, answer({ state: 'open', pull_request: { merged_at: null } }))).resolves.toMatchObject({ kind: 'pull', state: 'open' });
  });

  it('asks GitHub once per link for five minutes, and again after a failure', async () => {
    const link = { kind: 'repo' as const, repo: 'cache/test' };
    const fetch = vi.fn(async () => ({ full_name: 'cache/test' }));
    await cachedGitHubPreview(link, 0, fetch);
    await cachedGitHubPreview(link, 60_000, fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
    await cachedGitHubPreview(link, 5 * 60_000, fetch);
    expect(fetch).toHaveBeenCalledTimes(2);
    const failing = { kind: 'repo' as const, repo: 'cache/fails' };
    const broken = vi.fn(async () => { throw new Error('down'); });
    await expect(cachedGitHubPreview(failing, 0, broken)).rejects.toThrow('down');
    await expect(cachedGitHubPreview(failing, 1, broken)).rejects.toThrow('down');
    expect(broken).toHaveBeenCalledTimes(2);
  });
});
