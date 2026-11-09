import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

// A packet worker reads only its own lane's inbox. Once that lane has ended, the worker has no
// inbox of its own to read, so the inbox refuses it like the message and presence paths do,
// and another agent's messages stay unread.
const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-agent-inbox-active-lane-'));
const OPERATOR_TOKEN = 'agent-inbox-active-lane-operator-0123456789';
writeFileSync(join(dataDir, 'ws-token'), `${OPERATOR_TOKEN}\n`, 'utf8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { createLane, archiveLane } = await import('@/lib/lane/registry');
const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
const { closeDb } = await import('@/lib/db');
const presenceRoute = await import('@/app/api/agents/presence/route');
const inboxRoute = await import('@/app/api/agents/inbox/route');
const { createAgentMessagePostHandler } = await import('@/lib/agents/message-route-handler');
const { panelGateMiddleware } = await import('@/middleware');

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

function request(path: string, token: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3001${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      host: 'localhost:3001',
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

it('refuses the inbox to a packet worker whose lane has ended', async () => {
  const repoPath = join(dataDir, 'repo');
  const lane = createLane({ repoPath, branch: 'fixture-inbox-ended', runtime: 'codex', packetId: 'fixture-inbox-ended' });
  const workerToken = mintPacketWorkerToken('fixture-inbox-ended');
  const joined = await presenceRoute.POST(request('/api/agents/presence', OPERATOR_TOKEN, {
    agentId: 'fixture-inbox-receiver', name: 'Receiver', repo: repoPath,
    worktreePath: join(repoPath, 'receiver'), runtime: 'claude-code', sessionKey: 'claude-code:fixture-inbox-receiver',
  }));
  expect(joined.status).toBe(201);
  // Live delivery fails, so the message waits in the receiver's inbox until it is read.
  const postMessage = createAgentMessagePostHandler(
    { sendClaude: async () => { throw new Error('fixture: no live input'); }, sendCodex: async () => true },
    { discoverSessions: async () => [], resolveRepoPath: async () => null, now: () => new Date() },
  );
  const sent = await postMessage(request('/api/agents/message', OPERATOR_TOKEN,
    { from: 'operator', to: 'Receiver', repo: repoPath, text: 'For the receiver only.' }));
  expect(sent.status).toBe(201);

  expect(archiveLane(lane.id, 'user')?.status).toBe('archived');
  for (const path of ['/api/agents/inbox?agentId=fixture-inbox-receiver', '/api/agents/inbox?agent=Receiver', '/api/agents/inbox']) {
    const worker = request(path, workerToken);
    expect(panelGateMiddleware(worker).headers.get('x-middleware-next'), path).toBe('1');
    const response = await inboxRoute.GET(worker);
    expect(response.status, path).toBe(404);
    expect(await response.json(), path).toMatchObject({ error: { code: 'agent_bus_lane_not_found' } });
  }

  // The receiver's message was neither read nor acknowledged by the refused worker.
  const receiver = await inboxRoute.GET(request('/api/agents/inbox?agentId=fixture-inbox-receiver', OPERATOR_TOKEN));
  expect(receiver.status).toBe(200);
  expect((await receiver.json()).messages).toEqual([expect.objectContaining({ text: 'For the receiver only.' })]);
});
