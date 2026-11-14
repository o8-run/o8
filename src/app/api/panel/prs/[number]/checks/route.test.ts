import { beforeEach, expect, it, vi } from 'vitest';
const { fetch } = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/lib/github-broker/auth', () => ({ githubInstallationFetch: fetch }));
import { GET } from './route';
const head = 'a'.repeat(40);
const read = (repo = 'example/repo') => GET(new Request(`http://localhost/api/panel/prs/7/checks?repo=${repo}`), { params: Promise.resolve({ number: '7' }) });
beforeEach(() => fetch.mockReset());
it('reads timing for the authorized head and preserves unknown mergeability', async () => {
  fetch.mockResolvedValueOnce({ scope: 'same', response: Response.json({ head: { sha: head }, mergeable: null }) });
  fetch.mockResolvedValueOnce({ scope: 'same', response: Response.json({ check_runs: [{ name: 'unit', started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:01:01Z' }, { name: 'queued' }] }) });
  expect(await (await read()).json()).toEqual({ headSha: head, mergeable: null, timings: [{ name: 'unit', durationMs: 61000 }, { name: 'queued', durationMs: null }] });
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
