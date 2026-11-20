import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  requirePanelAuth: vi.fn(() => null),
  resolvePrincipal: vi.fn(() => 'operator'),
  resolvePrincipalContext: vi.fn(() => ({ role: 'operator' })),
  workerPacketRefusal: vi.fn((): { code: string; message: string } | null => null),
  findLane: vi.fn(),
  listRepos: vi.fn(),
  park: vi.fn(),
  restore: vi.fn(),
  reconcile: vi.fn(),
  snapshot: null as Record<string, unknown> | null,
  transitions: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: h.requirePanelAuth }));
vi.mock('@/lib/auth/principal', () => ({
  resolveRequestPrincipal: h.resolvePrincipal,
  resolveRequestPrincipalContext: h.resolvePrincipalContext,
  workerPacketRefusal: h.workerPacketRefusal,
}));
vi.mock('@/lib/lane/registry', () => ({ findLatestLaneByPacket: h.findLane }));
vi.mock('@/lib/repos/registry', () => ({ listRepos: h.listRepos }));
vi.mock('@/lib/workspace/hibernator', () => ({ parkWorkspace: h.park }));
vi.mock('@/lib/workspace/restorer', () => ({ restoreWorkspace: h.restore }));
vi.mock('@/lib/workspace/reconciler', () => ({ reconcileWorkspaceSnapshot: h.reconcile }));
vi.mock('@/lib/worktree/snapshot-state', () => ({
  getWorkspaceSnapshot: () => h.snapshot,
  listWorkspaceSnapshotTransitions: () => h.transitions,
}));

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-workspace-route-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const route = await import('./route');
const idempotency = await import('@/lib/orchestrator/idempotency-store');
const { closeDb, getSqlite } = await import('@/lib/db');
const { probeMetadataLockProcessIdentity } = await import('@/lib/worktree/metadata-lock-process-identity');

const lane = {
  id: 'lane-1',
  packetId: 'packet-1',
  repoPath: '/repo',
  worktreePath: '/worktrees/packet-1',
  sessionKey: 'codex-owned:packet-1',
  branch: 'inline/packet-1',
  baseBranch: 'main',
  status: 'reviewing',
  ownership: 'managed',
};

const repo = { id: 'repo-1', localPath: '/repo', name: 'repo' };

function snapshot(state: 'materialized' | 'parkable' | 'hibernating' | 'parked' | 'restoring') {
  return {
    repositoryUuid: 'repo-1',
    packetId: 'packet-1',
    laneId: 'lane-1',
    state,
    originalPath: '/worktrees/packet-1',
    branch: 'inline/packet-1',
    headCommit: 'a'.repeat(40),
    treeSha: 'b'.repeat(40),
    diffFingerprint: 'fingerprint-1',
    snapshotGeneration: 1,
    lastTransitionId: `snapshot:${state}`,
    lastError: null,
  };
}

function seedDeadReservation(
  action: 'park' | 'restore',
  clientMutationId: string,
  owner: { pid: number; identityJson: string | null; createdAt?: number } = {
    pid: 999_999_999,
    identityJson: null,
  },
): void {
  const key = idempotency.deriveIdempotencyKey({
    verb: `workspace_${action}`,
    scopeId: 'packet-1',
    clientKey: clientMutationId,
    body: JSON.stringify({ action, packetId: 'packet-1' }),
  });
  const now = Date.now();
  getSqlite().prepare(`
    INSERT INTO idempotency_keys
      (key, verb, packet_id, result_json, pid, reservation_id, owner_identity_json, created_at, expires_at)
    VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)
  `).run(
    key,
    `workspace_${action}`,
    'packet-1',
    owner.pid,
    `dead-${clientMutationId}`,
    owner.identityJson,
    owner.createdAt ?? now,
    now + 60_000,
  );
}

function post(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/orchestrator/workspace', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterAll(() => {
  // closeDb logs as the worker tears down; an unflushed log fails the shard.
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try { closeDb(); } finally { log.mockRestore(); }
  rmSync(dataDir, { recursive: true, force: true });
});

describe('/api/orchestrator/workspace', () => {
  beforeEach(() => {
    h.requirePanelAuth.mockReset().mockReturnValue(null);
    h.resolvePrincipal.mockReset().mockReturnValue('operator');
    h.resolvePrincipalContext.mockReset().mockReturnValue({ role: 'operator' });
    h.workerPacketRefusal.mockReset().mockReturnValue(null);
    h.findLane.mockReset().mockReturnValue(lane);
    h.listRepos.mockReset().mockResolvedValue([repo]);
    h.snapshot = null;
    h.transitions = [];
    h.reconcile.mockReset().mockResolvedValue(null);
    h.park.mockReset().mockImplementation(async () => {
      h.snapshot = snapshot('parked');
      return { status: 'parked', snapshot: h.snapshot };
    });
    h.restore.mockReset().mockImplementation(async () => {
      h.snapshot = snapshot('materialized');
      return { status: 'restored', snapshot: h.snapshot };
    });
    idempotency.__resetIdempotencyStoreForTests();
  });

  it('projects manual eligibility without exposing the workspace path or session identity', async () => {
    const response = await route.GET(new NextRequest(
      'http://localhost/api/orchestrator/workspace?packetId=packet-1',
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      result: { state: 'materialized', canPark: true, canRestore: false },
    });
    expect(JSON.stringify(body)).not.toContain('/worktrees/packet-1');
    expect(JSON.stringify(body)).not.toContain('session');
  });

  it('keeps an occupied restore quarantined and non-actionable in status truth', async () => {
    h.snapshot = {
      ...snapshot('restoring'),
      lastError: {
        code: 'restore_failed',
        message: 'Exact restore refused because the original path is occupied.',
        phase: 'restoring',
        recordedAt: 1,
      },
    };
    const response = await route.GET(new NextRequest(
      'http://localhost/api/orchestrator/workspace?packetId=packet-1',
    ));

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      result: {
        state: 'restoring',
        canRestore: false,
        note: 'Exact restore refused because the original path is occupied.',
      },
    });
  });

  it('does not advertise restore when a parked workspace path is occupied', async () => {
    h.snapshot = {
      ...snapshot('parked'),
      originalPath: dataDir,
    };
    const response = await route.GET(new NextRequest(
      'http://localhost/api/orchestrator/workspace?packetId=packet-1',
    ));
    const body = await response.json();

    expect(body).toMatchObject({
      ok: true,
      result: {
        state: 'parked',
        canRestore: false,
        note: 'The original workspace path is occupied; inspect or move it before restoring.',
      },
    });
    expect(JSON.stringify(body)).not.toContain(dataDir);
  });

  it('persists and replays one exact park action without removing twice', async () => {
    const body = { action: 'park', packetId: 'packet-1', clientMutationId: 'park-once-1' };
    const first = await route.POST(post(body));
    const replay = await route.POST(post(body));

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(h.park).toHaveBeenCalledTimes(1);
    await expect(replay.json()).resolves.toMatchObject({
      ok: true,
      result: {
        action: 'park',
        status: 'parked',
        clientMutationId: 'park-once-1',
        replayed: true,
      },
    });
  });

  it('rejects body drift on the same client mutation id', async () => {
    const first = await route.POST(post({
      action: 'park', packetId: 'packet-1', clientMutationId: 'workspace-drift-1',
    }));
    const conflict = await route.POST(post({
      action: 'restore', packetId: 'packet-1', clientMutationId: 'workspace-drift-1',
    }));

    expect(first.status).toBe(200);
    expect(conflict.status).toBe(409);
    expect(h.park).toHaveBeenCalledTimes(1);
    expect(h.restore).not.toHaveBeenCalled();
  });

  it('persists a truthful refusal instead of repeating a failed verification', async () => {
    h.park.mockResolvedValue({
      status: 'refused',
      code: 'park_refused',
      note: 'The workspace changed during its second verification scan.',
    });
    const body = { action: 'park', packetId: 'packet-1', clientMutationId: 'park-refused-1' };
    const first = await route.POST(post(body));
    const replay = await route.POST(post(body));

    expect(first.status).toBe(409);
    expect(replay.status).toBe(409);
    expect(h.park).toHaveBeenCalledTimes(1);
    await expect(replay.json()).resolves.toMatchObject({
      ok: false,
      result: { status: 'refused', retryable: false, replayed: true },
    });
  });

  it('replays an interrupted restore as safely rolled back without restoring twice', async () => {
    const clientMutationId = 'restore-crash-1';
    h.snapshot = {
      ...snapshot('restoring'),
      lastTransitionId: `${clientMutationId}:restoring`,
    };
    h.transitions = [{
      transitionId: `${clientMutationId}:restoring`,
      toState: 'restoring',
      snapshotGeneration: 1,
      receipt: null,
    }, {
      transitionId: `${clientMutationId}:failed-rolled-back`,
      toState: 'parked',
      snapshotGeneration: 1,
      receipt: null,
    }];
    h.reconcile.mockImplementation(async () => {
      h.snapshot = {
        ...snapshot('parked'),
        lastTransitionId: `${clientMutationId}:failed-rolled-back`,
      };
      return { toState: 'parked', disposition: 'reconciled' };
    });
    seedDeadReservation('restore', clientMutationId);

    const response = await route.POST(post({
      action: 'restore', packetId: 'packet-1', clientMutationId,
    }));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      ok: false,
      result: {
        action: 'restore',
        status: 'refused',
        retryable: true,
        replayed: true,
      },
    });
    expect(h.restore).not.toHaveBeenCalled();
    expect(h.reconcile).toHaveBeenCalledTimes(1);
  });

  it('reconciles a persisted restore whose reused PID has a different process identity', async () => {
    const clientMutationId = 'restore-pid-reused';
    h.snapshot = { ...snapshot('restoring'), lastTransitionId: `${clientMutationId}:restoring` };
    h.transitions = [{
      transitionId: `${clientMutationId}:restoring`,
      toState: 'restoring',
      snapshotGeneration: 1,
      receipt: null,
    }, {
      transitionId: `${clientMutationId}:failed-rolled-back`,
      toState: 'parked',
      snapshotGeneration: 1,
      receipt: null,
    }];
    h.reconcile.mockImplementation(async () => {
      h.snapshot = { ...snapshot('parked'), lastTransitionId: `${clientMutationId}:failed-rolled-back` };
      return { toState: 'parked', disposition: 'reconciled' };
    });
    const probe = await probeMetadataLockProcessIdentity(process.pid);
    expect(probe.state).toBe('live');
    if (probe.state !== 'live') throw new Error('The test process identity is unavailable.');
    seedDeadReservation('restore', clientMutationId, {
      pid: process.pid,
      identityJson: JSON.stringify({ ...probe.identity, startId: `${probe.identity.startId}-reused` }),
    });
    closeDb();
    expect(getSqlite().prepare(
      "SELECT pid, owner_identity_json FROM idempotency_keys WHERE verb = 'workspace_restore'",
    ).get()).toEqual({ pid: null, owner_identity_json: null });

    const response = await route.POST(post({
      action: 'restore', packetId: 'packet-1', clientMutationId,
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      result: { action: 'restore', status: 'refused', retryable: true, replayed: true },
    });
    expect(h.restore).not.toHaveBeenCalled();
    expect(h.reconcile).toHaveBeenCalledTimes(1);
  });

  it('reconciles an identity-less legacy restore proven to predate this boot', async () => {
    const clientMutationId = 'restore-legacy-prior-boot';
    h.snapshot = { ...snapshot('restoring'), lastTransitionId: `${clientMutationId}:restoring` };
    h.transitions = [{
      transitionId: `${clientMutationId}:restoring`, toState: 'restoring',
      snapshotGeneration: 1, receipt: null,
    }, {
      transitionId: `${clientMutationId}:failed-rolled-back`, toState: 'parked',
      snapshotGeneration: 1, receipt: null,
    }];
    h.reconcile.mockImplementation(async () => {
      h.snapshot = { ...snapshot('parked'), lastTransitionId: `${clientMutationId}:failed-rolled-back` };
      return { toState: 'parked', disposition: 'reconciled' };
    });
    const { probeSystemBootTimeMsSync } = await import('@/lib/worktree/metadata-lock-process-identity');
    const bootTimeMs = probeSystemBootTimeMsSync();
    expect(bootTimeMs).not.toBeNull();
    seedDeadReservation('restore', clientMutationId, {
      pid: process.pid,
      identityJson: null,
      createdAt: bootTimeMs! - 1_000,
    });
    closeDb();
    expect(getSqlite().prepare(
      "SELECT pid FROM idempotency_keys WHERE verb = 'workspace_restore'",
    ).get()).toEqual({ pid: null });

    const response = await route.POST(post({
      action: 'restore', packetId: 'packet-1', clientMutationId,
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      result: { action: 'restore', status: 'refused', retryable: true, replayed: true },
    });
    expect(h.restore).not.toHaveBeenCalled();
    expect(h.reconcile).toHaveBeenCalledTimes(1);
  });

  it('keeps an identity-less same-boot legacy owner in progress without proof of death', async () => {
    const clientMutationId = 'restore-legacy-same-boot';
    h.snapshot = { ...snapshot('restoring'), lastTransitionId: `${clientMutationId}:restoring` };
    seedDeadReservation('restore', clientMutationId, {
      pid: process.pid,
      identityJson: null,
      createdAt: Date.now(),
    });
    closeDb();
    expect(getSqlite().prepare(
      "SELECT pid FROM idempotency_keys WHERE verb = 'workspace_restore'",
    ).get()).toEqual({ pid: process.pid });

    const response = await route.POST(post({
      action: 'restore', packetId: 'packet-1', clientMutationId,
    }));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      result: { status: 'in_progress', replayed: true },
    });
    expect(h.restore).not.toHaveBeenCalled();
    expect(h.reconcile).not.toHaveBeenCalled();
  });

  it.each([
    {
      action: 'park' as const,
      state: 'materialized' as const,
      started: 'parkable',
      terminal: 'failed-before-remove',
      retryable: true,
    },
    {
      action: 'park' as const,
      state: 'parked' as const,
      started: 'hibernating',
      terminal: 'failed-after-remove',
      retryable: false,
    },
    {
      action: 'park' as const,
      state: 'hibernating' as const,
      started: 'hibernating',
      terminal: 'quarantined-after-remove',
      retryable: false,
    },
    {
      action: 'restore' as const,
      state: 'parked' as const,
      started: 'restoring',
      terminal: 'failed-path-absent',
      retryable: true,
    },
    {
      action: 'restore' as const,
      state: 'restoring' as const,
      started: 'restoring',
      terminal: 'failed-path-unknown',
      retryable: false,
    },
  ])('replays $action terminal $terminal truth without rerunning the mutation', async ({
    action,
    state,
    started,
    terminal,
    retryable,
  }) => {
    const clientMutationId = `terminal-${terminal}`;
    h.snapshot = {
      ...snapshot(state),
      lastTransitionId: `${clientMutationId}:${terminal}`,
      lastError: {
        code: `${action}_failed`,
        message: `Durable ${terminal} receipt.`,
        phase: state,
        recordedAt: 1,
      },
    };
    h.transitions = [{
      transitionId: `${clientMutationId}:${started}`,
      toState: started,
      snapshotGeneration: 1,
      receipt: null,
    }, {
      transitionId: `${clientMutationId}:${terminal}`,
      toState: state,
      snapshotGeneration: 1,
      receipt: null,
    }];
    seedDeadReservation(action, clientMutationId);

    const response = await route.POST(post({
      action,
      packetId: 'packet-1',
      clientMutationId,
    }));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      ok: false,
      result: {
        action,
        status: 'refused',
        retryable,
        replayed: true,
        note: `Durable ${terminal} receipt.`,
      },
    });
    expect(h.park).not.toHaveBeenCalled();
    expect(h.restore).not.toHaveBeenCalled();
  });

  it('keeps a generation-mismatched terminal receipt outcome-unknown', async () => {
    const clientMutationId = 'generation-mismatch';
    h.snapshot = {
      ...snapshot('materialized'),
      lastTransitionId: `${clientMutationId}:failed-before-remove`,
    };
    h.transitions = [{
      transitionId: `${clientMutationId}:parkable`,
      toState: 'parkable',
      snapshotGeneration: 0,
      receipt: null,
    }, {
      transitionId: `${clientMutationId}:failed-before-remove`,
      toState: 'materialized',
      snapshotGeneration: 0,
      receipt: null,
    }];
    seedDeadReservation('park', clientMutationId);

    const response = await route.POST(post({
      action: 'park', packetId: 'packet-1', clientMutationId,
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'outcome_unknown' },
      result: { outcomeUnknown: true, retryable: false },
    });
    expect(h.park).not.toHaveBeenCalled();
  });

  it('requires an operator principal before changing workspace materialization', async () => {
    h.resolvePrincipal.mockReturnValue('worker');
    const response = await route.POST(post({
      action: 'park', packetId: 'packet-1', clientMutationId: 'worker-park-1',
    }));

    expect(response.status).toBe(403);
    expect(h.park).not.toHaveBeenCalled();
  });

  it('refuses a worker reading another packet workspace', async () => {
    h.workerPacketRefusal.mockReturnValue({
      code: 'worker_packet_mismatch',
      message: 'Worker credential cannot address this packet.',
    });
    const response = await route.GET(new NextRequest(
      'http://localhost/api/orchestrator/workspace?packetId=packet-1',
    ));

    expect(response.status).toBe(403);
    expect(h.findLane).not.toHaveBeenCalled();
  });
});
