import { afterEach, expect, it, vi } from 'vitest';

// The minute-by-minute check reads only its own incident rows. Rebuilding the
// GitHub "waiting on someone else" inbox resolves every repository remote with git.
const reconcile = vi.hoisted(() => vi.fn(() => ({ created: 0, resolved: 0 })));
vi.mock('./outsider-inbox-builder', async (original) => ({
  ...await original<typeof import('./outsider-inbox-builder')>(),
  reconcileOutsideHumanWaitingInbox: reconcile,
}));

const platform = process.platform;
afterEach(() => { Object.defineProperty(process, 'platform', { value: platform }); });

it('checks LaunchAgent crash loops without rebuilding the outsider inbox', async () => {
  // Never probe a real launchd service from a test.
  Object.defineProperty(process, 'platform', { value: 'linux' });
  const { surfaceLaunchAgentCrashLoops } = await import('./launch-agent-health');
  await surfaceLaunchAgentCrashLoops();
  expect(reconcile).not.toHaveBeenCalled();
});
