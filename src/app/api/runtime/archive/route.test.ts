import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const stateMocks = vi.hoisted(() => ({
  codex: vi.fn(),
  claude: vi.fn(),
  cursor: vi.fn(),
  gemini: vi.fn(),
  grok: vi.fn(),
  opencode: vi.fn(),
  pi: vi.fn(),
  prime: vi.fn(),
  archiveClaude: vi.fn(),
  archiveCursor: vi.fn(),
  archiveGrok: vi.fn(),
  archivePi: vi.fn(),
  archivePrime: vi.fn(),
  archiveOwned: vi.fn(),
  getLane: vi.fn(),
  archiveLane: vi.fn(),
  findLaneBySession: vi.fn(),
}));

vi.mock('@/lib/codex/owned', () => ({
  archiveOwnedCodexSession: vi.fn(),
  ownedCodexSessionState: stateMocks.codex,
}));
vi.mock('@/lib/claude-code/owned', () => ({
  archiveOwnedClaudeCodeSession: stateMocks.archiveClaude,
  ownedClaudeCodeSessionState: stateMocks.claude,
}));
vi.mock('@/lib/cursor/owned', () => ({
  archiveOwnedCursorSession: stateMocks.archiveCursor,
  ownedCursorSessionState: stateMocks.cursor,
}));
vi.mock('@/lib/gemini/owned', () => ({
  archiveOwnedGeminiSession: vi.fn(),
  ownedGeminiSessionState: stateMocks.gemini,
}));
vi.mock('@/lib/grok/owned', () => ({
  archiveOwnedGrokSession: stateMocks.archiveGrok,
  ownedGrokSessionState: stateMocks.grok,
}));
vi.mock('@/lib/opencode/owned', () => ({
  archiveOwnedOpencodeSession: vi.fn(),
  ownedOpencodeSessionState: stateMocks.opencode,
}));
vi.mock('@/lib/pi/owned', () => ({
  archiveOwnedPiSession: stateMocks.archivePi,
  ownedPiSessionState: stateMocks.pi,
}));
vi.mock('@/lib/prime-agent/owned', () => ({
  archiveOwnedPrimeAgentSession: stateMocks.archivePrime,
  ownedPrimeAgentSessionState: stateMocks.prime,
}));
vi.mock('@/lib/lane/registry', () => ({
  getLane: stateMocks.getLane,
  archiveLane: stateMocks.archiveLane,
  findLaneBySession: stateMocks.findLaneBySession,
}));
vi.mock('@/lib/runtime/inventory', () => ({ invalidateRuntimeInventoryCache: vi.fn() }));
vi.mock('@/lib/runtime/owned-session-archive', () => ({
  archiveOwnedRuntimeSession: stateMocks.archiveOwned,
}));
vi.mock('@/lib/runtimes/shared/owned-session-index', () => ({
  readOwnedSessionRecord: vi.fn(async () => ({ repoPath: process.cwd() })),
}));
vi.mock('@/lib/runtimes', () => ({}));
vi.mock('@/lib/runtimes/shared/owned-session-lifecycle', () => ({
  getOwnedSessionLifecycle: vi.fn(() => undefined),
}));

import { GET, POST } from './route';
import { __resetIdempotencyStoreForTests } from '@/lib/orchestrator/idempotency-store';

function request(sessionKeys: string[]) {
  return new NextRequest(`http://localhost/api/runtime/archive?sessionKeys=${encodeURIComponent(sessionKeys.join(','))}`);
}

function post(body: unknown) {
  return new NextRequest('http://localhost/api/runtime/archive', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  stateMocks.codex.mockResolvedValue('active');
  stateMocks.claude.mockResolvedValue('missing');
  stateMocks.cursor.mockResolvedValue('missing');
  stateMocks.gemini.mockResolvedValue('archived');
  stateMocks.grok.mockResolvedValue('active');
  stateMocks.opencode.mockResolvedValue('missing');
  stateMocks.pi.mockResolvedValue('active');
  stateMocks.prime.mockResolvedValue('archived');
  stateMocks.getLane.mockReturnValue(null);
  stateMocks.findLaneBySession.mockReturnValue(null);
  stateMocks.archiveLane.mockReturnValue(null);
  stateMocks.archiveOwned.mockResolvedValue(null);
  __resetIdempotencyStoreForTests();
});

describe('GET /api/runtime/archive', () => {
  it('routes full owned keys by prefix, dedupes them, and fails open per key', async () => {
    const codexKey = 'codex-owned:codex-owned-1';
    const cursorKey = 'cursor-owned:cursor-owned-1';
    stateMocks.cursor.mockRejectedValue(new Error('uncertain filesystem'));

    const response = await GET(request([
      ` ${codexKey} `,
      'gemini-owned:gemini-owned-1',
      'opencode-owned:opencode-owned-1',
      cursorKey,
      'grok-owned:grok-owned-1',
      'unknown-owned:unknown-1',
      codexKey,
    ]));

    expect(await response.json()).toEqual({
      states: {
        [codexKey]: 'active',
        'gemini-owned:gemini-owned-1': 'archived',
        'opencode-owned:opencode-owned-1': 'missing',
        [cursorKey]: 'active',
        'grok-owned:grok-owned-1': 'active',
        'unknown-owned:unknown-1': 'active',
      },
    });
    expect(stateMocks.codex).toHaveBeenCalledOnce();
    expect(stateMocks.cursor).toHaveBeenCalledOnce();
  });

  it('caps the state lookup at 100 unique keys', async () => {
    const sessionKeys = Array.from({ length: 101 }, (_, index) => `codex-owned:codex-owned-${index}`);

    const response = await GET(request(sessionKeys));
    const body = await response.json() as { states: Record<string, string> };

    expect(Object.keys(body.states)).toHaveLength(100);
    expect(stateMocks.codex).toHaveBeenCalledTimes(100);
  });
});

describe('POST /api/runtime/archive', () => {
  it('archives a failed lane that never received a session key', async () => {
    const lane = {
      id: 'lane-sessionless',
      sessionKey: null,
      status: 'failed',
    };
    stateMocks.getLane.mockReturnValue(lane);
    stateMocks.archiveLane.mockReturnValue({ ...lane, status: 'archived' });

    const response = await POST(post({
      laneId: lane.id,
      clientMutationId: 'archive-sessionless-lane',
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      archived: true,
      laneId: lane.id,
    });
    expect(stateMocks.archiveLane).toHaveBeenCalledWith(lane.id, 'user');
  });

  it('refuses to hide a live sessionless lane', async () => {
    stateMocks.getLane.mockReturnValue({
      id: 'lane-running',
      sessionKey: null,
      status: 'running',
    });

    const response = await POST(post({
      laneId: 'lane-running',
      clientMutationId: 'archive-running-lane',
    }));

    expect(response.status).toBe(409);
    expect(stateMocks.archiveLane).not.toHaveBeenCalled();
  });

  it('retires the lane behind an archived session so the rail row leaves', async () => {
    const sessionKey = 'codex-owned:lane-failed';
    const lane = { id: 'lane-failed', sessionKey, status: 'failed' };
    stateMocks.archiveOwned.mockResolvedValue({ archived: true, note: 'Session archived.' });
    stateMocks.findLaneBySession.mockReturnValue(lane);
    stateMocks.archiveLane.mockReturnValue({ ...lane, status: 'archived' });

    const response = await POST(post({ sessionKey, clientMutationId: 'archive-failed-session' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, archived: true, laneId: lane.id });
    expect(stateMocks.archiveLane).toHaveBeenCalledWith(lane.id, 'user');
  });

  it('leaves a live lane running when only its session was archived', async () => {
    const sessionKey = 'codex-owned:lane-reviewing';
    stateMocks.archiveOwned.mockResolvedValue({ archived: true, note: 'Session archived.' });
    stateMocks.findLaneBySession.mockReturnValue({ id: 'lane-reviewing', sessionKey, status: 'reviewing' });

    const response = await POST(post({ sessionKey, clientMutationId: 'archive-reviewing-session' }));

    expect(response.status).toBe(200);
    expect(await response.json()).not.toMatchObject({ laneId: 'lane-reviewing' });
    expect(stateMocks.archiveLane).not.toHaveBeenCalled();
  });

  it('requires caller correlation before changing archive state', async () => {
    const response = await POST(post({ laneId: 'lane-without-correlation' }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('clientMutationId'),
    });
    expect(stateMocks.getLane).not.toHaveBeenCalled();
    expect(stateMocks.archiveOwned).not.toHaveBeenCalled();
  });

  it('returns a truthful 202 while an identical archive is still running', async () => {
    let complete: ((value: { archived: true; note: string }) => void) | undefined;
    stateMocks.archiveOwned.mockImplementationOnce(() => new Promise((resolve) => {
      complete = resolve;
    }));
    const body = {
      sessionKey: 'codex-owned:archive-in-progress',
      clientMutationId: 'archive-in-progress-1',
    };

    const firstPromise = POST(post(body));
    await vi.waitFor(() => expect(stateMocks.archiveOwned).toHaveBeenCalledTimes(1));
    const duplicate = await POST(post(body));

    expect(duplicate.status).toBe(202);
    await expect(duplicate.json()).resolves.toMatchObject({
      ok: true,
      archived: false,
      sessionKey: body.sessionKey,
      clientMutationId: body.clientMutationId,
      status: 'in_progress',
      inProgress: true,
      replayed: true,
    });
    expect(stateMocks.archiveOwned).toHaveBeenCalledTimes(1);

    complete?.({ archived: true, note: 'Archived once.' });
    expect((await firstPromise).status).toBe(200);
  });

  it('rejects one mutation id reused for a changed archive target', async () => {
    const firstLane = {
      id: 'lane-first-target',
      sessionKey: null,
      status: 'failed',
    };
    stateMocks.getLane.mockReturnValue(firstLane);
    stateMocks.archiveLane.mockReturnValue({ ...firstLane, status: 'archived' });
    const clientMutationId = 'archive-body-conflict';

    expect((await POST(post({ laneId: firstLane.id, clientMutationId }))).status).toBe(200);
    const conflict = await POST(post({ laneId: 'lane-changed-target', clientMutationId }));

    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: expect.stringContaining('different runtime archive'),
    });
    expect(stateMocks.archiveLane).toHaveBeenCalledTimes(1);
  });
});
