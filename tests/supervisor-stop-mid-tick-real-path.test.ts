import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentStatusEntry, SupervisorCallbacks } from '@/lib/supervisor/agent-supervisor-types';

const saved = { ...process.env };
afterEach(() => {
  vi.useRealTimers();
  for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
  Object.assign(process.env, saved);
});

// Two module instances on one SQLite file stand in for the WS process, which runs the supervisor
// loop, and Next, which serves stop and archive. A stop that lands while a heartbeat waits on the
// fleet status must keep that heartbeat from acting on the lane: no relaunch, steer, interrupt,
// escalation or completion report for a lane the operator already stopped.
it('never acts on a lane another process unregistered during the heartbeat', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-supervisor-stop-tick-')));
  const repo = join(directory, 'repo');
  mkdirSync(repo);
  Object.assign(process.env, { HOME: directory, CORTEX_IDE_DATA_DIR: directory, CORTEX_IDE_DB_PATH: join(directory, 'cortex-ide.db') });
  delete process.env.O8_DATA_DIR;
  let ws: typeof import('@/lib/supervisor/agent-supervisor') | undefined;
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.resetModules();
    ws = await import('@/lib/supervisor/agent-supervisor');
    vi.resetModules();
    const next = await import('@/lib/supervisor/agent-supervisor');
    const { getSqlite } = await import('@/lib/db');
    const rows = () => (getSqlite().prepare('SELECT surface_id FROM watched_agents ORDER BY surface_id').all() as Array<{ surface_id: string }>)
      .map(row => row.surface_id);

    // Each stopped lane would reach a different action on this heartbeat; the live lane is the
    // control that proves the heartbeat still steers a lane nobody stopped.
    const fleet: Record<string, AgentStatusEntry['status']> = {
      'surface-retry': 'failed', 'surface-steer': 'running', 'surface-interrupt': 'running',
      'surface-exhausted': 'failed', 'surface-finished': 'idle', 'surface-live': 'running',
    };
    for (const surfaceId of Object.keys(fleet)) ws.registerWatchedAgent(surfaceId, repo, surfaceId, 'Work.');
    const watch = (surfaceId: string) => ws!.getWatchedAgents().find(agent => agent.surfaceId === surfaceId)!;
    watch('surface-interrupt').steerCount = 2;
    watch('surface-exhausted').retryCount = 1;
    watch('surface-finished').tentativeFinishedSince = Date.now();
    // Past the first steer threshold and the completion grace, so every lane is due and stale.
    vi.setSystemTime(Date.now() + 7 * 60 * 1000);

    const acted: string[] = [];
    // The heartbeat waits on this held fleet answer.
    let answer!: (entries: AgentStatusEntry[]) => void;
    let asked = false;
    const held = new Promise<AgentStatusEntry[]>(resolve => { answer = resolve; });
    const callbacks: SupervisorCallbacks = {
      fetchFleetStatus: () => { asked = true; return held; },
      fetchTranscript: async () => [],
      steerAgent: async surfaceId => { acted.push(`steer ${surfaceId}`); },
      interruptAgent: async surfaceId => { acted.push(`interrupt ${surfaceId}`); },
      relaunchAgent: async (_prompt, _repo, _name, retryOf) => { acted.push(`relaunch ${retryOf}`); return { status: 'held', reason: 'fixture' }; },
      broadcastAgentUpdate: update => { acted.push(`broadcast ${update.surfaceId}`); },
      queueOrchestratorEscalation: (_repo, message) => { acted.push(`escalate ${/\((surface-[a-z]+)\)/.exec(message)?.[1]}`); },
      onAgentCompletion: async surfaceId => { acted.push(`complete ${surfaceId}`); return undefined; },
    };
    ws.startSupervisorLoop(callbacks);
    const tick = ws.runSupervisorTickForTesting();
    // The heartbeat asks for the fleet synchronously; no timer runs, so the loop's own tick never starts.
    expect(asked).toBe(true);

    // The operator stops five lanes from Next while the heartbeat waits on the fleet.
    const stopped = Object.keys(fleet).filter(surfaceId => surfaceId !== 'surface-live');
    for (const surfaceId of stopped) next.unregisterWatchedAgent(surfaceId);
    answer(Object.entries(fleet).map(([sessionKey, status]) => ({ sessionKey, status }) as AgentStatusEntry));
    await tick;

    expect(acted.filter(action => stopped.some(surfaceId => action.endsWith(` ${surfaceId}`)))).toEqual([]);
    expect(acted).toContain('steer surface-live');
    expect(rows()).toEqual(['surface-live']);
    expect(ws.getWatchedAgents().map(agent => agent.surfaceId)).toEqual(['surface-live']);
  } finally {
    ws?.stopSupervisorLoop();
    rmSync(directory, { recursive: true, force: true });
  }
});
