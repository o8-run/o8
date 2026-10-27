import { addColumnTolerant, tableColumnExists } from '@/lib/db/schema-columns';
/**
 * Database Connection — SQLite via Drizzle ORM
 *
 * Single connection per process (Next.js server).
 * Database file lives at DATA_DIR/cortex-ide.db (defaults to ~/.o8/).
 * Ensures tables on first connection until a schema marker is written.
 *
 * For production multi-tenant: swap better-sqlite3 for @neondatabase/serverless
 * or postgres.js — Drizzle supports both with minimal changes.
 */

import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getDataDir, migrateDataDirOnce } from '@/lib/data-dir-migration';
import { extractApprovalContextIdsFromMetadataJson } from '@/lib/approvals/context';
import * as schema from './schema';
import { migrateLegacyApprovalStoreIfNeeded } from '@/lib/approvals/storage-migration';
import { migrateLegacyLaneStoreIfNeeded } from '@/lib/lane/storage-migration';
import { ensureUsageLogIndexes, ensureUsageLogSchema } from '@/lib/db/usage-log-migration';
import { ensureOutcomeExclusionStorage } from '@/lib/db/outcome-exclusion-migration';
import { ensureSessionOutcomeColumns } from '@/lib/db/session-outcome-migration';
import { ensureWorkerTokenStorage } from '@/lib/db/worker-token-migration';
import { ensureV14Fts5Schema } from '@/lib/db/v14-fts5-migration';
import { ensureV15CommentsFtsSchema } from '@/lib/db/v15-comments-fts-migration';
import { ensureV16DocsFtsSchema } from '@/lib/db/v16-docs-fts-migration';
import { ensureV17FactsFtsSchema } from '@/lib/db/v17-facts-fts-migration';
import { ensureV18FactsSourceAuthoritySchema } from '@/lib/db/v18-facts-source-authority-migration';
import { ensureV19DocDistillStateSchema } from '@/lib/db/v19-doc-distill-state-migration';
import { ensureV20FactsEmbeddingSchema } from '@/lib/db/v20-facts-embedding-migration';
import { ensureV35UnifiedSearchSchema } from '@/lib/db/v35-unified-search-migration';
import { ensureV57CostLedgerAttributionSchema } from '@/lib/db/v57-cost-ledger-attribution-migration';
import { ensureLatestSchemas, ensurePostAutomationSchemas } from '@/lib/db/latest-schema-migrations';
import { quarantineDeadIdempotencyReservations } from '@/lib/db/idempotency-reservation-recovery';
import { DEFAULT_PROJECT_ID } from '@/lib/repos/projects';
// ── Data directory ──
migrateDataDirOnce();
const DATA_DIR = getDataDir();
// Keep the filename as cortex-ide.db so the data dir migration's byte-for-byte
// copy still points at the right file. Renaming the file would require a
// second migration step with no user-facing benefit.
const DB_PATH = process.env.CORTEX_IDE_DB_PATH || path.join(DATA_DIR, 'cortex-ide.db');
export const DB_SCHEMA_VERSION = 61;
function migrationMarkerPath(version: number): string {
  return path.join(DATA_DIR, `.db-migrated-v${version}`);
}
// Ensure data directory exists
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

// ── Singleton connection ──

let _db: BetterSQLite3Database<typeof schema> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _sqlite: any = null;

/**
 * Get the database instance. Creates it on first call.
 * Returns null if better-sqlite3 is not available (production bundle issue).
 */
export function getDb(): BetterSQLite3Database<typeof schema> | null {
  if (_db) return _db;
  if (!Database || !drizzle) return null;

  const dbFilePreviouslyExisted = existsSync(DB_PATH);
  const sqlite = new Database(DB_PATH);

  // Tighten permissions: the DB holds encrypted api_keys plus PLAINTEXT
  // chat_history / lanes / approvals. Keep it owner-only so another local user
  // or a backup/sync process can't read operator data (§PL-1). Best-effort.
  try {
    chmodSync(DATA_DIR, 0o700);
    for (const suffix of ['', '-wal', '-shm']) {
      const p = `${DB_PATH}${suffix}`;
      if (existsSync(p)) chmodSync(p, 0o600);
    }
  } catch { /* chmod is best-effort — never block DB init on it */ }

  // SQLite performance pragmas
  sqlite.pragma('journal_mode = WAL');      // Write-ahead logging (concurrent reads)
  sqlite.pragma('synchronous = NORMAL');    // Faster writes, still crash-safe with WAL
  sqlite.pragma('busy_timeout = 5000');     // Wait 5s instead of failing on lock
  sqlite.pragma('cache_size = -20000');     // 20MB page cache
  sqlite.pragma('foreign_keys = ON');       // Enforce FK constraints

  const db = drizzle!(sqlite, { schema });

  // #859 — the old gate skipped `ensureIdempotentColumnAdds` whenever the
  // top-version marker was missing, leaving installs that landed before v4
  // pinned at v3 forever and silently skipping the per-boot column-add +
  // backfill helpers. New behaviour:
  //   1. Existing DBs missing the top-version marker run the narrow migrations
  //      for columns referenced by base-schema indexes before `ensureTables`.
  //   2. Run `ensureTables` (CREATE TABLE IF NOT EXISTS) for new or upgrading
  //      DBs, then ALWAYS repeat `ensureIdempotentColumnAdds` so column-add + backfill
  //      helpers can never be silently skipped for existing installs whose
  //      marker drifted out of sync with DB_SCHEMA_VERSION.
  //   3. Backfill any missing v1..v12 markers in order so installs upgraded
  //      from older schemas show the full migration history on disk and
  //      brand-new installs don't appear to have skipped versions.
  try {
    const topMarkerExists = existsSync(migrationMarkerPath(DB_SCHEMA_VERSION));
    // Upgrade only columns referenced by current base-schema indexes here.
    // The full idempotent migration path expects the base tables to exist and
    // therefore runs after ensureTables below.
    if (dbFilePreviouslyExisted && !topMarkerExists) {
      ensureSessionOutcomeColumns(sqlite);
      ensureV57CostLedgerAttributionSchema(sqlite);
    }
    if (!dbFilePreviouslyExisted || !topMarkerExists) {
      ensureTables(sqlite);
    }
    ensureIdempotentColumnAdds(sqlite);
    ensureOutcomeExclusionStorage(sqlite);
    writeAllMissingMigrationMarkers();
  } catch (error) {
    // Never publish a half-initialized singleton. A later request must retry
    // the complete migration path rather than receiving a Drizzle handle whose
    // schema setup failed partway through.
    try { sqlite.close(); } catch { /* best effort */ }
    throw error;
  }

  _sqlite = sqlite;
  _db = db;

  console.log(`[db] Connected to ${DB_PATH}`);
  return db;
}

function ensureIdempotentColumnAdds(sqlite: Database.Database): void {
  ensureUserColumns(sqlite);
  ensureApprovalContextColumns(sqlite);
  ensureWatchedAgentColumns(sqlite);
  ensureChatHistoryColumns(sqlite);
  ensureSessionOutcomeColumns(sqlite);
  ensureUsageLogSchema(sqlite);
  ensureApprovalEventsTable(sqlite);
  ensureExternalMcpServerColumns(sqlite);
  ensureLaneHeartbeatColumns(sqlite);
  ensurePushSubscriptionsTable(sqlite);
  ensureMobileLiveActivityTokensTable(sqlite);
  ensureProjectsTables(sqlite);
  ensureProjectScopeColumns(sqlite);
  ensureMissionStateColumn(sqlite);
  ensureWorkerTokenStorage(sqlite);
  // #915 sub-1 — Schema v14 — Q&A retrieval foundation. FTS5 virtual tables
  // for outcomes/prs/issues/directives plus qa_eval_runs table. Skips with a
  // warning when FTS5 isn't compiled in. Always-on via the same idempotent
  // pattern as the rest of this function.
  ensureV14Fts5Schema(sqlite);
  // #915 phase 1.7 #2 — Schema v15 — github_comments + comments_fts. Brings
  // issue/PR comment bodies into the FTS surface so decisions/specs that
  // live in epic-thread comments (e.g. epic #915's locked architecture
  // comment naming outcomes_fts/qa_eval_runs) become searchable.
  ensureV15CommentsFtsSchema(sqlite);
  // #915 path-to-70 phase 1.7 #3 — Schema v16 — `docs` parent table +
  // `docs_fts` FTS5 mirror for repo markdown (CLAUDE.md, README, AGENTS.md,
  // docs/design/DESIGN.md, THEME.md, docs/**). Same skip-with-warning pattern
  // when FTS5 is off.
  ensureV16DocsFtsSchema(sqlite);
  // #915 north star #1 — Schema v17 — Engineering Brain Indexer foundation.
  // `facts` table holds distilled facts with provenance + fingerprint upsert,
  // `facts_fts` is the BM25 mirror, `facts_queue` is the worker's job table.
  // Worker (#2), RRF merge (#3), and smoke eval (#4) ship separately.
  ensureV17FactsFtsSchema(sqlite);
  // #915 north star follow-up — Schema v18 — `facts.source_authority` REAL
  // column + state-aware backfill. Establishes the source-of-truth hierarchy
  // (directive 1.0 → merged-PR 0.95 → outcome 0.9 → closed-issue 0.85 →
  // pr 0.8 → issue 0.75 → comment 0.7) so retrieval + composer can prefer
  // higher-authority rows when facts conflict.
  ensureV18FactsSourceAuthoritySchema(sqlite);
  // #915 north star Phase 2b — Schema v19 — `doc_distill_state` checkpoint
  // table for the docs distillation worker. Tracks per-chunk progress so
  // long runs can resume after interruption without re-paying LLM cost.
  ensureV19DocDistillStateSchema(sqlite);
  // #962 — Schema v20 — `facts.embedding BLOB` for 1536-dim float32 OpenAI
  // embeddings. Nullable; rows without embeddings fall through to BM25-only
  // scoring. Backfill is opt-in via `scripts/backfill-fact-embeddings.ts`.
  ensureV20FactsEmbeddingSchema(sqlite);
  ensureV35UnifiedSearchSchema(sqlite);
  ensureLatestSchemas(sqlite);
  // #835 — recover any session_outcomes rows whose `valid_from` was inserted
  // as NULL (legacy seeds, raw INSERTs that bypassed the Drizzle schema
  // default). The column-add backfill in `ensureSessionOutcomeColumns` only
  // fires once when the column is created; this runs every boot.
  backfillSessionOutcomeValidFrom(sqlite);
  // Schema v23 — `automations` table (cron-style scheduled agent runs).
  // CREATE TABLE IF NOT EXISTS, so safe on every boot; indexes follow.
  ensureAutomationsTable(sqlite);
  // Schema v24 — `automations.last_error_message` so the UI can surface WHY a
  // failed run errored (not just the boolean status). Idempotent column-add.
  ensureAutomationsErrorColumn(sqlite);
  ensurePostAutomationSchemas(sqlite);
  // Schema v25 (#1099) — `app_state` table for top-level kv state +
  // `projects.color` / `projects.sort_order` columns. Drops the JSON ledger
  // sidecar at `~/.o8/projects.json` as the source of truth for activeProjectId,
  // color, and ordering. Migration reads existing JSON into SQLite once.
  ensureAppStateTable(sqlite);
  ensureProjectsLedgerColumns(sqlite);
  // Schema v27 — `artifacts` table (visual verification screenshots/video).
  // CREATE TABLE IF NOT EXISTS + indexes, safe on every boot.
  ensureArtifactsTable(sqlite);
  // #beta-referral — `beta_invites` table (the operator's founding invite set).
  // CREATE TABLE IF NOT EXISTS + index, safe on every boot.
  ensureBetaInvitesTable(sqlite);
  // Schema v29 (#1329) — `session_rules` table: operator-authored rules scoped
  // to one orchestrator thread. Ephemeral (die with the thread). CREATE TABLE
  // IF NOT EXISTS + index, safe on every boot.
  ensureSessionRulesTable(sqlite);
  // Schema v32 (#1497) — `idempotency_keys` table. Persists the dedupe guard
  // for orchestrator control verbs (steer/rerun/retry/dispatch) so a client
  // timeout+retry can't double-fire and a restart can't wipe the guard.
  // CREATE TABLE IF NOT EXISTS + index, safe on every boot.
  ensureIdempotencyKeysTable(sqlite);
  migrateProjectsLedgerJsonIfNeeded(sqlite);
}
/**
 * Schema v32 (#1497) — persisted idempotency keys. See schema.ts
 * `idempotencyKeys` + `orchestrator/idempotency-store.ts` for the reserve →
 * finalize protocol. Machine-only table; ms-epoch stamps.
 *
 * Schema v33 (#1513) — adds the `pid` column (owning process id of an in-flight
 * reservation) and reaps reservations left behind by a dead process on every
 * connection open. This preserves the old in-memory merge cache's "a restart
 * forgets in-flight merges so the operator can retry immediately" behavior now
 * that merge verbs share the persisted store — a LIVE in-flight duplicate is
 * still deduped, but a reservation whose owner died is released.
 *
 * Schema v34 (#1600) — adds an execution-owner token so clearing an externally
 * terminated reservation cannot let its stale promise overwrite a later retry.
 */
function ensureIdempotencyKeysTable(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT PRIMARY KEY,
      verb TEXT NOT NULL,
      packet_id TEXT,
      result_json TEXT,
      pid INTEGER,
      reservation_id TEXT,
      owner_identity_json TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys(expires_at);
  `);
  if (!tableColumnExists(sqlite, 'idempotency_keys', 'pid')) {
    addColumnTolerant(sqlite, 'ALTER TABLE idempotency_keys ADD COLUMN pid INTEGER');
  }
  if (!tableColumnExists(sqlite, 'idempotency_keys', 'reservation_id'))
    addColumnTolerant(sqlite, 'ALTER TABLE idempotency_keys ADD COLUMN reservation_id TEXT');
  if (!tableColumnExists(sqlite, 'idempotency_keys', 'owner_identity_json'))
    addColumnTolerant(sqlite, 'ALTER TABLE idempotency_keys ADD COLUMN owner_identity_json TEXT');
  quarantineDeadIdempotencyReservations(sqlite);
}

/**
 * Schema v29 (#1329) — session rules. Operator-authored, thread-scoped rules
 * pinned into every orchestrator turn + inherited by dispatched workers. Keyed
 * by orchestrator thread id (e.g. `thoughts-…`). See `session-rules-store.ts`.
 */
function ensureSessionRulesTable(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS session_rules (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      text TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_session_rules_thread
      ON session_rules(thread_id, active, created_at);
  `);
}

function ensureAutomationsTable(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS automations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner TEXT NOT NULL,
      project_id TEXT,
      repo_path TEXT NOT NULL,
      branch TEXT NOT NULL DEFAULT 'main',
      runtime TEXT NOT NULL,
      prompt TEXT NOT NULL,
      trigger_kind TEXT NOT NULL DEFAULT 'manual',
      cron_expr TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      next_run_at INTEGER,
      last_run_at INTEGER,
      last_run_status TEXT NOT NULL DEFAULT 'idle',
      last_lane_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_automations_owner_created
      ON automations(owner, created_at);
    CREATE INDEX IF NOT EXISTS idx_automations_enabled_next_run
      ON automations(enabled, next_run_at);
  `);
}

function ensureAutomationsErrorColumn(sqlite: Database.Database): void {
  if (!tableColumnExists(sqlite, 'automations', 'last_error_message')) {
    addColumnTolerant(sqlite, 'ALTER TABLE automations ADD COLUMN last_error_message TEXT');
  }
}

/**
 * Schema v27 — visual verification artifacts. See schema.ts `artifacts` for the
 * field semantics. `rel_path` is relative to the data dir (clone-safe).
 */
function ensureArtifactsTable(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'screenshot',
      source TEXT NOT NULL,
      lane_id TEXT,
      packet_id TEXT,
      repo_path TEXT,
      pr_number INTEGER,
      thread_id TEXT,
      label TEXT,
      phase TEXT,
      pair_id TEXT,
      rel_path TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'image/png',
      width INTEGER,
      height INTEGER,
      bytes INTEGER,
      gh_comment_url TEXT,
      captured_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_artifacts_packet ON artifacts(packet_id, captured_at);
    CREATE INDEX IF NOT EXISTS idx_artifacts_pr ON artifacts(pr_number, captured_at);
    CREATE INDEX IF NOT EXISTS idx_artifacts_lane ON artifacts(lane_id, captured_at);
    CREATE INDEX IF NOT EXISTS idx_artifacts_thread ON artifacts(thread_id, captured_at);
  `);
}

/**
 * #beta-referral — the operator's founding beta invites. See schema.ts
 * `betaInvites` for field semantics. This table is the local generation +
 * sent/redeemed ledger; hosted redemption is optional.
 */
function ensureBetaInvitesTable(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS beta_invites (
      code TEXT PRIMARY KEY,
      owner TEXT NOT NULL DEFAULT 'operator',
      accent TEXT NOT NULL,
      position INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'available',
      sent_at TEXT,
      redeemed_at TEXT,
      redeemed_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_beta_invites_owner ON beta_invites(owner);
  `);
}

// ── #1099 — projects ledger migration to SQLite ──

/**
 * Schema v25 — generic top-level key/value table. First consumer is the
 * `active_project_id` row that replaces the same field in
 * `~/.o8/projects.json`. Anything else that's "one row globally" (e.g.
 * dismissed-tour flags, last-used-runtime hints) can live here too.
 */
function ensureAppStateTable(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

/**
 * Schema v25 — projects ledger persistence. `color` is the curated palette
 * entry for the project dot; `sort_order` preserves the JSON ledger's array
 * order so the UI ordering survives the migration. Both nullable so existing
 * rows inserted by `createProject` don't break.
 */
function ensureProjectsLedgerColumns(sqlite: Database.Database): void {
  if (!tableColumnExists(sqlite, 'projects', 'color')) {
    addColumnTolerant(sqlite, 'ALTER TABLE projects ADD COLUMN color TEXT');
  }
  if (!tableColumnExists(sqlite, 'projects', 'sort_order')) {
    addColumnTolerant(sqlite, 'ALTER TABLE projects ADD COLUMN sort_order INTEGER DEFAULT 0');
  }
}

/**
 * One-time JSON → SQLite migration for `~/.o8/projects.json` (#1099).
 * Reads the legacy ledger and upserts `color` + `sort_order` onto matching
 * SQLite projects (matched by id first, then by slug) plus writes
 * `active_project_id` into `app_state`. Marker file
 * `.db-migrated-projects-ledger-v1` guards against re-run.
 *
 * Failure-tolerant: a bad JSON file or missing project row logs + skips
 * rather than failing the boot. The reader in `repos/projects.ts` falls
 * back to the JSON file when SQLite has no migrated data, so the operator
 * never sees a regression from a hiccupped migration.
 */
function migrateProjectsLedgerJsonIfNeeded(sqlite: Database.Database): void {
  const markerPath = path.join(DATA_DIR, '.db-migrated-projects-ledger-v1');
  if (existsSync(markerPath)) return;

  const jsonPath = path.join(DATA_DIR, 'projects.json');
  if (!existsSync(jsonPath)) {
    // Fresh install — no JSON to migrate. Mark done so we don't re-check.
    try { writeFileSync(markerPath, new Date().toISOString()); } catch { /* best effort */ }
    return;
  }

  try {
    const raw = readFileSync(jsonPath, 'utf8');
    const parsed = JSON.parse(raw) as {
      projects?: Array<{ id?: string; name?: string; color?: string }>;
      activeProjectId?: string;
    };
    const projects = Array.isArray(parsed.projects) ? parsed.projects : [];

    const updateById = sqlite.prepare(
      'UPDATE projects SET color = COALESCE(color, ?), sort_order = ? WHERE id = ?',
    );
    const updateBySlug = sqlite.prepare(
      'UPDATE projects SET color = COALESCE(color, ?), sort_order = ? WHERE slug = ?',
    );

    let migrated = 0;
    projects.forEach((entry, index) => {
      const color = typeof entry.color === 'string' && entry.color ? entry.color : null;
      const sortOrder = index;
      // Try id match first (SQLite project id), then slug match (slugified
      // name) for ledger-only rows that pre-date the SQLite projects table.
      if (entry.id && typeof entry.id === 'string') {
        const res = updateById.run(color, sortOrder, entry.id);
        if (res.changes > 0) { migrated += 1; return; }
      }
      if (entry.name && typeof entry.name === 'string') {
        const slug = entry.name
          .normalize('NFKD')
          .replace(/[̀-ͯ]/g, '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 60);
        const res = updateBySlug.run(color, sortOrder, slug);
        if (res.changes > 0) { migrated += 1; return; }
      }
    });

    if (typeof parsed.activeProjectId === 'string' && parsed.activeProjectId) {
      const now = Date.now();
      sqlite.prepare(
        `INSERT INTO app_state (key, value, updated_at) VALUES ('active_project_id', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(parsed.activeProjectId, now);
    }

    console.log(`[db] migrated projects ledger: ${migrated}/${projects.length} rows, active=${parsed.activeProjectId ?? '(none)'}`);
    try { writeFileSync(markerPath, new Date().toISOString()); } catch { /* best effort */ }
  } catch (err) {
    console.warn(`[db] projects ledger migration failed (will retry next boot): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Get the raw SQLite instance (for transactions, pragmas, etc).
 */
export function getSqlite(): Database.Database {
  if (!_sqlite) getDb();
  return _sqlite!;
}

/**
 * Close the database connection (for graceful shutdown).
 */
export function closeDb(): void {
  if (_sqlite) {
    _sqlite.close();
    _sqlite = null;
    _db = null;
    console.log('[db] Connection closed');
  }
}

/**
 * Get the database file path.
 */
export function getDbPath(): string {
  return DB_PATH;
}

// ── Table creation ──

/**
 * Create tables if they don't exist.
 * Uses raw SQL instead of Drizzle migrations for simplicity in v1.
 * When we move to PostgreSQL, we'll use proper migrations.
 */
function ensureTables(sqlite: Database.Database): void {
  ensureWorkerTokenStorage(sqlite);
  const approvalsTablePreviouslyMissing = !sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'approvals'`)
    .get();
  const lanesTablePreviouslyMissing = !sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lanes'`)
    .get();

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      github_id INTEGER UNIQUE,
      discord_id TEXT UNIQUE,
      clerk_user_id TEXT UNIQUE,
      email TEXT UNIQUE,
      name TEXT,
      avatar_url TEXT,
      plan TEXT NOT NULL DEFAULT 'free',
      token_budget_usd REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      encrypted_key TEXT NOT NULL,
      iv TEXT NOT NULL,
      label TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS usage_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      session_key TEXT,
      lane_id TEXT, packet_id TEXT, mission_id TEXT, role TEXT, attempt INTEGER NOT NULL DEFAULT 1, run_id TEXT, metadata_json TEXT,
      repo_path TEXT,
      agent_name TEXT,
      request_type TEXT DEFAULT 'chat',
      billing_period TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      stripe_customer_id TEXT UNIQUE,
      stripe_subscription_id TEXT UNIQUE,
      plan TEXT NOT NULL DEFAULT 'free',
      status TEXT NOT NULL DEFAULT 'active',
      current_period_end TEXT,
      cancel_at_period_end INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      user_agent TEXT,
      ip_address TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chat_history (
      tab_id TEXT PRIMARY KEY,
      messages_json TEXT NOT NULL DEFAULT '[]',
      model TEXT,
      saved_at TEXT,
      modified_at TEXT NOT NULL DEFAULT (datetime('now')),
      starred INTEGER NOT NULL DEFAULT 0,
      title TEXT,
      plan_text TEXT,
      repo_name TEXT,
      repo_path TEXT,
      repo_branch TEXT,
      remote_url TEXT
    );

    CREATE TABLE IF NOT EXISTS session_outcomes (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      repo_path TEXT NOT NULL,
      branch TEXT,
      runtime TEXT NOT NULL,
      session_key TEXT,
      lane_id TEXT,
      packet_id TEXT,
      outcome TEXT NOT NULL,
      summary TEXT NOT NULL,
      plan_text TEXT,
      attempts INTEGER NOT NULL DEFAULT 1,
      retry_history_json TEXT NOT NULL DEFAULT '[]',
      duration_ms INTEGER,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      model TEXT,
      patterns_json TEXT NOT NULL DEFAULT '[]',
      conflict_zones_json TEXT NOT NULL DEFAULT '[]',
      changed_files_json TEXT NOT NULL DEFAULT '[]',
      review_approved INTEGER,
      review_findings_count INTEGER NOT NULL DEFAULT 0,
      transcript_path TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      valid_from TEXT NOT NULL DEFAULT (datetime('now')),
      valid_to TEXT,
      skipped_tests INTEGER, reworked INTEGER, merged_clean INTEGER
    );

    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_id TEXT NOT NULL REFERENCES users(id),
      slug TEXT UNIQUE,
      token_budget_usd REAL,
      max_seats INTEGER DEFAULT 10,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS team_members (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member',
      joined_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS waitlist (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      github_username TEXT,
      source TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS github_installations (
      installation_id INTEGER PRIMARY KEY,
      account_login TEXT NOT NULL,
      account_type TEXT,
      target_type TEXT,
      permissions_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS github_repositories (
      repo_id INTEGER PRIMARY KEY,
      full_name TEXT NOT NULL UNIQUE,
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      private INTEGER NOT NULL DEFAULT 0,
      default_branch TEXT,
      installation_id INTEGER REFERENCES github_installations(installation_id) ON DELETE SET NULL,
      last_webhook_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS github_sync_state (
      key TEXT PRIMARY KEY,
      repo_full_name TEXT NOT NULL,
      resource TEXT NOT NULL,
      etag TEXT,
      last_synced_at TEXT,
      last_successful_at TEXT,
      last_error TEXT,
      stale_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS github_issues (
      issue_id INTEGER PRIMARY KEY,
      repo_full_name TEXT NOT NULL,
      number INTEGER NOT NULL,
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      author_login TEXT,
      body TEXT,
      labels_json TEXT NOT NULL DEFAULT '[]',
      assignees_json TEXT NOT NULL DEFAULT '[]',
      comments_count INTEGER NOT NULL DEFAULT 0,
      url TEXT NOT NULL,
      created_at TEXT,
      updated_at TEXT,
      closed_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_github_issues_repo_number ON github_issues(repo_full_name, number);

    CREATE TABLE IF NOT EXISTS github_pull_requests (
      pull_request_id INTEGER PRIMARY KEY,
      repo_full_name TEXT NOT NULL,
      number INTEGER NOT NULL,
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      author_login TEXT,
      body TEXT,
      head_ref_name TEXT,
      base_ref_name TEXT,
      additions INTEGER NOT NULL DEFAULT 0,
      deletions INTEGER NOT NULL DEFAULT 0,
      changed_files INTEGER NOT NULL DEFAULT 0,
      review_decision TEXT,
      status_checks_json TEXT NOT NULL DEFAULT '[]',
      url TEXT NOT NULL,
      created_at TEXT,
      updated_at TEXT,
      closed_at TEXT,
      merged_at TEXT
    );

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      source TEXT NOT NULL,
      runtime TEXT NOT NULL,
      agent TEXT NOT NULL,
      session_key TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      summary TEXT NOT NULL,
      tool_name TEXT,
      args_json TEXT,
      command TEXT,
      editable INTEGER,
      diff_json TEXT,
      risk TEXT NOT NULL,
      metadata_json TEXT,
      packet_id TEXT,
      lane_id TEXT,
      policy_rule_id TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      resolved_at INTEGER,
      resolution_json TEXT,
      audit_json TEXT NOT NULL DEFAULT '[]',
      fingerprint TEXT NOT NULL,
      continuation_json TEXT
    );

    CREATE TABLE IF NOT EXISTS lanes (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      label TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      worktree_path TEXT,
      branch TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      runtime TEXT NOT NULL, model TEXT,
      session_key TEXT,
      packet_id TEXT, pr_number INTEGER,
      status TEXT NOT NULL, outcome TEXT, outcome_note TEXT,
      ownership TEXT NOT NULL,
      writer_token TEXT,
      last_heartbeat_at INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_event_at TEXT,
      last_event_label TEXT
    );

    -- Parallel-mission registry. File at ~/.o8/orchestrator-state.json
    -- still owns the single active-mission lifecycle; this table archives
    -- every mission so get_mission_status can serve queries for earlier
    -- missions whose file representation has been overwritten. Packet
    -- status is reconstructed by joining packet_meta_json against the
    -- live lanes table (lanes are mission-agnostic).
    CREATE TABLE IF NOT EXISTS missions (
      id TEXT PRIMARY KEY,
      repo_path TEXT NOT NULL,
      runtime TEXT NOT NULL DEFAULT 'codex',
      prompt TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      constraints TEXT NOT NULL DEFAULT '',
      packet_meta_json TEXT NOT NULL DEFAULT '[]',
      mission_state_json TEXT,
      total_waves INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS missions_created_at_idx ON missions(created_at DESC);

    CREATE TABLE IF NOT EXISTS dispatch_rules (
      id TEXT PRIMARY KEY,
      repo_path TEXT NOT NULL,
      packet_type TEXT NOT NULL,
      rule_text TEXT NOT NULL,
      source TEXT NOT NULL,
      signal_score REAL NOT NULL DEFAULT 1,
      promoted_at TEXT,
      demoted_at TEXT,
      created_at TEXT NOT NULL,
      last_used_at TEXT
    );

    CREATE TABLE IF NOT EXISTS worker_runs (
      id TEXT PRIMARY KEY,
      lane_id TEXT NOT NULL REFERENCES lanes(id) ON DELETE CASCADE,
      worker_token_id TEXT NOT NULL REFERENCES worker_tokens(id) ON DELETE CASCADE,
      transport TEXT NOT NULL,
      status TEXT NOT NULL,
      remote_branch TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      last_event_at TEXT NOT NULL,
      error_json TEXT
    );

    CREATE TABLE IF NOT EXISTS worker_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      worker_run_id TEXT NOT NULL REFERENCES worker_runs(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lane_events (
      id TEXT PRIMARY KEY,
      lane_id TEXT NOT NULL REFERENCES lanes(id) ON DELETE CASCADE,
      verb TEXT NOT NULL,
      actor TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      timestamp TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS external_mcp_servers (
      id TEXT PRIMARY KEY,
      team_id TEXT,
      name TEXT NOT NULL UNIQUE,
      transport TEXT NOT NULL,
      command TEXT NOT NULL,
      args TEXT NOT NULL DEFAULT '[]',
      env_json TEXT,
      url TEXT,
      oauth_token TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      symon_injection INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_github_prs_repo_number ON github_pull_requests(repo_full_name, number);

    -- Indexes for common queries
    CREATE INDEX IF NOT EXISTS idx_approvals_status_created ON approvals(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_approvals_session_key_created ON approvals(session_key, created_at);
    CREATE INDEX IF NOT EXISTS idx_approvals_tool_name ON approvals(tool_name, status);
    CREATE INDEX IF NOT EXISTS idx_approvals_fingerprint_status ON approvals(fingerprint, status);
    CREATE INDEX IF NOT EXISTS idx_approvals_resolved_at ON approvals(resolved_at);
    CREATE INDEX IF NOT EXISTS idx_usage_logs_user_period ON usage_logs(user_id, billing_period);
    CREATE INDEX IF NOT EXISTS idx_usage_logs_created ON usage_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_chat_history_modified_at ON chat_history(modified_at);
    CREATE INDEX IF NOT EXISTS idx_chat_history_repo_path ON chat_history(repo_path);
    CREATE INDEX IF NOT EXISTS idx_so_repo_runtime ON session_outcomes(repo_path, runtime, completed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_so_repo_completed ON session_outcomes(repo_path, completed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_so_lane_id ON session_outcomes(lane_id);
    CREATE INDEX IF NOT EXISTS idx_so_packet_id ON session_outcomes(packet_id);
    CREATE INDEX IF NOT EXISTS idx_so_valid_to ON session_outcomes(valid_to);
    CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id);
    CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_github_repositories_installation ON github_repositories(installation_id);
    CREATE INDEX IF NOT EXISTS idx_github_sync_repo_resource ON github_sync_state(repo_full_name, resource);
    CREATE INDEX IF NOT EXISTS idx_github_issues_repo_state_updated ON github_issues(repo_full_name, state, updated_at);
    CREATE INDEX IF NOT EXISTS idx_github_prs_repo_state_updated ON github_pull_requests(repo_full_name, state, updated_at);
    CREATE INDEX IF NOT EXISTS idx_lanes_session_key ON lanes(session_key);
    CREATE INDEX IF NOT EXISTS idx_lanes_packet_id ON lanes(packet_id);
    CREATE INDEX IF NOT EXISTS idx_lanes_repo_branch_status ON lanes(repo_path, branch, status);
    CREATE INDEX IF NOT EXISTS idx_lanes_status ON lanes(status);
    CREATE INDEX IF NOT EXISTS idx_dispatch_rules_repo_path_packet_type ON dispatch_rules(repo_path, packet_type);
    CREATE INDEX IF NOT EXISTS idx_dispatch_rules_signal_score_desc ON dispatch_rules(signal_score DESC);
    CREATE INDEX IF NOT EXISTS idx_worker_runs_lane_id ON worker_runs(lane_id);
    CREATE INDEX IF NOT EXISTS idx_worker_runs_status ON worker_runs(status);
    CREATE INDEX IF NOT EXISTS idx_worker_events_run_created ON worker_events(worker_run_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_lane_events_lane_timestamp ON lane_events(lane_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_lane_events_timestamp ON lane_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_external_mcp_servers_enabled ON external_mcp_servers(enabled);
    CREATE INDEX IF NOT EXISTS idx_external_mcp_servers_updated_at ON external_mcp_servers(updated_at);
    CREATE INDEX IF NOT EXISTS idx_external_mcp_servers_team_id ON external_mcp_servers(team_id);

    CREATE TABLE IF NOT EXISTS review_queue (
      id TEXT PRIMARY KEY,
      lane_id TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_review_queue_status ON review_queue(status);
    CREATE INDEX IF NOT EXISTS idx_review_queue_lane_id ON review_queue(lane_id);

    CREATE TABLE IF NOT EXISTS watched_agents (
      surface_id TEXT PRIMARY KEY,
      repo_path TEXT NOT NULL,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL DEFAULT '',
      registered_at INTEGER NOT NULL,
      last_status TEXT NOT NULL DEFAULT 'running',
      retry_count INTEGER NOT NULL DEFAULT 0,
      steer_count INTEGER NOT NULL DEFAULT 0,
      completion_reported INTEGER NOT NULL DEFAULT 0,
      last_event_at INTEGER NOT NULL DEFAULT 0,
      last_activity_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      user_agent TEXT,
      label TEXT,
      webhook_url TEXT,
      last_delivered_at INTEGER,
      failure_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_push_subscriptions_created_at ON push_subscriptions(created_at);

    -- Schema v26 — ActivityKit Live Activity push tokens for o8-mobile.
    CREATE TABLE IF NOT EXISTS mobile_live_activity_tokens (
      push_token TEXT PRIMARY KEY,
      activity_id TEXT,
      bundle_id TEXT NOT NULL,
      environment TEXT NOT NULL DEFAULT 'sandbox',
      device_label TEXT,
      last_signature TEXT,
      last_delivered_at INTEGER,
      failure_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_mobile_live_activity_tokens_updated_at ON mobile_live_activity_tokens(updated_at);

    -- Schema v13 — Projects (epic #899). Operator-curated repo groupings that
    -- replace the Jaccard-based cross-repo proposer (#748). project_repos.role
    -- is free-form text in the DB; the curated set lives in src/lib/projects/types.ts.
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      description TEXT,
      main_repo_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_repos (
      project_id TEXT NOT NULL,
      repo_id TEXT NOT NULL,
      role TEXT,
      suggestion_origin TEXT NOT NULL DEFAULT 'manual',
      added_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, repo_id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_project_repos_repo_id ON project_repos(repo_id);

    CREATE TABLE IF NOT EXISTS dismissed_suggestions (
      fingerprint TEXT PRIMARY KEY,
      dismissed_at INTEGER NOT NULL,
      reason TEXT
    );

    -- Mobile E2EE — per-device revocable tokens. We store the
    -- token HASH only (the token is shown once at enrollment); identity_public_key
    -- is the device's Ed25519 handshake key. The shared ~/.o8/ws-token stays valid
    -- alongside these for the desktop webview + migration.
    CREATE TABLE IF NOT EXISTS mobile_devices (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      device_label TEXT,
      identity_public_key TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mobile_devices_token_hash ON mobile_devices(token_hash);

    -- Mobile inline diff comments — operator line notes from
    -- the phone, anchored to a file + line of an agent session's diff. Read by
    -- the desktop review surface + injected into the agent's iterate prompt.
    CREATE TABLE IF NOT EXISTS mobile_diff_comments (
      id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      path TEXT NOT NULL,
      line_number INTEGER NOT NULL,
      side TEXT NOT NULL DEFAULT 'new',
      text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mobile_diff_comments_session ON mobile_diff_comments(session_key);
  `);

  ensureApprovalContextColumns(sqlite);
  ensureWatchedAgentColumns(sqlite);
  ensureChatHistoryColumns(sqlite);
  ensureSessionOutcomeColumns(sqlite);
  ensureUsageLogSchema(sqlite);
  ensureApprovalEventsTable(sqlite);
  ensureExternalMcpServerColumns(sqlite);
  migrateLegacyApprovalStoreIfNeeded(sqlite, { approvalsTablePreviouslyMissing });
  backfillWatchedAgentColumns(sqlite);
  backfillApprovalContextColumns(sqlite);
  backfillApprovalEventsFromAuditJson(sqlite);
  backfillSessionOutcomeValidFrom(sqlite);
  ensureApprovalContextIndexes(sqlite);
  ensureUsageLogIndexes(sqlite);
  migrateLegacyLaneStoreIfNeeded(sqlite, { lanesTablePreviouslyMissing });
  ensureProjectScopeColumns(sqlite);
}

/**
 * #859 — walk every marker version v1..DB_SCHEMA_VERSION and write any that
 * are missing. Existing installs that landed before v4 stayed pinned at v3
 * forever because the old `writeMigrationMarker()` only stamped the highest
 * version once and bailed; brand-new installs likewise only ever showed
 * `.db-migrated-v12`, hiding the migration history.
 *
 * This runs unconditionally on every boot. The `existsSync` check makes each
 * write idempotent — we only touch files that aren't already present — so
 * the cost is one stat per missing marker (~12 syscalls in the worst case).
 *
 * We don't run version-specific SQL here. The schema-mutating helpers live
 * in `ensureIdempotentColumnAdds` and `ensureTables`; markers are purely an
 * audit trail of what's been applied. That separation matches the issue
 * fix: "idempotent column-add helpers should run unconditionally" + "walk
 * all marker versions on every boot".
 */
function writeAllMissingMigrationMarkers(): void {
  const now = new Date().toISOString();
  for (let version = 1; version <= DB_SCHEMA_VERSION; version += 1) {
    const markerPath = migrationMarkerPath(version);
    if (existsSync(markerPath)) continue;
    try {
      writeFileSync(
        markerPath,
        JSON.stringify({ schemaVersion: version, migratedAt: now }),
      );
    } catch (error) {
      console.warn(`[db] Failed to write migration marker at ${markerPath}`, error);
    }
  }
}

function ensureUserColumns(sqlite: Database.Database): void {
  // Clerk identity link. SQLite ALTER TABLE ADD COLUMN can't add a UNIQUE
  // column, so add the plain column then enforce uniqueness with a partial
  // unique index (NULLs are allowed for pre-Clerk / BYOK-only local users).
  if (!tableColumnExists(sqlite, 'users', 'clerk_user_id')) {
    addColumnTolerant(sqlite, 'ALTER TABLE users ADD COLUMN clerk_user_id TEXT');
  }
  sqlite.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_clerk_user_id ON users(clerk_user_id) WHERE clerk_user_id IS NOT NULL',
  );
}

function ensureApprovalContextColumns(sqlite: Database.Database): void {
  if (!tableColumnExists(sqlite, 'approvals', 'packet_id')) {
    addColumnTolerant(sqlite, 'ALTER TABLE approvals ADD COLUMN packet_id TEXT');
  }
  if (!tableColumnExists(sqlite, 'approvals', 'lane_id')) {
    addColumnTolerant(sqlite, 'ALTER TABLE approvals ADD COLUMN lane_id TEXT');
  }
  if (!tableColumnExists(sqlite, 'approvals', 'gate_result_json')) {
    addColumnTolerant(sqlite, 'ALTER TABLE approvals ADD COLUMN gate_result_json TEXT');
  }
  if (!tableColumnExists(sqlite, 'approvals', 'conflict_report_json')) {
    addColumnTolerant(sqlite, 'ALTER TABLE approvals ADD COLUMN conflict_report_json TEXT');
  }
}

function ensureWatchedAgentColumns(sqlite: Database.Database): void {
  if (!tableColumnExists(sqlite, 'watched_agents', 'last_event_at')) {
    addColumnTolerant(sqlite, 'ALTER TABLE watched_agents ADD COLUMN last_event_at INTEGER NOT NULL DEFAULT 0');
  }
}

function ensureChatHistoryColumns(sqlite: Database.Database): void {
  if (!tableColumnExists(sqlite, 'chat_history', 'plan_text')) {
    addColumnTolerant(sqlite, 'ALTER TABLE chat_history ADD COLUMN plan_text TEXT');
  }
}

function ensureLaneHeartbeatColumns(sqlite: Database.Database): void {
  for (const [column, type] of Object.entries({ last_heartbeat_at: 'INTEGER', pr_number: 'INTEGER', outcome: 'TEXT', outcome_note: 'TEXT', model: 'TEXT' })) {
    if (!tableColumnExists(sqlite, 'lanes', column)) addColumnTolerant(sqlite, `ALTER TABLE lanes ADD COLUMN ${column} ${type}`);
  }
}

function ensureMissionStateColumn(sqlite: Database.Database): void {
  if (!tableColumnExists(sqlite, 'missions', 'mission_state_json')) {
    addColumnTolerant(sqlite, 'ALTER TABLE missions ADD COLUMN mission_state_json TEXT');
  }
}

function backfillSessionOutcomeValidFrom(sqlite: Database.Database): void {
  // #835 — `valid_from` should always be populated (Drizzle schema default
  // supplies `datetime('now')`), but legacy seed rows and raw INSERTs that
  // bypass the ORM can leave it NULL. Without a value here, the decay sweep
  // can't compare against it and the row leaks live forever. Backfill from
  // the work timestamp (`completed_at`) when present, else `created_at`,
  // else `datetime('now')` as the last-resort floor.
  const result = sqlite.prepare(`
    UPDATE session_outcomes
    SET valid_from = COALESCE(completed_at, created_at, datetime('now'))
    WHERE valid_from IS NULL OR valid_from = ''
  `).run() as { changes?: number };

  if ((result.changes ?? 0) > 0) {
    console.log(`[db] Backfilled valid_from for ${result.changes} session_outcomes row${result.changes === 1 ? '' : 's'}`);
  }
}

/**
 * #745 phase 2 — public entry point for the periodic backfill tick.
 *
 * The boot-time backfill in `ensureIdempotentColumnAdds()` only fires when
 * `getDb()` is first called per process. Long-running processes that get a
 * raw NULL-`valid_from` row inserted by another agent between boots leak the
 * row as "live but unbackfilled" until the next process restart. The decay
 * sweep does compensate via COALESCE in its WHERE clause, but recall paths
 * that gate on `valid_from IS NOT NULL` (see `liveOutcomeFilter()`) still
 * exclude these rows from results — and now `countOutcomes()` matches that
 * exclusion too.
 *
 * The decay tick (every 6h) calls this as step 0 so any stray NULL gets
 * stamped before the same tick runs the age-out sweep.
 */
export function runSessionOutcomeValidFromBackfill(): void {
  if (!_sqlite) {
    // No DB connection yet — nothing to backfill. The first `getDb()` call
    // will run the boot-time backfill anyway.
    return;
  }
  try {
    backfillSessionOutcomeValidFrom(_sqlite);
  } catch (error) {
    console.warn(
      '[db] periodic valid_from backfill failed:',
      error instanceof Error ? error.message : error,
    );
  }
}

function backfillWatchedAgentColumns(sqlite: Database.Database): void {
  const result = sqlite.prepare(`
    UPDATE watched_agents
    SET last_event_at = CASE
      WHEN last_event_at IS NOT NULL AND last_event_at > 0 THEN last_event_at
      WHEN last_activity_at IS NOT NULL AND last_activity_at > 0 THEN last_activity_at
      ELSE registered_at
    END
    WHERE last_event_at IS NULL OR last_event_at <= 0
  `).run() as { changes?: number };

  if ((result.changes ?? 0) > 0) {
    console.log(`[db] Backfilled last_event_at for ${result.changes} watched agent row${result.changes === 1 ? '' : 's'}`);
  }
}

function backfillApprovalContextColumns(sqlite: Database.Database): void {
  const approvalsNeedingBackfill = sqlite.prepare(`
    SELECT id, metadata_json, packet_id, lane_id
    FROM approvals
    WHERE packet_id IS NULL OR lane_id IS NULL
  `).all() as Array<{
    id: string;
    metadata_json: string | null;
    packet_id: string | null;
    lane_id: string | null;
  }>;

  if (approvalsNeedingBackfill.length === 0) {
    return;
  }

  const updateApprovalContext = sqlite.prepare(`
    UPDATE approvals
    SET packet_id = ?, lane_id = ?
    WHERE id = ?
  `);

  let updatedCount = 0;
  sqlite.transaction((rows: typeof approvalsNeedingBackfill) => {
    for (const row of rows) {
      const { packetId, laneId } = extractApprovalContextIdsFromMetadataJson(row.metadata_json);
      const nextPacketId = row.packet_id ?? packetId;
      const nextLaneId = row.lane_id ?? laneId;

      if (nextPacketId === row.packet_id && nextLaneId === row.lane_id) {
        continue;
      }

      updateApprovalContext.run(nextPacketId ?? null, nextLaneId ?? null, row.id);
      updatedCount += 1;
    }
  })(approvalsNeedingBackfill);

  if (updatedCount > 0) {
    console.log(`[db] Backfilled approval context columns for ${updatedCount} approval rows`);
  }
}

function ensureApprovalEventsTable(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS approval_events (
      id TEXT PRIMARY KEY,
      approval_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'system',
      note TEXT,
      details_json TEXT NOT NULL DEFAULT '{}',
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_approval_events_approval_timestamp
      ON approval_events(approval_id, timestamp);
  `);
}

function backfillApprovalEventsFromAuditJson(sqlite: Database.Database): void {
  // Check if we've already backfilled by looking for any rows
  const existing = sqlite.prepare('SELECT COUNT(*) as count FROM approval_events').get() as { count: number };
  if (existing.count > 0) return;

  const rows = sqlite.prepare(`
    SELECT id, audit_json FROM approvals WHERE audit_json IS NOT NULL AND audit_json != '[]'
  `).all() as Array<{ id: string; audit_json: string }>;

  if (rows.length === 0) return;

  const insert = sqlite.prepare(`
    INSERT OR IGNORE INTO approval_events (id, approval_id, event_type, actor, note, details_json, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let eventCount = 0;
  sqlite.transaction((allRows: typeof rows) => {
    for (const row of allRows) {
      let events: Array<{ type?: string; actor?: string; note?: string; timestamp?: number; [key: string]: unknown }> = [];
      try { events = JSON.parse(row.audit_json); } catch { continue; }
      if (!Array.isArray(events)) continue;

      for (const event of events) {
        const eventId = `evt-${row.id}-${event.timestamp ?? Date.now()}-${eventCount}`;
        const { type, actor, note, timestamp, ...rest } = event;
        insert.run(
          eventId,
          row.id,
          type ?? 'unknown',
          actor ?? 'system',
          note ?? null,
          JSON.stringify(rest),
          timestamp ?? Date.now(),
        );
        eventCount += 1;
      }
    }
  })(rows);

  if (eventCount > 0) {
    console.log(`[db] Backfilled ${eventCount} approval events from audit_json blobs`);
  }
}

function ensureApprovalContextIndexes(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_approvals_packet_id ON approvals(packet_id);
    CREATE INDEX IF NOT EXISTS idx_approvals_lane_id ON approvals(lane_id);
  `);
}

/**
 * Schema v10 — push_subscriptions table for mobile Web Push (issue #639).
 * Creates the table if missing on existing databases. Idempotent.
 */
function ensurePushSubscriptionsTable(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      user_agent TEXT,
      label TEXT,
      webhook_url TEXT,
      last_delivered_at INTEGER,
      failure_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_push_subscriptions_created_at ON push_subscriptions(created_at);
  `);
}

/**
 * Schema v26 — ActivityKit Live Activity push tokens for o8-mobile.
 * ActivityKit tokens are per Live Activity and are different from Web Push
 * subscriptions, so keep them in a dedicated table and prune on APNs 400/410.
 */
function ensureMobileLiveActivityTokensTable(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS mobile_live_activity_tokens (
      push_token TEXT PRIMARY KEY,
      activity_id TEXT,
      bundle_id TEXT NOT NULL,
      environment TEXT NOT NULL DEFAULT 'sandbox',
      device_label TEXT,
      last_signature TEXT,
      last_delivered_at INTEGER,
      failure_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_mobile_live_activity_tokens_updated_at ON mobile_live_activity_tokens(updated_at);
  `);
}

/**
 * Schema v13 — Projects model (epic #899). Creates the three Projects tables
 * for installs that landed before v13. Idempotent.
 */
function ensureProjectsTables(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      description TEXT,
      main_repo_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_repos (
      project_id TEXT NOT NULL,
      repo_id TEXT NOT NULL,
      role TEXT,
      suggestion_origin TEXT NOT NULL DEFAULT 'manual',
      added_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, repo_id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_project_repos_repo_id ON project_repos(repo_id);

    CREATE TABLE IF NOT EXISTS dismissed_suggestions (
      fingerprint TEXT PRIMARY KEY,
      dismissed_at INTEGER NOT NULL,
      reason TEXT
    );
  `);

  if (!tableColumnExists(sqlite, 'projects', 'main_repo_id')) {
    addColumnTolerant(sqlite, 'ALTER TABLE projects ADD COLUMN main_repo_id TEXT');
  }
  sqlite.exec(`
    UPDATE projects
    SET main_repo_id = (
      SELECT repo_id
      FROM project_repos
      WHERE project_repos.project_id = projects.id
      ORDER BY
        CASE role
          WHEN 'fullstack' THEN 0
          WHEN 'backend' THEN 1
          WHEN 'service' THEN 2
          WHEN 'frontend' THEN 3
          WHEN 'shared' THEN 4
          WHEN 'library' THEN 5
          WHEN 'mobile' THEN 6
          WHEN 'site' THEN 7
          WHEN 'docs' THEN 8
          WHEN 'infra' THEN 9
          ELSE 10
        END,
        added_at ASC
      LIMIT 1
    )
    WHERE (main_repo_id IS NULL OR main_repo_id = '')
      AND EXISTS (
        SELECT 1 FROM project_repos WHERE project_repos.project_id = projects.id
      )
  `);
}

/**
 * Schema v13 — add nullable `project_id` to existing tables that should be
 * scopable to a Project. Cross-repo signals (outcomes, approvals, lanes) can
 * then propagate to every member repo via the new Projects model.
 */
function ensureProjectScopeColumns(sqlite: Database.Database): void {
  if (!tableColumnExists(sqlite, 'session_outcomes', 'project_id')) {
    addColumnTolerant(sqlite, 'ALTER TABLE session_outcomes ADD COLUMN project_id TEXT');
  }
  if (!tableColumnExists(sqlite, 'approvals', 'project_id')) {
    addColumnTolerant(sqlite, 'ALTER TABLE approvals ADD COLUMN project_id TEXT');
  }
  if (!tableColumnExists(sqlite, 'lanes', 'project_id')) {
    addColumnTolerant(sqlite, 'ALTER TABLE lanes ADD COLUMN project_id TEXT');
  }
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_session_outcomes_project_id ON session_outcomes(project_id);
    CREATE INDEX IF NOT EXISTS idx_approvals_project_id ON approvals(project_id);
    CREATE INDEX IF NOT EXISTS idx_lanes_project_id ON lanes(project_id);
  `);
  sqlite.prepare(
    "UPDATE session_outcomes SET project_id = ? WHERE project_id IS NULL OR project_id = ''",
  ).run(DEFAULT_PROJECT_ID);
  sqlite.prepare(
    "UPDATE approvals SET project_id = ? WHERE project_id IS NULL OR project_id = ''",
  ).run(DEFAULT_PROJECT_ID);
  sqlite.prepare(
    "UPDATE lanes SET project_id = ? WHERE project_id IS NULL OR project_id = ''",
  ).run(DEFAULT_PROJECT_ID);
}

/**
 * Adds columns introduced in schema v8 to an existing external_mcp_servers table.
 * CREATE TABLE IF NOT EXISTS already includes these for fresh databases.
 */
function ensureExternalMcpServerColumns(sqlite: Database.Database): void {
  if (!tableColumnExists(sqlite, 'external_mcp_servers', 'team_id')) {
    addColumnTolerant(sqlite, 'ALTER TABLE external_mcp_servers ADD COLUMN team_id TEXT');
  }
  if (!tableColumnExists(sqlite, 'external_mcp_servers', 'url')) {
    addColumnTolerant(sqlite, 'ALTER TABLE external_mcp_servers ADD COLUMN url TEXT');
  }
  if (!tableColumnExists(sqlite, 'external_mcp_servers', 'oauth_token')) {
    addColumnTolerant(sqlite, 'ALTER TABLE external_mcp_servers ADD COLUMN oauth_token TEXT');
  }
  // Ensure team_id index exists (may be missing on pre-v8 databases)
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_external_mcp_servers_team_id ON external_mcp_servers(team_id);
  `);
}

// Re-export schema for convenience
export * from './schema';
export { schema };
