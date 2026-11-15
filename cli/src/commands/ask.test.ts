import { afterEach, expect, it, vi } from 'vitest';
import { runAsk } from './ask';
vi.mock('./packet/worktree-resolve.js', () => ({ resolveLaneFromCwd: async () => null }));
afterEach(() => { vi.unstubAllGlobals(); });
it('surfaces the managed outage next step from o8 ask', async () => {
  const message = 'Managed Brain inference is unavailable or its allowance is reached. Select Subscription in Brain settings to use a connected CLI.';
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: false, code: 'managed_brain_unavailable', error: message, message, citations: [], sourcesConsidered: 0 }, { status: 503 })));
  await expect(runAsk({ human: true, verbose: false }, ['rules'])).rejects.toMatchObject({ code: 'managed_brain_unavailable', message });
});
