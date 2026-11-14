import 'server-only';
import { getSqlite } from '@/lib/db';

export interface PublicationReceipt {
  id: string;
  repo: string;
  number: number;
  approvedSha: string;
  mergedSha: string | null;
  baseSha: string | null;
  baseRef: string | null;
  method: 'merge' | 'squash' | 'rebase';
  action: 'merge' | 'enable-auto-merge';
  authorizingPrincipal: string;
  scope: string;
  status: 'unknown' | 'merged' | 'queued' | 'auto_merge_enabled' | 'refused';
  checks: unknown;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}
function tables() {
  const db = getSqlite();
  db.exec(`CREATE TABLE IF NOT EXISTS github_publication_intents (
    host TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL, receipt TEXT NOT NULL,
    PRIMARY KEY(host, repo, number));
    CREATE TABLE IF NOT EXISTS github_publication_events (
      id INTEGER PRIMARY KEY, intent_id TEXT NOT NULL, receipt TEXT NOT NULL);`);
  return db;
}
export function readPublication(host: string, repo: string, number: number): PublicationReceipt | null {
  const row = tables().prepare('SELECT receipt FROM github_publication_intents WHERE host=? AND repo=? AND number=?')
    .get(host, repo.toLowerCase(), number) as { receipt: string } | undefined;
  return row ? JSON.parse(row.receipt) : null;
}
/** Claim and append evidence in the same SQLite transaction, before sending any mutation. */
export function claimPublication(host: string, receipt: PublicationReceipt): PublicationReceipt {
  const db = tables();
  return db.transaction(() => {
    const previous = readPublication(host, receipt.repo, receipt.number);
    if (previous && previous.status !== 'refused') return previous;
    savePublication(host, receipt, true);
    return receipt;
  }).immediate();
}
export function savePublication(host: string, receipt: PublicationReceipt, replaceRefusal = false): void {
  const db = tables();
  db.transaction(() => {
    const current = readPublication(host, receipt.repo, receipt.number);
    if (current && current.id !== receipt.id && !replaceRefusal) return;
    if (current?.id === receipt.id && (current.status === 'merged'
      || receipt.status === 'unknown' && ['queued', 'auto_merge_enabled'].includes(current.status))) return;
    const json = JSON.stringify(receipt);
    db.prepare('INSERT INTO github_publication_intents VALUES (?,?,?,?) ON CONFLICT(host,repo,number) DO UPDATE SET receipt=excluded.receipt')
      .run(host, receipt.repo.toLowerCase(), receipt.number, json);
    db.prepare('INSERT INTO github_publication_events(intent_id,receipt) VALUES (?,?)').run(receipt.id, json);
  })();
}

export function recordPublicationRefusal(receipt: PublicationReceipt): void {
  tables().prepare('INSERT INTO github_publication_events(intent_id,receipt) VALUES (?,?)').run(receipt.id, JSON.stringify(receipt));
}
