import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';

// The gate lets a packet worker report on and block a task. The worker may do that only for its
// own packet's task, and under the CLI's actor, so it cannot block another packet's work or speak
// as the operator. The operator keeps both.
const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-task-mutation-worker-'));
const OPERATOR_TOKEN = 'task-mutation-worker-operator-0123456789';
const LEGACY_WORKER_TOKEN = 'task-mutation-worker-legacy-0123456789';
writeFileSync(join(dataDir, 'ws-token'), `${OPERATOR_TOKEN}\n`, 'utf8');
writeFileSync(join(dataDir, 'worker-token'), LEGACY_WORKER_TOKEN, 'utf8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { createLane, getLane, getLaneEvents } = await import('@/lib/lane/registry');
const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
const { withLockedState } = await import('@/lib/orchestrator/control-plane');
const { closeDb } = await import('@/lib/db');
const reportRoute = await import('@/app/api/tasks/[taskId]/report/route');
const blockRoute = await import('@/app/api/tasks/[taskId]/block/route');
const { panelGateMiddleware } = await import('@/middleware');

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

// A loopback caller, as Next's bundled server stamps it, through the real gate and then the route.
async function mutate(action: 'report' | 'block', taskId: string, token: string, body: Record<string, unknown>) {
  const init = {
    method: 'POST',
    headers: {
      host: 'localhost:3001', 'x-o8-client-addr': '127.0.0.1',
      authorization: `Bearer ${token}`, 'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  };
  const url = `http://localhost:3001/api/tasks/${taskId}/${action}`;
  const gate = panelGateMiddleware(new NextRequest(url, init));
  if (gate.headers.get('x-middleware-next') !== '1') return gate;
  const route = action === 'report' ? reportRoute : blockRoute;
  return route.POST(new NextRequest(url, init), { params: Promise.resolve({ taskId }) });
}

it('lets a packet worker report and block only its own task, under the CLI actor', async () => {
  const repoPath = join(dataDir, 'repo');
  await withLockedState((state) => {
    for (const id of ['fixture-task-own', 'fixture-task-other']) {
      state.packets.push({ id, title: id, summary: 'fixture', workspaceTargetPath: repoPath } as OrchestratorPacket);
    }
    return state;
  });
  const own = createLane({ repoPath, branch: 'fixture-task-own', runtime: 'codex', packetId: 'fixture-task-own' });
  const other = createLane({ repoPath, branch: 'fixture-task-other', runtime: 'codex', packetId: 'fixture-task-other' });
  const otherStatus = getLane(other.id)!.status;
  const worker = mintPacketWorkerToken('fixture-task-own');

  // Another packet's task: refused before any lane or packet changes.
  for (const [action, body] of [
    ['block', { reason: 'fixture blocks a neighbour', actor: 'user' }],
    ['report', { event: 'question', message: 'fixture asks as the operator', actor: 'user' }],
  ] as const) {
    const refused = await mutate(action, 'fixture-task-other', worker, body);
    expect(refused.status, action).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: 'worker_packet_mismatch' } });
  }
  expect(getLane(other.id)!.status).toBe(otherStatus);
  expect(getLaneEvents(other.id).filter(event => event.verb === 'agent_report')).toEqual([]);
  const legacy = await mutate('block', 'fixture-task-own', LEGACY_WORKER_TOKEN, { reason: 'fixture legacy block' });
  expect(legacy.status).toBe(403);

  // Its own task: accepted, and the actor it sent is replaced by the CLI's.
  const reported = await mutate('report', 'fixture-task-own', worker,
    { event: 'progress', message: 'fixture progress', actor: 'user' });
  expect(reported.status).toBe(200);
  const blocked = await mutate('block', 'fixture-task-own', worker, { reason: 'fixture needs input', actor: 'user' });
  expect(blocked.status).toBe(200);
  expect(getLane(own.id)!.status).toBe('awaiting_orchestrator');
  const ownReports = getLaneEvents(own.id).filter(event => event.verb === 'agent_report');
  expect(ownReports.map(event => [event.payload.event, event.actor])).toEqual([
    ['progress', 'orchestrator'], ['blocked', 'orchestrator'],
  ]);

  // The operator still blocks any task and names its actor.
  const operator = await mutate('block', 'fixture-task-other', OPERATOR_TOKEN, { reason: 'operator holds it', actor: 'user' });
  expect(operator.status).toBe(200);
  expect(getLane(other.id)!.status).toBe('awaiting_orchestrator');
  expect(getLaneEvents(other.id).filter(event => event.verb === 'agent_report').map(event => event.actor)).toEqual(['user']);
});
