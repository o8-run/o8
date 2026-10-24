import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('./env', () => ({
  getGitHubAppConfig: () => config.value,
  requireGitHubAppConfig: () => config.value,
}));
const { githubInstallationFetch } = await import('./auth');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.UTC(2026, 5, 1));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('threads the read deadline through installation lookup, token mint and final fetch', async () => {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  config.value = { appId: '42', privateKey: key, apiBaseUrl: 'https://api.github.com' };
  const signal = new AbortController().signal;
  const fetch = vi.fn()
    .mockResolvedValueOnce(Response.json({ id: 12345 }))
    .mockResolvedValueOnce(Response.json({ token: 'test-installation-token', expires_at: '2030-01-01T00:00:00Z' }))
    .mockResolvedValueOnce(Response.json({ full_name: 'owner/project', private: false }));
  vi.stubGlobal('fetch', fetch);
  await githubInstallationFetch('owner/project', '/repos/owner/project', { method: 'GET', signal });
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(fetch.mock.calls.every((call) => call[1].signal === signal)).toBe(true);
});
