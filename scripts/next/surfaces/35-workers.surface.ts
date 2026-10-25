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
    ...(process.argv.includes('--workers-navigation') ? [['running-next', 'running', 'running'] as const] : []),
  ] as const) {
    const id = `worker-${suffix}`;
    const lane = createLane({ repoPath: repo, branch: id, runtime: 'pi', packetId: id,
      sessionKey: `fixture:${id}`, label: `Task ${suffix}` });
    laneIds[id] = lane.id;
    setLaneStatus(lane.id, laneStatus, 'system', suffix === 'blocked' ? 'file_owned' : 'fixture_ready');
    const messages = process.argv.includes('--workers-long-activity')
      ? Array.from({ length: 515 }, (_, index) => `Progress ${index + 1}`)
      : ['Read the task', 'Inspect the working tree', 'Check ownership'];
    const recordedAt = Date.now() - 2_000;
    for (const [index, message] of messages.entries()) {
      const event = appendEvent(lane.id, 'agent_report', 'system', { event: 'progress', message });
      // Recorded order is explicit; UUID ordering must not decide same-ms steps.
      getSqlite().prepare('UPDATE lane_events SET timestamp = ? WHERE id = ?')
        .run(new Date(recordedAt + index).toISOString(), event.id);
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
  const detail = await import('../../../src/app/api/lanes/[id]/route');
  const events = await import('../../../src/app/api/orchestrator/lane-events/route');
  return { priority: 10, match: (method, path) => {
    const match = /^\/api\/lanes\/([^/]+)(\/events)?$/.exec(path);
    if (method !== 'GET' || !match || !Object.values(laneIds).includes(match[1])) return undefined;
    const id = match[1];
    return request => (match[2] ? activity : detail).GET(request, { params: Promise.resolve({ id }) });
  }, before: ({ method, url }) => { calls.push(`${method} ${url.pathname}${url.search}`); }, routes: {
    'GET /api/orchestrator/state': state.GET,
    'GET /api/workers-fixture': async request => {
      if (request.nextUrl.searchParams.has('block')) setLaneStatus(laneIds['worker-running'], 'awaiting_orchestrator', 'system', 'file_owned');
      if (request.nextUrl.searchParams.has('progress')) appendEvent(laneIds['worker-blocked'], 'agent_report', 'system', { event: 'progress', message: 'Progress after refresh' });
      return Response.json({ calls, laneIds });
    },
    'GET /api/lanes': lanes.GET,
    'GET /api/orchestrator/lane-events': events.GET,
  } };
}
