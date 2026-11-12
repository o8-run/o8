import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const runtimeMocks = vi.hoisted(() => ({
  launchCodexFromMobile: vi.fn(),
  launchRuntimeSurface: vi.fn(),
  performRuntimeAction: vi.fn(),
}));

vi.mock('@/lib/runtime/actions', () => runtimeMocks);
vi.mock('@/lib/realtime/publisher', () => ({
  publishRealtimeMutation: vi.fn(async () => {}),
}));
vi.mock('@/lib/command-center/snapshot', () => ({
  invalidateCommandCenterSnapshotCaches: vi.fn(),
}));
vi.mock('@/lib/mobile/inbox', () => ({
  invalidateInboxCache: vi.fn(),
}));

// Warm the classic handler before timing in-flight actions; native forwarding keeps it cold.
await import('@/lib/mobile/action-route');
const actionRoute = await import('@/app/api/mobile/action/route');
const actionIdempotency = await import('@/lib/mobile/action-idempotency');
const { __resetIdempotencyStoreForTests } = await import('@/lib/orchestrator/idempotency-store');

function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3001/api/mobile/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('mobile action persisted idempotency', () => {
  beforeEach(() => {
    __resetIdempotencyStoreForTests();
    vi.clearAllMocks();
  });

  it('returns 202 for an in-flight duplicate and exactly replays a completed response', async () => {
    let resolveLaunch: ((value: {
      ok: true;
      action: 'launch';
      surfaceId: string;
      runtime: 'codex';
      status: 'queued';
      note: string;
    }) => void) | undefined;
    runtimeMocks.launchCodexFromMobile.mockImplementationOnce(() => new Promise((resolve) => {
      resolveLaunch = resolve;
    }));

    const body = {
      action: 'launch',
      sessionKey: 'launch:new',
      clientMutationId: 'mobile-launch-1',
      cwd: '/tmp/repo',
      message: 'Run the packet',
    };

    const firstPromise = actionRoute.POST(post(body));
    await vi.waitFor(() => expect(runtimeMocks.launchCodexFromMobile).toHaveBeenCalledTimes(1));

    const duplicateInFlight = await actionRoute.POST(post(body));
    expect(duplicateInFlight.status).toBe(202);
    expect(await duplicateInFlight.json()).toMatchObject({
      ok: true,
      status: 'queued',
      duplicate: true,
      inProgress: true,
      clientMutationId: 'mobile-launch-1',
    });
    expect(runtimeMocks.launchCodexFromMobile).toHaveBeenCalledTimes(1);

    const changedInFlight = await actionRoute.POST(post({
      ...body,
      message: 'Run a different packet',
    }));
    expect(changedInFlight.status).toBe(409);
    await expect(changedInFlight.json()).resolves.toMatchObject({
      ok: false,
      error: 'idempotency_conflict',
    });
    expect(runtimeMocks.launchCodexFromMobile).toHaveBeenCalledTimes(1);

    resolveLaunch?.({
      ok: true,
      action: 'launch',
      surfaceId: 'codex-owned:new',
      runtime: 'codex',
      status: 'queued',
      note: 'Launch queued.',
    });
    const first = await firstPromise;
    const firstBody = await first.json();
    expect(first.status).toBe(200);

    const completedReplay = await actionRoute.POST(post(body));
    expect(completedReplay.status).toBe(200);
    expect(completedReplay.headers.get('x-o8-idempotency-replayed')).toBe('1');
    expect(await completedReplay.json()).toEqual(firstBody);
    expect(runtimeMocks.launchCodexFromMobile).toHaveBeenCalledTimes(1);

    const changedAfterCompletion = await actionRoute.POST(post({
      ...body,
      attachments: [{
        mimeType: 'text/plain',
        fileName: 'changed.txt',
        content: 'changed attachment',
      }],
    }));
    expect(changedAfterCompletion.status).toBe(409);
    await expect(changedAfterCompletion.json()).resolves.toMatchObject({
      ok: false,
      error: 'idempotency_conflict',
    });
    expect(runtimeMocks.launchCodexFromMobile).toHaveBeenCalledTimes(1);
  });

  it('leaves legacy no-id calls outside the persisted guard', async () => {
    runtimeMocks.launchCodexFromMobile.mockResolvedValue({
      ok: true,
      action: 'launch',
      surfaceId: 'codex-owned:new',
      runtime: 'codex',
      status: 'queued',
      note: 'Launch queued.',
    });
    const body = {
      action: 'launch',
      sessionKey: 'launch:new',
      cwd: '/tmp/repo',
      message: 'Run the packet',
    };

    await actionRoute.POST(post(body));
    await actionRoute.POST(post(body));

    expect(runtimeMocks.launchCodexFromMobile).toHaveBeenCalledTimes(2);
  });

  it('does not cache a retryable runtime failure under the mutation id', async () => {
    runtimeMocks.performRuntimeAction.mockResolvedValue({
      ok: false,
      action: 'send_input',
      surfaceId: 'codex-owned:retryable-failure',
      runtime: 'codex',
      status: 'unavailable',
      note: 'Runtime is temporarily unavailable.',
    });
    const body = {
      action: 'steer',
      sessionKey: 'codex-owned:retryable-failure',
      clientMutationId: 'mobile-retryable-failure',
      message: 'continue',
    };

    const first = await actionRoute.POST(post(body));
    const second = await actionRoute.POST(post(body));

    expect(first.status).toBe(501);
    expect(second.status).toBe(501);
    expect(second.headers.get('x-o8-idempotency-replayed')).toBeNull();
    expect(runtimeMocks.performRuntimeAction).toHaveBeenCalledTimes(2);
  });

  it('replays a thrown runtime outcome as terminal without sending twice', async () => {
    runtimeMocks.performRuntimeAction.mockRejectedValue(new Error('provider response lost'));
    const body = {
      action: 'steer',
      sessionKey: 'codex-owned:ambiguous-failure',
      clientMutationId: 'mobile-ambiguous-failure',
      message: 'continue',
    };

    const first = await actionRoute.POST(post(body));
    const second = await actionRoute.POST(post(body));

    expect(first.status).toBe(500);
    expect(first.headers.get('x-o8-terminal-outcome')).toBe('unknown');
    expect(second.status).toBe(500);
    expect(second.headers.get('x-o8-idempotency-replayed')).toBe('1');
    await expect(second.json()).resolves.toMatchObject({
      ok: false,
      error: 'outcome_unknown',
      clientMutationId: 'mobile-ambiguous-failure',
      outcomeUnknown: true,
      retryable: false,
      message: 'provider response lost',
    });
    expect(runtimeMocks.performRuntimeAction).toHaveBeenCalledTimes(1);
  });

  it.each([
    'codex-owned:resume-ambiguous',
    'claude-code:resume-ambiguous',
    'codex:resume-ambiguous',
  ])('does not redeliver an ambiguous resume for %s', async (sessionKey) => {
    runtimeMocks.performRuntimeAction.mockRejectedValue(new Error('response lost after send'));
    const body = {
      action: 'resume',
      sessionKey,
      clientMutationId: `mobile-resume-${sessionKey}`,
      message: 'continue',
    };

    const first = await actionRoute.POST(post(body));
    const replay = await actionRoute.POST(post(body));

    expect(first.status).toBe(500);
    expect(first.headers.get('x-o8-terminal-outcome')).toBe('unknown');
    expect(replay.status).toBe(500);
    expect(replay.headers.get('x-o8-idempotency-replayed')).toBe('1');
    expect(runtimeMocks.performRuntimeAction).toHaveBeenCalledTimes(1);
  });

  it('returns structured JSON when the persisted idempotency store fails', async () => {
    vi.spyOn(actionIdempotency, 'bindMobileActionIdempotency').mockImplementationOnce(() => {
      throw new Error('sqlite write failed');
    });

    const response = await actionRoute.POST(post({
      action: 'launch',
      sessionKey: 'launch:new',
      clientMutationId: 'mobile-idempotency-store-failure',
      cwd: '/tmp/repo',
      message: 'Run the packet',
    }));

    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: 'mobile_action_failed',
      message: 'sqlite write failed',
    });
    expect(runtimeMocks.launchCodexFromMobile).not.toHaveBeenCalled();
  });
});
