import { beforeEach, expect, it, vi } from 'vitest';
const { fetch, exec, repos } = vi.hoisted(() => ({ fetch: vi.fn(), exec: vi.fn(), repos: vi.fn() }));
vi.mock('@/lib/repos/registry', () => ({ listRepos: repos }));
vi.mock('@/lib/providers/child-process', () => {
  const call = Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: exec });
  return { execFile: call };
});
vi.mock('@/lib/github-broker/auth', () => ({ githubInstallationFetch: fetch }));
import { GET } from './route';
const head = 'a'.repeat(40);
const read = (repo = 'example/repo') => GET(new Request(`http://localhost/api/panel/prs/7/checks?repo=${repo}`), { params: Promise.resolve({ number: '7' }) });
beforeEach(() => { fetch.mockReset(); exec.mockReset(); repos.mockReset(); });
it('reads timing for the authorized head and preserves unknown mergeability', async () => {
  fetch.mockResolvedValueOnce({ scope: 'same', response: Response.json({ head: { sha: head }, mergeable: null }) });
  fetch.mockResolvedValueOnce({ scope: 'same', response: Response.json({ check_runs: [{ name: 'unit', started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:01:01Z' }, { name: 'queued' }] }) });
  expect(await (await read()).json()).toEqual({ headSha: head, mergeable: null, conflictingFiles: null, timings: [{ name: 'unit', durationMs: 61000 }, { name: 'queued', durationMs: null }] });
  expect(fetch.mock.calls[1][1]).toContain(`/commits/${head}/check-runs`);
});
it('rejects invalid addresses before provider access', async () => {
  expect((await read('invalid')).status).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
});
it('refuses checks from a different authorization scope', async () => {
  fetch.mockResolvedValueOnce({ scope: 'old', response: Response.json({ head: { sha: head } }) });
  fetch.mockResolvedValueOnce({ scope: 'new', response: Response.json({ check_runs: [] }) });
  expect((await read()).status).toBe(502);
});

it('lists exact-commit conflicts while isolating all new Git objects', async () => {
  fetch.mockResolvedValueOnce({ scope: 'same', response: Response.json({ head: { sha: head }, base: { sha: 'b'.repeat(40) }, mergeable: false }) });
  fetch.mockResolvedValueOnce({ scope: 'same', response: Response.json({ check_runs: [] }) });
  repos.mockResolvedValue([{ remoteUrl: 'https://github.com/example/repo.git', localPath: '/fixture/repo' }]);
  exec.mockResolvedValueOnce({ stdout: '/fixture/objects\n' });
  exec.mockRejectedValueOnce({ code: 1, stdout: `${'c'.repeat(40)}\0src/a.rs\0src/b.rs\0` });
  const result = await (await read()).json();
  expect(result.conflictingFiles).toEqual(['src/a.rs', 'src/b.rs']);
  const options = exec.mock.calls[1][2];
  expect(options.env.GIT_ALTERNATE_OBJECT_DIRECTORIES).toBe('/fixture/objects');
  expect(options.env.GIT_OBJECT_DIRECTORY).not.toBe('/fixture/objects');
  expect(exec.mock.calls[1][1]).toEqual(['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', 'b'.repeat(40), head]);
});
it('keeps the count unknown when exact commit objects are missing', async () => {
  fetch.mockResolvedValueOnce({ scope: 'same', response: Response.json({ head: { sha: head }, base: { sha: 'b'.repeat(40) }, mergeable: false }) });
  fetch.mockResolvedValueOnce({ scope: 'same', response: Response.json({ check_runs: [] }) });
  repos.mockResolvedValue([]);
  expect((await (await read()).json()).conflictingFiles).toBeNull();
  expect(exec).not.toHaveBeenCalled();
});
