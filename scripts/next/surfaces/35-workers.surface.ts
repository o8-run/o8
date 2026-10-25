import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SurfaceContext, SurfaceRoutes } from '../surface-routes';

export default async function register({ repo }: SurfaceContext): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--workers')) return {};
  const { createLane, setLaneStatus, appendEvent } = await import('../../../src/lib/lane/registry');
  const { createEmptyOrchestratorMissionState } = await import('../../../src/lib/orchestrator/store');
  const { writeOrchestratorControlPlaneState } = await import('../../../src/lib/orchestrator/control-plane');
  const { getSqlite } = await import('../../../src/lib/db');
  const { execFileSync } = await import('../../../src/lib/providers/child-process');
  execFileSync('git', ['branch', '-M', 'main'], { cwd: repo });
  writeFileSync(join(repo, 'shared.txt'), 'Original shared file\n');
  execFileSync('git', ['add', 'shared.txt'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture base'], { cwd: repo });
  writeFileSync(join(repo, 'shared.txt'), 'Shared file under review\n');
  const { getRuntime } = await import('../../../src/lib/runtimes');
  const { invalidateRuntimeInventoryCache } = await import('../../../src/lib/runtime/inventory');
  const runtime = getRuntime('pi')!;
  const discovery = runtime.discoverSessions;
  const resume = runtime.resume;
  const bodies: unknown[] = [];
  const deliveries: Array<{ sessionKey: string; message: string }> = [];
  let drop = false;
  const packets = [];
  const laneIds: Record<string, string> = {};
  const calls: string[] = [];
  for (const [suffix, status, laneStatus] of [
    ['running', 'running', 'running'], ['review', 'awaiting_review', 'reviewing'],
    ['blocked', 'blocked', 'awaiting_orchestrator'],
    ...(process.argv.includes('--workers-navigation') ? [
      ['running-next', 'running', 'running'] as const,
      ['running-third', 'running', 'running'] as const,
    ] : []),
  ] as const) {
    const id = `worker-${suffix}`;
    const lane = createLane({ repoPath: repo, branch: id, runtime: 'pi', packetId: id,
      worktreePath: repo, baseBranch: 'main', sessionKey: `fixture:${id}`, label: `Task ${suffix}` });
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
      dependencyLabels: [], dependencyPacketIds: [], queueState: 'queued' as const, releaseState: 'pending' as const,
      status, blockedReason: suffix === 'blocked' ? 'The file is already owned by another worker. Choose how to continue.' : null,
      lane: null, review: null, attemptCount: 1 });
  }
  writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), missionId: 'workers-fixture',
    repoPath: repo, packets, updatedAt: new Date().toISOString() });
  const lanes = await import('../../../src/app/api/lanes/route');
  const state = await import('../../../src/app/api/orchestrator/state/route');
  const activity = await import('../../../src/app/api/lanes/[id]/events/route');
  const detail = await import('../../../src/app/api/lanes/[id]/route');
  const diff = await import('../../../src/app/api/worktrees/diff/route');
  const steer = await import('../../../src/app/api/orchestrator/steer-packet/route');
  const events = await import('../../../src/app/api/orchestrator/lane-events/route');
  return { priority: 10,
    match: (method, path) => {
      const match = /^\/api\/lanes\/([^/]+)(\/events)?$/.exec(path);
      if (method !== 'GET' || !match || !Object.values(laneIds).includes(match[1])) return undefined;
      const id = match[1];
      return request => (match[2] ? activity : detail).GET(request, { params: Promise.resolve({ id }) });
    },
    admit: ({ body, url }) => !body || url.pathname === '/api/orchestrator/steer-packet'
      && Object.hasOwn(laneIds, JSON.parse(body).packetId) ? 200 : 400,
    before: ({ method, url, body }) => {
      calls.push(`${method} ${url.pathname}${url.search}`);
      if (method === 'POST' && url.pathname === '/api/orchestrator/steer-packet') {
        const value = JSON.parse(body); bodies.push(value);
        // Only the external runtime boundary is authored; route, queue, provenance
        // and idempotency persist through the production service and database.
        runtime.discoverSessions = async () => [{ sessionKey: `fixture:${value.packetId}`, runtimeId: 'pi',
          displayName: 'Fixture worker', cwd: repo, branch: value.packetId, status: 'idle', ownership: 'owned',
          sessionCapabilities: { canSendInput: true, canInterrupt: false, canReviewDiffs: true }, lastActivityAt: new Date() }];
        runtime.resume = async (sessionKey, message) => {
          deliveries.push({ sessionKey, message }); return { ok: true, note: 'Fixture accepted', sessionKey };
        };
        invalidateRuntimeInventoryCache();
      }
    },
    after: ({ method, url }, response) => {
      if (method === 'POST' && url.pathname === '/api/orchestrator/steer-packet') {
        runtime.discoverSessions = discovery; runtime.resume = resume; invalidateRuntimeInventoryCache();
        if (drop && response.ok) { drop = false; return true; }
      }
      return false;
    },
    routes: {
      'GET /api/orchestrator/state': state.GET,
      'GET /api/workers-fixture': async request => {
        if (request.nextUrl.searchParams.has('block')) setLaneStatus(laneIds['worker-running'], 'awaiting_orchestrator', 'system', 'file_owned');
        if (request.nextUrl.searchParams.has('drop')) drop = true;
        if (request.nextUrl.searchParams.has('progress')) appendEvent(laneIds['worker-blocked'], 'agent_report', 'system', { event: 'progress', message: 'Progress after refresh' });
        return Response.json({ calls, laneIds, repo, bodies, deliveries });
      },
      'GET /api/lanes': lanes.GET,
      'GET /api/orchestrator/lane-events': events.GET,
      'GET /api/worktrees/diff': diff.GET,
      'POST /api/orchestrator/steer-packet': steer.POST,
    },
  };
}
