import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  claimOutsideWorkerSplits,
  outsideWorkerSessionKeysForLane,
  outsideWorkerSessionKeysForPacketIds,
  outsideWorkerSessionKeysForSettledPackets,
  outsideWorkerPlacementKey,
  queueOutsideWorkerSplit,
  registerOutsideWorkerSplitMountSurface,
  releaseOutsideWorkerSplits,
  removeOutsideWorkerSplits,
  resetOutsideWorkerSplitsForTest,
  subscribeOutsideWorkerSplits,
} from './outside-worker-split';

afterEach(() => resetOutsideWorkerSplitsForTest());

function claim(tabId: string, repoPath = '/tmp/example') {
  return claimOutsideWorkerSplits({ tabId, repoPath });
}

describe('outside worker split broker', () => {
  it('holds a launch until an active chat surface claims it', () => {
    queueOutsideWorkerSplit({
      sessionKey: 'opencode-owned:one',
      runtime: 'opencode',
      repoPath: '/tmp/example',
    });

    expect(claim('orchestrator-one')).toEqual([
      expect.objectContaining({ sessionKey: 'opencode-owned:one' }),
    ]);
    expect(claim('orchestrator-one')).toEqual([]);
    expect(claim('orchestrator-two')).toEqual([]);
  });

  it('updates a queued launch without duplicating its split', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeOutsideWorkerSplits(listener);
    queueOutsideWorkerSplit({ sessionKey: 'codex-owned:one', runtime: 'codex', repoPath: '/tmp/one' });
    queueOutsideWorkerSplit({ sessionKey: 'codex-owned:one', runtime: 'codex', repoPath: '/tmp/two' });

    expect(claim('orchestrator-one', '/tmp/two')).toEqual([
      expect.objectContaining({ sessionKey: 'codex-owned:one', repoPath: '/tmp/two' }),
    ]);
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it('releases a tab claim so another active surface can adopt the worker', () => {
    queueOutsideWorkerSplit({
      sessionKey: '3code-owned:handoff',
      runtime: '3code',
      repoPath: '/tmp/outside',
    });

    expect(claim('orchestrator-one', '/tmp/outside')).toHaveLength(1);
    releaseOutsideWorkerSplits('orchestrator-one');
    expect(claim('orchestrator-two', '/tmp/outside')).toEqual([
      expect.objectContaining({ sessionKey: '3code-owned:handoff' }),
    ]);
  });

  it('removes settled or dismissed workers instead of offering them again', () => {
    queueOutsideWorkerSplit({
      sessionKey: 'opencode-owned:settled',
      runtime: 'opencode',
      repoPath: '/tmp/outside',
    });
    claim('orchestrator-one', '/tmp/outside');

    removeOutsideWorkerSplits(['opencode-owned:settled']);
    releaseOutsideWorkerSplits('orchestrator-one');

    expect(claim('orchestrator-two', '/tmp/outside')).toEqual([]);
  });

  it('keeps the lane binding after claim so terminal events can retire the pane', () => {
    queueOutsideWorkerSplit({
      sessionKey: 'opencode-owned:outside',
      runtime: 'opencode',
      repoPath: '/tmp/outside',
      laneId: 'lane-outside',
    });

    claim('orchestrator-tab', '/tmp/outside');

    expect(outsideWorkerSessionKeysForLane('lane-outside')).toEqual(['opencode-owned:outside']);
  });

  it('keeps the packet binding after its lane is released from durable state', () => {
    queueOutsideWorkerSplit({
      sessionKey: 'opencode-owned:released',
      runtime: 'opencode',
      repoPath: '/tmp/outside',
      packetId: 'packet-released',
      laneId: 'lane-gone',
    });

    claim('orchestrator-tab', '/tmp/outside');

    expect(outsideWorkerSessionKeysForPacketIds(new Set(['packet-released']))).toEqual([
      'opencode-owned:released',
    ]);
    expect(outsideWorkerSessionKeysForSettledPackets([{
      id: 'packet-released',
      status: 'released',
      releaseState: 'released',
      archivedAt: null,
    }])).toEqual(['opencode-owned:released']);
  });

  it('only lets the durable parent workspace and thread claim a worker', () => {
    queueOutsideWorkerSplit({
      sessionKey: 'codex-owned:placed',
      runtime: 'codex',
      repoPath: '/repo/one',
      packetId: 'packet-placed',
      launchContext: {
        source: 'mcp',
        presentation: 'split',
        repoContext: 'transient',
        parentWorkspaceId: 'workspace-one',
        parentThreadId: 'thoughts-one',
      },
    });

    expect(claimOutsideWorkerSplits({
      tabId: 'wrong-repo-tab',
      repoPath: '/repo/two',
      workspaceId: 'workspace-one',
      threadId: 'thoughts-one',
    })).toEqual([]);
    expect(claimOutsideWorkerSplits({
      tabId: 'wrong-workspace-tab',
      repoPath: '/repo/one',
      workspaceId: 'workspace-two',
      threadId: 'thoughts-one',
    })).toEqual([]);
    expect(claimOutsideWorkerSplits({
      tabId: 'wrong-thread-tab',
      repoPath: '/repo/one',
      workspaceId: 'workspace-one',
      threadId: 'thoughts-two',
    })).toEqual([]);
    expect(claimOutsideWorkerSplits({
      tabId: 'parent-tab',
      repoPath: '/repo/one/',
      workspaceId: 'workspace-one',
      threadId: 'thoughts-one',
    })).toEqual([expect.objectContaining({ sessionKey: 'codex-owned:placed' })]);
  });

  it('replaces session transport under one packet identity after rotation', () => {
    queueOutsideWorkerSplit({
      sessionKey: 'codex-owned:old',
      runtime: 'codex',
      repoPath: '/repo/one',
      packetId: 'packet-stable',
    });
    queueOutsideWorkerSplit({
      sessionKey: 'codex-owned:new',
      runtime: 'codex',
      repoPath: '/repo/one',
      packetId: 'packet-stable',
    });

    expect(claim('consumer-tab', '/repo/one')).toEqual([
      expect.objectContaining({ packetId: 'packet-stable', sessionKey: 'codex-owned:new' }),
    ]);
    expect(outsideWorkerSessionKeysForPacketIds(new Set(['packet-stable']))).toEqual([
      'codex-owned:new',
    ]);
  });

  it('delivers a rotated transport once to its existing owner', () => {
    const placedClaim = (tabId: string) => claimOutsideWorkerSplits({
      tabId,
      repoPath: '/repo/one',
      workspaceId: 'workspace-parent',
      threadId: 'thread-parent',
    });
    queueOutsideWorkerSplit({
      sessionKey: 'codex-owned:old',
      runtime: 'codex',
      repoPath: '/repo/one',
      packetId: 'packet-stable',
      laneId: 'lane-stable',
      launchContext: {
        source: 'mcp',
        presentation: 'split',
        repoContext: 'transient',
        parentWorkspaceId: 'workspace-parent',
        parentThreadId: 'thread-parent',
      },
    });
    expect(placedClaim('owner-tab')).toEqual([
      expect.objectContaining({ sessionKey: 'codex-owned:old' }),
    ]);

    queueOutsideWorkerSplit({
      sessionKey: 'codex-owned:new',
      runtime: 'codex',
      repoPath: '/repo/one',
      laneId: 'lane-stable',
    });

    expect(placedClaim('other-tab')).toEqual([]);
    expect(placedClaim('owner-tab')).toEqual([
      expect.objectContaining({
        sessionKey: 'codex-owned:new',
        packetId: 'packet-stable',
        launchContext: expect.objectContaining({
          parentWorkspaceId: 'workspace-parent',
          parentThreadId: 'thread-parent',
        }),
      }),
    ]);
    expect(placedClaim('owner-tab')).toEqual([]);
  });

  it('does not merge different packets that happen to reuse a lane id', () => {
    queueOutsideWorkerSplit({
      sessionKey: 'codex-owned:first',
      runtime: 'codex',
      repoPath: '/repo/one',
      packetId: 'packet-first',
      laneId: 'lane-reused',
    });
    queueOutsideWorkerSplit({
      sessionKey: 'codex-owned:second',
      runtime: 'codex',
      repoPath: '/repo/one',
      packetId: 'packet-second',
      laneId: 'lane-reused',
    });

    expect(claim('consumer-tab', '/repo/one')).toEqual([
      expect.objectContaining({ packetId: 'packet-first' }),
      expect.objectContaining({ packetId: 'packet-second' }),
    ]);
  });

  it('uses a deterministic repo-scoped placement for parentless launches', () => {
    const request = {
      repoPath: '/repo/one/',
      launchContext: {
        source: 'cli' as const,
        presentation: 'split' as const,
        repoContext: 'transient' as const,
      },
    };
    expect(outsideWorkerPlacementKey(request)).toBe('repo:/repo/one');
    expect(outsideWorkerPlacementKey({ ...request, repoPath: '/repo/one' })).toBe('repo:/repo/one');
    expect(outsideWorkerPlacementKey({
      ...request,
      launchContext: {
        ...request.launchContext,
        parentWorkspaceId: 'workspace-one',
        parentThreadId: 'thread-one',
      },
    })).toBe('parent:workspace-one:thread-one:repo:/repo/one');
    expect(outsideWorkerPlacementKey({
      ...request,
      repoPath: '/repo/two',
      launchContext: {
        ...request.launchContext,
        parentWorkspaceId: 'workspace-one',
        parentThreadId: 'thread-one',
      },
    })).toBe('parent:workspace-one:thread-one:repo:/repo/two');
  });

  it('mounts parentless workers in the deterministic first surface when the repo is unopened', () => {
    const mounts: string[] = [];
    registerOutsideWorkerSplitMountSurface({
      workspaceId: 'workspace-z',
      getPlacement: () => ({ repoPaths: [], threadIds: [] }),
      mount: () => { mounts.push('workspace-z'); return 'tab-z'; },
    });
    registerOutsideWorkerSplitMountSurface({
      workspaceId: 'workspace-a',
      getPlacement: () => ({ repoPaths: [], threadIds: [] }),
      mount: () => { mounts.push('workspace-a'); return 'tab-a'; },
    });

    queueOutsideWorkerSplit({
      sessionKey: 'codex-owned:unopened',
      runtime: 'codex',
      repoPath: '/repo/unopened',
      packetId: 'packet-unopened',
    });

    expect(mounts).toEqual(['workspace-a']);
  });

  it('prefers the active workspace when a parentless repo is unopened', () => {
    const mounts: string[] = [];
    registerOutsideWorkerSplitMountSurface({
      workspaceId: 'workspace-a',
      getPlacement: () => ({ active: false, repoPaths: [], threadIds: [] }),
      mount: () => { mounts.push('workspace-a'); return 'tab-a'; },
    });
    registerOutsideWorkerSplitMountSurface({
      workspaceId: 'workspace-z',
      getPlacement: () => ({ active: true, repoPaths: [], threadIds: [] }),
      mount: () => { mounts.push('workspace-z'); return 'tab-z'; },
    });

    queueOutsideWorkerSplit({
      sessionKey: 'codex-owned:active-workspace',
      runtime: 'codex',
      repoPath: '/repo/unopened-active',
      packetId: 'packet-active-workspace',
    });

    expect(mounts).toEqual(['workspace-z']);
  });

  it('waits for the exact parent workspace instead of mounting in a fallback', async () => {
    const mounts: string[] = [];
    registerOutsideWorkerSplitMountSurface({
      workspaceId: 'workspace-fallback',
      getPlacement: () => ({ repoPaths: [], threadIds: [] }),
      mount: () => { mounts.push('fallback'); return 'tab-fallback'; },
    });
    queueOutsideWorkerSplit({
      sessionKey: 'codex-owned:parented',
      runtime: 'codex',
      repoPath: '/repo/parented',
      packetId: 'packet-parented',
      launchContext: {
        source: 'mcp',
        presentation: 'split',
        repoContext: 'transient',
        parentWorkspaceId: 'workspace-parent',
        parentThreadId: 'thread-parent',
      },
    });
    expect(mounts).toEqual([]);

    registerOutsideWorkerSplitMountSurface({
      workspaceId: 'workspace-parent',
      getPlacement: () => ({ repoPaths: [], threadIds: [] }),
      mount: (request) => {
        mounts.push(request.launchContext?.parentThreadId ?? 'missing-thread');
        return 'tab-parent';
      },
    });
    await Promise.resolve();
    expect(mounts).toEqual(['thread-parent']);
  });
});

it('keeps the standing worker pane when its task packet is archived', () => {
  queueOutsideWorkerSplit({ sessionKey: 'codex-owned:standing-pane', runtime: 'codex',
    repoPath: '/tmp/standing-fixture', packetId: 'standing-task', laneId: 'lane-standing' });
  expect(outsideWorkerSessionKeysForSettledPackets([{ id: 'standing-task', status: 'archived',
    releaseState: 'pending', standingLaneId: 'lane-standing' }])).toEqual([]);
});
