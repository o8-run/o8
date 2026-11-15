import type Database from 'better-sqlite3';

/** Additive, replay-safe publication reservations and append-only decision evidence. */
export function ensureV82GitHubPublicationSchema(sqlite: Database.Database): void {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS github_publication_intents (
    host TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL, receipt TEXT NOT NULL,
    PRIMARY KEY(host, repo, number));
    CREATE TABLE IF NOT EXISTS github_publication_events (
      id INTEGER PRIMARY KEY, intent_id TEXT NOT NULL, receipt TEXT NOT NULL);`);
}
