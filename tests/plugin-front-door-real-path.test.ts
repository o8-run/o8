import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { handleNativeHttp } from '@/lib/ws-server/native-http-routes';
import { forwardToNext, registeredFrontDoorRoute } from '@/lib/ws-server/api-front-door';
import { pluginReplayAuthorization, type PluginRelayGrant } from '@/lib/connect/plugin-relay';
import { replayRelayHttpRequest } from '@/lib/mobile/relay-http-replay';
import { RelayHttpRequestRegistry, type HttpReqFrame } from '@/lib/mobile/relay-connector-protocol';
import { mintPluginToken } from '@/lib/auth/plugin-token';
import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { appendPluginAudit } from '@/lib/mcp/plugin-audit';
import { writeOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { createEmptyOrchestratorMissionState } from '@/lib/orchestrator/store';
import { __resetIdempotencyStoreForTests } from '@/lib/orchestrator/idempotency-store';

// Only the worker delivery boundary is replaced. Admission, current mission
// selection, idempotency, audit, credentials and the HTTP handlers are real.
const steer = vi.hoisted(() => vi.fn(async () => ({ packetId: 'packet-plugin', note: 'accepted' })));
vi.mock('@/lib/orchestrator/operator-mission-service', () => ({ steerPacket: steer }));

let server: Server;
let origin: string;
let received: Array<{ principal: ReturnType<typeof resolveRequestPrincipalContext>; marker: string | undefined }>;
const selected = { machineId: 'machine-plugin', missionId: 'mission-plugin', packetId: 'packet-plugin' };
const grant = (scopes = ['o8:read']): PluginRelayGrant => ({ clientId: 'client-plugin', scopes, expiresAt: Date.now() + 60_000 });
function frame(name = 'o8_attention', args: Record<string, unknown> = { machineId: selected.machineId }): HttpReqFrame {
  return { rid: 'fixture-call', path: '/api/plugins/mcp', method: 'POST',
    headers: { 'content-type': 'application/json' }, authorization: 'Bearer remote-caller-must-not-win',
    bodyB64: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).toString('base64') };
}
async function relay(request = frame(), permission = grant()) {
  const authorization = pluginReplayAuthorization(selected.machineId, permission, request);
  if (!authorization) throw new Error('Fixture grant refused before replay');
  const replies: Record<string, unknown>[] = [];
  await replayRelayHttpRequest({ sid: 'plugin-stream', request, apiBase: origin,
    authorizationOverride: authorization, requestRegistry: new RelayHttpRequestRegistry(),
    timeoutMs: 5000, maxTunnelBytes: 1024 * 1024, isStreamActive: () => true,
    send: reply => { replies.push(reply); } });
  return { status: replies[0].status, body: JSON.parse(Buffer.from(String(replies[0].bodyB64), 'base64').toString()) };
}
beforeEach(async () => {
  vi.stubEnv('O8_API_FRONT_DOOR', '1'); vi.stubEnv('O8_NEXT_O8D', '0');
  steer.mockClear(); __resetIdempotencyStoreForTests(); received = [];
  const absent = createServer();
  await new Promise<void>(resolve => absent.listen(0, '127.0.0.1', resolve));
  const next = new URL(`http://127.0.0.1:${(absent.address() as { port: number }).port}`);
  await new Promise<void>(resolve => absent.close(() => resolve()));
  server = createServer((req, res) => {
    void (async () => {
      const port = (server.address() as { port: number }).port;
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(key, value);
      received.push({ principal: resolveRequestPrincipalContext(new Request(origin + req.url, { headers })),
        marker: typeof req.headers['x-o8-relay-forward'] === 'string' ? req.headers['x-o8-relay-forward'] : undefined });
      if (registeredFrontDoorRoute(new URL(req.url!, origin).pathname, req.method!)
        && await handleNativeHttp(req, res, port, false, req.socket.remoteAddress ?? null)) return;
      forwardToNext(req, res, next, port, req.socket.remoteAddress ?? null);
    })().catch(error => res.writeHead(500).end(String(error)));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = String((server.address() as { port: number }).port);
  origin = `http://127.0.0.1:${port}`;
  for (const key of ['PORT', 'O8_API_PORT', 'O8_WS_PORT']) vi.stubEnv(key, port);
  writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), missionId: selected.missionId,
    packets: [{ id: selected.packetId, referenceLabel: 'P1', title: 'Fixture', summary: 'Working', workspaceTargetPath: null,
      branchTarget: 'fixture', runtime: 'codex', dependencyLabels: [], dependencyPacketIds: [],
      queueState: 'queued', releaseState: 'pending', status: 'running' }] });
});
afterEach(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  vi.unstubAllEnvs();
});

it('replays the plugin grant through the public handler with its scope and expiry intact', async () => {
  const permission = grant();
  const result = await relay(frame(), permission);
  expect(result.status).toBe(200);
  expect(result.body.result.structuredContent.ok).toBe(true);
  expect(result.body.result.structuredContent.tasks).toContainEqual(expect.objectContaining({ missionId: selected.missionId, packetId: selected.packetId }));
  expect(received[0]).toMatchObject({ marker: '1', principal: { role: 'plugin', clientId: permission.clientId,
    machineId: selected.machineId, scopes: permission.scopes, expiresAt: permission.expiresAt } });
  expect(steer).not.toHaveBeenCalled();
});

it('refuses the wrong scope, wrong machine and expired grants without worker delivery', async () => {
  const follow = frame('o8_follow_up', { ...selected, message: 'Fixture follow-up', idempotencyKey: 'refused' });
  expect((await relay(follow)).status).toBe(403);
  expect((await relay(frame('o8_attention', { machineId: 'other-machine' }))).status).toBe(403);
  expect(pluginReplayAuthorization(selected.machineId, { ...grant(), expiresAt: Date.now() - 1 }, frame())).toBeNull();
  expect(pluginReplayAuthorization(selected.machineId, grant(), { ...frame(), path: '/api/panel/approvals' })).toBeNull();
  const expired = mintPluginToken({ ...selected, clientId: 'client-plugin', scopes: ['o8:read'] }, { now: Date.now() - 120_000 });
  const response = await fetch(origin + '/api/plugins/mcp', { method: 'POST', headers: { authorization: `Bearer ${expired}`, 'content-type': 'application/json' }, body: '{}' });
  expect(response.status).toBe(401);
  expect(steer).not.toHaveBeenCalled();
});

it('reads the persisted audit through the public operator route and refuses a plugin bearer', async () => {
  appendPluginAudit({ at: new Date().toISOString(), actor: 'plugin', surface: 'chatgpt', clientId: 'audit-fixture',
    machineId: selected.machineId, callId: 'audit-call', tool: 'o8_attention', phase: 'finished', outcome: 'success', argumentHash: 'fixture-digest' });
  const response = await fetch(origin + '/api/plugins/audit', { headers: { authorization: `Bearer ${getOrCreateWsToken()}` } });
  expect(response.status).toBe(200);
  expect((await response.json()).events).toContainEqual(expect.objectContaining({ clientId: 'audit-fixture', callId: 'audit-call' }));
  const bearer = mintPluginToken({ machineId: selected.machineId, clientId: 'client-plugin', scopes: ['o8:read'] });
  expect((await fetch(origin + '/api/plugins/audit', { headers: { authorization: `Bearer ${bearer}` } })).status).toBe(403);
});

it('replays an idempotent follow-up receipt with exactly one worker delivery', async () => {
  const request = frame('o8_follow_up', { ...selected, message: 'Fixture follow-up', idempotencyKey: 'once-only' });
  const permission = grant(['o8:read', 'o8:follow-up']);
  const first = await relay(request, permission);
  const second = await relay(request, permission);
  expect(first.status).toBe(200); expect(second.status).toBe(200);
  const result = first.body.result.structuredContent;
  expect(result).toMatchObject({ ok: true, accepted: true, replayed: false });
  expect(second.body.result.structuredContent).toEqual({ ...result, replayed: true });
  expect(steer).toHaveBeenCalledTimes(1);
});
