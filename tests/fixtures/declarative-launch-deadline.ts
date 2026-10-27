import { existsSync, readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';

export function declarativeLaunchDeadlineTest(fixture: {
  repo: () => string;
  packet: (repo: string, id: string) => OrchestratorPacket;
  mission: (repo: string, packet: OrchestratorPacket) => Promise<OrchestratorMissionState>;
  capturePath: string;
}) {
  it('holds an uncertain post-spawn journal timeout without creating a second worker', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const id = 'pkt-started-journal-stall';
    const ioModule = await import('@/lib/runtimes/shared/owned-session/session-io');
    const original = ioModule.createOwnedSessionIo;
    let reachedJournal = false;
    let entered!: () => void;
    const held = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let saved!: () => void;
    const settled = new Promise<void>(resolve => { saved = resolve; });
    const spy = vi.spyOn(ioModule, 'createOwnedSessionIo').mockImplementation(options => {
      const io = original(options);
      return { ...io, saveSession: async session => {
        if (session.packetId === id && session.activeRun?.spawnState === 'started') {
          reachedJournal = true; entered(); await gate;
          try { await io.saveSession(session); } finally { saved(); }
        } else await io.saveSession(session);
      } };
    });
    const repo = fixture.repo();
    await import('@/lib/repos/registry').then(({ addRepo }) => addRepo(repo));
    const [{ runDispatchTick }, registry] = await Promise.all([
      import('@/lib/orchestrator/scheduling'), import('@/lib/lane/registry'),
    ]);
    const lines = () => existsSync(fixture.capturePath) ? readFileSync(fixture.capturePath, 'utf8').trim().split('\n').filter(Boolean).length : 0;
    const before = lines();
    const pending = runDispatchTick(await fixture.mission(repo, fixture.packet(repo, id)), { launchBudget: { maxLaunches: 1 } });
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([held, pending.then(() => { throw new Error('Launch returned before the started journal checkpoint.'); })]);
      clock = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 31_000);
      const result = await Promise.race([pending, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Started journal ignored its launch deadline.')), 1_000);
      })]);
      expect(result.packets[0].blockedReason).toContain('started_journal');
      const lane = registry.findLatestLaneByPacket(id)!;
      expect(lane.status).toBe('awaiting_orchestrator');
      expect(registry.getLaneEvents(lane.id, 100)).toEqual(expect.arrayContaining([
        expect.objectContaining({ verb: 'runtime_launch_step', payload: expect.objectContaining({
          step: 'started_journal', code: 'runtime_launch_timeout', effectStarted: true,
        }) }),
      ]));
      await vi.waitFor(() => expect(lines()).toBe(before + 1));
    } finally {
      clearTimeout(timer); release(); await pending; if (reachedJournal) await settled;
      await new Promise(resolve => setTimeout(resolve, 100));
      clock?.mockRestore(); spy.mockRestore();
    }
    expect(lines()).toBe(before + 1);
    const lane = registry.findLatestLaneByPacket(id)!;
    await vi.waitFor(() => expect(registry.getLaneEvents(lane.id, 100).some(event => event.verb === 'runtime_process_exit')).toBe(true));
  }, 60_000);
  it('bounds a post-worktree CLI-resolution stall and fences its late spawn', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const repo = fixture.repo();
    await import('@/lib/repos/registry').then(({ addRepo }) => addRepo(repo));
    const resolver = await import('@/lib/runtimes/shared/cli-resolver');
    const original = resolver.resolveCli;
    let entered!: () => void;
    const held = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let completed!: () => void;
    const resolved = new Promise<void>(resolve => { completed = resolve; });
    const spy = vi.spyOn(resolver, 'resolveCli').mockImplementation(async options => {
      if (options.runtimeId === 'qoder') { entered(); await gate; }
      try { return await original(options); } finally { completed(); }
    });
    const [{ runDispatchTick }, registry] = await Promise.all([
      import('@/lib/orchestrator/scheduling'), import('@/lib/lane/registry'),
    ]);
    const id = 'pkt-post-worktree-stall';
    const capture = () => existsSync(fixture.capturePath) ? readFileSync(fixture.capturePath, 'utf8') : '';
    const before = capture();
    const pending = runDispatchTick(await fixture.mission(repo, fixture.packet(repo, id)), { launchBudget: { maxLaunches: 1 } });
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await held;
      const now = performance.now();
      clock = vi.spyOn(performance, 'now').mockReturnValue(now + 31_000);
      const result = await Promise.race([pending, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Post-worktree launch remained silent after its deadline.')), 1_000);
      })]);
      expect(result.packets[0].blockedReason).toContain('runtime_launch_timeout');
      const lane = registry.findLatestLaneByPacket(id)!;
      expect(lane.status).not.toBe('launching');
      expect(registry.getLaneEvents(lane.id, 100)).toEqual(expect.arrayContaining([
        expect.objectContaining({ verb: 'runtime_launch_step', payload: expect.objectContaining({ step: 'binary_resolution', phase: 'started' }) }),
        expect.objectContaining({ verb: 'runtime_launch_step', payload: expect.objectContaining({ step: 'binary_resolution', phase: 'failed', code: 'runtime_launch_timeout' }) }),
      ]));
    } finally {
      clearTimeout(timer);
      release();
      await pending; await resolved;
      await new Promise(resolve => setTimeout(resolve, 100));
      clock?.mockRestore();
      spy.mockRestore();
    }
    expect(capture()).toBe(before);
  }, 60_000);
  it('refuses OS creation when synchronous child policy preparation crosses the deadline', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const id = 'pkt-final-spawn-deadline';
    const policy = await import('@/lib/providers/spawn-environment');
    const original = policy.stampChildPolicy;
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    let crossed = false;
    const spy = vi.spyOn(policy, 'stampChildPolicy').mockImplementation(env => {
      const result = original(env);
      if (env.O8_WORKER_PACKET_ID === id && env.O8_OWNED_RUN_MARKER) {
        crossed = true;
        clock ??= vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 31_000);
      }
      return result;
    });
    const repo = fixture.repo();
    await import('@/lib/repos/registry').then(({ addRepo }) => addRepo(repo));
    const { runDispatchTick } = await import('@/lib/orchestrator/scheduling');
    const read = () => existsSync(fixture.capturePath) ? readFileSync(fixture.capturePath, 'utf8') : '';
    const before = read();
    try {
      const result = await runDispatchTick(await fixture.mission(repo, fixture.packet(repo, id)), { launchBudget: { maxLaunches: 1 } });
      expect(crossed).toBe(true);
      expect(result.packets[0].blockedReason).toContain('runtime_launch_timeout');
      expect(read()).toBe(before);
    } finally { clock?.mockRestore(); spy.mockRestore(); }
  }, 60_000);

}
