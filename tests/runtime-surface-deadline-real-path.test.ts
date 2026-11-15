import { expect, it, vi } from 'vitest';
import { runtimeLaunchStep, withRuntimeLaunchClock } from '@/lib/runtime/launch-deadline';
const h = vi.hoisted(() => ({ launch: vi.fn(), now: 0 }));
vi.mock('@/lib/runtimes', () => ({ getRuntime: () => ({ capabilities: { launch: true }, launch: h.launch }) }));
vi.mock('@/lib/runtime/launch-effort', () => ({ assertLaunchEffortPin: async () => {} }));
vi.mock('@/lib/runtime/launch-work-mode', () => ({ resolveLaunchWorkMode: () => ({ ok: true, workMode: 'scratch' }) }));
vi.mock('@/lib/runtime/single-attempt-launch', () => ({ assertSingleAttemptLaunch: () => {} }));
vi.mock('@/lib/runtime/project-launch-brief', () => ({ buildLaunchPromptWithProjectBrief: async () => ({ prompt: 'fixture', projectContext: null }), summarizeTaskName: () => 'fixture' }));
vi.mock('@/lib/orchestrator/reviewer-pr-source', () => ({ assertReviewerPrCheckout: async () => {} }));
vi.mock('@/lib/runtime/launch-governance', () => ({ settleRuntimeLaunchGovernance: async ({ result }: { result: unknown }) => result }));
vi.mock('@/lib/cortex/knowledge/sources', () => ({ assertNotKnowledgeSource: () => {} }));
const { launchRuntimeSurface } = await import('@/lib/runtime/actions');
it.each(['qoder', 'claude-code'] as const)('real surface launch fences %s preparation and holds its started process', async runtime => {
  h.now = 0;
  h.launch.mockImplementationOnce(() => runtimeLaunchStep({}, 'binary_resolution', () => { h.now = 31_000; }));
  await expect(withRuntimeLaunchClock(() => h.now, () => launchRuntimeSurface({ runtime, prompt: 'fixture', repoPath: process.cwd(), isolate: false, skipSetup: true }))).rejects.toMatchObject({ code: 'runtime_launch_timeout', step: 'binary_resolution' });
  h.now = 0;
  let processes = 0;
  h.launch.mockImplementationOnce(() => runtimeLaunchStep({}, 'process_spawn', async () => {
    processes++; h.now = 31_000;
    await new Promise(resolve => setTimeout(resolve, 60));
    return { ok: true, sessionKey: `${runtime}-owned:fixture` };
  }));
  await expect(withRuntimeLaunchClock(() => h.now, () => launchRuntimeSurface({ runtime, prompt: 'fixture', repoPath: process.cwd(), isolate: false, skipSetup: true }))).resolves.toMatchObject({ ok: true });
  expect(processes).toBe(1);
});
it('releases the exact launch lease once before a timed-out read settles', async () => {
  const leases = await import('@/lib/orchestrator/workspace-lifecycle-lease');
  const { withPacketLifecycleMutationLock } = await import('@/lib/orchestrator/lifecycle-mutation-lock');
  const { runtimeLaunchRead } = await import('@/lib/runtime/launch-deadline');
  const releaseSpy = vi.spyOn(leases, 'releaseWorkspaceLifecycleLease');
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const read = new Promise<void>(resolve => { release = resolve; });
  h.now = 0;
  h.launch.mockImplementationOnce(() => runtimeLaunchStep({}, 'binary_resolution', () => runtimeLaunchRead(async () => { entered(); await read; return { ok: true }; })));
  const pending = withRuntimeLaunchClock(() => h.now, () => withPacketLifecycleMutationLock('deadline-lease-fixture', () => launchRuntimeSurface({ runtime: 'qoder', prompt: 'fixture', repoPath: process.cwd(), isolate: false, skipSetup: true })));
  const observed = expect(pending).rejects.toMatchObject({ code: 'runtime_launch_timeout', step: 'binary_resolution' });
  try {
    await ready;
    h.now = 31_000;
    await observed;
    expect(releaseSpy.mock.calls.filter(([lease]) => lease.packetId === 'deadline-lease-fixture')).toHaveLength(1);
    release();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(releaseSpy.mock.calls.filter(([lease]) => lease.packetId === 'deadline-lease-fixture')).toHaveLength(1);
  } finally { release(); releaseSpy.mockRestore(); }
});
