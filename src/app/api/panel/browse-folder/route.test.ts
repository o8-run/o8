import { beforeEach, expect, it, vi } from 'vitest';
import { execSync } from '@/lib/providers/child-process';
import { POST } from './route';

vi.mock('@/lib/providers/child-process', () => ({ execSync: vi.fn() }));
beforeEach(() => vi.mocked(execSync).mockReset());
it('distinguishes cancellation from an unavailable system picker', async () => {
  vi.mocked(execSync).mockImplementationOnce(() => { throw Object.assign(new Error('cancelled'), { stderr: 'User canceled. (-128)' }); });
  const cancelled = await POST();
  expect(cancelled.status).toBe(200);
  expect(await cancelled.json()).toEqual({ path: null });
  vi.mocked(execSync).mockImplementationOnce(() => { throw new Error('command unavailable'); });
  const unavailable = await POST();
  expect(unavailable.status).toBe(503);
  expect((await unavailable.json()).error).toContain('Paste');
});
