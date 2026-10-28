// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchWithLongLivedBudget,
  installLongLivedFetchBudgetGuard,
  resetLongLivedFetchBudgetForTests,
  snapshotLongLivedFetchBudgetForTests,
} from './connection-budget';

function neverEndingSseResponse(): Response {
  return new Response(new ReadableStream<Uint8Array>(), {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
}

describe('long-lived fetch budget guard', () => {
  beforeEach(() => {
    resetLongLivedFetchBudgetForTests();
  });

  afterEach(() => {
    resetLongLivedFetchBudgetForTests();
    vi.restoreAllMocks();
  });

  it('logs holder labels when same-origin SSE requests exceed the budget and releases on cancel', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    window.fetch = vi.fn(async () => neverEndingSseResponse()) as unknown as typeof fetch;

    installLongLivedFetchBudgetGuard();

    const responses = await Promise.all([
      window.fetch('/api/v2/chat'),
      window.fetch('/api/v2/chat'),
      window.fetch('/api/v2/chat'),
      window.fetch('/api/v2/chat'),
      window.fetch('/api/v2/chat'),
    ]);

    expect(snapshotLongLivedFetchBudgetForTests()).toEqual([
      'GET /api/v2/chat',
      'GET /api/v2/chat',
      'GET /api/v2/chat',
      'GET /api/v2/chat',
      'GET /api/v2/chat',
    ]);
    expect(errorSpy).toHaveBeenCalledWith(
      '[conn-budget] long-lived app-origin request budget exceeded',
      expect.objectContaining({
        count: 5,
        limit: 4,
        holders: [
          'GET /api/v2/chat',
          'GET /api/v2/chat',
          'GET /api/v2/chat',
          'GET /api/v2/chat',
          'GET /api/v2/chat',
        ],
      }),
    );

    await Promise.all(responses.map((response) => response.body?.cancel()));
    expect(snapshotLongLivedFetchBudgetForTests()).toEqual([]);
  });

  it('tracks explicitly marked long-lived fetches before response headers arrive', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const resolvers: Array<(response: Response) => void> = [];
    window.fetch = vi.fn(() => new Promise<Response>((resolve) => {
      resolvers.push(resolve);
    })) as unknown as typeof fetch;

    const requests = Array.from({ length: 5 }, () => fetchWithLongLivedBudget('/api/runtime/transcript'));

    expect(snapshotLongLivedFetchBudgetForTests()).toEqual([
      'GET /api/runtime/transcript',
      'GET /api/runtime/transcript',
      'GET /api/runtime/transcript',
      'GET /api/runtime/transcript',
      'GET /api/runtime/transcript',
    ]);
    expect(errorSpy).toHaveBeenCalledWith(
      '[conn-budget] long-lived app-origin request budget exceeded',
      expect.objectContaining({ count: 5, limit: 4 }),
    );

    resolvers.forEach((resolve) => resolve(new Response(null, { status: 204 })));
    await Promise.all(requests);
    expect(snapshotLongLivedFetchBudgetForTests()).toEqual([]);
  });

  it('still aborts ordinary app requests without headers after 45 seconds', async () => {
    vi.useFakeTimers();
    try {
      window.fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      })) as typeof fetch;
      installLongLivedFetchBudgetGuard();
      const pending = window.fetch('/api/panel/app/update-state');
      const rejected = expect(pending).rejects.toThrow('no response headers in 45s');
      await vi.advanceTimersByTimeAsync(45_000);
      await rejected;
      expect(snapshotLongLivedFetchBudgetForTests()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
