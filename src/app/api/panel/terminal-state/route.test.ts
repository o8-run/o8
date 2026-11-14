import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { GET, POST } from './route';
import { listReposFresh } from '@/lib/repos/registry';
import { buildRepoStateScope } from '@/lib/terminal/tab-state';

const dataDir = process.env.CORTEX_IDE_DATA_DIR!;
const stateDir = path.join(dataDir, 'terminal-states');
const stateUrl = 'http://localhost/api/panel/terminal-state?scope=tile-root';

beforeEach(async () => {
  rmSync(path.join(dataDir, 'repos.json'), { force: true });
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(path.join(dataDir, 'terminal-state.json'), { force: true });
  await listReposFresh();
});

describe('terminal state restore without a registered repo', () => {
  // The browser console's tab handlers are gone; these cases save the state
  // they used to persist and read it back through the route.
  it.each([0, 9, null])('saves and reads back an ended shell with exit status %s and its final output', async (exitCode) => {
    const terminalExit = { exitCode, transcript: 'FINAL-PERSISTED-MARKER\nlast line' };
    const tab = { id: 'ended-shell', label: 'Terminal 1', kind: 'terminal' as const, cliAgent: 'shell', tmuxSession: 'cortex-dash-ended-fixture', terminalExit, createdAt: 1, lastActivity: 2 };
    const persisted = { version: 1, activeTabId: tab.id, tabs: [tab], savedAt: new Date().toISOString() };
    const save = await POST(new Request(stateUrl, { method: 'POST', body: JSON.stringify(persisted) }));
    expect(save.status).toBe(200);
    const read = await GET(new Request(stateUrl));
    expect(read.status).toBe(200);
    const body = await read.json();
    expect(body.activeTabId).toBe(tab.id);
    expect(body.tabs).toEqual([expect.objectContaining({ id: tab.id, tmuxSession: tab.tmuxSession, terminalExit })]);
  });

  it.each([false, true])('keeps the newer selected conversation when canonical state is newer: %s', async (canonicalIsNewer) => {
    const repoPath = path.join(dataDir, 'registered-repo');
    writeFileSync(path.join(dataDir, 'repos.json'), JSON.stringify({ version: 1,
      repos: [{ id: 'registered', name: 'repo', localPath: repoPath }],
    }));
    await listReposFresh();
    const state = (id: string, savedAt: string) => ({ version: 1, activeTabId: id, savedAt,
      tabs: [{ id, kind: 'orchestrator', label: id, repoPath, orchestratorThreadId: `thoughts-${id}` }],
    });
    const root = state('selected-root', '2026-10-11T12:00:00.000Z');
    const canonical = state('canonical', canonicalIsNewer ? '2026-10-11T13:00:00.000Z' : '2026-10-10T12:00:00.000Z');
    await POST(new Request(`${stateUrl.replace('tile-root', buildRepoStateScope(repoPath))}`, { method: 'POST', body: JSON.stringify(canonical) }));
    await POST(new Request(stateUrl, { method: 'POST', body: JSON.stringify(root) }));
    const response = await GET(new Request(stateUrl));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(canonicalIsNewer ? canonical : root);
  });

  it('saves and reads back a plan chat without adopting a repository or terminal', async () => {
    const now = Date.now();
    const tab = { id: 'chatgpt-plan-fixture', label: 'ChatGPT plan', kind: 'chatgpt-plan' as const, tmuxSession: null, createdAt: now, lastActivity: now };
    const persisted = { version: 1, activeTabId: tab.id, tabs: [tab], savedAt: new Date().toISOString() };
    const save = await POST(new Request(stateUrl, { method: 'POST', body: JSON.stringify(persisted) }));
    expect(save.status).toBe(200);
    const response = await GET(new Request(stateUrl));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.activeTabId).toBe(tab.id);
    expect(body.tabs).toEqual([expect.objectContaining({ id: tab.id, label: 'ChatGPT plan', kind: 'chatgpt-plan', tmuxSession: null })]);
    expect(body.tabs[0].repo).toBeUndefined();
  });

  it('reloads a persisted global terminal and filters an orphaned repo tab', async () => {
    const save = await POST(new Request(stateUrl, {
      method: 'POST',
      body: JSON.stringify({
        version: 1,
        activeTabId: 'global-shell',
        savedAt: '2026-09-24T00:00:00.000Z',
        tabs: [
          { id: 'global-shell', kind: 'terminal', label: 'Terminal 1', cliAgent: 'shell', tmuxSession: 'cortex-dash-live' },
          { id: 'old-repo', kind: 'terminal', label: 'Old repo', cliAgent: 'shell', repoPath: '/missing-repo', tmuxSession: 'cortex-dash-old' },
        ],
      }),
    }));
    expect(save.status).toBe(200);

    const restored = await GET(new Request(stateUrl));
    expect(restored.status).toBe(200);
    const state = await restored.json() as { tabs: Array<{ id: string; tmuxSession?: string }> };
    expect(state.tabs).toEqual([
      expect.objectContaining({ id: 'global-shell', tmuxSession: 'cortex-dash-live' }),
    ]);
  });

  it('does not restore a repo-scoped tab from fallback state when its repo is gone', async () => {
    const save = await POST(new Request('http://localhost/api/panel/terminal-state?scope=repo-old', {
      method: 'POST',
      body: JSON.stringify({
        version: 1,
        activeTabId: 'old-repo',
        savedAt: '2026-09-24T00:00:00.000Z',
        tabs: [{ id: 'old-repo', kind: 'terminal', label: 'Old repo', cliAgent: 'shell', repoPath: '/missing-repo' }],
      }),
    }));
    expect(save.status).toBe(200);

    const restored = await GET(new Request(stateUrl));
    expect(restored.status).toBe(204);
  });

  it('filters removed-repo tabs in a fallback selected for a registered repo', async () => {
    const repoPath = path.join(dataDir, 'registered-repo');
    writeFileSync(path.join(dataDir, 'repos.json'), JSON.stringify({
      version: 1,
      repos: [{ id: 'registered', name: 'registered-repo', localPath: repoPath }],
    }));
    await listReposFresh();
    await POST(new Request('http://localhost/api/panel/terminal-state?scope=repo-older', {
      method: 'POST',
      body: JSON.stringify({
        version: 1,
        activeTabId: 'registered-tab',
        savedAt: '2026-09-24T00:00:00.000Z',
        tabs: [
          { id: 'registered-tab', kind: 'terminal', label: 'Registered', cliAgent: 'shell', repoPath },
          { id: 'removed-tab', kind: 'terminal', label: 'Removed', cliAgent: 'shell', repoPath: '/missing-repo' },
        ],
      }),
    }));

    const restored = await GET(new Request(`${stateUrl.replace('tile-root', 'repo-current')}&repoPath=${encodeURIComponent(repoPath)}`));
    expect(restored.status).toBe(200);
    const state = await restored.json() as { tabs: Array<{ id: string }> };
    expect(state.tabs.map((tab) => tab.id)).toEqual(['registered-tab']);
  });

  it('filters retired packet chat tabs from the nonempty fallback', async () => {
    await POST(new Request('http://localhost/api/panel/terminal-state?scope=repo-older', {
      method: 'POST',
      body: JSON.stringify({
        version: 1,
        activeTabId: 'global-shell',
        savedAt: '2026-09-24T00:00:00.000Z',
        tabs: [
          { id: 'global-shell', kind: 'terminal', label: 'Terminal 1', cliAgent: 'shell' },
          { id: 'retired-chat', kind: 'chat', label: 'Retired', cliAgent: 'codex', orchestrationPacket: { packetId: 'missing-packet' } },
        ],
      }),
    }));

    const restored = await GET(new Request(stateUrl));
    expect(restored.status).toBe(200);
    const state = await restored.json() as { tabs: Array<{ id: string }> };
    expect(state.tabs.map((tab) => tab.id)).toEqual(['global-shell']);
  });
});


describe('terminal state restore through repository aliases', () => {
  it.each(['global', 'canonical-request', 'alias-request'])('restores an alias-bound tab through %s', async (entry) => {
    const fixture = mkdtempSync(path.join(dataDir, 'restore-alias-'));
    try {
      const repoPath = path.join(fixture, 'repo');
      const aliasPath = path.join(fixture, 'alias');
      mkdirSync(repoPath);
      symlinkSync(repoPath, aliasPath, 'junction');
      writeFileSync(path.join(dataDir, 'repos.json'), JSON.stringify({ version: 1,
        repos: [{ id: 'registered', name: 'repo', localPath: repoPath }],
      }));
      await listReposFresh();
      const save = await POST(new Request(stateUrl, { method: 'POST', body: JSON.stringify({
        version: 1, activeTabId: 'cloud-review', tabs: [
          { id: 'cloud-review', kind: 'chat', label: 'Cloud review', chatRuntime: 'cloud', chatSessionKey: 'cloud:review', repoPath: aliasPath },
        ],
      }) }));
      expect(save.status).toBe(200);
      const requestUrl = entry === 'global' ? stateUrl
        : `http://localhost/api/panel/terminal-state?scope=repo-current&repoPath=${encodeURIComponent(entry === 'alias-request' ? aliasPath : repoPath)}`;
      const restored = await GET(new Request(requestUrl));
      expect(restored.status).toBe(200);
      expect(await restored.json()).toMatchObject({ activeTabId: 'cloud-review', tabs: [
        { id: 'cloud-review', chatSessionKey: 'cloud:review', repoPath: aliasPath },
      ] });
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('does not restore a tab whose path resolves outside the registered repository', async () => {
    const fixture = mkdtempSync(path.join(dataDir, 'restore-alias-'));
    try {
      const repoPath = path.join(fixture, 'repo');
      const outsidePath = path.join(fixture, 'outside');
      mkdirSync(repoPath);
      mkdirSync(outsidePath);
      const escapedPath = path.join(repoPath, 'outside-link');
      symlinkSync(outsidePath, escapedPath, 'junction');
      writeFileSync(path.join(dataDir, 'repos.json'), JSON.stringify({ version: 1,
        repos: [{ id: 'registered', name: 'repo', localPath: repoPath }],
      }));
      await listReposFresh();
      await POST(new Request(stateUrl, { method: 'POST', body: JSON.stringify({
        version: 1, activeTabId: 'global-shell', tabs: [
          { id: 'global-shell', kind: 'terminal', cliAgent: 'shell' },
          { id: 'escaped-repo', kind: 'chat', chatRuntime: 'cloud', chatSessionKey: 'cloud:other', repoPath: escapedPath },
        ],
      }) }));
      const restored = await GET(new Request(stateUrl));
      expect(restored.status).toBe(200);
      const state = await restored.json() as { tabs: Array<{ id: string }> };
      expect(state.tabs.map((tab) => tab.id)).toEqual(['global-shell']);
      const rejected = await GET(new Request(`${stateUrl}&repoPath=${encodeURIComponent(escapedPath)}`));
      expect(rejected.status).toBe(204);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
