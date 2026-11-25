// A fresh HTTP host for the production middleware, routes, registry and startup
// reconciler. Only the external provider executable is substituted by the test.
import { createServer } from 'node:http';
import { join } from 'node:path';
import { NextRequest, NextResponse } from 'next/server';

async function main() {
  const { panelGateMiddleware } = await import('../../src/middleware');
  const launch = await import('../../src/app/api/runtime/launch/route');
  const action = await import('../../src/app/api/runtime/action/route');
  const transcript = await import('../../src/app/api/runtime/transcript/route');
  const registry = await import('../../src/lib/lane/registry');
  const { reconcileStuckLanes } = await import('../../src/lib/lane/reconcile');
  const { probeLaneSessionAlive } = await import('../../src/lib/lane/owned-session-liveness');
  const { getOwnedCodexRuntimeTail, getOwnedCodexFleetAdditions, sweepOrphanedCodexSessions } = await import('../../src/lib/codex/owned');
  const claude = await import('../../src/lib/claude-code/owned');
  const runtimeId = process.env.O8_RESTART_FIXTURE_RUNTIME === 'claude-code' ? 'claude-code' : 'codex';
  const readFleet = runtimeId === 'claude-code' ? claude.getOwnedClaudeCodeFleetAdditions : getOwnedCodexFleetAdditions;
  const readTail = runtimeId === 'claude-code' ? claude.getOwnedClaudeCodeRuntimeTail : getOwnedCodexRuntimeTail;
  const { updateOperatorDefaults } = await import('../../src/lib/operator/defaults');
  const { getOrCreateWsToken } = await import('../../src/lib/ws-auth');
  const { writeOrchestratorControlPlaneState } = await import('../../src/lib/orchestrator/control-plane');
  const { createEmptyOrchestratorMissionState, normalizeOrchestratorMissionState } = await import('../../src/lib/orchestrator/store');
  await import('../../src/lib/runtimes');
  await updateOperatorDefaults({ storageReserveRatio: 0.0001,
    storageReserveFloorGb: 0.001 });
  const server = createServer(async (incoming, outgoing) => {
    try {
      let body = '';
      for await (const chunk of incoming) body += String(chunk);
      const request = new NextRequest(`http://127.0.0.1:${port}${incoming.url}`, {
        method: incoming.method, headers: new Headers(incoming.headers as Record<string, string>),
        ...(body ? { body } : {}),
      });
      const gate = panelGateMiddleware(request);
      let response: Response = gate;
      if (gate.headers.get('x-middleware-next') === '1') {
        const path = request.nextUrl.pathname;
        if (path === '/api/setup/status') response = NextResponse.json({ ready: true });
        else if (path === '/api/runtime/launch') {
          const payload = await request.clone().json();
          response = await launch.POST(request);
          const result = await response.clone().json();
          // The production lane command caller binds the returned session after
          // launchRuntimeSurface. Exercise that registry write, without seeding
          // an owned-session record or replacing the runtime implementation.
          if (result.ok && payload.existingLaneId && !registry.getLane(payload.existingLaneId)?.sessionKey) {
            registry.attachSession(payload.existingLaneId, result.surfaceId, 'system');
            registry.setLaneStatus(payload.existingLaneId, 'running', 'system');
          }
        }
        else if (path === '/api/runtime/action') response = await action.POST(request);
        else if (path === '/api/runtime/transcript') response = await transcript.GET(request);
        else if (path === '/api/fixture/lane') {
          const payload = body ? JSON.parse(body) : {};
          const packetId = payload.packetId ?? 'pkt-restart-fixture';
          const branch = payload.branch ?? 'inline/restart-fixture';
          const repoPath = join(process.env.O8_RESTART_FIXTURE_ROOT!, 'repo');
          const lane = registry.createLane({ repoPath, branch, baseBranch: 'main',
            runtime: runtimeId, packetId, label: 'Restart fixture' });
          registry.setLaneStatus(lane.id, 'launching', 'system');
          writeOrchestratorControlPlaneState(normalizeOrchestratorMissionState({
            ...createEmptyOrchestratorMissionState(), missionId: 'mission-restart-fixture', repoPath,
            packets: [{ id: packetId, title: 'Restart fixture', summary: 'Offline packet restart',
              status: 'running', queueState: 'running', releaseState: 'released', runtime: runtimeId,
              workMode: 'edit', workspaceTargetPath: repoPath, branchTarget: lane.branch }],
          }));
          response = NextResponse.json(lane);
        } else if (path === '/api/fixture/fleet') {
          await readFleet({ fresh: true });
          response = NextResponse.json({ ok: true });
        } else if (path === '/api/fixture/sweep') {
          response = NextResponse.json({ archived: await sweepOrphanedCodexSessions(new Set(), -1) });
        } else if (path === '/api/fixture/state') {
          const surface = request.nextUrl.searchParams.get('surface')!;
          let lifecycleError: string | undefined;
          try { await readFleet({ fresh: true }); } catch (error) { lifecycleError = String(error); }
          let tail: unknown;
          try { tail = await readTail(surface); } catch (error) { tail = { error: String(error) }; }
          const lane = registry.getLane(request.nextUrl.searchParams.get('lane')!);
          response = NextResponse.json({ lane, tail, lifecycleError, alive: lane ? await probeLaneSessionAlive(lane) : null });
        } else response = NextResponse.json({ ok: true });
      }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { outgoing.writeHead(500); outgoing.end(JSON.stringify({ error: String(error) })); }
  });
  let port = 0;
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
  process.env.O8_API_PORT = String(port);
  getOrCreateWsToken();
  await reconcileStuckLanes();
  process.send?.({ port, pid: process.pid });
  process.on('SIGTERM', () => { server.close(() => process.exit(0)); server.closeAllConnections(); });
}
void main().catch(error => { console.error(error); process.exit(1); });
