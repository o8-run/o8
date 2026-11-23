import { afterEach, describe, expect, it, vi } from 'vitest';

import { idleGateStats, noteRequest, resetIdleGate } from '@/lib/background-work/idle-gate';
import { publishPacketTailEvent } from './packet-tail';

afterEach(() => {
  vi.restoreAllMocks();
  resetIdleGate();
});

describe('publishPacketTailEvent', () => {
  it('posts the live event as a server self-request the idle gate does not count', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    publishPacketTailEvent({ id: 'event-1', laneId: 'lane-packet-tail', verb: 'close_timing', actor: 'system',
      payload: { packetId: 'pkt-packet-tail' }, timestamp: new Date().toISOString() });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toMatch(/\/internal\/packet-tail$/);

    // The headers the server receives, as the HTTP handler hands them to the gate.
    const headers = Object.fromEntries(Object.entries(init!.headers as Record<string, string>)
      .map(([name, value]) => [name.toLowerCase(), value]));
    resetIdleGate();
    noteRequest(headers, 'POST', '/internal/packet-tail');
    const stats = idleGateStats();
    expect(stats.activity).toEqual({});
    expect(stats.ignored).toEqual({ 'server self-request': 1 });
  });
});
