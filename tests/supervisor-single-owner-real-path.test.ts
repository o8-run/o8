import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { SupervisorCallbacks } from '@/lib/supervisor/agent-supervisor-types';

type Supervisor = typeof import('@/lib/supervisor/agent-supervisor');

const saved = { ...process.env };
afterEach(() => {
  vi.useRealTimers();
  for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
  Object.assign(process.env, saved);
});

// Two module instances on one SQLite file stand in for the two processes: the WS process runs
// the supervisor loop, and Next serves stop, reset, rerun and retry. Only the shared row is common.
it('drops a watch from the WS loop when another process unregisters it', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-supervisor-owner-')));
  const repo = join(directory, 'repo');
  mkdirSync(repo);
  Object.assign(process.env, { HOME: directory, CORTEX_IDE_DATA_DIR: directory, CORTEX_IDE_DB_PATH: join(directory, 'cortex-ide.db') });
  delete process.env.O8_DATA_DIR;
  let ws: Supervisor | undefined;
  try {
    vi.resetModules();
    ws = await import('@/lib/supervisor/agent-supervisor');
    vi.resetModules();
    const next = await import('@/lib/supervisor/agent-supervisor');
    const { getSqlite } = await import('@/lib/db');
    const rows = () => (getSqlite().prepare('SELECT surface_id FROM watched_agents ORDER BY surface_id').all() as Array<{ surface_id: string }>)
      .map(row => row.surface_id);
    const watching = () => ws!.getWatchedAgents().map(agent => agent.surfaceId).sort();

    ws.registerWatchedAgent('surface-live', repo, 'Live lane', 'Keep going.');
    ws.registerWatchedAgent('surface-stopped', repo, 'Stopped lane', 'Stop me.');
    expect([rows(), next.getWatchedAgents()]).toEqual([['surface-live', 'surface-stopped'], []]);

    // Next's map never held the watch, yet its unregister must still end it.
    next.unregisterWatchedAgent('surface-stopped');
    expect(rows()).toEqual(['surface-live']);

    // The WS loop's next heartbeat drops its copy and never acts on the stopped lane again.
    const acted: string[] = [];
    const callbacks: SupervisorCallbacks = {
      fetchFleetStatus: async () => ['surface-live', 'surface-stopped'].map(sessionKey => ({ sessionKey, status: 'running' }) as never),
      fetchTranscript: async () => [],
      steerAgent: async (surfaceId) => { acted.push(`steer ${surfaceId}`); },
      interruptAgent: async (surfaceId) => { acted.push(`interrupt ${surfaceId}`); },
      relaunchAgent: async (_prompt, _repo, _name, retryOf) => { acted.push(`relaunch ${retryOf}`); return { status: 'held', reason: 'fixture' }; },
      broadcastAgentUpdate: () => {},
      queueOrchestratorEscalation: () => {},
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    ws.startSupervisorLoop(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    expect(watching()).toEqual(['surface-live']);
    expect(rows()).toEqual(['surface-live']);
    expect(acted.filter(action => action.includes('surface-stopped'))).toEqual([]);

    // A write from the loop never brings back a row another process deleted.
    next.unregisterWatchedAgent('surface-live');
    await ws.ingestAgentCompletionSignal('surface-live');
    expect([rows(), watching()]).toEqual([[], []]);
  } finally {
    ws?.stopSupervisorLoop();
    rmSync(directory, { recursive: true, force: true });
  }
});
