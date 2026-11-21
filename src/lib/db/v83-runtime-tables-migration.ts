import path from 'node:path';
import type Database from 'better-sqlite3';
import { addColumnTolerant, tableColumnExists } from '@/lib/db/schema-columns';
import { DEFAULT_PROJECT_ID } from '@/lib/repos/projects';

/**
 * Tables the runtime's background jobs used to create on first use.
 *
 * Every first-time CREATE or ALTER commits a schema change, and each other
 * process sharing the database must then reload its schema and reconnect its
 * FTS5 tables. FTS5 reads its config inside that reconnect; when a second
 * schema change lands in between, the statement fails with SQLITE_SCHEMA
 * "vtable constructor failed" (SQLite re-prepares only once). The worker
 * runtime started these jobs right after it reported ready, so its burst of
 * new tables broke the server's first issue sync (#5204). Creating them in
 * the serialized bootstrap means the first process to open the database
 * makes them before it serves anything, and every later call is a no-op.
 */
export function ensureV83RuntimeTablesSchema(sqlite: Database.Database): void {
  ensureWorktreeMetadataLeaseSchema(sqlite);
  ensureWorktreeMaintenanceDiscoverySchema(sqlite);
  ensureSupervisorInboxSchema(sqlite);
  ensureProblemDossierSchema(sqlite);
  ensureDependencySeedSchema(sqlite);
  ensureKnowledgeChunksSchema(sqlite);
}

function addMissingColumns(sqlite: Database.Database, table: string, columns: Array<[string, string]>): void {
  for (const [column, definition] of columns) {
    if (!tableColumnExists(sqlite, table, column)) {
      addColumnTolerant(sqlite, `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}

export function ensureWorktreeMetadataLeaseSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS worktree_metadata_leases (
      metadata_root TEXT PRIMARY KEY,
      reservation_id TEXT NOT NULL UNIQUE,
      owner_pid INTEGER NOT NULL CHECK (owner_pid > 0),
      owner_identity_json TEXT NOT NULL,
      acquired_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS worktree_metadata_state (
      metadata_root TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      mirror_identity_json TEXT,
      updated_at INTEGER NOT NULL
    );
  `);
  addMissingColumns(sqlite, 'worktree_metadata_state', [['mirror_identity_json', 'TEXT']]);
}

// Trim the platform separator first, then the final component's character set.
// This expression is identical in the ownership index and exact basename query.
const separator = path.sep.replaceAll("'", "''");
const lanePath = `rtrim(worktree_path, '${separator}')`;
export const WORKTREE_LANE_BASENAME_SQL = `substr(${lanePath}, length(rtrim(${lanePath}, replace(${lanePath}, '${separator}', ''))) + 1)`;

/** Discovery is advisory. Metadata, holds and the exact retirement journal remain authority. */
export function ensureWorktreeMaintenanceDiscoverySchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS worktree_maintenance_roots (
      metadata_root TEXT PRIMARY KEY,
      repository_path TEXT NOT NULL,
      revision TEXT,
      held_reason TEXT,
      checked_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS worktree_maintenance_entries (
      discovery_key TEXT PRIMARY KEY,
      metadata_root TEXT NOT NULL,
      repository_path TEXT NOT NULL,
      worktree_id TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      lane_id TEXT,
      packet_id TEXT,
      revision TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_maintenance_entries_root
      ON worktree_maintenance_entries(metadata_root);
    CREATE INDEX IF NOT EXISTS idx_maintenance_entries_lane
      ON worktree_maintenance_entries(lane_id);
    CREATE INDEX IF NOT EXISTS idx_maintenance_entries_packet
      ON worktree_maintenance_entries(repository_path, packet_id);
    CREATE TABLE IF NOT EXISTS worktree_maintenance_state (
      key TEXT PRIMARY KEY, value_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS worktree_maintenance_pending (lane_id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS worktree_metadata_state (
      metadata_root TEXT PRIMARY KEY, payload_json TEXT NOT NULL,
      mirror_identity_json TEXT, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_maintenance_held_roots
      ON worktree_maintenance_roots(metadata_root) WHERE held_reason IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_maintenance_held_repo_roots
      ON worktree_maintenance_roots(repository_path, metadata_root) WHERE held_reason IS NOT NULL;
  `);
  const tableExists = (name: string) => sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name);
  if (tableExists('lanes')) sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_maintenance_active_lanes ON lanes(created_at, id)
      WHERE status NOT IN ('completed', 'archived');
    CREATE INDEX IF NOT EXISTS idx_maintenance_terminal_lanes ON lanes(created_at, id)
      WHERE status IN ('completed', 'archived');
    CREATE INDEX IF NOT EXISTS idx_maintenance_lane_path ON lanes(worktree_path);
    CREATE INDEX IF NOT EXISTS idx_maintenance_lane_basename
      ON lanes(${WORKTREE_LANE_BASENAME_SQL}) WHERE worktree_path IS NOT NULL;
  `);
  if (tableExists('workspace_exact_claims')) sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_maintenance_claims
    ON workspace_exact_claims(kind, repository_path, worktree_id)`);
}

/** One definition for the inbox and the heal bot, which each used to create it. */
export function ensureSupervisorInboxSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS supervisor_inbox (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      incident_key TEXT,
      repo_path TEXT NOT NULL,
      packet_id TEXT,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      heal_attempt_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT,
      repeat_count INTEGER NOT NULL DEFAULT 1,
      resolved_at TEXT,
      resolution_lane_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_supervisor_inbox_status_created
      ON supervisor_inbox(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_supervisor_inbox_repo_path_created
      ON supervisor_inbox(repo_path, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_supervisor_inbox_repo_created
      ON supervisor_inbox(repo_path, created_at);
    CREATE INDEX IF NOT EXISTS idx_supervisor_inbox_packet_id
      ON supervisor_inbox(packet_id);
  `);
  addMissingColumns(sqlite, 'supervisor_inbox', [
    ['project_id', 'TEXT'],
    ['incident_key', 'TEXT'],
    ['heal_attempt_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['last_seen_at', 'TEXT'],
    ['repeat_count', 'INTEGER NOT NULL DEFAULT 1'],
    ['resolution_lane_id', 'TEXT'],
  ]);
  sqlite.prepare(
    "UPDATE supervisor_inbox SET project_id = ? WHERE project_id IS NULL OR project_id = ''",
  ).run(DEFAULT_PROJECT_ID);
  sqlite.prepare(
    "UPDATE supervisor_inbox SET last_seen_at = created_at WHERE last_seen_at IS NULL OR last_seen_at = ''",
  ).run();
  sqlite.prepare(
    'UPDATE supervisor_inbox SET repeat_count = 1 WHERE repeat_count IS NULL OR repeat_count < 1',
  ).run();
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_supervisor_inbox_project_status_created
      ON supervisor_inbox(project_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_supervisor_inbox_incident_status
      ON supervisor_inbox(incident_key, status);
  `);
}

export function ensureProblemDossierSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS problem_dossiers (
      id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      pain_statement TEXT NOT NULL,
      first_observed_at TEXT NOT NULL,
      last_observed_at TEXT NOT NULL,
      occurrence_count INTEGER NOT NULL DEFAULT 0,
      comparable_exposure_count INTEGER NOT NULL DEFAULT 0,
      impact_band TEXT NOT NULL,
      evidence_confidence TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'candidate',
      closure_contract_json TEXT NOT NULL,
      suppressed_at TEXT,
      cooldown_until TEXT,
      accepted_at TEXT,
      linked_task_id TEXT,
      provisional_resolved_at TEXT,
      verified_closed_at TEXT,
      reopened_at TEXT,
      operator_stopped_at TEXT,
      suppression_reason TEXT,
      recurrence_proposal_id TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS problem_evidence (
      id TEXT PRIMARY KEY,
      dossier_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      packet_id TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      FOREIGN KEY (dossier_id) REFERENCES problem_dossiers(id) ON DELETE CASCADE,
      UNIQUE(source_type, source_id)
    );

    CREATE TABLE IF NOT EXISTS problem_remedies (
      id TEXT PRIMARY KEY,
      dossier_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      task_id TEXT,
      mission_id TEXT,
      packet_id TEXT,
      lane_id TEXT,
      approval_id TEXT,
      review_id TEXT,
      release_ref TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (dossier_id) REFERENCES problem_dossiers(id) ON DELETE CASCADE,
      UNIQUE(dossier_id, sequence)
    );

    CREATE TABLE IF NOT EXISTS problem_events (
      id TEXT PRIMARY KEY,
      dossier_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor TEXT NOT NULL,
      note TEXT,
      from_status TEXT,
      to_status TEXT,
      at TEXT NOT NULL,
      FOREIGN KEY (dossier_id) REFERENCES problem_dossiers(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_problem_dossiers_project_status
      ON problem_dossiers(project_id, status, last_observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_problem_evidence_dossier_observed
      ON problem_evidence(dossier_id, observed_at);
    CREATE INDEX IF NOT EXISTS idx_problem_remedies_dossier_created
      ON problem_remedies(dossier_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_problem_events_dossier_at
      ON problem_events(dossier_id, at);
  `);

  addMissingColumns(sqlite, 'problem_dossiers', [
    ['provisional_resolved_at', 'TEXT'],
    ['verified_closed_at', 'TEXT'],
    ['reopened_at', 'TEXT'],
    ['operator_stopped_at', 'TEXT'],
    ['suppression_reason', 'TEXT'],
    ['recurrence_proposal_id', 'TEXT'],
    ['last_error', 'TEXT'],
  ]);
  addMissingColumns(sqlite, 'problem_remedies', [['sequence', 'INTEGER NOT NULL DEFAULT 1']]);
}

export function ensureDependencySeedSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS dependency_seed_images (
      recipe_key TEXT PRIMARY KEY,
      generation TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('building', 'built', 'ready', 'retiring')),
      source_receipt_id TEXT,
      source_tree_digest TEXT,
      publisher_pid INTEGER,
      publisher_identity_json TEXT,
      image_path TEXT NOT NULL,
      manifest_path TEXT NOT NULL,
      staging_directory TEXT NOT NULL,
      staging_path TEXT NOT NULL,
      staging_device INTEGER NOT NULL,
      staging_inode INTEGER NOT NULL,
      image_device INTEGER,
      image_inode INTEGER,
      image_digest TEXT,
      manifest_device INTEGER,
      manifest_inode INTEGER,
      manifest_digest TEXT,
      image_retired_path TEXT,
      image_retirement_phase INTEGER NOT NULL DEFAULT 0,
      manifest_retired_path TEXT,
      manifest_retirement_phase INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dependency_seed_leases (
      lease_id TEXT PRIMARY KEY,
      recipe_key TEXT NOT NULL,
      generation TEXT NOT NULL,
      workspace_path TEXT NOT NULL UNIQUE,
      shadow_path TEXT NOT NULL UNIQUE,
      mount_path TEXT NOT NULL UNIQUE,
      attached_image_path TEXT,
      device_entry TEXT,
      system_entities_json TEXT,
      helper_pid INTEGER,
      helper_identity_json TEXT,
      base_device INTEGER,
      base_inode INTEGER,
      shadow_device INTEGER,
      shadow_inode INTEGER,
      mount_device INTEGER,
      mount_inode INTEGER,
      state TEXT NOT NULL CHECK (state IN ('mounting', 'mounted', 'detaching', 'blocked')),
      owner_pid INTEGER NOT NULL,
      owner_identity_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (recipe_key) REFERENCES dependency_seed_images(recipe_key) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS dependency_seed_leases_image_idx
      ON dependency_seed_leases(recipe_key, generation, state);
  `);
  addMissingColumns(sqlite, 'dependency_seed_images', [
    ['source_receipt_id', 'TEXT'],
    ['source_tree_digest', 'TEXT'],
    ['publisher_pid', 'INTEGER'],
    ['publisher_identity_json', 'TEXT'],
    ['image_retired_path', 'TEXT'],
    ['image_retirement_phase', 'INTEGER NOT NULL DEFAULT 0'],
    ['manifest_retired_path', 'TEXT'],
    ['manifest_retirement_phase', 'INTEGER NOT NULL DEFAULT 0'],
  ]);
  addMissingColumns(sqlite, 'dependency_seed_leases', [
    ['system_entities_json', 'TEXT'],
    ['helper_pid', 'INTEGER'],
    ['helper_identity_json', 'TEXT'],
    ['base_device', 'INTEGER'],
    ['base_inode', 'INTEGER'],
    ['attached_image_path', 'TEXT'],
  ]);
}

export function ensureKnowledgeChunksSchema(sqlite: Database.Database): void {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS knowledge_chunks (
    source_id TEXT PRIMARY KEY, source TEXT NOT NULL, relative_path TEXT NOT NULL,
    title TEXT NOT NULL, wiki_links TEXT NOT NULL, text_hash TEXT NOT NULL)`);
}
