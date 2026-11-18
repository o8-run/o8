import type { OrchestratorPacket } from './types';

export function normalizePacketStorageAdmissionEpoch(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 1;
}

export function advancePacketStorageAdmissionEpoch(packet: OrchestratorPacket): void {
  const current = Math.max(
    normalizePacketStorageAdmissionEpoch(packet.storageAdmissionEpoch),
    Number.isSafeInteger(packet.launchAttempts) && (packet.launchAttempts ?? 0) >= 0
      ? (packet.launchAttempts ?? 0) + (packet.storageAdmission ? 0 : 1)
      : 1,
    packet.storageAdmission?.ownerId === packet.id
      && Number.isSafeInteger(packet.storageAdmission.ownerGeneration)
      ? packet.storageAdmission.ownerGeneration
      : 1,
  );
  if (!Number.isSafeInteger(current) || current >= Number.MAX_SAFE_INTEGER) {
    throw new Error('The packet storage admission epoch cannot be advanced safely.');
  }
  packet.storageAdmissionEpoch = current + 1;
}

export function normalizePacketStorageAdmission(
  value: unknown,
): OrchestratorPacket['storageAdmission'] {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const states = new Set(['reserved', 'committed', 'held', 'released', 'quarantined']);
  const sources = new Set(['same-repo-history', 'source-size-fallback', 'apfs-clone-growth', 'unknown']);
  const numberOrNull = (candidate: unknown) => (
    typeof candidate === 'number' && Number.isSafeInteger(candidate) ? candidate : null
  );
  const pressure = normalizePressureReceipt(row.pressure);
  if (
    row.schema !== 'o8/packet-storage-admission/v1'
    || !states.has(String(row.state))
    || !sources.has(String(row.estimateSource))
    || typeof row.reason !== 'string'
    || typeof row.reservationId !== 'string'
    || typeof row.mutationId !== 'string'
    || typeof row.ownerId !== 'string'
  ) return null;
  const ownerGeneration = numberOrNull(row.ownerGeneration);
  const estimateBytes = numberOrNull(row.estimateBytes);
  const historySamples = numberOrNull(row.historySamples);
  const recordedAt = numberOrNull(row.recordedAt);
  if (ownerGeneration === null || estimateBytes === null || historySamples === null || recordedAt === null) return null;
  return {
    schema: 'o8/packet-storage-admission/v1',
    state: row.state as NonNullable<OrchestratorPacket['storageAdmission']>['state'],
    reason: row.reason,
    reservationId: row.reservationId,
    mutationId: row.mutationId,
    ownerId: row.ownerId,
    ownerGeneration,
    estimateBytes,
    estimateSource: row.estimateSource as NonNullable<OrchestratorPacket['storageAdmission']>['estimateSource'],
    historySamples,
    volumeId: typeof row.volumeId === 'string' ? row.volumeId : null,
    physicalAvailableBytes: numberOrNull(row.physicalAvailableBytes),
    reservedBeforeBytes: numberOrNull(row.reservedBeforeBytes),
    requiredReserveBytes: numberOrNull(row.requiredReserveBytes),
    dispatchHeadroomBytes: numberOrNull(row.dispatchHeadroomBytes),
    pressure,
    recordedAt,
  };
}

function normalizePressureReceipt(
  value: unknown,
): NonNullable<NonNullable<OrchestratorPacket['storageAdmission']>['pressure']> | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (
    row.schema !== 'o8/storage-pressure-decision/v1'
    || (row.mode !== 'manual' && row.mode !== 'pressure')
    || !['disabled', 'manual_review', 'admitted_after_parking', 'exhausted'].includes(String(row.status))
    || row.trigger !== 'reserve_breached'
    || !Number.isSafeInteger(row.launchGeneration)
    || !Number.isSafeInteger(row.recordedAt)
    || !Array.isArray(row.candidates)
  ) return null;
  const candidates = row.candidates.map(normalizePressureCandidate);
  if (candidates.some((candidate) => candidate === null)) return null;
  return {
    schema: 'o8/storage-pressure-decision/v1',
    mode: row.mode,
    status: row.status as 'disabled' | 'manual_review' | 'admitted_after_parking' | 'exhausted',
    trigger: 'reserve_breached',
    launchGeneration: row.launchGeneration as number,
    candidates: candidates as NonNullable<NonNullable<OrchestratorPacket['storageAdmission']>['pressure']>['candidates'],
    recordedAt: row.recordedAt as number,
  };
}

function normalizePressureCandidate(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const nullableInteger = (candidate: unknown) => (
    candidate === null || (typeof candidate === 'number' && Number.isSafeInteger(candidate))
      ? candidate as number | null
      : undefined
  );
  const measured = nullableInteger(row.measuredAllocatedBytes);
  const reclaimed = nullableInteger(row.verifiedReclaimedAvailableBytes);
  // Receipts persisted before the path was recorded stay readable as an unknown path.
  const workspacePath = row.workspacePath === undefined || row.workspacePath === null
    ? null
    : typeof row.workspacePath === 'string' ? row.workspacePath : undefined;
  if (
    workspacePath === undefined
    || typeof row.packetId !== 'string'
    || typeof row.laneId !== 'string'
    || typeof row.operationId !== 'string'
    || (row.repositoryUuid !== null && typeof row.repositoryUuid !== 'string')
    || measured === undefined
    || reclaimed === undefined
    || !['candidate', 'parked', 'already_parked', 'refused'].includes(String(row.outcome))
    || typeof row.reason !== 'string'
  ) return null;
  return {
    packetId: row.packetId,
    repositoryUuid: row.repositoryUuid as string | null,
    laneId: row.laneId,
    operationId: row.operationId,
    workspacePath,
    measuredAllocatedBytes: measured,
    verifiedReclaimedAvailableBytes: reclaimed,
    outcome: row.outcome as 'candidate' | 'parked' | 'already_parked' | 'refused',
    reason: row.reason,
  };
}
