import { beforeEach, describe, expect, it, vi } from 'vitest';

const appendEvent = vi.fn();
const packet = { id: 'pkt-1', title: 't', summary: 's', allowedFiles: ['src/a.ts'], lastEventLabel: null as string | null };

vi.mock('@/lib/lane/registry', () => ({
  appendEvent: (...args: unknown[]) => appendEvent(...args),
  listLanes: () => [{ id: 'lane-1', packetId: 'pkt-1' }],
}));
vi.mock('@/lib/orchestrator/control-plane', () => ({
  withLockedState: async (mutate: (state: { packets: Array<typeof packet> }) => unknown) => ({ result: mutate({ packets: [packet] }) }),
}));

import { requestPacketScopeExpansion } from './packet-scope-expansion';

describe('packet scope expansion audit record', () => {
  beforeEach(() => {
    appendEvent.mockClear();
    packet.allowedFiles = ['src/a.ts'];
    packet.lastEventLabel = null;
  });

  it('records a lead grant as scope_granted with the paths and reason', async () => {
    const result = await requestPacketScopeExpansion({
      packetId: 'pkt-1', paths: ['src/b.ts'], reason: 'caller needs the same fix', grantedBy: 'lead',
    });
    expect(result).toMatchObject({ laneId: 'lane-1', grantedBy: 'lead', expanded: true, allowedPaths: ['src/a.ts', 'src/b.ts'] });
    expect(packet.lastEventLabel).toBe('scope_granted');
    expect(appendEvent).toHaveBeenCalledWith('lane-1', 'scope_granted', 'orchestrator', expect.objectContaining({
      packetId: 'pkt-1', requestedPaths: ['src/b.ts'], allowedPaths: ['src/a.ts', 'src/b.ts'], reason: 'caller needs the same fix',
    }));
  });

  it('keeps a worker request as scope_expansion_requested, which holds the packet for inspection', async () => {
    const result = await requestPacketScopeExpansion({ packetId: 'pkt-1', paths: ['src/b.ts'], reason: 'caller needs the same fix' });
    expect(result.grantedBy).toBe('worker');
    expect(packet.lastEventLabel).toBe('scope_expansion_requested');
    expect(appendEvent).toHaveBeenCalledWith('lane-1', 'scope_expansion_requested', 'orchestrator', expect.anything());
  });

  it('refuses an unbounded grant', async () => {
    await expect(requestPacketScopeExpansion({ packetId: 'pkt-1', paths: ['**/*'], reason: 'everything please', grantedBy: 'lead' }))
      .rejects.toThrow('not bounded');
    expect(appendEvent).not.toHaveBeenCalled();
  });
});
