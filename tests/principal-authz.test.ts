/**
 * Principal capability matrix, driven through the REAL route handlers (RF-1).
 *
 * WHY THIS EXISTS — the "green tests encode the premise" gap, incident-proven.
 * The unit test src/lib/auth/principal.test.ts calls resolveRequestPrincipal()
 * with hand-built args and proves the classifier works IN ISOLATION. That is
 * exactly the premise-encoding anti-pattern: it never proves a governance route
 * actually CALLS the resolver on the path a worker takes. This suite imports each
 * mutating control-plane route module and invokes its handler with a constructed
 * Request that carries (or lacks) the local-worker token — so the assertion is
 * "the real endpoint denies the worker", not "the guard function returns 'worker'".
 *
 * Capability matrix asserted (RF-1 §1.3), per principal:
 *   - operator (ws-token bearer)             → allowed / reaches real logic
 *   - worker   (local-worker token)          → 403 (or governance card), never mutates
 *   - spectator (Broadcast bearer)           → two read projections only, never mutates
 *   - unauthenticated remote (LAN, no token) → 401 at the real entry point
 *
 * The worker-token file + ws-token file are written to a temp data dir BEFORE any
 * import, because worker-token.ts and the DB resolve their dir at module load.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';
// Realtime publisher fans out over WS + touches the network; stub it so the
// approvals handler runs its GOVERNANCE logic without side effects.
vi.mock('@/lib/realtime/publisher', () => ({
  publishRealtimeMutation: vi.fn(async () => {}),
}));

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-principal-authz-'));
const WORKER_TOKEN = 'local-worker-token-cafebabe0123456789abcdef01';
const WS_TOKEN = 'operator-ws-token-0123456789abcdefaaaa';
// An enrolled per-device bearer (managed remote access). The middleware + steer
// route resolve it against the registry's derived active-token-hash file.
const DEVICE_TOKEN = 'enrolled-device-token-cafef00d0123456789abcd';
const SPECTATOR_TOKEN = 'broadcast-spectator-token-cafef00d0123456789';
writeFileSync(join(dataDir, 'worker-token'), `${WORKER_TOKEN}\n`, 'utf-8');
writeFileSync(join(dataDir, 'ws-token'), `${WS_TOKEN}\n`, 'utf-8');
writeFileSync(
  join(dataDir, 'mobile-device-tokens'),
  `${createHash('sha256').update(DEVICE_TOKEN).digest('hex')}\n`,
  'utf-8',
);
writeFileSync(
  join(dataDir, 'broadcast-spectator-tokens'),
  `${createHash('sha256').update(SPECTATOR_TOKEN).digest('hex')}\n`,
  'utf-8',
);
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

// Dynamic imports — must resolve the data dir set above.
const approvals = await import('@/app/api/panel/approvals/route');
const supervisorInbox = await import('@/lib/supervisor/inbox');
supervisorInbox.listInboxItems({ includeAllProjects: true, includeDismissed: true });
const problemDossiers = await import('@/app/api/panel/problem-dossiers/route');
const steer = await import('@/app/api/orchestrator/steer-packet/route');
const reset = await import('@/app/api/orchestrator/reset-packet/route');
const rerun = await import('@/app/api/orchestrator/rerun-with-feedback/route');
const sessionRules = await import('@/app/api/orchestrator/session-rules/route');
const merge = await import('@/app/api/orchestrator/merge/route');
const mergePreview = await import('@/app/api/orchestrator/merge-preview/route');
const workspace = await import('@/app/api/orchestrator/workspace/route');
const devServer = await import('@/app/api/panel/dev-server/route');
const fileIo = await import('@/app/api/panel/file-io/route');
const lanes = await import('@/app/api/lanes/route');
const managedRuns = await import('@/app/api/panel/managed-runs/route');
const laneEvents = await import('@/app/api/lanes/[id]/events/route');
const broadcastEvents = await import('@/app/api/broadcast/events/route');
const broadcastCommentary = await import('@/app/api/broadcast/commentary/route');
const broadcastPost = await import('@/app/api/broadcast/post/route');
const broadcastSay = await import('@/app/api/broadcast/say/route');
const broadcastCalendar = await import('@/app/api/broadcast/calendar/route');
const broadcastAutomationSay = await import('@/app/api/broadcast/automation-say/route');
const broadcastWhy = await import('@/app/api/broadcast/why/route');
const broadcastSnapshot = await import('@/app/api/broadcast/snapshot/route');
const broadcastTokens = await import('@/app/api/broadcast/tokens/route');
const { createTestApproval, getApproval, createApproval, listApprovalEvents } = await import('@/lib/approvals/store');
const { panelGateMiddleware } = await import('@/middleware');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
const { getSqlite } = await import('@/lib/db');
getSqlite().prepare(`
  INSERT OR IGNORE INTO broadcast_tokens (id, token_hash, label, created_at, revoked_at)
  VALUES (?, ?, ?, ?, NULL)
`).run(
  'spectator-authz-fixture',
  createHash('sha256').update(SPECTATOR_TOKEN).digest('hex'),
  'principal authz fixture',
  new Date().toISOString(),
);

type Principal = 'operator' | 'worker' | 'spectator';

/** A loopback request (so in-handler requirePanelAuth passes) carrying the
 *  worker token when principal='worker'. This is how a dispatched worker's `o8`
 *  CLI actually calls the loopback API. */
function req(
  url: string,
  { principal, method = 'POST', body, workerPacketId, workerToken }: {
    principal: Principal;
    method?: string;
    body?: unknown;
    workerPacketId?: string;
    workerToken?: string;
  },
): NextRequest {
  const headers: Record<string, string> = { host: 'localhost:3001' };
  if (principal === 'worker') {
    headers.authorization = `Bearer ${workerToken ?? WORKER_TOKEN}`;
    if (workerPacketId) headers['x-o8-worker-packet-id'] = workerPacketId;
  } else if (principal === 'operator') {
    headers.authorization = `Bearer ${WS_TOKEN}`;
  } else {
    headers.authorization = `Bearer ${SPECTATOR_TOKEN}`;
  }
  return new NextRequest(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('principal-authz — Broadcast spectator is read-only through the real entry point', () => {
  it('mints once, authorizes the feed, and revokes on the next middleware read', async () => {
    const mintResponse = await broadcastTokens.POST(req('http://localhost:3001/api/broadcast/tokens', {
      principal: 'operator',
      body: { action: 'mint', label: 'principal test' },
    }));
    expect(mintResponse.status).toBe(200);
    const minted = await mintResponse.json() as { bearer: string; token: { id: string } };
    expect(minted.bearer).toMatch(/^o8sp_/);
    expect(JSON.stringify(getSqlite().prepare('SELECT * FROM broadcast_tokens WHERE id = ?').get(minted.token.id)))
      .not.toContain(minted.bearer);

    const feedRequest = new NextRequest('http://localhost:3001/api/broadcast/events', {
      headers: { host: 'localhost:3001', authorization: `Bearer ${minted.bearer}` },
    });
    expect(panelGateMiddleware(feedRequest).status).toBe(200);
    expect((await broadcastEvents.GET(feedRequest)).status).toBe(200);

    const revokeResponse = await broadcastTokens.POST(req('http://localhost:3001/api/broadcast/tokens', {
      principal: 'operator',
      body: { action: 'revoke', id: minted.token.id },
    }));
    expect(revokeResponse.status).toBe(200);
    expect(panelGateMiddleware(feedRequest).status).toBe(401);
  });

  it('reads both Broadcast projections with its dedicated bearer', async () => {
    const eventsRequest = req('http://localhost:3001/api/broadcast/events?limit=5', {
      principal: 'spectator',
      method: 'GET',
    });
    expect(panelGateMiddleware(eventsRequest).status).toBe(200);
    const eventsResponse = await broadcastEvents.GET(eventsRequest);
    expect(eventsResponse.status).toBe(200);
    await expect(eventsResponse.json()).resolves.toMatchObject({
      schema: 'o8/broadcast.events/v1',
      events: expect.any(Array),
    });

    const commentaryResponse = broadcastCommentary.GET(req(
      'http://localhost:3001/api/broadcast/commentary',
      { principal: 'spectator', method: 'GET' },
    ));
    expect(commentaryResponse.status).toBe(200);
    await expect(commentaryResponse.json()).resolves.toMatchObject({
      schema: 'o8/broadcast.commentary/v1',
      commentary: expect.any(Array),
      cursor: expect.any(String),
    });

    const snapshotRequest = req('http://localhost:3001/api/broadcast/snapshot?events=5', {
      principal: 'spectator',
      method: 'GET',
    });
    expect(panelGateMiddleware(snapshotRequest).status).toBe(200);
    const snapshotResponse = await broadcastSnapshot.GET(snapshotRequest);
    expect(snapshotResponse.status).toBe(200);
    await expect(snapshotResponse.json()).resolves.toMatchObject({
      schema: 'o8/broadcast.snapshot/v1',
      activeAgents: expect.any(Array),
      pendingApprovals: { count: expect.any(Number) },
    });
  });

  it('posts through the real route as operator or packet-bound worker, never spectator', async () => {
    const packetId = `packet-broadcast-post-${Date.now()}`;
    const packetWorkerToken = mintPacketWorkerToken(packetId);
    const operatorResponse = await broadcastPost.POST(req('http://localhost:3001/api/broadcast/post', {
      principal: 'operator',
      body: {
        kind: 'conversation',
        actor: 'operator',
        audience: 'mister',
        text: 'Give the room a short update.',
      },
    }));
    expect(operatorResponse.status).toBe(201);

    const workerRequest = req('http://localhost:3001/api/broadcast/post', {
      principal: 'worker',
      workerToken: packetWorkerToken,
      body: {
        kind: 'commentary',
        actor: 'worker',
        text: 'The packet is ready for review.',
      },
    });
    expect(panelGateMiddleware(workerRequest).status).toBe(200);
    const workerResponse = await broadcastPost.POST(workerRequest);
    expect(workerResponse.status).toBe(201);
    await expect(workerResponse.json()).resolves.toMatchObject({
      event: { refs: { packetId } },
    });

    const spectatorRequest = req('http://localhost:3001/api/broadcast/post', {
      principal: 'spectator',
      body: { kind: 'commentary', actor: 'spectator', text: 'Denied.' },
    });
    expect(panelGateMiddleware(spectatorRequest).status).toBe(403);
    const spectatorResponse = await broadcastPost.POST(spectatorRequest);
    expect(spectatorResponse.status).toBe(403);
    await expect(spectatorResponse.json()).resolves.toMatchObject({
      error: { code: 'broadcast_post_forbidden' },
    });

    const legacyWorkerResponse = await broadcastPost.POST(req('http://localhost:3001/api/broadcast/post', {
      principal: 'worker',
      body: { kind: 'commentary', actor: 'worker', text: 'Unbound.' },
    }));
    expect(legacyWorkerResponse.status).toBe(403);
  });

  it('queues on-demand speech only for the operator principal', async () => {
    const operatorRequest = req('http://localhost:3001/api/broadcast/say', {
      principal: 'operator',
      body: { text: 'Review is ready.' },
    });
    expect(panelGateMiddleware(operatorRequest).status).toBe(200);
    const operatorResponse = await broadcastSay.POST(operatorRequest);
    expect(operatorResponse.status).toBe(200);
    await expect(operatorResponse.json()).resolves.toMatchObject({
      event: { kind: 'commentary', actor: 'symon', text: 'Review is ready.' },
    });

    const workerRequest = req('http://localhost:3001/api/broadcast/say', {
      principal: 'worker',
      body: { text: 'Worker cannot speak.' },
    });
    expect(panelGateMiddleware(workerRequest).status).toBe(403);
    expect((await broadcastSay.POST(workerRequest)).status).toBe(403);

    const spectatorRequest = req('http://localhost:3001/api/broadcast/say', {
      principal: 'spectator',
      body: { text: 'Spectator cannot speak.' },
    });
    expect(panelGateMiddleware(spectatorRequest).status).toBe(403);
    expect((await broadcastSay.POST(spectatorRequest)).status).toBe(403);
  });

  it('keeps Calendar ingestion and attention provenance operator-only', async () => {
    const event = {
      eventId: 'calendar-authz-event',
      title: 'Private appointment',
      calendar: 'Personal',
      startLocal: '2026-08-28T10:00:00',
      endLocal: '2026-08-28T10:30:00',
      startEpochMs: Date.now() + 10 * 60_000,
      endEpochMs: Date.now() + 40 * 60_000,
      allDay: false,
    };
    const operator = req('http://localhost:3001/api/broadcast/calendar', {
      principal: 'operator',
      body: event,
    });
    expect(panelGateMiddleware(operator).status).toBe(200);
    expect((await broadcastCalendar.POST(operator)).status).toBe(200);

    for (const principal of ['worker', 'spectator'] as const) {
      const calendarRequest = req('http://localhost:3001/api/broadcast/calendar', {
        principal,
        body: event,
      });
      expect(panelGateMiddleware(calendarRequest).status).toBe(403);
      expect((await broadcastCalendar.POST(calendarRequest)).status).toBe(403);
      const whyRequest = req('http://localhost:3001/api/broadcast/why', {
        principal,
        method: 'GET',
      });
      expect(panelGateMiddleware(whyRequest).status).toBe(403);
      expect(broadcastWhy.GET(whyRequest).status).toBe(403);
    }
    expect(broadcastWhy.GET(req('http://localhost:3001/api/broadcast/why', {
      principal: 'operator',
      method: 'GET',
    })).status).toBe(200);
  });

  it('admits scheduled speech only from a packet-bound automation lane', async () => {
    const { createLane } = await import('@/lib/lane/registry');
    const packetId = `packet-automation-attention-${Date.now()}`;
    createLane({
      label: '[automation] Morning operator check-in',
      repoPath: '/tmp/automation-attention-authz',
      branch: `automation/attention-${Date.now()}`,
      baseBranch: 'main',
      runtime: 'codex',
      packetId,
    });
    const workerToken = mintPacketWorkerToken(packetId);
    const workerRequest = req('http://localhost:3001/api/broadcast/automation-say', {
      principal: 'worker',
      workerToken,
      body: { text: 'Two approvals need you.' },
    });
    expect(panelGateMiddleware(workerRequest).status).toBe(200);
    expect((await broadcastAutomationSay.POST(workerRequest)).status).toBe(200);

    const operatorRequest = req('http://localhost:3001/api/broadcast/automation-say', {
      principal: 'operator',
      body: { text: 'Operator cannot impersonate an automation packet.' },
    });
    expect((await broadcastAutomationSay.POST(operatorRequest)).status).toBe(403);
  });

  it('long-polls the real feed route until a new ledger event arrives', async () => {
    const { appendEvent, createLane } = await import('@/lib/lane/registry');
    const lane = createLane({
      label: 'Broadcast long poll',
      repoPath: '/tmp/broadcast-long-poll',
      branch: `agent/broadcast-long-poll-${Date.now()}`,
      baseBranch: 'main',
      runtime: 'codex',
      packetId: `packet-broadcast-long-poll-${Date.now()}`,
    });
    const initialResponse = await broadcastEvents.GET(req(
      'http://localhost:3001/api/broadcast/events?limit=100',
      { principal: 'spectator', method: 'GET' },
    ));
    const initial = await initialResponse.json() as { cursor: string };
    const pending = broadcastEvents.GET(req(
      `http://localhost:3001/api/broadcast/events?limit=10&wait=1000&cursor=${encodeURIComponent(initial.cursor)}`,
      { principal: 'spectator', method: 'GET' },
    ));
    setTimeout(() => {
      appendEvent(lane.id, 'agent_report', 'orchestrator', {
        event: 'progress',
        message: 'long poll delivered',
      });
    }, 50);

    const response = await pending;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      events: [{ kind: 'progress', laneId: lane.id, detail: 'long poll delivered' }],
    });
  });

  it('cannot reach token management or any representative mutating route', async () => {
    const mutations = [
      'http://localhost:3001/api/broadcast/tokens',
      'http://localhost:3001/api/panel/approvals',
      'http://localhost:3001/api/lanes',
      'http://localhost:3001/api/leases',
    ];
    for (const url of mutations) {
      expect(panelGateMiddleware(req(url, { principal: 'spectator', body: {} })).status).toBe(403);
    }
    const response = await broadcastTokens.POST(req('http://localhost:3001/api/broadcast/tokens', {
      principal: 'spectator',
      body: { action: 'mint' },
    }));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'broadcast_operator_forbidden' },
    });
  });
});

function packetFixture(overrides: Partial<OrchestratorPacket> = {}): OrchestratorPacket {
  return {
    id: 'pkt-authz-session-rules',
    referenceLabel: 'PKT-AUTHZ',
    title: 'authz packet',
    summary: 'test packet',
    workspaceTargetPath: null,
    branchTarget: 'issue/authz',
    runtime: 'codex',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'running',
    blockedReason: null,
    lastEventAt: null,
    lastEventLabel: null,
    archivedAt: null,
    review: null,
    lane: null,
    orchestratorThreadId: null,
    ...overrides,
  };
}

function writeMissionWithPackets(packets: OrchestratorPacket[]): OrchestratorMissionState {
  return writeOrchestratorControlPlaneState({
    ...createEmptyOrchestratorMissionState(),
    missionId: 'mission-principal-authz',
    packets,
  });
}

/** A genuine off-host LAN request with no credential — the unauthenticated
 *  remote principal, denied at the middleware entry point. */
function lanReq(url: string, method = 'POST'): NextRequest {
  return new NextRequest(url.replace('localhost', '192.168.1.50'), {
    method,
    headers: { host: '192.168.1.50:3001' },
  });
}

function anonymousLoopbackReq(url: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { host: 'localhost:3001' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('principal-authz — approvals resolve (CRIT-1: a worker cannot self-approve)', () => {
  const url = 'http://localhost:3001/api/panel/approvals';

  it('WORKER token → 403, and the approval stays PENDING (no state transition)', async () => {
    const approval = createTestApproval('sess:crit1-worker');
    const res = await approvals.POST(req(url, { principal: 'worker', body: { action: 'approve', id: approval.id } }));
    expect(res.status).toBe(403);
    // Prove the real side effect did NOT happen — the card is untouched.
    expect(getApproval(approval.id)?.status).toBe('pending');
  });

  it('omitting the worker token stays ANONYMOUS and cannot self-approve', async () => {
    const approval = createTestApproval('sess:crit1-omitted-token');
    const res = await approvals.POST(anonymousLoopbackReq(url, { action: 'approve', id: approval.id }));
    expect(res.status).toBe(403);
    expect(getApproval(approval.id)?.status).toBe('pending');
  });

  it('OPERATOR ws-token → resolves the SAME card to approved', async () => {
    const approval = createTestApproval('sess:crit1-operator');
    const res = await approvals.POST(req(url, { principal: 'operator', body: { action: 'approve', id: approval.id } }));
    expect(res.status).toBe(200);
    expect(getApproval(approval.id)?.status).toBe('approved');
  });

  it('unauthenticated REMOTE → refused at the middleware Host gate (421, #4814)', () => {
    // /api/panel/approvals has no in-handler auth; the middleware IS its gate.
    // A non-loopback Host is refused at the Host gate (421) before the auth path.
    expect(panelGateMiddleware(lanReq(url)).status).toBe(421);
  });
});

describe('principal-authz — recurring problem dossiers are worker-readable only', () => {
  const url = 'http://localhost:3001/api/panel/problem-dossiers?includeSuppressed=true';

  it('WORKER GET passes the capability gate and reaches the production route', async () => {
    const request = req(url, { principal: 'worker', method: 'GET' });
    expect(panelGateMiddleware(request).status).toBe(200);

    const response = await problemDossiers.GET(request);
    const payload = await response.json() as { schema?: string; error?: string };
    expect(payload.error).toBeUndefined();
    expect({ status: response.status, ...payload }).toMatchObject({
      status: 200,
      schema: 'o8/problem-dossiers/v1',
    });
  });

  it('WORKER POST stays denied at both authorization layers', async () => {
    const request = req(url, { principal: 'worker', body: {} });
    expect(panelGateMiddleware(request).status).toBe(403);
    expect((await problemDossiers.POST(request)).status).toBe(403);
  });

  it('unauthenticated REMOTE GET stays denied at both layers (Host gate 421, in-handler 401)', async () => {
    const request = lanReq(url, 'GET');
    expect(panelGateMiddleware(request).status).toBe(421);
    expect((await problemDossiers.GET(request)).status).toBe(401);
  });
});

// Control-plane verbs that reject a worker outright (HIGH-4). For the operator
// principal we assert the request is NOT rejected as a worker (it reaches real
// logic and fails later on the missing packet — a 4xx/5xx that is NOT 403),
// which proves the principal gate distinguishes without needing a live packet.
describe('principal-authz — packet control verbs reject worker principals (HIGH-4)', () => {
  const cases: Array<{ name: string; url: string; POST: (r: NextRequest) => Promise<Response>; body: unknown }> = [
    { name: 'steer-packet', url: 'http://localhost:3001/api/orchestrator/steer-packet', POST: steer.POST, body: { packetId: 'pkt-x', message: 'go', idempotencyKey: 'authz-steer-1' } },
    { name: 'reset-packet', url: 'http://localhost:3001/api/orchestrator/reset-packet', POST: reset.POST, body: { packetId: 'pkt-x' } },
    { name: 'rerun-with-feedback', url: 'http://localhost:3001/api/orchestrator/rerun-with-feedback', POST: rerun.POST, body: { packetId: 'pkt-x', feedback: 'redo', idempotencyKey: 'authz-rerun-1' } },
    { name: 'workspace-control', url: 'http://localhost:3001/api/orchestrator/workspace', POST: workspace.POST, body: { action: 'park', packetId: 'pkt-x', clientMutationId: 'authz-workspace-1' } },
  ];

  for (const c of cases) {
    it(`${c.name}: WORKER → 403`, async () => {
      const res = await c.POST(req(c.url, { principal: 'worker', body: c.body }));
      expect(res.status).toBe(403);
    });

    it(`${c.name}: OPERATOR → NOT 403 (passes the principal gate, reaches real logic)`, async () => {
      const res = await c.POST(req(c.url, { principal: 'operator', body: c.body }));
      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(401);
    });

    it(`${c.name}: unauthenticated REMOTE → 401 (in-handler requirePanelAuth)`, async () => {
      const res = await c.POST(lanReq(c.url));
      expect(res.status).toBe(401);
    });
  }
});

describe('principal-authz — workspace reads stay packet-bound', () => {
  it('refuses a real packet-scoped worker credential before workspace lookup', async () => {
    const workerToken = mintPacketWorkerToken('pkt-workspace-owner');
    const request = req(
      'http://localhost:3001/api/orchestrator/workspace?packetId=pkt-workspace-other',
      {
        principal: 'worker',
        method: 'GET',
        workerToken,
      },
    );
    const response = await workspace.GET(request);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'worker_packet_mismatch' },
    });
  });
});

describe('principal-authz — merge preview admits only the owning worker packet', () => {
  it('keeps operator and device output unchanged while enforcing worker packet ownership', async () => {
    const repoPath = mkdtempSync(join(os.tmpdir(), 'o8-merge-preview-authz-'));
    const packetId = `pkt-merge-preview-owner-${Date.now()}`;
    const otherPacketId = `${packetId}-other`;
    const branch = `inline/${packetId}`;
    const git = (...args: string[]) => execFileSync('git', args, {
      cwd: repoPath,
      stdio: 'pipe',
    });

    try {
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 'test@o8.dev');
      git('config', 'user.name', 'o8 test');
      writeFileSync(join(repoPath, 'README.md'), 'base\n');
      git('add', 'README.md');
      git('commit', '-q', '-m', 'base');
      git('checkout', '-q', '-b', branch);
      writeFileSync(join(repoPath, 'README.md'), 'base\npacket change\n');
      git('add', 'README.md');
      git('commit', '-q', '-m', 'packet change');

      const { createLane } = await import('@/lib/lane/registry');
      createLane({
        label: 'merge preview authorization',
        repoPath,
        worktreePath: repoPath,
        branch,
        baseBranch: 'main',
        runtime: 'codex',
        packetId,
      });

      const ownedUrl = `http://localhost:3001/api/orchestrator/merge-preview?packetId=${packetId}`;
      const otherUrl = `http://localhost:3001/api/orchestrator/merge-preview?packetId=${otherPacketId}`;
      const operatorRequest = req(ownedUrl, { principal: 'operator', method: 'GET' });
      expect(panelGateMiddleware(operatorRequest).status).toBe(200);
      const operatorResponse = await mergePreview.GET(operatorRequest);
      expect(operatorResponse.status).toBe(200);
      const operatorBody = await operatorResponse.text();
      expect(JSON.parse(operatorBody)).toMatchObject({
        packetId,
        checks: expect.any(Array),
        blockers: expect.any(Array),
        branch,
      });

      const workerToken = mintPacketWorkerToken(packetId);
      const ownedWorkerRequest = req(ownedUrl, {
        principal: 'worker',
        method: 'GET',
        workerToken,
      });
      expect(panelGateMiddleware(ownedWorkerRequest).status).toBe(200);
      const ownedWorkerResponse = await mergePreview.GET(ownedWorkerRequest);
      expect(ownedWorkerResponse.status).toBe(200);
      expect(await ownedWorkerResponse.text()).toBe(operatorBody);

      const deviceRequest = new NextRequest(ownedUrl, {
        method: 'GET',
        headers: { host: 'localhost:3001', authorization: `Bearer ${DEVICE_TOKEN}` },
      });
      expect(panelGateMiddleware(deviceRequest).status).toBe(200);
      const deviceResponse = await mergePreview.GET(deviceRequest);
      expect(deviceResponse.status).toBe(200);
      expect(await deviceResponse.text()).toBe(operatorBody);

      const mismatchRequest = req(otherUrl, {
        principal: 'worker',
        method: 'GET',
        workerToken,
      });
      expect(panelGateMiddleware(mismatchRequest).status).toBe(200);
      const mismatchResponse = await mergePreview.GET(mismatchRequest);
      expect(mismatchResponse.status).toBe(403);
      await expect(mismatchResponse.json()).resolves.toMatchObject({
        ok: false,
        error: { code: 'worker_packet_mismatch' },
      });

      const legacyWorkerRequest = req(ownedUrl, {
        principal: 'worker',
        method: 'GET',
      });
      expect(panelGateMiddleware(legacyWorkerRequest).status).toBe(200);
      const legacyWorkerResponse = await mergePreview.GET(legacyWorkerRequest);
      expect(legacyWorkerResponse.status).toBe(403);
      await expect(legacyWorkerResponse.json()).resolves.toMatchObject({
        ok: false,
        error: { code: 'worker_packet_mismatch' },
      });

      const anonymousRequest = new NextRequest(ownedUrl, {
        method: 'GET',
        headers: { host: 'localhost:3001' },
      });
      expect(panelGateMiddleware(anonymousRequest).status).toBe(401);
      const anonymousResponse = await mergePreview.GET(anonymousRequest);
      expect(anonymousResponse.status).toBe(401);
      await expect(anonymousResponse.json()).resolves.toMatchObject({
        ok: false,
        error: { code: 'unauthorized' },
      });
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('principal-authz — worker credentials are bound to their persisted packet owner (#1644)', () => {
  const url = 'http://localhost:3001/api/orchestrator/merge';

  it('refuses packet B, accepts packet A, and leaves operator context unaffected through the real merge route', async () => {
    const { createLane } = await import('@/lib/lane/registry');
    const packetA = `pkt-authz-owner-a-${Date.now()}`;
    const packetB = `pkt-authz-owner-b-${Date.now()}`;
    // The worker card reads the lane diff through hardened lane Git, which needs a real repository.
    const repoPath = join(dataDir, 'packet-owner-repo');
    execFileSync('git', ['init', '-q', '-b', 'main', repoPath], { stdio: 'pipe' });
    for (const [label, packetId] of [['A', packetA], ['B', packetB]]) {
      createLane({ label: `packet ownership ${label}`, repoPath, branch: `agent/${packetId}`, baseBranch: 'main', runtime: 'codex', packetId });
    }
    const packetAToken = mintPacketWorkerToken(packetA);

    const mismatch = await merge.POST(req(url, {
      principal: 'worker',
      workerToken: packetAToken,
      body: { packetId: packetB },
    }));
    expect(mismatch.status).toBe(403);
    expect(await mismatch.json()).toMatchObject({
      ok: false,
      error: { code: 'worker_packet_mismatch' },
    });

    const owned = await merge.POST(req(url, {
      principal: 'worker',
      workerToken: packetAToken,
      body: { packetId: packetA },
    }));
    expect(owned.status).toBe(200);
    expect(await owned.json()).toMatchObject({
      ok: true,
      result: { merged: false, status: 'pending_operator_approval' },
    });

    const operator = await merge.POST(req(url, {
      principal: 'operator',
      body: { packetId: packetB, requestedByWorker: true },
    }));
    expect(operator.status).toBe(200);
  });
});

// Managed remote access (#relay): steer-packet is the ONE control verb the
// operator's phone may drive. It must accept an enrolled per-device bearer while
// still rejecting a worker — driven through the REAL route handler, because the
// route replaced requirePanelAuth with a principal gate and the relay connector
// forwards the device bearer with a NON-loopback client-addr (never loopback-
// trusted). The premise-encoding trap here would be testing resolveRequestPrincipal
// in isolation; instead we invoke steer.POST with the device credential.
describe('principal-authz — steer-packet accepts an enrolled mobile device (managed relay)', () => {
  const url = 'http://localhost:3001/api/orchestrator/steer-packet';

  function deviceReq(body: unknown): NextRequest {
    return new NextRequest(url, {
      method: 'POST',
      headers: { host: 'localhost:3001', authorization: `Bearer ${DEVICE_TOKEN}` },
      body: JSON.stringify(body),
    });
  }

  it('DEVICE token → NOT 403 and NOT 401 (passes the principal gate, reaches real logic)', async () => {
    const res = await steer.POST(deviceReq({
      packetId: 'pkt-does-not-exist',
      message: 'go',
      idempotencyKey: 'device-authz-steer-1',
    }));
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(401);
  });

  it('a device is NOT a worker: the worker is still 403 on the same verb', async () => {
    const res = await steer.POST(req(url, { principal: 'worker', body: { packetId: 'pkt-x', message: 'go' } }));
    expect(res.status).toBe(403);
  });

  it('an unknown/garbage bearer stays anonymous → 401 (fail-closed)', async () => {
    const res = await steer.POST(new NextRequest(url, {
      method: 'POST',
      headers: { host: 'localhost:3001', authorization: 'Bearer not-an-enrolled-device-tokenaaaaaaaa' },
      body: JSON.stringify({ packetId: 'pkt-x', message: 'go' }),
    }));
    expect(res.status).toBe(401);
  });
});

describe('principal-authz — session rules writes are operator-only (#1329 HIGH-4)', () => {
  const url = 'http://localhost:3001/api/orchestrator/session-rules';

  it('POST: WORKER → 403; OPERATOR → 200 and the rule is persisted', async () => {
    const workerRes = await sessionRules.POST(req(url, { principal: 'worker', body: { threadId: 't-1', text: 'no shortcuts' } }));
    expect(workerRes.status).toBe(403);

    const opRes = await sessionRules.POST(req(url, { principal: 'operator', body: { threadId: 't-1', text: 'no shortcuts' } }));
    expect(opRes.status).toBe(200);
    const json = await opRes.json();
    // operatorSuccess wraps the payload as { ok, result }.
    expect(json.result?.rule?.text).toBe('no shortcuts');
  });

  it('DELETE: WORKER → 403 (a worker may READ the rules that govern it, never edit)', async () => {
    const res = await sessionRules.DELETE(req(`${url}?id=some-rule`, { principal: 'worker', method: 'DELETE' }));
    expect(res.status).toBe(403);
  });

  it('GET: WORKER → 200 only for the thread that dispatched its packet', async () => {
    const packetId = 'pkt-authz-owned-thread';
    writeMissionWithPackets([
      packetFixture({ id: packetId, orchestratorThreadId: 't-owned' }),
    ]);
    const res = await sessionRules.GET(req(`${url}?threadId=t-owned`, {
      principal: 'worker',
      method: 'GET',
      workerPacketId: packetId,
      workerToken: mintPacketWorkerToken(packetId),
    }));
    expect(res.status).toBe(200);
  });

  it('GET: WORKER naming another thread → 403', async () => {
    const packetId = 'pkt-authz-other-thread';
    writeMissionWithPackets([
      packetFixture({ id: packetId, orchestratorThreadId: 't-owned' }),
    ]);
    const res = await sessionRules.GET(req(`${url}?threadId=t-stolen`, {
      principal: 'worker',
      method: 'GET',
      workerPacketId: packetId,
      workerToken: mintPacketWorkerToken(packetId),
    }));
    expect(res.status).toBe(403);
  });

  it('GET: WORKER without packet binding → 403', async () => {
    const res = await sessionRules.GET(req(`${url}?threadId=t-1`, { principal: 'worker', method: 'GET' }));
    expect(res.status).toBe(403);
  });
});

describe('principal-authz — shell/RCE primitive is operator-only (HIGH-3 dev-server)', () => {
  const url = 'http://localhost:3001/api/panel/dev-server';

  it('WORKER → 403 before any shell spawn', async () => {
    const res = await devServer.POST(req(url, { principal: 'worker', body: { repoPath: '/tmp', command: 'echo hi' } }));
    expect(res.status).toBe(403);
  });

  it('OPERATOR → NOT 403 (passes the principal gate; missing fields → 400)', async () => {
    const res = await devServer.POST(req(url, { principal: 'operator', body: {} }));
    expect(res.status).toBe(400); // reached real handler: repoPath/command required
  });
});

describe('principal-authz — worker file access is confined to registered repos (HIGH-6)', () => {
  const url = 'http://localhost:3001/api/panel/file-io';

  it('WORKER reading an arbitrary absolute path (/etc/hosts) → 403', async () => {
    const res = await fileIo.GET(req(`${url}?path=${encodeURIComponent('/etc/hosts')}`, { principal: 'worker', method: 'GET' }));
    expect(res.status).toBe(403);
  });

  it('OPERATOR reading the same arbitrary path → NOT 403 (terminal-grade operator tool)', async () => {
    // The file exists on macOS/Linux CI runners; operator passes the worker gate
    // and reads it (200) — the point is it is NOT the worker 403.
    const res = await fileIo.GET(req(`${url}?path=${encodeURIComponent('/etc/hosts')}`, { principal: 'operator', method: 'GET' }));
    expect(res.status).not.toBe(403);
  });
});

describe('principal-authz — spectator cannot bypass middleware at sensitive read handlers', () => {
  it('file-io GET rejects the spectator before reading a valid absolute path', async () => {
    const request = req(`http://localhost:3001/api/panel/file-io?path=${encodeURIComponent('/etc/hosts')}`, {
      principal: 'spectator',
      method: 'GET',
    });
    expect(panelGateMiddleware(request).status).toBe(403);
    expect((await fileIo.GET(request)).status).toBe(403);
  });

  it('lanes GET rejects the spectator before reconciliation or fleet reads', async () => {
    const request = req('http://localhost:3001/api/lanes', { principal: 'spectator', method: 'GET' });
    expect(panelGateMiddleware(request).status).toBe(403);
    expect((await lanes.GET(request)).status).toBe(403);
  });

  it('managed-runs GET rejects the spectator before tmux reconciliation', async () => {
    const request = req('http://localhost:3001/api/panel/managed-runs', { principal: 'spectator', method: 'GET' });
    expect(panelGateMiddleware(request).status).toBe(403);
    expect((await managedRuns.GET(request)).status).toBe(403);
  });
});

// Fail-closed sweep: the absence of a credential must never read as operator.
describe('principal-authz — fail-closed: unknown/absent principal is denied on every mutating verb', () => {
  const mutating = [
    'http://192.168.1.50:3001/api/panel/approvals',
    'http://192.168.1.50:3001/api/orchestrator/steer-packet',
    'http://192.168.1.50:3001/api/orchestrator/reset-packet',
    'http://192.168.1.50:3001/api/orchestrator/rerun-with-feedback',
    'http://192.168.1.50:3001/api/orchestrator/session-rules',
    'http://192.168.1.50:3001/api/orchestrator/merge',
    'http://192.168.1.50:3001/api/panel/dev-server',
    'http://192.168.1.50:3001/api/panel/file-io',
  ];

  it.each(mutating)('LAN POST with no credential is refused at the Host gate (421): %s', (url) => {
    expect(panelGateMiddleware(lanReq(url)).status).toBe(421);
  });
});

describe('principal-authz — worker lane-event reports are accepted (post-CRIT-1 regression)', () => {
  // CRIT-1 made dispatched workers present O8_WORKER_TOKEN instead of the
  // operator ws-token; the lane-events route's in-handler bearer check only
  // compared against the ws-token, silently 401ing every worker
  // `o8 packet report` / huddle post (live-hit 2026-07-03, pkt-1f225562).
  const params = { params: Promise.resolve({ id: 'lane-does-not-exist' }) };

  it('WORKER token → passes the bearer gate (reaches lane lookup, not 401)', async () => {
    const res = await laneEvents.POST(
      req('http://localhost:3001/api/lanes/lane-does-not-exist/events', {
        principal: 'worker',
        body: { verb: 'agent_report', event: 'progress', message: 'x' },
      }),
      params,
    );
    expect(res.status).not.toBe(401);
  });

  it('OPERATOR ws-token → passes the bearer gate too', async () => {
    const headers: Record<string, string> = {
      host: 'localhost:3001',
      authorization: `Bearer ${WS_TOKEN}`,
    };
    const res = await laneEvents.POST(
      new NextRequest('http://localhost:3001/api/lanes/lane-does-not-exist/events', {
        method: 'POST',
        headers,
        body: JSON.stringify({ verb: 'agent_report', event: 'progress', message: 'x' }),
      }),
      params,
    );
    expect(res.status).not.toBe(401);
  });

  it('garbage bearer → still 401', async () => {
    const headers: Record<string, string> = {
      host: 'localhost:3001',
      authorization: 'Bearer not-a-real-token-aaaaaaaaaaaaaaaa',
    };
    const res = await laneEvents.POST(
      new NextRequest('http://localhost:3001/api/lanes/lane-does-not-exist/events', {
        method: 'POST',
        headers,
        body: JSON.stringify({ verb: 'agent_report', event: 'progress', message: 'x' }),
      }),
      params,
    );
    expect(res.status).toBe(401);
  });
});

describe('principal-authz — /api/lanes actor comes from the credential, never the body (#1173 H1)', () => {
  // The hole: dispatch(body) with actor defaulting to trusted 'user' let ANY
  // loopback caller (worker token, tokenless same-origin fetch) self-assert
  // 'user' — which pre-approves merges and skips the governance card. The
  // route now clamps: only the operator credential may act as 'user'; workers
  // are forced to 'orchestrator', and other principals are refused. Proven
  // through the REAL route handler against a persisted lane and its events.
  it('worker token archiving a lane is recorded as orchestrator even when the body claims user', async () => {
    const lanesRoute = await import('@/app/api/lanes/route');
    const { createLane, getLaneEvents } = await import('@/lib/lane/registry');
    const lane = createLane({
      label: 'authz clamp lane (worker)',
      repoPath: '/tmp/authz-clamp-repo',
      branch: 'agent/authz-clamp-w',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: `pkt-authz-clamp-worker-${Date.now()}`,
    });
    const res = await lanesRoute.POST(req('http://localhost:3001/api/lanes', {
      principal: 'worker',
      workerToken: mintPacketWorkerToken(lane.packetId!),
      body: { verb: 'archive', laneId: lane.id, actor: 'user' },
    }));
    expect(res.status).toBeLessThan(500);
    const events = getLaneEvents(lane.id, 20);
    const archived = events.filter((event) => event.verb === 'status_change')
      .find((event) => (event.payload as { status?: string }).status === 'archived');
    expect(archived).toBeTruthy();
    expect(archived?.actor).toBe('orchestrator');
  });

  it('operator token keeps user-actor semantics', async () => {
    const lanesRoute = await import('@/app/api/lanes/route');
    const { createLane, getLaneEvents } = await import('@/lib/lane/registry');
    const lane = createLane({
      label: 'authz clamp lane (operator)',
      repoPath: '/tmp/authz-clamp-repo',
      branch: 'agent/authz-clamp-o',
      baseBranch: 'main',
      runtime: 'codex',
    });
    const res = await lanesRoute.POST(req('http://localhost:3001/api/lanes', {
      principal: 'operator',
      body: { verb: 'archive', laneId: lane.id },
    }));
    expect(res.status).toBeLessThan(500);
    const events = getLaneEvents(lane.id, 20);
    const archived = events.filter((event) => event.verb === 'status_change')
      .find((event) => (event.payload as { status?: string }).status === 'archived');
    expect(archived).toBeTruthy();
    expect(archived?.actor).toBe('user');
  });

  it('tokenless loopback is refused by the explicit operator/worker allowlist', async () => {
    const lanesRoute = await import('@/app/api/lanes/route');
    const { createLane, getLaneEvents } = await import('@/lib/lane/registry');
    const lane = createLane({
      label: 'authz clamp lane (anon)',
      repoPath: '/tmp/authz-clamp-repo',
      branch: 'agent/authz-clamp-a',
      baseBranch: 'main',
      runtime: 'codex',
    });
    const res = await lanesRoute.POST(anonymousLoopbackReq('http://localhost:3001/api/lanes', {
      verb: 'archive',
      laneId: lane.id,
      actor: 'user',
    }));
    expect(res.status).toBe(403);
    const events = getLaneEvents(lane.id, 20);
    expect(events.some((event) => (
      event.verb === 'status_change'
      && (event.payload as { status?: string }).status === 'archived'
    ))).toBe(false);
  });
});


describe('principal-authz — external CLI resume', () => {
  it.each([
    ['codex', 'codex:stale-thread'],
    ['codex', 'codex-discovered:stale-thread'],
    ['codex', 'codex-live:67890'],
    ['claude-code', 'claude-code:stale-thread'],
    ['claude-code', 'claude-code-discovered:stale-thread'],
  ] as const)('keeps %s %s pending without claiming approval', async (runtime, sessionKey) => {
    const { createLane, getLane, updateLane } = await import('@/lib/lane/registry');
    const lane = createLane({
      repoPath: dataDir,
      branch: `test/external-resume-${sessionKey.replaceAll(':', '-')}`,
      runtime,
      sessionKey,
    });
    updateLane(lane.id, { status: 'awaiting_input' }, 'orchestrator');
    const approval = createApproval({
      source: 'runtime', runtime, agent: 'External CLI', sessionKey,
      title: 'Resume lane', description: 'Continue the external CLI.',
      summary: 'Resume lane.', risk: 'medium',
      continuation: { kind: 'lane', laneId: lane.id, verb: 'resume' },
    });
    const response = await approvals.POST(req('http://localhost/api/panel/approvals', {
      principal: 'operator', body: { action: 'approve', id: approval.id },
    }));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('original terminal');
    expect(getApproval(approval.id)?.status).toBe('pending');
    expect(listApprovalEvents(approval.id).some((event) => event.type === 'approved')).toBe(false);
    expect(getLane(lane.id)).toMatchObject({ sessionKey, status: 'awaiting_input' });
  });
});
