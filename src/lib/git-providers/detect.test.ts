import { afterEach, describe, expect, it } from 'vitest';
import { configureGitLabProvider, detectGitProvider, resolveGitLabProject } from './detect';

afterEach(() => configureGitLabProvider());

describe('git provider detection from the origin remote', () => {
  it.each([
    'https://github.com/example/widget.git',
    'git@github.com:example/widget.git',
  ])('keeps GitHub remotes on GitHub: %s', (remote) => {
    expect(detectGitProvider(remote)).toEqual({ kind: 'github', repo: 'example/widget' });
  });

  it.each([
    ['git@gitlab.com:group/widget.git', 'gitlab.com/group/widget'],
    ['https://gitlab.com/group/sub/widget.git', 'gitlab.com/group/sub/widget'],
    ['ssh://git@gitlab.com/group/widget.git', 'gitlab.com/group/widget'],
  ])('detects gitlab.com: %s', (remote, slug) => {
    expect(detectGitProvider(remote)).toEqual({ kind: 'gitlab', project: { baseUrl: 'https://gitlab.com', path: slug.slice('gitlab.com/'.length), slug } });
  });

  it('detects a configured self-managed host over HTTPS and SSH, and stops detecting gitlab.com once it is not configured', () => {
    configureGitLabProvider({ hosts: [{ baseUrl: 'https://code.example.test:8443/' }] });
    expect(detectGitProvider('https://code.example.test:8443/team/widget.git')).toMatchObject({ kind: 'gitlab', project: { baseUrl: 'https://code.example.test:8443', slug: 'code.example.test:8443/team/widget' } });
    expect(detectGitProvider('ssh://git@code.example.test:2222/team/widget.git')).toMatchObject({ kind: 'gitlab', project: { path: 'team/widget' } });
    expect(detectGitProvider('https://code.example.test/team/widget.git')).toBeNull();
    expect(detectGitProvider('git@gitlab.com:group/widget.git')).toBeNull();
  });

  it.each([null, '', 'https://example.test/group/widget.git', 'git@gitlab.com:widget.git', 'https://gitlab.com/group/../widget', 'file:///srv/gitlab.com/group/widget', 'https://gitlab.com/group/widget%zz', 'https://example.test/a/b%zz'])('returns no provider for %s', (remote) => {
    expect(detectGitProvider(remote)).toBeNull();
  });

  it('resolves only host-qualified GitLab keys, never GitHub owner/name keys', () => {
    expect(resolveGitLabProject('gitlab.com/group/sub/widget')).toEqual({ baseUrl: 'https://gitlab.com', path: 'group/sub/widget', slug: 'gitlab.com/group/sub/widget' });
    expect(resolveGitLabProject('example/widget')).toBeNull();
    expect(resolveGitLabProject('gitlab.com/widget')).toBeNull();
    expect(resolveGitLabProject('evil.test/group/widget')).toBeNull();
  });
});
