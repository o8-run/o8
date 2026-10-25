import type { SurfaceContext, SurfaceRoutes } from '../surface-routes';

export default async function register({ repo }: SurfaceContext): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--workers')) return {};
  const { createLane, setLaneStatus, appendEvent } = await import('../../../src/lib/lane/registry');
  const { createEmptyOrchestratorMissionState } = await import('../../../src/lib/orchestrator/store');
  const { writeOrchestratorControlPlaneState } = await import('../../../src/lib/orchestrator/control-plane');
  const { getSqlite } = await import('../../../src/lib/db');
  const packets = [];
  const laneIds: Record<string, string> = {};
  const calls: string[] = [];
  for (const [suffix, status, laneStatus] of [
    ['running', 'running', 'running'], ['review', 'awaiting_review', 'reviewing'],
    ['blocked', 'blocked', 'awaiting_orchestrator'],
  ] as const) {
    const id = `worker-${suffix}`;
    const lane = createLane({ repoPath: repo, branch: id, runtime: 'pi', packetId: id,
      sessionKey: `fixture:${id}`, label: `Task ${suffix}` });
    laneIds[id] = lane.id;
    setLaneStatus(lane.id, laneStatus, 'system', suffix === 'blocked' ? 'file_owned' : 'fixture_ready');
    for (const [index, message] of ['Read the task', 'Inspect the working tree', 'Check ownership'].entries()) {
      const event = appendEvent(lane.id, 'agent_report', 'system', { event: 'progress', message });
      // Recorded order is explicit; UUID ordering must not decide same-ms steps.
      getSqlite().prepare('UPDATE lane_events SET timestamp = ? WHERE id = ?')
        .run(new Date(Date.now() - 100 + index).toISOString(), event.id);
    }
    packets.push({ id, referenceLabel: `Task ${packets.length + 1}`, title: suffix === 'blocked' ? 'Resolve the shared file' : `Task ${suffix}`,
      summary: 'Fixture task', workspaceTargetPath: repo, branchTarget: id, runtime: 'pi' as const,
      dependencyLabels: [], dependencyPacketIds: [], queueState: suffix === 'blocked' ? 'held' as const : 'queued' as const, releaseState: 'pending' as const,
      status, blockedReason: suffix === 'blocked' ? 'The file is already owned by another worker. Choose how to continue.' : null,
      lane: null, review: null, attemptCount: 1 });
  }
  writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), missionId: 'workers-fixture',
    repoPath: repo, packets, updatedAt: new Date().toISOString() });
  const lanes = await import('../../../src/app/api/lanes/route');
  const state = await import('../../../src/app/api/orchestrator/state/route');
  const activity = await import('../../../src/app/api/lanes/[id]/events/route');
  const events = await import('../../../src/app/api/orchestrator/lane-events/route');
  return { priority: 10, match: (method, path) => {
    const id = /^\/api\/lanes\/([^/]+)\/events$/.exec(path)?.[1];
    return method === 'GET' && id && Object.values(laneIds).includes(id)
      ? request => activity.GET(request, { params: Promise.resolve({ id }) }) : undefined;
  }, before: ({ method, url }) => { calls.push(`${method} ${url.pathname}${url.search}`); }, routes: {
    'GET /api/orchestrator/state': state.GET,
    'GET /api/workers-fixture': async request => {
      if (request.nextUrl.searchParams.has('block')) setLaneStatus(laneIds['worker-running'], 'awaiting_orchestrator', 'system', 'file_owned');
      return Response.json({ calls, laneIds });
    },
    'GET /api/lanes': lanes.GET,
    'GET /api/orchestrator/lane-events': events.GET,
  } };
}
