import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { publishArtifactRecorded, publishCortexChange } from '@/lib/realtime/publisher';
import { scheduleNextServerStartup } from '@/lib/startup/schedule';

import { atRest, noteRequest, resetIdleGate, startIdleGate } from './idle-gate';

vi.mock('@/lib/ws-auth', () => ({ getOrCreateWsToken: () => 'token' }));

const sent: Array<{ url: string; method: string; headers: Record<string, string> }> = [];

beforeEach(() => {
  vi.useFakeTimers();
  resetIdleGate();
  startIdleGate({ liveSessions: () => false });
  sent.length = 0;
  // The server receives each request it sends to itself and the gate classifies it.
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)
      .map(([key, value]) => [key.toLowerCase(), value]));
    const method = init.method ?? 'GET';
    sent.push({ url: String(url), method, headers });
    noteRequest(headers, method);
    return new Response(JSON.stringify({ product: 'o8' }), { status: 200 });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetIdleGate();
  vi.useRealTimers();
});

it("keeps the server at rest through its own change notices and boot requests", async () => {
  vi.advanceTimersByTime(120_000);
  expect(atRest()).toBe(true);

  // An always-on loop (the external merge watcher) records merged directives at rest.
  await publishCortexChange({ scope: 'directive', reason: 'trailer:merged' });
  await publishArtifactRecorded({ artifactId: 'artifact-1' });
  scheduleNextServerStartup();
  await vi.advanceTimersByTimeAsync(2_500);

  expect(sent.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
    'POST /internal/cortex-changes',
    'POST /internal/artifacts',
    'GET /api/panel/status',
    'POST /api/review/auto-review',
  ]);
  expect(atRest()).toBe(true);
});
