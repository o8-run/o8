import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-cortex-worker-authz-'));
const operatorToken = 'operator-cortex-observation-token-0123456789';
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
writeFileSync(path.join(dataDir, 'ws-token'), `${operatorToken}\n`, 'utf8');

const [{ panelGateMiddleware }, proposalsRoute, packetTokens, laneRegistry, proposals] = await Promise.all([
  import('@/middleware'),
  import('@/app/api/cortex/proposals/route'),
  import('@/lib/auth/packet-worker-token'),
  import('@/lib/lane/registry'),
  import('@/lib/cortex/proposals'),
]);

const packetA = `pkt-cortex-a-${Date.now()}`;
const packetB = `pkt-cortex-b-${Date.now()}`;
const laneA = laneRegistry.createLane({
  repoPath: '/tmp/o8-cortex-worker-authz',
  branch: 'agent/cortex-a',
  runtime: 'codex',
  packetId: packetA,
});
const laneB = laneRegistry.createLane({
  repoPath: '/tmp/o8-cortex-worker-authz',
  branch: 'agent/cortex-b',
  runtime: 'codex',
  packetId: packetB,
});
const workerTokenA = packetTokens.mintPacketWorkerToken(packetA);

function request(body: Record<string, unknown>, token: string | null = workerTokenA): NextRequest {
  const headers: Record<string, string> = {
    host: 'localhost:3001',
    'content-type': 'application/json',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return new NextRequest('http://localhost:3001/api/cortex/proposals', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function observation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'propose_observation',
    packetId: packetA,
    laneId: laneA.id,
    proposed_by: 'spoofed-author',
    kind: 'gotcha',
    scope: 'packet',
    text: 'Worker observation real-path fixture.',
    ...overrides,
  };
}

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('packet worker Cortex observation authorization through the real route', () => {
  it('admits the worker at middleware, binds authorship to its packet, and persists the proposal', async () => {
    const workerRequest = request(observation());
    expect(panelGateMiddleware(workerRequest).status).toBe(200);

    const response = await proposalsRoute.POST(workerRequest);
    expect(response.status).toBe(200);
    const payload = await response.json() as { proposal: { id: string; proposed_by: string } };
    expect(payload.proposal.proposed_by).toBe(packetA);
    expect(proposals.readObservationProposals()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: payload.proposal.id,
        packetId: packetA,
        laneId: laneA.id,
        proposed_by: packetA,
      }),
    ]));
  });

  it('denies cross-packet and cross-lane worker proposals without persisting either', async () => {
    const before = proposals.readObservationProposals().length;
    const packetMismatch = await proposalsRoute.POST(request(observation({
      packetId: packetB,
      laneId: laneB.id,
      text: 'Cross-packet attempt.',
    })));
    expect(packetMismatch.status).toBe(403);
    await expect(packetMismatch.json()).resolves.toMatchObject({
      error: { code: 'worker_packet_mismatch' },
    });

    const laneMismatch = await proposalsRoute.POST(request(observation({
      laneId: laneB.id,
      text: 'Cross-lane attempt.',
    })));
    expect(laneMismatch.status).toBe(403);
    await expect(laneMismatch.json()).resolves.toMatchObject({
      error: { code: 'worker_lane_mismatch' },
    });
    expect(proposals.readObservationProposals()).toHaveLength(before);
  });

  it('keeps proposal dismissal operator-only', async () => {
    const proposal = proposals.readObservationProposals()[0];
    const workerDismiss = await proposalsRoute.POST(request({
      action: 'dismiss_observation',
      id: proposal.id,
    }));
    expect(workerDismiss.status).toBe(403);
    expect(proposals.readObservationProposals()).toContainEqual(expect.objectContaining({ id: proposal.id }));

    const operatorDismiss = await proposalsRoute.POST(request({
      action: 'dismiss_observation',
      id: proposal.id,
    }, operatorToken));
    expect(operatorDismiss.status).toBe(200);
    expect(proposals.readObservationProposals()).not.toContainEqual(expect.objectContaining({ id: proposal.id }));
  });

  it('refuses an unauthenticated non-loopback-Host mutation at the Host gate (421, #4814)', () => {
    const remote = new NextRequest('http://192.0.2.20:3001/api/cortex/proposals', {
      method: 'POST',
      headers: { host: '192.0.2.20:3001', 'content-type': 'application/json' },
      body: JSON.stringify(observation()),
    });
    // A non-loopback Host is refused at the middleware Host gate before auth.
    expect(panelGateMiddleware(remote).status).toBe(421);
  });

  it('keeps an unauthenticated loopback mutation denied at the auth gate (401)', () => {
    // Allowed Host, no principal: refused at the bearer gate, not the Host gate.
    expect(panelGateMiddleware(request(observation(), null)).status).toBe(401);
  });
});
