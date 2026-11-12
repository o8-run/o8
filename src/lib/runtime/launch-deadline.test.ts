import { expect, it, vi } from 'vitest';
import { runtimeLaunchStep, withRuntimeLaunchDeadline } from './launch-deadline';
vi.mock('@/lib/lane/registry', () => ({ appendEvent: vi.fn(), getLane: vi.fn(), setLaneStatus: vi.fn() }));
it('holds one started spawn until identity proof settles after the deadline', async () => {
  let now = 0;
  let release!: () => void;
  const proof = new Promise<void>(resolve => { release = resolve; });
  let processes = 0;
  let attached = false;
  const launch = withRuntimeLaunchDeadline({ runtime: 'qoder', timeoutMs: 30, clock: () => now }, async () => {
    await runtimeLaunchStep({}, 'process_spawn', async () => { processes++; await proof; });
    attached = true;
  });
  const observed = launch.then(() => 'attached', () => 'orphaned');
  now = 50;
  await new Promise(resolve => setTimeout(resolve, 60));
  release();
  expect(await observed).toBe('attached');
  expect(processes).toBe(1);
  expect(attached).toBe(true);
});
it('excludes backend readiness and reviewer checkout from preparation time', async () => {
  let now = 0;
  await expect(withRuntimeLaunchDeadline({ runtime: 'qoder', timeoutMs: 30, clock: () => now }, async () => {
    await runtimeLaunchStep({}, 'reviewer_checkout', async () => { now += 100; await new Promise(resolve => setTimeout(resolve, 60)); });
    await runtimeLaunchStep({}, 'backend_gate', async () => { now += 100; await new Promise(resolve => setTimeout(resolve, 60)); });
    await runtimeLaunchStep({}, 'process_spawn', () => {});
  })).resolves.toBeUndefined();
});
it('names the stalled preparation step', async () => {
  let now = 0;
  await expect(withRuntimeLaunchDeadline({ runtime: 'qoder', timeoutMs: 30, clock: () => now }, () =>
    runtimeLaunchStep({}, 'binary_resolution', () => { now = 50; }))).rejects.toMatchObject({ code: 'runtime_launch_timeout', step: 'binary_resolution', effectStarted: false });
});
it('counts nested readiness and checkout pause once', async () => {
  let now = 0;
  await expect(withRuntimeLaunchDeadline({ runtime: 'qoder', timeoutMs: 30, clock: () => now }, async () => {
    await runtimeLaunchStep({}, 'reviewer_checkout', async () => {
      now = 10;
      await runtimeLaunchStep({}, 'backend_gate', () => { now = 20; });
      now = 30;
    });
    now = 65;
    await runtimeLaunchStep({}, 'binary_resolution', () => {});
  })).rejects.toMatchObject({ code: 'runtime_launch_timeout', step: 'binary_resolution' });
});
it.each(['backend_gate', 'reviewer_checkout'])('bounds a stalled %s independently', async step => {
  let now = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const pending = withRuntimeLaunchDeadline({ runtime: 'qoder', stepTimeoutMs: 30, clock: () => now }, () => runtimeLaunchStep({}, step, async () => { now = 50; await gate; }));
  const observed = pending.then(() => 'completed', error => error.step);
  try { expect(await Promise.race([observed, new Promise(resolve => setTimeout(() => resolve('unbounded'), 100))])).toBe(step); }
  finally { release(); await observed; }
});
it('keeps the final OS creation guard on the preparation budget', async () => {
  const { assertRuntimeSpawnDeadline } = await import('./launch-deadline');
  let now = 0;
  let processes = 0;
  await expect(withRuntimeLaunchDeadline({ runtime: 'qoder', timeoutMs: 30, clock: () => now }, () => runtimeLaunchStep({}, 'process_spawn', () => {
    now = 50;
    assertRuntimeSpawnDeadline();
    processes++;
  }))).rejects.toMatchObject({ code: 'runtime_launch_timeout', effectStarted: false });
  expect(processes).toBe(0);
});
