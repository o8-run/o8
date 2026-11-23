import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FleetSnapshot } from '@/lib/fleet/types';

// The phone and the window poll the inbox about every 8 s, just past its 8 s
// cache. An unchanged poll must not rebuild the snapshot; a changed input must.
const fleet = vi.hoisted(() => ({ current: null as FleetSnapshot | null }));
const builds = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/lib/runtime/inventory', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/runtime/inventory')>(),
  getRuntimeInventorySnapshot: async () => fleet.current,
}));
vi.mock('@/lib/review/workspace', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/review/workspace')>(),
  // Read once per build, so it counts builds.
  getWorkspaceReviewSnapshot: async () => { builds.count += 1; return null; },
}));
vi.mock('@/lib/github-broker/idle-drafts', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/github-broker/idle-drafts')>(),
  readRegisteredIdleDrafts: async () => ({ drafts: [], sources: [] }),
}));
vi.mock('@/lib/repos/projects', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/repos/projects')>(),
  getDefaultProjectId: () => 'inbox-version-project',
}));

const { getMobileInboxSnapshot } = await import('./inbox');
const { createTestApproval } = await import('@/lib/approvals/store');
const { createLane } = await import('@/lib/lane/registry');
const { getDataDir } = await import('@/lib/data-dir-migration');

function snapshot(task: string): FleetSnapshot {
  return {
    agents: [{
      id: 'codex-owned:one', name: 'Codex', squadId: 'codex', runtime: 'codex', model: 'gpt-5-codex', status: 'running',
      currentTask: task, workspace: '/repo/o8', branch: 'main', sessionKey: 'codex-owned:one', approvalStatus: 'none',
      lastEventAt: 'just now', lastActivityAt: 1, context: { usedPercent: 0, trend: 'stable' }, alerts: 0,
    }],
    events: [],
    meta: { primarySessionKey: 'codex-owned:one', mode: 'live' },
  } as unknown as FleetSnapshot;
}

let now = Date.parse('2026-11-23T12:00:00Z');
beforeAll(() => { vi.spyOn(Date, 'now').mockImplementation(() => now); });
afterAll(() => { vi.restoreAllMocks(); });
const poll = async () => { now += 8_200; await getMobileInboxSnapshot(); return builds.count; };

describe('mobile inbox polls past the cache TTL', () => {
  it('reuses the snapshot while its inputs read the same, and rebuilds when one changes', async () => {
    fleet.current = snapshot('first task');
    await getMobileInboxSnapshot();
    expect(builds.count).toBe(1);
    expect(await poll()).toBe(1);
    expect(await poll()).toBe(1);

    fleet.current = snapshot('second task');
    expect(await poll()).toBe(2);
    expect(await poll()).toBe(2);

    createTestApproval('codex-owned:one');
    expect(await poll()).toBe(3);

    createLane({ repoPath: '/tmp/inbox-version-repo', projectId: 'inbox-version-project', branch: 'inbox-version', runtime: 'codex' });
    expect(await poll()).toBe(4);

    const states = join(getDataDir(), 'terminal-states');
    mkdirSync(states, { recursive: true });
    writeFileSync(join(states, 'tile-root.json'), JSON.stringify({ activeTabId: 'chat-1', tabs: [{ id: 'chat-1', kind: 'llm-chat', label: 'Chat' }] }));
    expect(await poll()).toBe(5);
    expect(await poll()).toBe(5);
  });

  it('rebuilds an unchanged snapshot at least every 30 s', async () => {
    const before = builds.count;
    // Built 8.2 s before this test began: reused at 16.4 and 24.6 s, rebuilt at 32.8 s.
    expect(await poll()).toBe(before);
    expect(await poll()).toBe(before);
    expect(await poll()).toBe(before + 1);
  });
});
