import type Database from 'better-sqlite3';
import { addColumnTolerant, tableColumnExists } from './schema-columns';

/** Additive and replay-safe. v80 is reserved by the correction-review change. */
export function ensureV81ExternalPrReviewSchema(sqlite: Database.Database): void {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS external_pr_review_tasks (
    id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, repo_path TEXT NOT NULL,
    repository_id TEXT NOT NULL, pr_number INTEGER NOT NULL CHECK(pr_number > 0),
    pr_url TEXT NOT NULL, current_revision_id TEXT REFERENCES external_pr_review_revisions(id),
    UNIQUE(repo_id, repository_id, pr_number)
  );
  CREATE TABLE IF NOT EXISTS external_pr_review_revisions (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES external_pr_review_tasks(id),
    sequence INTEGER NOT NULL CHECK(sequence > 0), predecessor_id TEXT REFERENCES external_pr_review_revisions(id),
    head_sha TEXT NOT NULL, base_sha TEXT NOT NULL, base_ref TEXT NOT NULL,
    intended_outcome TEXT, packet_id TEXT NOT NULL UNIQUE, adopted_at TEXT NOT NULL,
    run_evidence_id TEXT, draft INTEGER CHECK(draft IN (0, 1)),
    UNIQUE(task_id, sequence)
  );`);
  if (!tableColumnExists(sqlite, 'external_pr_review_revisions', 'draft')) {
    addColumnTolerant(sqlite, 'ALTER TABLE external_pr_review_revisions ADD COLUMN draft INTEGER CHECK(draft IN (0, 1))');
  }
}
