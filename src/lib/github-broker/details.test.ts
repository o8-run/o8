import { beforeEach, describe, expect, it, vi } from 'vitest';

const { githubInstallationFetch } = vi.hoisted(() => ({ githubInstallationFetch: vi.fn() }));
vi.mock('./auth', () => ({ githubInstallationFetch }));
import { fetchGitHubPullRequestDetail } from './details';
import { readPullRequestChecks as readScopedChecks } from './pull-request-checks';
const readPullRequestChecks = (repo: string, head: string, installation?: number) => readScopedChecks(repo, head, installation, 'interactive', installation ? 'fixture-authority' : undefined);

const pull = { number: 7, title: 'Change', state: 'open', draft: true, html_url: 'https://github.com/example/repo/pull/7', user: { login: 'author', avatar_url: 'https://avatars.githubusercontent.com/u/1' }, labels: [{ name: 'ui' }], requested_reviewers: [{ login: 'reviewer' }], head: { sha: 'head', ref: 'work' }, base: { ref: 'main' } };
beforeEach(() => vi.clearAllMocks());

describe('pull request detail reads', () => {
  it('starts files, checks and reviews together instead of waiting for a large file response', async () => {
    const finish = new Map<string, (value: { response: Response }) => void>();
    githubInstallationFetch.mockImplementation((_repo: string, path: string) => path.endsWith('/pulls/7')
      ? Promise.resolve({ response: Response.json(pull) })
      : new Promise<{ response: Response }>((resolve) => { finish.set(path, resolve); }));
    const pending = fetchGitHubPullRequestDetail('example/repo', 7);
    await vi.waitFor(() => expect(finish.size).toBe(3));
    finish.get('/repos/example/repo/pulls/7/files?per_page=100')!({ response: Response.json([{ filename: 'app.ts', additions: 27, deletions: 4, patch: '@@ diff' }]) });
    finish.get('/repos/example/repo/commits/head/check-runs?per_page=100')!({ response: Response.json({ check_runs: [{ name: 'unit', status: 'completed', conclusion: 'success', html_url: 'https://github.com/example/repo/actions/runs/1' }] }) });
    finish.get('/repos/example/repo/pulls/7/reviews?per_page=100')!({ response: Response.json([{ state: 'APPROVED' }, { state: 'COMMENTED' }]) });
    expect(await pending).toMatchObject({ number: 7, draft: true, avatarUrl: pull.user.avatar_url, labels: ['ui'], requestedReviewers: ['reviewer'], files: [{ path: 'app.ts', patch: '@@ diff' }], statusCheckRollup: [{ name: 'unit', conclusion: 'success', url: 'https://github.com/example/repo/actions/runs/1' }], reviewDecision: 'APPROVED' });
  });

  it('preserves file errors and tolerates unavailable optional checks and reviews', async () => {
    githubInstallationFetch.mockImplementation(async (_repo: string, path: string) => {
      if (path.endsWith('/pulls/7')) return { response: Response.json(pull) };
      if (path.includes('/files?')) return { response: Response.json([{ filename: 'app.ts' }]) };
      throw new Error('Optional read unavailable');
    });
    expect(await fetchGitHubPullRequestDetail('example/repo', 7)).toMatchObject({ files: [{ path: 'app.ts' }], statusCheckRollup: [], reviewDecision: null });
    githubInstallationFetch.mockImplementation(async (_repo: string, path: string) => ({ response: path.endsWith('/pulls/7') ? Response.json(pull) : Response.json({ message: 'Files unavailable' }, { status: 502 }) }));
    await expect(fetchGitHubPullRequestDetail('example/repo', 7)).rejects.toThrow('Pull request changes could not be read');
  });

  it('discards a supplied review decision when restarting an aggregate anonymously', async () => {
    let metadataReads = 0;
    let reviewReads = 0;
    githubInstallationFetch.mockImplementation(async (_repo: string, path: string) => {
      if (path.endsWith('/pulls/7')) {
        metadataReads++;
        return { scope: metadataReads === 1 ? 'installation' : 'anonymous', anonymous: metadataReads > 1,
          response: Response.json({ ...pull, head: null }) };
      }
      if (path.includes('/reviews?')) { reviewReads++; return { scope: 'anonymous', anonymous: true, response: Response.json([{ state: 'CHANGES_REQUESTED' }]) }; }
      return { scope: 'anonymous', anonymous: true, response: Response.json([{ filename: 'public.ts' }]) };
    });
    expect(await fetchGitHubPullRequestDetail('example/retry-reviews', 7, Promise.resolve('APPROVED')))
      .toMatchObject({ githubScope: 'anonymous', reviewDecision: 'CHANGES_REQUESTED', files: [{ path: 'public.ts' }] });
    expect(metadataReads).toBe(2);
    expect(reviewReads).toBe(1);
  });

  it.each([false, true])('bounds scope-change retries and refuses ordinary credential rotation (anonymous=%s)', async anonymous => {
    let metadataReads = 0;
    githubInstallationFetch.mockImplementation(async (_repo: string, path: string) => {
      if (path.endsWith('/pulls/7')) { metadataReads++; return { scope: `root-${metadataReads}`, anonymous, response: Response.json({ ...pull, head: null }) }; }
      return { scope: 'different', anonymous, response: Response.json([]) };
    });
    await expect(fetchGitHubPullRequestDetail('example/bounded-retry', 7)).rejects.toThrow('authorization changed');
    expect(metadataReads).toBe(anonymous ? 2 : 1);
  });

  it('restarts rather than mixing reviews returned under a different scope', async () => {
    let metadataReads = 0;
    githubInstallationFetch.mockImplementation(async (_repo: string, path: string) => {
      if (path.endsWith('/pulls/7')) metadataReads++;
      const scope = metadataReads === 1 ? 'installation' : 'anonymous';
      if (path.endsWith('/pulls/7')) return { scope, anonymous: scope === 'anonymous', response: Response.json({ ...pull, title: scope, head: null }) };
      if (path.includes('/reviews?')) return { scope: 'anonymous', anonymous: true, response: Response.json([{ state: 'CHANGES_REQUESTED' }]) };
      return { scope, anonymous: scope === 'anonymous', response: Response.json([]) };
    });
    expect(await fetchGitHubPullRequestDetail('example/retry-review-scope', 7)).toMatchObject({ title: 'anonymous', reviewDecision: 'CHANGES_REQUESTED' });
    expect(metadataReads).toBe(2);
  });
});

describe('conditional pull request checks', () => {
  const checks = { check_runs: [{ name: 'unit', status: 'completed', conclusion: 'success' }] };
  const fetched = (response: Response, id = 901) => ({ response, installation: { id }, scope: 'fixture-authority' });

  it('revalidates checks after fresh metadata and observes changes on the same head', async () => {
    const headers: Array<HeadersInit | undefined> = [];
    let metadataReads = 0;
    githubInstallationFetch.mockImplementation(async (_repo: string, path: string, init?: RequestInit) => {
      if (path.endsWith('/pulls/7')) { metadataReads++; return fetched(Response.json(pull)); }
      if (path.includes('/check-runs?')) {
        headers.push(init?.headers);
        if (headers.length === 2) return fetched(new Response(null, { status: 304 }));
        return fetched(Response.json(headers.length === 1 ? checks : { check_runs: [{ name: 'unit', status: 'in_progress' }] }, { headers: { etag: `"checks-${headers.length}"` } }));
      }
      return fetched(Response.json([]));
    });
    const read = () => fetchGitHubPullRequestDetail('example/conditional', 7);
    expect((await read()).statusCheckRollup[0].conclusion).toBe('success');
    expect((await read()).statusCheckRollup[0].conclusion).toBe('success');
    expect((await read()).statusCheckRollup[0]).toMatchObject({ status: 'in_progress', conclusion: null });
    expect(metadataReads).toBe(3);
    expect(headers).toEqual([undefined, { 'If-None-Match': '"checks-1"' }, { 'If-None-Match': '"checks-1"' }]);
    githubInstallationFetch.mockRejectedValueOnce(new Error('Access revoked'));
    await expect(read()).rejects.toThrow('Access revoked');
    expect(headers).toHaveLength(3);
  });

  it('shares only concurrent same-scope reads and revalidates the next request', async () => {
    let finish!: (result: ReturnType<typeof fetched>) => void;
    githubInstallationFetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = readPullRequestChecks('example/shared-checks', 'head', 901);
    const second = readPullRequestChecks('example/shared-checks', 'head', 901);
    expect(githubInstallationFetch).toHaveBeenCalledTimes(1);
    finish(fetched(Response.json(checks, { headers: { etag: '"shared"' } })));
    expect(await first).toEqual(await second);
    githubInstallationFetch.mockResolvedValueOnce(fetched(new Response(null, { status: 304 })));
    expect(await readPullRequestChecks('example/shared-checks', 'head', 901)).toEqual(await first);
    expect(githubInstallationFetch).toHaveBeenCalledTimes(2);
  });

  it('separates repository, installation and head and rejects a changed installation', async () => {
    githubInstallationFetch.mockResolvedValue(fetched(Response.json(checks, { headers: { etag: '"scope"' } })));
    await readPullRequestChecks('example/scope-checks', 'head', 901);
    githubInstallationFetch.mockImplementation(async (_repo: string, _path: string, init?: RequestInit) => {
      expect(init?.headers).toBeUndefined();
      return fetched(Response.json(checks));
    });
    await readPullRequestChecks('example/other-checks', 'head', 901);
    await readPullRequestChecks('example/scope-checks', 'other-head', 901);
    await expect(readPullRequestChecks('example/scope-checks', 'head', 902)).rejects.toThrow('installation changed');
    githubInstallationFetch.mockResolvedValueOnce(fetched(Response.json(checks), 902));
    await readPullRequestChecks('example/scope-checks', 'head', 902);
  });

  it('discards validators after errors and never substitutes previous successful checks', async () => {
    githubInstallationFetch.mockResolvedValueOnce(fetched(Response.json(checks, { headers: { etag: '"old"' } })));
    await readPullRequestChecks('example/error-checks', 'head', 901);
    githubInstallationFetch.mockResolvedValueOnce(fetched(Response.json({ message: 'Unavailable' }, { status: 503 })));
    await expect(readPullRequestChecks('example/error-checks', 'head', 901)).rejects.toThrow('(503)');
    githubInstallationFetch.mockImplementationOnce(async (_repo: string, _path: string, init?: RequestInit) => {
      expect(init?.headers).toBeUndefined();
      return fetched(new Response(null, { status: 304 }));
    });
    await expect(readPullRequestChecks('example/error-checks', 'head', 901)).rejects.toThrow('(304)');
    githubInstallationFetch.mockResolvedValueOnce(fetched(Response.json(checks)));
    expect(await readPullRequestChecks('example/error-checks', 'head', 901)).toHaveLength(1);
  });

  it('releases aborted and malformed responses for retry', async () => {
    githubInstallationFetch.mockRejectedValueOnce(new DOMException('Interrupted', 'AbortError'));
    await expect(readPullRequestChecks('example/aborted-checks', 'head', 901)).rejects.toThrow('Interrupted');
    githubInstallationFetch.mockResolvedValueOnce(fetched(Response.json({ check_runs: null }, { headers: { etag: '"invalid"' } })));
    await expect(readPullRequestChecks('example/aborted-checks', 'head', 901)).rejects.toThrow('response is invalid');
    githubInstallationFetch.mockImplementationOnce(async (_repo: string, _path: string, init?: RequestInit) => {
      expect(init?.headers).toBeUndefined();
      return fetched(Response.json(checks));
    });
    await readPullRequestChecks('example/aborted-checks', 'head', 901);
  });

  it('does not retain a validator when the response omits an ETag or installation scope', async () => {
    githubInstallationFetch.mockImplementation(async (_repo: string, _path: string, init?: RequestInit) => {
      expect(init?.headers).toBeUndefined();
      return fetched(Response.json(checks));
    });
    await readPullRequestChecks('example/no-validator', 'head', 901);
    await readPullRequestChecks('example/no-validator', 'head', 901);
    githubInstallationFetch.mockImplementation(async (_repo: string, _path: string, init?: RequestInit) => {
      expect(init?.headers).toBeUndefined();
      return fetched(Response.json(checks, { headers: { etag: '"not-scoped"' } }));
    });
    await readPullRequestChecks('example/no-installation', 'head');
    await readPullRequestChecks('example/no-installation', 'head');
    expect(githubInstallationFetch).toHaveBeenCalledTimes(4);
  });

  it('bounds retained entries and prevents an evicted request from deleting its replacement', async () => {
    let rejectOld!: (reason: Error) => void;
    githubInstallationFetch.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
    const old = readPullRequestChecks('example/evicted-checks', 'head', 901);
    const failed = expect(old).rejects.toThrow('Old read failed');
    githubInstallationFetch.mockImplementation(async () => fetched(Response.json(checks, { headers: { etag: '"retained"' } })));
    for (let index = 0; index < 32; index++) await readPullRequestChecks(`example/bounded-${index}`, 'head', 901);
    await readPullRequestChecks('example/evicted-checks', 'head', 901);
    rejectOld(new Error('Old read failed'));
    await failed;
    githubInstallationFetch.mockImplementationOnce(async (_repo: string, _path: string, init?: RequestInit) => {
      expect(init?.headers).toEqual({ 'If-None-Match': '"retained"' });
      return fetched(new Response(null, { status: 304 }));
    });
    expect(await readPullRequestChecks('example/evicted-checks', 'head', 901)).toHaveLength(1);
  });
});
