import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { afterAll, expect, it } from 'vitest';
let host: ChildProcess | undefined;
afterAll(async () => {
  if (host?.exitCode === null) { host.kill('SIGTERM'); await once(host, 'exit'); }
});
it('Workers uses the production state, lanes and live event routes behind operator auth', async () => {
  host = spawn(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx',
    'scripts/next/dev-server.ts', '--workers', '--shell'], {
    env: { ...process.env, O8_NEXT_API_TOKEN: 'fixture-workers-token' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  host.stderr!.on('data', chunk => { diagnostics += String(chunk); });
  const lines = createInterface({ input: host.stdout! });
  let origin = '';
  for await (const line of lines) {
    try { origin = JSON.parse(line).origin ?? ''; } catch { continue; }
    if (origin) { lines.close(); break; }
  }
  expect(origin, diagnostics).toBeTruthy();
  const headers = { authorization: 'Bearer fixture-workers-token' };
  const lanes = await fetch(origin + '/api/lanes?active=true', { headers });
  expect(lanes.status).toBe(200);
  const laneData = await lanes.json();
  expect(laneData.lanes.map((lane: { packetId: string }) => lane.packetId).sort())
    .toEqual(['worker-blocked', 'worker-review', 'worker-running']);
  const state = await fetch(origin + '/api/orchestrator/state', { headers });
  const payload = await state.json();
  expect(payload.mission.packets.map((packet: { id: string }) => packet.id).sort())
    .toEqual(['worker-blocked', 'worker-review', 'worker-running']);
  expect(payload.mission.packets.map((packet: { status: string }) => packet.status))
    .toEqual(['running', 'awaiting_review', 'blocked']);
  const events = await fetch(origin + '/api/orchestrator/lane-events?since=0&timeoutMs=0', { headers });
  expect(events.status).toBe(200);
  expect((await events.json()).events.length).toBeGreaterThan(0);
  const blocked = laneData.lanes.find((lane: { packetId: string }) => lane.packetId === 'worker-blocked');
  const activity = await fetch(origin + `/api/lanes/${blocked.id}/events?since=0&limit=500`, { headers });
  expect(activity.status).toBe(200);
  const activityData = await activity.json();
  expect(activityData.events.filter((event: { payload: { message?: string } }) => event.payload.message).map((event: { payload: { message: string } }) => event.payload.message))
    .toEqual(['Read the task', 'Inspect the working tree', 'Check ownership']);
  expect((await fetch(origin + '/api/lanes?active=true')).status).toBe(401);
}, 60_000);
