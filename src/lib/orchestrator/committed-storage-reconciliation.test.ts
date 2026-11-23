import { beforeEach, expect, it, vi } from 'vitest';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { StorageReservationRecord } from '@/lib/workspace/storage-admission';

const registry = vi.hoisted(() => ({ stamp: '1:1:1', lookups: [] as string[] }));

vi.mock('@/lib/lane/registry', () => ({ listLanes: () => [] }));
vi.mock('@/lib/orchestrator/mission-registry', () => ({
  missionsStamp: () => registry.stamp,
  listDurablePacketsWithId: (ownerId: string) => {
    registry.lookups.push(ownerId);
    return [{ id: ownerId, status: 'archived', releaseState: 'released', lane: null } as unknown as OrchestratorPacket];
  },
}));
vi.mock('./storage-admission-owner-liveness', () => ({
  resolvePacketCheckoutByOwner: async () => ({ state: 'present', evidence: 'checkout exists' }),
}));

const { resolveCommittedPacketStorageOwner } = await import('./committed-storage-reconciliation');

function reservation(ownerId: string): StorageReservationRecord {
  return { reservationId: `packet-storage:${ownerId}:1`, ownerId, targetPath: '/tmp/worktrees' } as StorageReservationRecord;
}

beforeEach(() => {
  registry.stamp = '1:1:1';
  registry.lookups = [];
});

it('scans stored missions for an owner again only after a stored mission changes', async () => {
  for (let pass = 0; pass < 3; pass += 1) {
    await resolveCommittedPacketStorageOwner(reservation('pkt-a'));
    await resolveCommittedPacketStorageOwner(reservation('pkt-b'));
  }
  expect(registry.lookups).toEqual(['pkt-a', 'pkt-b']);

  registry.stamp = '1:2:2';
  const owner = await resolveCommittedPacketStorageOwner(reservation('pkt-a'));
  expect(registry.lookups).toEqual(['pkt-a', 'pkt-b', 'pkt-a']);
  // The checkout is still probed on every pass.
  expect(owner).toMatchObject({ liveness: 'alive', source: 'committed-storage-checkout' });
});
