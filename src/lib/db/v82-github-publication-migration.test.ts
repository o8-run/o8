import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { ensureV82GitHubPublicationSchema } from './v82-github-publication-migration';

it('adds publication tables and preserves existing reservations and events on replay', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE legacy(value TEXT); INSERT INTO legacy VALUES (\'retained\')');
    ensureV82GitHubPublicationSchema(db);
    db.prepare('INSERT INTO github_publication_intents VALUES (?,?,?,?)').run('host', 'repo', 1, '{"status":"unknown"}');
    db.prepare('INSERT INTO github_publication_events(intent_id,receipt) VALUES (?,?)').run('intent', '{"status":"unknown"}');
    ensureV82GitHubPublicationSchema(db);
    expect(db.prepare('SELECT receipt FROM github_publication_intents').all()).toEqual([{ receipt: '{"status":"unknown"}' }]);
    expect(db.prepare('SELECT intent_id,receipt FROM github_publication_events').all()).toEqual([{ intent_id: 'intent', receipt: '{"status":"unknown"}' }]);
    expect(db.prepare('SELECT * FROM legacy').all()).toEqual([{ value: 'retained' }]);
  } finally { db.close(); }
});
