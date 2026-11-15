import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/lane/registry', () => ({
  findLaneByPacket: () => ({ packetId: 'pkt-1', status: 'failed' }),
  getLane: () => null,
}));
vi.mock('@/lib/orchestrator/control-plane', () => ({
  ControlPlaneLockTimeoutError: class extends Error {},
  readOrchestratorControlPlaneState: () => ({ missionId: 'mission-1', packets: [{ id: 'pkt-1', status: 'blocked' }] }),
}));
vi.mock('@/lib/orchestrator/mission-registry', () => ({ findMissionRegistryEntryByPacketId: () => null }));
vi.mock('@/lib/tasks/actions', () => ({ TaskMutationError: class extends Error {} }));

import { O8ApiError } from '@/lib/mcp/api-error';
import { lifecycleErrorResult } from './lifecycle-error';

describe('steer_packet on a failed packet', () => {
  it('names the packet state and the recovery call instead of a bare 409', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = lifecycleErrorResult(
      'steer_packet',
      new O8ApiError(409, 'o8 API error (409)', { code: 'steer_unavailable', message: 'No parked session to steer.' }),
      'pkt-1',
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body).toMatchObject({
      ok: false, code: 'steer_unavailable', packetId: 'pkt-1', missionId: 'mission-1', state: 'failed', packetState: 'blocked',
    });
    expect(body.next).toContain('retry_packet({"packetId":"pkt-1"})');
  });
});
