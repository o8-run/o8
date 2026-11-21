import path from 'node:path';
import { getSqlite } from '@/lib/db';
import { ensureDependencySeedSchema } from '@/lib/db/v83-runtime-tables-migration';
import type { MetadataLockProcessIdentity } from '@/lib/worktree/metadata-lock-process-identity';
import {
  normalizedNamespacePath,
  type HdiSystemEntity,
} from './dependency-image-device-authority';
import { retireGovernedDependencyFile } from './dependency-image-file-authority';
export type DependencySeedImageState = 'building' | 'built' | 'ready' | 'retiring';
export type DependencySeedLeaseState = 'mounting' | 'mounted' | 'detaching' | 'blocked';
export interface DependencySeedImageRecord {
  recipeKey: string;
  generation: string;
  state: DependencySeedImageState;
  sourceReceiptId: string | null;
  sourceTreeDigest: string | null;
  publisherPid: number | null;
  publisherIdentity: MetadataLockProcessIdentity | null;
  imagePath: string;
  manifestPath: string;
  stagingDirectory: string;
  stagingPath: string;
  stagingDevice: number;
  stagingInode: number;
  imageDevice: number | null;
  imageInode: number | null;
  imageDigest: string | null;
  manifestDevice: number | null;
  manifestInode: number | null;
  manifestDigest: string | null;
  imageRetiredPath: string | null;
  imageRetirementPhase: number;
  manifestRetiredPath: string | null;
  manifestRetirementPhase: number;
  createdAt: number;
  updatedAt: number;
}
export interface DependencySeedLeaseRecord {
  leaseId: string;
  recipeKey: string;
  generation: string;
  workspacePath: string;
  shadowPath: string; mountPath: string; attachedImagePath: string | null;
  deviceEntry: string | null;
  systemEntities: HdiSystemEntity[] | null;
  helperPid: number | null;
  helperIdentity: MetadataLockProcessIdentity | null;
  baseDevice: number | null; baseInode: number | null;
  shadowDevice: number | null;
  shadowInode: number | null;
  mountDevice: number | null;
  mountInode: number | null;
  state: DependencySeedLeaseState;
  ownerPid: number;
  ownerIdentity: MetadataLockProcessIdentity;
  createdAt: number;
  updatedAt: number;
}
interface ImageRow {
  recipe_key: string;
  generation: string;
  state: string;
  source_receipt_id: string | null;
  source_tree_digest: string | null;
  publisher_pid: number | null;
  publisher_identity_json: string | null;
  image_path: string;
  manifest_path: string;
  staging_directory: string;
  staging_path: string;
  staging_device: number;
  staging_inode: number;
  image_device: number | null;
  image_inode: number | null;
  image_digest: string | null;
  manifest_device: number | null;
  manifest_inode: number | null;
  manifest_digest: string | null;
  image_retired_path: string | null;
  image_retirement_phase: number;
  manifest_retired_path: string | null;
  manifest_retirement_phase: number;
  created_at: number;
  updated_at: number;
}
interface LeaseRow {
  lease_id: string;
  recipe_key: string;
  generation: string;
  workspace_path: string;
  shadow_path: string;
  mount_path: string;
  attached_image_path: string | null;
  device_entry: string | null;
  system_entities_json: string | null;
  helper_pid: number | null;
  helper_identity_json: string | null;
  base_device: number | null;
  base_inode: number | null;
  shadow_device: number | null;
  shadow_inode: number | null;
  mount_device: number | null;
  mount_inode: number | null;
  state: string;
  owner_pid: number;
  owner_identity_json: string;
  created_at: number;
  updated_at: number;
}
let initializedDatabasePath: string | null = null;
// Leases written before the namespace fix stored /private-prefixed paths that the
// disk-image tooling never reports back, stranding those rows against every lookup
// and authority compare. Collapse them once, when the registry opens.
function normalizeStoredLeaseNamespaces(db: ReturnType<typeof getSqlite>): void {
  const rows = db.prepare(
    'SELECT lease_id, workspace_path, shadow_path, mount_path FROM dependency_seed_leases',
  ).all() as Array<Pick<LeaseRow, 'lease_id' | 'workspace_path' | 'shadow_path' | 'mount_path'>>;
  const update = db.prepare(`
    UPDATE dependency_seed_leases
    SET workspace_path = ?, shadow_path = ?, mount_path = ?
    WHERE lease_id = ?
  `);
  for (const row of rows) {
    const workspacePath = normalizedNamespacePath(row.workspace_path);
    const shadowPath = normalizedNamespacePath(row.shadow_path);
    const mountPath = normalizedNamespacePath(row.mount_path);
    if (workspacePath === row.workspace_path
      && shadowPath === row.shadow_path
      && mountPath === row.mount_path) continue;
    try {
      update.run(workspacePath, shadowPath, mountPath, row.lease_id);
    } catch (error) {
      // A row already duplicated under both spellings is its own fault to resolve.
      // Leaving it untouched keeps the registry openable for every other lease.
      if ((error as { code?: unknown }).code !== 'SQLITE_CONSTRAINT_UNIQUE') throw error;
    }
  }
}
function sqlite() {
  const db = getSqlite();
  if (initializedDatabasePath !== db.name) {
    ensureDependencySeedSchema(db);
    normalizeStoredLeaseNamespaces(db);
    initializedDatabasePath = db.name;
  }
  return db;
}
function decodeImage(row: ImageRow): DependencySeedImageRecord {
  return {
    recipeKey: row.recipe_key,
    generation: row.generation,
    state: row.state as DependencySeedImageState,
    sourceReceiptId: row.source_receipt_id,
    sourceTreeDigest: row.source_tree_digest,
    publisherPid: row.publisher_pid,
    publisherIdentity: row.publisher_identity_json
      ? JSON.parse(row.publisher_identity_json) as MetadataLockProcessIdentity : null,
    imagePath: row.image_path,
    manifestPath: row.manifest_path,
    stagingDirectory: row.staging_directory,
    stagingPath: row.staging_path,
    stagingDevice: row.staging_device,
    stagingInode: row.staging_inode,
    imageDevice: row.image_device,
    imageInode: row.image_inode,
    imageDigest: row.image_digest,
    manifestDevice: row.manifest_device,
    manifestInode: row.manifest_inode,
    manifestDigest: row.manifest_digest,
    imageRetiredPath: row.image_retired_path,
    imageRetirementPhase: row.image_retirement_phase,
    manifestRetiredPath: row.manifest_retired_path,
    manifestRetirementPhase: row.manifest_retirement_phase,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function decodeLease(row: LeaseRow): DependencySeedLeaseRecord {
  return {
    leaseId: row.lease_id,
    recipeKey: row.recipe_key,
    generation: row.generation,
    workspacePath: row.workspace_path,
    shadowPath: row.shadow_path,
    mountPath: row.mount_path,
    attachedImagePath: row.attached_image_path,
    deviceEntry: row.device_entry,
    systemEntities: row.system_entities_json
      ? JSON.parse(row.system_entities_json) as HdiSystemEntity[] : null,
    helperPid: row.helper_pid,
    helperIdentity: row.helper_identity_json
      ? JSON.parse(row.helper_identity_json) as MetadataLockProcessIdentity : null,
    baseDevice: row.base_device,
    baseInode: row.base_inode,
    shadowDevice: row.shadow_device,
    shadowInode: row.shadow_inode,
    mountDevice: row.mount_device,
    mountInode: row.mount_inode,
    state: row.state as DependencySeedLeaseState,
    ownerPid: row.owner_pid,
    ownerIdentity: JSON.parse(row.owner_identity_json) as MetadataLockProcessIdentity,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export function readDependencySeedImage(recipeKey: string): DependencySeedImageRecord | null {
  const row = sqlite().prepare(
    'SELECT * FROM dependency_seed_images WHERE recipe_key = ?',
  ).get(recipeKey) as ImageRow | undefined;
  return row ? decodeImage(row) : null;
}
export function listDependencySeedImages(
  states?: DependencySeedImageState[],
): DependencySeedImageRecord[] {
  const rows = states?.length
    ? sqlite().prepare(`
      SELECT * FROM dependency_seed_images
      WHERE state IN (${states.map(() => '?').join(', ')})
      ORDER BY created_at ASC, recipe_key ASC
    `).all(...states) as ImageRow[]
    : sqlite().prepare(
      'SELECT * FROM dependency_seed_images ORDER BY created_at ASC, recipe_key ASC',
    ).all() as ImageRow[];
  return rows.map(decodeImage);
}
export function beginDependencySeedImage(input: {
  recipeKey: string;
  generation: string;
  sourceReceiptId: string;
  sourceTreeDigest: string;
  publisherPid: number;
  publisherIdentity: MetadataLockProcessIdentity;
  imagePath: string;
  manifestPath: string;
  stagingDirectory: string;
  stagingPath: string;
  stagingDevice: number;
  stagingInode: number;
  now?: number;
}): DependencySeedImageRecord {
  const now = input.now ?? Date.now();
  const db = sqlite();
  const insert = db.transaction(() => {
    const existing = readDependencySeedImage(input.recipeKey);
    if (existing) return existing;
    db.prepare(`
      INSERT INTO dependency_seed_images (
        recipe_key, generation, state, source_receipt_id, source_tree_digest,
        publisher_pid, publisher_identity_json, image_path, manifest_path,
        staging_directory, staging_path, staging_device, staging_inode,
        created_at, updated_at
      ) VALUES (?, ?, 'building', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.recipeKey,
      input.generation,
      input.sourceReceiptId,
      input.sourceTreeDigest,
      input.publisherPid,
      JSON.stringify(input.publisherIdentity),
      path.resolve(input.imagePath),
      path.resolve(input.manifestPath),
      path.resolve(input.stagingDirectory),
      path.resolve(input.stagingPath),
      input.stagingDevice,
      input.stagingInode,
      now,
      now,
    );
    return readDependencySeedImage(input.recipeKey)!;
  });
  return insert.immediate();
}
function samePublisher(record: DependencySeedImageRecord, input: {
  publisherPid: number;
  publisherIdentity: MetadataLockProcessIdentity;
}): boolean {
  return record.publisherPid === input.publisherPid
    && record.publisherIdentity !== null
    && JSON.stringify(record.publisherIdentity) === JSON.stringify(input.publisherIdentity);
}
/** Transfer an unfinished generation only after the caller proves the prior process is gone. */
export function adoptDependencySeedImagePublisher(input: {
  recipeKey: string;
  generation: string;
  priorPublisherPid: number;
  priorPublisherIdentity: MetadataLockProcessIdentity;
  publisherPid: number;
  publisherIdentity: MetadataLockProcessIdentity;
  now?: number;
}): DependencySeedImageRecord | null {
  const result = sqlite().prepare(`
    UPDATE dependency_seed_images SET
      publisher_pid = ?, publisher_identity_json = ?, updated_at = ?
    WHERE recipe_key = ? AND generation = ? AND state IN ('building', 'built')
      AND publisher_pid = ? AND publisher_identity_json = ?
  `).run(
    input.publisherPid,
    JSON.stringify(input.publisherIdentity),
    input.now ?? Date.now(),
    input.recipeKey,
    input.generation,
    input.priorPublisherPid,
    JSON.stringify(input.priorPublisherIdentity),
  );
  const current = readDependencySeedImage(input.recipeKey);
  if (result.changes === 1) return current;
  if (current?.generation === input.generation && samePublisher(current, input)) return current;
  return null;
}
export function recordBuiltDependencySeedImage(input: {
  recipeKey: string;
  generation: string;
  publisherPid: number;
  publisherIdentity: MetadataLockProcessIdentity;
  imageDevice: number;
  imageInode: number;
  imageDigest: string;
  manifestDevice: number;
  manifestInode: number;
  manifestDigest: string;
  now?: number;
}): DependencySeedImageRecord {
  const result = sqlite().prepare(`
    UPDATE dependency_seed_images SET
      state = 'built', image_device = ?, image_inode = ?, image_digest = ?,
      manifest_device = ?, manifest_inode = ?, manifest_digest = ?, updated_at = ?
    WHERE recipe_key = ? AND generation = ? AND state = 'building'
      AND publisher_pid = ? AND publisher_identity_json = ?
  `).run(
    input.imageDevice,
    input.imageInode,
    input.imageDigest,
    input.manifestDevice,
    input.manifestInode,
    input.manifestDigest,
    input.now ?? Date.now(),
    input.recipeKey,
    input.generation,
    input.publisherPid,
    JSON.stringify(input.publisherIdentity),
  );
  const current = readDependencySeedImage(input.recipeKey);
  if (!current || (result.changes !== 1 && (current.state !== 'built'
    || current.generation !== input.generation
    || !samePublisher(current, input)
    || current.imageDevice !== input.imageDevice
    || current.imageInode !== input.imageInode
    || current.imageDigest !== input.imageDigest
    || current.manifestDevice !== input.manifestDevice
    || current.manifestInode !== input.manifestInode
    || current.manifestDigest !== input.manifestDigest))) {
    throw new Error('Dependency image build lost its durable generation claim.');
  }
  return current;
}
export function publishDependencySeedImage(input: {
  recipeKey: string;
  generation: string;
  publisherPid: number;
  publisherIdentity: MetadataLockProcessIdentity;
  now?: number;
}): DependencySeedImageRecord {
  const result = sqlite().prepare(`
    UPDATE dependency_seed_images SET state = 'ready', updated_at = ?
    WHERE recipe_key = ? AND generation = ? AND state = 'built'
      AND publisher_pid = ? AND publisher_identity_json = ?
  `).run(
    input.now ?? Date.now(),
    input.recipeKey,
    input.generation,
    input.publisherPid,
    JSON.stringify(input.publisherIdentity),
  );
  const current = readDependencySeedImage(input.recipeKey);
  if (!current || current.generation !== input.generation || !samePublisher(current, input)
    || (result.changes !== 1 && current.state !== 'ready')) {
    throw new Error('Dependency image publication lost its durable generation claim.');
  }
  return current;
}
export function removeUnpublishedDependencySeedImage(input: {
  recipeKey: string;
  generation: string;
  publisherPid: number;
  publisherIdentity: MetadataLockProcessIdentity;
}): void {
  const result = sqlite().prepare(`
    DELETE FROM dependency_seed_images
    WHERE recipe_key = ? AND generation = ? AND state IN ('building', 'built')
      AND publisher_pid = ? AND publisher_identity_json = ?
  `).run(
    input.recipeKey,
    input.generation,
    input.publisherPid,
    JSON.stringify(input.publisherIdentity),
  );
  if (result.changes !== 1) {
    throw new Error('Dependency image recovery lost its durable publisher claim.');
  }
}
export function beginDependencySeedLease(input: {
  leaseId: string;
  recipeKey: string;
  generation: string;
  workspacePath: string;
  shadowPath: string;
  mountPath: string;
  ownerPid: number;
  ownerIdentity: MetadataLockProcessIdentity;
  now?: number;
}): DependencySeedLeaseRecord {
  const now = input.now ?? Date.now();
  const image = readDependencySeedImage(input.recipeKey);
  if (!image || image.state !== 'ready' || image.generation !== input.generation) {
    throw new Error('Dependency image is not ready for this generation.');
  }
  try {
    sqlite().prepare(`
      INSERT INTO dependency_seed_leases (
        lease_id, recipe_key, generation, workspace_path, shadow_path, mount_path,
        state, owner_pid, owner_identity_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'mounting', ?, ?, ?, ?)
    `).run(
      input.leaseId,
      input.recipeKey,
      input.generation,
      normalizedNamespacePath(input.workspacePath),
      normalizedNamespacePath(input.shadowPath),
      normalizedNamespacePath(input.mountPath),
      input.ownerPid,
      JSON.stringify(input.ownerIdentity),
      now,
      now,
    );
  } catch (error) {
    if ((error as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw new Error('This workspace already has a dependency image generation lease.');
    }
    throw error;
  }
  return readDependencySeedLease(input.leaseId)!;
}
export function readDependencySeedLease(leaseId: string): DependencySeedLeaseRecord | null {
  const row = sqlite().prepare(
    'SELECT * FROM dependency_seed_leases WHERE lease_id = ?',
  ).get(leaseId) as LeaseRow | undefined;
  return row ? decodeLease(row) : null;
}
export function findDependencySeedLeaseForWorkspace(
  workspacePath: string,
): DependencySeedLeaseRecord | null {
  const row = sqlite().prepare(
    'SELECT * FROM dependency_seed_leases WHERE workspace_path = ?',
  ).get(normalizedNamespacePath(workspacePath)) as LeaseRow | undefined;
  return row ? decodeLease(row) : null;
}
export function listDependencySeedLeases(recipeKey?: string): DependencySeedLeaseRecord[] {
  const rows = recipeKey
    ? sqlite().prepare(
      'SELECT * FROM dependency_seed_leases WHERE recipe_key = ? ORDER BY created_at ASC',
    ).all(recipeKey) as LeaseRow[]
    : sqlite().prepare(
      'SELECT * FROM dependency_seed_leases ORDER BY created_at ASC',
    ).all() as LeaseRow[];
  return rows.map(decodeLease);
}
export function recordAttachedDependencySeedLease(input: {
  leaseId: string; imagePath: string; deviceEntry: string; systemEntities: HdiSystemEntity[];
  helperPid: number; helperIdentity: MetadataLockProcessIdentity;
  baseDevice: number; baseInode: number; shadowDevice: number; shadowInode: number;
  mountDevice: number; mountInode: number;
  now?: number;
}): DependencySeedLeaseRecord {
  const imagePath = path.resolve(input.imagePath);
  const systemEntities = JSON.stringify(input.systemEntities);
  const helperIdentity = JSON.stringify(input.helperIdentity);
  sqlite().prepare(`
    UPDATE dependency_seed_leases SET
      attached_image_path = ?, device_entry = ?, system_entities_json = ?,
      helper_pid = ?, helper_identity_json = ?, base_device = ?, base_inode = ?,
      shadow_device = ?, shadow_inode = ?, mount_device = ?, mount_inode = ?,
      updated_at = ?
    WHERE lease_id = ? AND state = 'mounting' AND attached_image_path IS NULL
      AND device_entry IS NULL AND system_entities_json IS NULL AND helper_pid IS NULL
      AND helper_identity_json IS NULL AND base_device IS NULL AND base_inode IS NULL
      AND shadow_device IS NULL AND shadow_inode IS NULL AND mount_device IS NULL
      AND mount_inode IS NULL
  `).run(
    imagePath, input.deviceEntry, systemEntities, input.helperPid, helperIdentity,
    input.baseDevice, input.baseInode, input.shadowDevice, input.shadowInode,
    input.mountDevice, input.mountInode, input.now ?? Date.now(), input.leaseId,
  );
  const current = readDependencySeedLease(input.leaseId);
  const exact = current?.state === 'mounting'
    && current.attachedImagePath === imagePath && current.deviceEntry === input.deviceEntry
    && JSON.stringify(current.systemEntities) === systemEntities
    && current.helperPid === input.helperPid && JSON.stringify(current.helperIdentity) === helperIdentity
    && current.baseDevice === input.baseDevice && current.baseInode === input.baseInode
    && current.shadowDevice === input.shadowDevice && current.shadowInode === input.shadowInode
    && current.mountDevice === input.mountDevice && current.mountInode === input.mountInode;
  if (!current || !exact) {
    throw new Error('Dependency image attach lost its durable cleanup receipt.');
  }
  return current;
}
export function bindMountedDependencySeedLease(input: {
  leaseId: string;
  imagePath: string;
  deviceEntry: string;
  systemEntities: HdiSystemEntity[];
  helperPid: number;
  helperIdentity: MetadataLockProcessIdentity;
  baseDevice: number;
  baseInode: number;
  shadowDevice: number;
  shadowInode: number;
  mountDevice: number;
  mountInode: number;
  ownerPid?: number;
  ownerIdentity?: MetadataLockProcessIdentity;
  now?: number;
}): DependencySeedLeaseRecord {
  const assignments = [
    "state = 'mounted'",
    'updated_at = ?',
  ];
  const values: unknown[] = [
    input.now ?? Date.now(),
  ];
  if (input.ownerPid !== undefined && input.ownerIdentity !== undefined) {
    assignments.push('owner_pid = ?', 'owner_identity_json = ?');
    values.push(input.ownerPid, JSON.stringify(input.ownerIdentity));
  }
  values.push(
    input.leaseId,
    path.resolve(input.imagePath),
    input.deviceEntry,
    JSON.stringify(input.systemEntities),
    input.helperPid,
    JSON.stringify(input.helperIdentity),
    input.baseDevice,
    input.baseInode,
    input.shadowDevice,
    input.shadowInode,
    input.mountDevice,
    input.mountInode,
  );
  sqlite().prepare(`
    UPDATE dependency_seed_leases SET ${assignments.join(', ')}
    WHERE lease_id = ? AND state IN ('mounting', 'mounted')
      AND attached_image_path = ? AND device_entry = ? AND system_entities_json = ?
      AND helper_pid = ? AND helper_identity_json = ?
      AND base_device = ? AND base_inode = ?
      AND shadow_device = ? AND shadow_inode = ?
      AND mount_device = ? AND mount_inode = ?
  `).run(...values);
  const current = readDependencySeedLease(input.leaseId);
  const exact = current?.state === 'mounted'
    && current.attachedImagePath === path.resolve(input.imagePath)
    && current.deviceEntry === input.deviceEntry
    && JSON.stringify(current.systemEntities) === JSON.stringify(input.systemEntities)
    && current.helperPid === input.helperPid
    && JSON.stringify(current.helperIdentity) === JSON.stringify(input.helperIdentity)
    && current.baseDevice === input.baseDevice
    && current.baseInode === input.baseInode
    && current.shadowDevice === input.shadowDevice
    && current.shadowInode === input.shadowInode
    && current.mountDevice === input.mountDevice
    && current.mountInode === input.mountInode;
  if (!current || !exact) {
    throw new Error('Dependency image mount lost its durable lease.');
  }
  return current;
}
export function bindDetachingDependencySeedLease(input: {
  leaseId: string;
  deviceEntry: string | null;
  shadowDevice: number;
  shadowInode: number;
  mountDevice?: number | null;
  mountInode?: number | null;
  now?: number;
}): DependencySeedLeaseRecord {
  const result = sqlite().prepare(`
    UPDATE dependency_seed_leases SET state = 'detaching',
      device_entry = COALESCE(?, device_entry), shadow_device = ?, shadow_inode = ?,
      mount_device = COALESCE(?, mount_device), mount_inode = COALESCE(?, mount_inode),
      updated_at = ?
    WHERE lease_id = ? AND state IN ('mounting', 'mounted', 'detaching', 'blocked')
  `).run(
    input.deviceEntry,
    input.shadowDevice,
    input.shadowInode,
    input.mountDevice ?? null,
    input.mountInode ?? null,
    input.now ?? Date.now(),
    input.leaseId,
  );
  const current = readDependencySeedLease(input.leaseId);
  if (!current || (result.changes !== 1 && (current.state !== 'detaching'
    || current.shadowDevice !== input.shadowDevice
    || current.shadowInode !== input.shadowInode
    || (input.deviceEntry !== null && current.deviceEntry !== input.deviceEntry)))) {
    throw new Error('Dependency image cleanup lost its durable lease authority.');
  }
  return current;
}
export function transitionDependencySeedLease(
  leaseId: string,
  expectedState: DependencySeedLeaseState,
  state: DependencySeedLeaseState,
  now = Date.now(),
): DependencySeedLeaseRecord {
  const result = sqlite().prepare(`
    UPDATE dependency_seed_leases SET state = ?, updated_at = ?
    WHERE lease_id = ? AND state = ?
  `).run(state, now, leaseId, expectedState);
  const current = readDependencySeedLease(leaseId);
  if (!current || (result.changes !== 1 && current.state !== state)) {
    throw new Error('Dependency image lease transition lost its durable claim.');
  }
  return current;
}
export function removeDependencySeedLease(leaseId: string): void {
  const result = sqlite().prepare(
    "DELETE FROM dependency_seed_leases WHERE lease_id = ? AND state = 'detaching'",
  ).run(leaseId);
  if (result.changes !== 1) {
    throw new Error('Dependency image lease removal requires a detaching lease.');
  }
}
export function removePreparedDependencySeedLease(leaseId: string): void {
  const result = sqlite().prepare(`
    DELETE FROM dependency_seed_leases
    WHERE lease_id = ? AND state = 'mounting'
      AND attached_image_path IS NULL
      AND device_entry IS NULL AND system_entities_json IS NULL
      AND helper_pid IS NULL AND helper_identity_json IS NULL
      AND base_device IS NULL AND base_inode IS NULL
      AND shadow_device IS NULL AND shadow_inode IS NULL
      AND mount_device IS NULL AND mount_inode IS NULL
  `).run(leaseId);
  if (result.changes !== 1) {
    throw new Error('Dependency image prepared lease gained device authority before cancellation.');
  }
}
export function beginDependencySeedImageRetirement(
  recipeKey: string,
  generation: string,
  now = Date.now(),
): DependencySeedImageRecord {
  const db = sqlite();
  const retire = db.transaction(() => {
    const active = db.prepare(`
      SELECT COUNT(*) AS count FROM dependency_seed_leases
      WHERE recipe_key = ? AND generation = ?
    `).get(recipeKey, generation) as { count: number };
    if (active.count !== 0) {
      throw new Error('Dependency image retirement is blocked by generation leases.');
    }
    const current = readDependencySeedImage(recipeKey);
    if (!current || current.generation !== generation
      || (current.state !== 'ready' && current.state !== 'retiring')) {
      throw new Error('Dependency image is not ready to retire.');
    }
    const imageRetiredPath = path.join(
      path.dirname(current.imagePath),
      `.o8-retired-image-${generation}`,
    );
    const manifestRetiredPath = path.join(
      path.dirname(current.manifestPath),
      `.o8-retired-manifest-${generation}`,
    );
    const result = db.prepare(`
      UPDATE dependency_seed_images SET
        state = 'retiring', image_retired_path = COALESCE(image_retired_path, ?),
        manifest_retired_path = COALESCE(manifest_retired_path, ?), updated_at = ?
      WHERE recipe_key = ? AND generation = ? AND state IN ('ready', 'retiring')
    `).run(imageRetiredPath, manifestRetiredPath, now, recipeKey, generation);
    if (result.changes !== 1) throw new Error('Dependency image retirement lost its durable claim.');
    const retiring = readDependencySeedImage(recipeKey)!;
    if (retiring.imageRetiredPath !== imageRetiredPath
      || retiring.manifestRetiredPath !== manifestRetiredPath) {
      throw new Error('Dependency image retirement paths differ from durable authority.');
    }
    return retiring;
  });
  return retire.immediate();
}
export function removeRetiredDependencySeedImage(recipeKey: string, generation: string): void {
  const result = sqlite().prepare(`
    DELETE FROM dependency_seed_images
    WHERE recipe_key = ? AND generation = ? AND state = 'retiring'
      AND image_retirement_phase = 3 AND manifest_retirement_phase = 3
  `).run(recipeKey, generation);
  if (result.changes !== 1) throw new Error('Dependency image retirement lost its durable claim.');
}
function advanceDependencySeedImageRetirement(
  recipeKey: string,
  generation: string,
  artifact: 'image' | 'manifest',
  phase: 1 | 2 | 3,
): void {
  const column = artifact === 'image' ? 'image_retirement_phase' : 'manifest_retirement_phase';
  sqlite().prepare(`
    UPDATE dependency_seed_images SET ${column} = ?, updated_at = ?
    WHERE recipe_key = ? AND generation = ? AND state = 'retiring' AND ${column} < ?
  `).run(phase, Date.now(), recipeKey, generation, phase);
  const current = readDependencySeedImage(recipeKey);
  const durable = artifact === 'image'
    ? current?.imageRetirementPhase : current?.manifestRetirementPhase;
  if (!current || current.generation !== generation || current.state !== 'retiring'
    || durable === undefined || durable < phase) {
    throw new Error('Dependency image retirement phase lost its durable claim.');
  }
}
export async function unlinkExactRetiringDependencySeedFile(input: {
  recipeKey: string;
  generation: string;
  artifact: 'image' | 'manifest';
  filePath: string;
  retiredPath: string | null;
  phase: number;
  device: number | null;
  inode: number | null;
  digest: string | null;
  afterRename?: (retiredPath: string) => Promise<void>;
}): Promise<void> {
  if (!input.retiredPath || input.device === null || input.inode === null || !input.digest) {
    throw new Error('Retiring dependency image file has no exact durable identity.');
  }
  await retireGovernedDependencyFile({
    canonicalPath: input.filePath,
    retiredPath: input.retiredPath,
    authority: { device: input.device, inode: input.inode, digest: input.digest },
    phase: input.phase,
    advancePhase: (phase) => advanceDependencySeedImageRetirement(
      input.recipeKey, input.generation, input.artifact, phase,
    ),
    afterRename: input.afterRename,
  });
}
