import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ token: 'fixture-a' }));
vi.mock('./env', () => ({ getGitHubAppConfig: () => null }));
vi.mock('./managed', () => ({ readManagedGithubToken: () => ({ token: state.token, installationId: 7001, accountLogin: 'example' }) }));
import { githubInstallationFetch } from './auth';

beforeEach(() => { state.token = 'fixture-a'; vi.unstubAllGlobals(); });
it('shares real broker reads, sends conditional validators and clones the unchanged response per consumer', async () => {
  const request = vi.fn(async () => Response.json({ number: 7 }, { headers: { etag: '"fixture"' } }));
  vi.stubGlobal('fetch', request);
  const read = () => githubInstallationFetch('example/conditional', '/repos/example/conditional/pulls/7', undefined, { share: true });
  const [one, two] = await Promise.all([read(), read()]);
  expect(request).toHaveBeenCalledTimes(1);
  expect(await one.response.json()).toEqual(await two.response.json());
  request.mockImplementationOnce(async (_url?: unknown, init?: RequestInit) => {
    expect(new Headers(init?.headers).get('if-none-match')).toBe('"fixture"');
    return new Response(null, { status: 304 });
  });
  expect(await (await read()).response.json()).toEqual({ number: 7 });
});
it('does not share validators or cached answers across credentials and never turns a refusal into success', async () => {
  const request = vi.fn(async () => Response.json({ private: 'fixture' }, { headers: { etag: '"private"' } })); vi.stubGlobal('fetch', request);
  const read = () => githubInstallationFetch('example/scope', '/repos/example/scope/pulls/1', undefined, { share: true });
  await read(); state.token = 'fixture-b';
  request.mockImplementationOnce(async (_url?: unknown, init?: RequestInit) => {
    expect(new Headers(init?.headers).get('if-none-match')).toBeNull(); return new Response('', { status: 401 });
  });
  await expect(read()).rejects.toThrow('(401)');
});
