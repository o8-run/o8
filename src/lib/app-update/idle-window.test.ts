import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { evaluateUpdateIdleWindow, readTerminalInventory } from './idle-window';

const terminalSession = {
  name: 'cortex-dash-test',
  kind: 'dash-shell' as const,
  clientCount: 0,
  cwd: null,
  commandHint: null,
};

describe('evaluateUpdateIdleWindow', () => {
  it('lists parked records separately from active work and ignores terminal lanes', () => {
    const result = evaluateUpdateIdleWindow({
      lanes: [
        { id: 'idle', label: 'Idle lane', status: 'idle', runtime: 'codex', sessionKey: null },
        { id: 'review', label: 'Review lane', status: 'reviewing', runtime: 'codex', sessionKey: null },
        { id: 'failed', label: 'Failed lane', status: 'failed', runtime: 'codex', sessionKey: null },
        { id: 'done', label: 'Done lane', status: 'completed', runtime: 'codex', sessionKey: null },
        { id: 'archived', label: 'Archived lane', status: 'archived', runtime: 'codex', sessionKey: null },
      ],
      terminalSessions: [],
      managedRuns: [],
      ownedSessions: [],
      terminalInventoryAvailable: true,
      checkedAt: '2026-07-31T12:00:00.000Z',
    });

    expect(result.idle).toBe(true);
    expect(result.active.lanes).toEqual([]);
    expect(result.parkedLanes.map(lane => lane.id)).toEqual(['idle', 'review']);
  });

  it('blocks attached terminals and owned managed processes but ignores detached shells', () => {
    const result = evaluateUpdateIdleWindow({
      lanes: [],
      terminalSessions: [
        terminalSession,
        { ...terminalSession, name: 'attached-shell', clientCount: 1 },
        { ...terminalSession, name: 'owned-worker', kind: 'managed-process', clientCount: 0 },
      ],
      managedRuns: [],
      ownedSessions: [],
      terminalInventoryAvailable: true,
    });

    expect(result.idle).toBe(false);
    expect(result.active.terminalSessions.map((session) => session.name)).toEqual([
      'attached-shell',
      'owned-worker',
    ]);
  });

  it('fails closed when terminal inventory is unavailable or a managed/owned run is live', () => {
    const unavailable = evaluateUpdateIdleWindow({
      lanes: [],
      terminalSessions: [],
      managedRuns: [],
      ownedSessions: [],
      terminalInventoryAvailable: false,
    });
    expect(unavailable.idle).toBe(false);
    expect(unavailable.unavailable).toEqual(['terminal-sessions']);

    const managed = evaluateUpdateIdleWindow({
      lanes: [],
      terminalSessions: [terminalSession],
      managedRuns: [{ id: 'run-1', session: 'cortex-run-1', command: 'npm test', cwd: '/tmp/repo' }],
      ownedSessions: [],
      terminalInventoryAvailable: true,
    });
    expect(managed.idle).toBe(false);
    expect(managed.active.managedRuns).toHaveLength(1);

    const owned = evaluateUpdateIdleWindow({
      lanes: [],
      terminalSessions: [],
      managedRuns: [],
      ownedSessions: [{ surfaceId: 'codex-owned:live', pid: 42, tmuxSession: null }],
      terminalInventoryAvailable: true,
    });
    expect(owned.idle).toBe(false);
    expect(owned.active.ownedSessions).toEqual([
      { surfaceId: 'codex-owned:live', pid: 42, tmuxSession: null },
    ]);
  });

  it('reports idle when only terminal lanes and detached shells remain', () => {
    const result = evaluateUpdateIdleWindow({
      lanes: [
        { id: 'done', label: 'Done lane', status: 'completed', runtime: 'codex', sessionKey: null },
      ],
      terminalSessions: [terminalSession],
      managedRuns: [],
      ownedSessions: [],
      terminalInventoryAvailable: true,
    });
    expect(result.idle).toBe(true);
  });
});

describe('readTerminalInventory', () => {
  it('marks its request to the local server as background, so it never keeps the idle gate awake', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'o8-idle-window-'));
    vi.stubEnv('O8_DATA_DIR', dataDir);
    vi.stubEnv('CORTEX_IDE_DATA_DIR', dataDir);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ sessions: [] }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(readTerminalInventory()).resolves.toEqual({ available: true, sessions: [] });
      const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
      expect(new Headers(init?.headers).get('x-o8-background')).toBe('1');
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});
