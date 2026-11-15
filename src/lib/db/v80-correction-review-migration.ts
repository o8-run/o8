import type Database from 'better-sqlite3';

/** Saved review authority is stored atomically with its author delivery intent. */
export function ensureV80CorrectionReviewSchema(sqlite: Database.Database): void {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS correction_reviews (
    correction_id TEXT PRIMARY KEY REFERENCES worker_corrections(id),
    lane_id TEXT NOT NULL, packet_id TEXT NOT NULL, source_json TEXT NOT NULL,
    review_id TEXT UNIQUE REFERENCES review_queue(id), head_sha TEXT, run_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_correction_reviews_packet ON correction_reviews(packet_id, created_at);`);
}
