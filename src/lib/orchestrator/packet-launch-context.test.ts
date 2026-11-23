import { describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({
  current: { missionId: 'mission-current', packets: [] as Array<Record<string, unknown>> },
  registry: [] as Array<Record<string, unknown>>,
  stamp: '1',
  scans: 0,
}));

vi.mock('@/lib/orchestrator/control-plane', () => ({
  readOrchestratorControlPlaneState: () => fixtures.current,
}));

vi.mock('@/lib/orchestrator/mission-registry', () => ({
  listMissionRegistryEntries: () => { fixtures.scans += 1; return fixtures.registry; },
  missionsStamp: () => fixtures.stamp,
}));

const { resolvePacketLaunchContexts } = await import('./packet-launch-context');

function launchContext(caller: string, placement?: { workspaceId: string; threadId: string }) {
  return {
    source: 'cli',
    presentation: 'split',
    repoContext: 'transient',
    caller,
    ...(placement ? {
      parentWorkspaceId: placement.workspaceId,
      parentThreadId: placement.threadId,
    } : {}),
  } as const;
}

describe('packet launch context lookup', () => {
  it('falls back to a non-current mission so durable lane polling can still split the worker', () => {
    const persistedLaunchContext = launchContext('outside terminal', {
      workspaceId: 'workspace-parent',
      threadId: 'thoughts-parent',
    });
    fixtures.current = {
      missionId: 'mission-current',
      packets: [{ id: 'pkt-current', launchContext: launchContext('current') }],
    };
    fixtures.registry = [{
      id: 'mission-older',
      mission: {
        missionId: 'mission-older',
        packets: [{ id: 'pkt-older', launchContext: persistedLaunchContext }],
      },
    }];

    fixtures.stamp = 'fallback';
    expect(resolvePacketLaunchContexts(['pkt-older']).get('pkt-older')).toEqual({
      launchContext: persistedLaunchContext,
      missionId: 'mission-older',
    });
  });

  it('parses the stored missions again only after a stored mission changes', () => {
    const first = launchContext('first');
    fixtures.current = { missionId: 'mission-current', packets: [] };
    fixtures.registry = [{ id: 'mission-a', mission: { missionId: 'mission-a', packets: [{ id: 'pkt-a', launchContext: first }] } }];
    fixtures.stamp = 'before';
    fixtures.scans = 0;
    // A lane poll asks for packets that carry no launch context too (pkt-none).
    for (let poll = 0; poll < 5; poll += 1) {
      expect(resolvePacketLaunchContexts(['pkt-a', 'pkt-none']).get('pkt-a')).toEqual({ launchContext: first, missionId: 'mission-a' });
    }
    expect(fixtures.scans).toBe(1);

    const second = launchContext('second');
    fixtures.registry = [{ id: 'mission-b', mission: { missionId: 'mission-b', packets: [{ id: 'pkt-a', launchContext: second }] } }];
    fixtures.stamp = 'after';
    expect(resolvePacketLaunchContexts(['pkt-a']).get('pkt-a')).toEqual({ launchContext: second, missionId: 'mission-b' });
    expect(fixtures.scans).toBe(2);
  });
});
