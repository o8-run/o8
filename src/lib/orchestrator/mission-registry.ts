import 'server-only';

import { getSqlite } from '@/lib/db';
import { hasCanonicalReleaseEvidence } from '@/lib/orchestrator/packet-release-truth';
import { packetReleaseIdentityIsCurrent } from '@/lib/orchestrator/release-ownership';
import { buildDependencyGraph } from '@/lib/orchestrator/dag';
import { normalizeOrchestratorMissionState } from '@/lib/orchestrator/store';
import { normalizeOrchestratorMissionStateForPersistence } from '@/lib/orchestrator/persisted-mission';
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';
import { assertMissionSnapshotAvailable } from './mission-snapshot-availability';

interface MissionStateRow {
  id: string;
  mission_state_json: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

export interface MissionRegistryEntry {
  id: string;
  mission: OrchestratorMissionState;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

const registryMutationLocks = new Map<string, Promise<void>>();

function nextRegistryVersion(missionId: string): number {
  const row = getSqlite().prepare('SELECT updated_at FROM missions WHERE id = ?')
    .get(missionId) as Pick<MissionStateRow, 'updated_at'> | undefined;
  return Math.max(Date.now(), (row?.updated_at ?? 0) + 1);
}

function parseMissionState(json: string | null, strict = false): OrchestratorMissionState | null {
  if (!json?.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (strict) assertMissionSnapshotAvailable(parsed);
    return normalizeOrchestratorMissionState(parsed as OrchestratorMissionState);
  } catch {
    if (strict) throw new Error('Stored packet snapshot is unavailable.');
    return null;
  }
}

function archiveRegistryRowUnlocked(id: string) {
  const archivedAt = Date.now();
  const version = nextRegistryVersion(id);
  getSqlite().prepare(`
    UPDATE missions SET archived_at = ?, updated_at = ?
     WHERE id = ? AND archived_at IS NULL
  `).run(archivedAt, version, id);
}

function queueArchiveRegistryRow(id: string) {
  const missionId = id.trim();
  if (!missionId) return;
  void withRegistryMutationLock(missionId, async () => {
    archiveRegistryRowUnlocked(missionId);
  }).catch((error) => {
    console.warn(`[mission-registry] Failed to archive ${missionId}: ${error instanceof Error ? error.message : String(error)}`);
  });
}

function packetIsActive(packet: OrchestratorPacket) {
  if (packet.archivedAt || packet.releaseState === 'released') return false;
  if (packet.status === 'failed' || packet.status === 'archived') return false;
  if (packet.queueState === 'queued' || packet.queueState === 'held') return true;
  return packet.status === 'launching'
    || packet.status === 'running'
    || packet.status === 'recovering'
    || packet.status === 'awaiting_review';
}

export function missionHasPendingHeadlessWork(state: OrchestratorMissionState) {
  return state.packets.some((packet) => {
    if (!packetIsActive(packet)) return false;
    return packet.queueState === 'queued'
      || packet.status === 'queued'
      || packet.status === 'launching'
      || packet.status === 'running'
      || packet.status === 'recovering';
  });
}

export function missionIsTerminal(state: OrchestratorMissionState) {
  return state.packets.length > 0 && state.packets.every((packet) => !packetIsActive(packet));
}

function missionRegistryEntryFromRow(row: MissionStateRow, strict = false): MissionRegistryEntry | null {
  const mission = parseMissionState(row.mission_state_json, strict);
  return mission ? {
    id: row.id,
    mission,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  } : null;
}

export function readMissionRegistryEntry(
  missionId: string,
  options: { includeArchived?: boolean } = {},
): MissionRegistryEntry | null {
  const normalizedId = missionId.trim();
  if (!normalizedId) return null;
  const row = getSqlite().prepare(`
    SELECT id, mission_state_json, created_at, updated_at, archived_at
      FROM missions
     WHERE id = ?
       ${options.includeArchived ? '' : 'AND archived_at IS NULL'}
  `).get(normalizedId) as MissionStateRow | undefined;
  return row ? missionRegistryEntryFromRow(row) : null;
}

export function listMissionRegistryEntries(
  options: { includeArchived?: boolean; excludeMissionId?: string | null; strict?: boolean } = {},
): MissionRegistryEntry[] {
  const rows = getSqlite().prepare(`
    SELECT id, mission_state_json, created_at, updated_at, archived_at
      FROM missions
     WHERE ${options.includeArchived ? '1 = 1' : 'archived_at IS NULL'}
     ORDER BY created_at ASC
  `).all() as MissionStateRow[];

  const entries: MissionRegistryEntry[] = [];
  const excludeMissionId = options.excludeMissionId?.trim() ?? '';
  for (const row of rows) {
    if (excludeMissionId && row.id === excludeMissionId) continue;
    const entry = missionRegistryEntryFromRow(row, options.strict);
    if (!entry) continue;
    entries.push(entry);
  }
  return entries;
}

export function listActiveMissionRegistryEntries(currentMissionId?: string | null): MissionRegistryEntry[] {
  const rows = getSqlite().prepare(`
    SELECT id, mission_state_json, created_at, updated_at, archived_at
      FROM missions
     WHERE archived_at IS NULL
     ORDER BY created_at ASC
  `).all() as MissionStateRow[];

  const entries: MissionRegistryEntry[] = [];
  const excludeMissionId = currentMissionId?.trim() ?? '';
  for (const row of rows) {
    if (excludeMissionId && row.id === excludeMissionId) continue;
    const entry = missionRegistryEntryFromRow(row);
    if (!entry || missionIsTerminal(entry.mission)) {
      queueArchiveRegistryRow(row.id);
      continue;
    }
    entries.push(entry);
  }
  return entries;
}

export function findMissionRegistryEntryByPacketId(
  packetId: string,
  options: { includeArchived?: boolean; excludeMissionId?: string | null } = {},
): MissionRegistryEntry | null {
  const normalizedPacketId = packetId.trim();
  if (!normalizedPacketId) return null;
  return listMissionRegistryEntries(options)
    .find((entry) => entry.mission.packets.some((packet) => packet.id === normalizedPacketId)) ?? null;
}

export function hasRegistryPendingHeadlessWork(currentMissionId?: string | null) {
  return listActiveMissionRegistryEntries(currentMissionId)
    .some((entry) => missionHasPendingHeadlessWork(entry.mission));
}

function preserveReleasedPackets(state: OrchestratorMissionState): OrchestratorMissionState {
  const current = readMissionRegistryEntry(state.missionId!, { includeArchived: true });
  if (!current) return state;
  const durable = new Map(current.mission.packets.map((packet) => [packet.id, packet]));
  const packets = state.packets.map((packet) => {
    const persisted = durable.get(packet.id);
    durable.delete(packet.id);
    if (!persisted) return packet;
    // Compare every durable packet before accepting release evidence. A released
    // mirror from before reset must not revive its old generation or receipt.
    const generationOrder = (packet.storageAdmissionEpoch ?? 0) - (persisted.storageAdmissionEpoch ?? 0)
      || (packet.attemptCount ?? 0) - (persisted.attemptCount ?? 0);
    if (generationOrder < 0) return persisted;
    if (generationOrder > 0) return packet;
    // In the same generation, pending mirrors cannot undo canonical release.
    // Explicit ownership-checked registry mutations can still reset in place.
    if (persisted.releaseState === 'released' && hasCanonicalReleaseEvidence(persisted)
      && !(packet.releaseState === 'released' && hasCanonicalReleaseEvidence(packet))) return persisted;
    return packet;
  });
  const omittedReleased = [...durable.values()].filter((packet) => (
    packet.releaseState === 'released' && hasCanonicalReleaseEvidence(packet)
  ));
  return { ...state, packets: [...packets, ...omittedReleased] };
}

function writeMissionRegistryStateUnlocked(state: OrchestratorMissionState, mirror = false): OrchestratorMissionState | null {
  const missionId = state.missionId?.trim();
  if (!missionId) return null;
  const write = getSqlite().transaction(() => {
    // Read and write under the SQLite transaction as well as the in-process
    // registry lock, so another process's release cannot land between them.
    const normalized = normalizeOrchestratorMissionStateForPersistence(mirror ? preserveReleasedPackets(state) : state);
    const waves = buildDependencyGraph(normalized.packets).map((node) => node.wave);
    const archivedAt = missionIsTerminal(normalized) ? Date.now() : null;
    const version = nextRegistryVersion(missionId);
    getSqlite().prepare(`
      UPDATE missions
         SET prompt = ?, summary = ?, constraints = ?, packet_meta_json = ?,
             mission_state_json = ?, total_waves = ?, updated_at = ?, archived_at = ?
       WHERE id = ?
    `).run(
      normalized.prompt,
      normalized.summary,
      normalized.constraints,
      JSON.stringify(normalized.packets.map((packet) => ({
        id: packet.id,
        title: packet.title,
        referenceLabel: packet.referenceLabel,
      }))),
      JSON.stringify(normalized),
      Math.max(1, ...waves),
      version,
      archivedAt,
      missionId,
    );
    return normalized;
  });
  return write.immediate();
}

async function withRegistryMutationLock<T>(missionId: string, fn: () => Promise<T>): Promise<T> {
  const key = missionId.trim();
  const previous = registryMutationLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const lock = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.catch(() => {}).then(() => lock);
  registryMutationLocks.set(key, chained);
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (registryMutationLocks.get(key) === chained) {
      registryMutationLocks.delete(key);
    }
  }
}

export async function withMissionRegistryState<T>(
  missionId: string,
  updater: (state: OrchestratorMissionState) => Promise<{ state: OrchestratorMissionState; result: T }> | { state: OrchestratorMissionState; result: T },
): Promise<{ state: OrchestratorMissionState; result: T }> {
  const normalizedId = missionId.trim();
  if (!normalizedId) {
    throw new Error('missionId is required.');
  }

  return withRegistryMutationLock(normalizedId, async () => {
    const entry = readMissionRegistryEntry(normalizedId, { includeArchived: true });
    if (!entry) {
      throw new Error(`Mission ${normalizedId} not found.`);
    }
    const next = await updater(entry.mission);
    const persisted = writeMissionRegistryStateUnlocked({
      ...next.state,
      missionId: normalizedId,
    });
    if (!persisted) {
      throw new Error(`Mission ${normalizedId} could not be persisted.`);
    }
    return { result: next.result, state: persisted };
  });
}

export async function persistMissionRegistryState(state: OrchestratorMissionState): Promise<OrchestratorMissionState | null> {
  const missionId = state.missionId?.trim();
  if (!missionId) return null;
  return withRegistryMutationLock(missionId, async () => writeMissionRegistryStateUnlocked(state, true));
}

/** Publish a current mission only when its captured registry version has not advanced. */
export async function persistMissionRegistryStateIfVersion(
  state: OrchestratorMissionState,
  expectedUpdatedAt: number,
): Promise<boolean> {
  const missionId = state.missionId?.trim();
  if (!missionId) return false;
  return withRegistryMutationLock(missionId, async () => {
    const publish = getSqlite().transaction(() => {
      const current = readMissionRegistryEntry(missionId, { includeArchived: true });
      if (!current || current.updatedAt !== expectedUpdatedAt) return false;
      return writeMissionRegistryStateUnlocked(state, true) !== null;
    });
    return publish.immediate();
  });
}

/** Persist only the released packet into its durable owner before retiring its lane. */
export async function persistReleasedPacketToMission(
  packet: OrchestratorPacket,
  laneId: string,
  generation: string,
): Promise<boolean> {
  if (packet.releaseState !== 'released' || !hasCanonicalReleaseEvidence(packet)) {
    throw new Error('Canonical packet release evidence is required.');
  }
  const owner = findMissionRegistryEntryByPacketId(packet.id, { includeArchived: true });
  // Legacy/lane-only packets may have no registry row.
  if (!owner) return true;
  return withRegistryMutationLock(owner.id, async () => {
    const write = getSqlite().transaction(() => {
      const current = readMissionRegistryEntry(owner.id, { includeArchived: true });
      const target = current?.mission.packets.find((candidate) => candidate.id === packet.id);
      if (!current || !target || !packetReleaseIdentityIsCurrent(target, laneId, generation, true)) return false;
      Object.assign(target, {
        status: packet.status,
        queueState: packet.queueState,
        releaseState: packet.releaseState,
        releaseStatePayload: packet.releaseStatePayload,
        blockedReason: packet.blockedReason,
        recovery: packet.recovery,
        ...(packet.review?.reviewedHeadSha === packet.releaseStatePayload?.headSha ? { review: packet.review } : {}),
        lastEventAt: packet.lastEventAt,
        lastEventLabel: packet.lastEventLabel,
        lane: packet.lane,
      });
      writeMissionRegistryStateUnlocked(current.mission);
      return true;
    });
    return write.immediate();
  });
}
