import { beforeEach, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/mobile/agents/route';
import { projectMobileAgent } from './agents';
import { getRuntimeAuthSnapshot } from '@/lib/runtimes/shared/auth-detect';
vi.mock('@/lib/runtimes/shared/auth-detect', () => ({ getRuntimeAuthSnapshot: vi.fn() }));
vi.mock('@/lib/orchestrator/runtime-capabilities', () => ({
  listDispatchableRuntimes: () => ['agent-one', 'agent-two'],
  getRuntimeCapability: (id: string) => ({ label: id, authHouse: id, defaultModel: id === 'agent-one' ? 'model-one' : undefined }),
}));
const definition = { id: 'agent-one', label: 'Agent One', defaultModel: 'model-one' };
beforeEach(() => vi.resetAllMocks());
it('projects only approved fields and never exposes private account evidence', async () => {
  vi.mocked(getRuntimeAuthSnapshot).mockResolvedValue({ statuses: {
    'agent-one': { installed: true, authenticated: true, email: 'private@example.test', orgId: 'private',
      binaryPath: '/private/bin', token: 'secret', connection: { state: 'observed', account: 'private@example.test', observations: [] } },
    'agent-two': { installed: false, authenticated: false },
  }, suggestedSubscriptionProfile: { detail: 'private' } } as never);
  const response = await GET();
  expect(response.headers.get('Cache-Control')).toContain('no-store');
  expect(await response.json()).toEqual({ agents: [
    { id: 'agent-one', displayName: 'agent-one', installed: true, signedIn: true, defaultModel: 'model-one' },
    { id: 'agent-two', displayName: 'agent-two', installed: false, signedIn: null, defaultModel: null },
  ] });
});
it.each([
  [{ installed: true, authenticated: false }, null],
  [{ installed: false, authenticated: true }, null],
  [{ installed: true, authenticated: true, nativeLoginState: 'unknown' }, null],
  [{ installed: true, authenticated: true, nativeLoginState: 'logged_out' }, false],
  [{ installed: true, authenticated: false, nativeLoginState: 'logged_in' }, true],
  [{ installed: true, authenticated: false, connection: { state: 'configured' } }, null],
  [{ installed: true, authenticated: false, connection: { state: 'not_connected' } }, false],
] as const)('keeps sign-in evidence distinct from readiness: %j', (status, expected) => {
  expect(projectMobileAgent(definition, status as never).signedIn).toBe(expected);
});
it('returns a fixed error without leaking probe failures', async () => {
  vi.mocked(getRuntimeAuthSnapshot).mockRejectedValue(new Error('secret path and token'));
  const response = await GET();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'Agent availability unavailable' });
});
