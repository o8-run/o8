import 'server-only';
import { createHash } from 'node:crypto';
import { getSqlite } from '@/lib/db';
import { recordAutomationSourceEvent } from '@/lib/automations/source-events';
import { githubApiCallStats, type GitHubApiCallStats } from '@/lib/github/cache';

export type PrWatchChange = 'head' | 'checks' | 'state' | 'comments' | 'reviews';
export interface PrWatchResult { changes: PrWatchChange[]; commentUpdatesPaused: boolean; superseded?: boolean; githubApiCalls: GitHubApiCallStats }
type RemarkSignature = [string, number, string];
interface Baseline { head: string; checks: string; state: string; comments: string; reviews: string; commentSignatures: RemarkSignature[]; reviewSignatures: RemarkSignature[]; commentWakes: number; generation: number; readOrder: number }
interface Remark { id: number; author: string; body: string; state?: string; kind?: 'comments' | 'inline' | 'reviews' }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function tables() {
  const db = getSqlite();
  db.exec(`CREATE TABLE IF NOT EXISTS github_pr_watch_baselines (scope TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL, baseline TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(scope,repo,number));
    CREATE TABLE IF NOT EXISTS github_pr_watch_own_remarks (scope TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL, kind TEXT NOT NULL, id INTEGER NOT NULL, recorded_at INTEGER NOT NULL, PRIMARY KEY(scope,repo,number,kind,id));
    CREATE TABLE IF NOT EXISTS github_pr_watch_clock (id INTEGER PRIMARY KEY CHECK(id=1), sequence INTEGER NOT NULL); INSERT OR IGNORE INTO github_pr_watch_clock VALUES (1,0);`);
  return db;
}
export function beginPrWatchRead(): number {
  return (tables().prepare('UPDATE github_pr_watch_clock SET sequence=sequence+1 WHERE id=1 RETURNING sequence').get() as { sequence: number }).sequence;
}
export function recordOwnPrRemark(scope: string | undefined, repo: string, number: number, kind: 'comments' | 'reviews', id?: number): void {
  if (!scope || !Number.isSafeInteger(id)) return;
  const db = tables();
  db.prepare('INSERT OR IGNORE INTO github_pr_watch_own_remarks VALUES (?,?,?,?,?,?)').run(scope, repo.toLowerCase(), number, kind, id, Date.now());
  db.prepare('DELETE FROM github_pr_watch_own_remarks WHERE recorded_at < ?').run(Date.now() - 30 * 86_400_000);
  db.prepare('DELETE FROM github_pr_watch_own_remarks WHERE rowid NOT IN (SELECT rowid FROM github_pr_watch_own_remarks ORDER BY recorded_at DESC LIMIT 4096)').run();
}
/** A successful authorized read advances one durable baseline; failures never mean "no updates". */
export function recordPrWatchSnapshot(input: {
  scope: string; repo: string; number: number; head: string; state: string; checks: unknown; checksUnavailable?: boolean;
  comments: Remark[]; reviews: Remark[]; discussionIncomplete?: boolean; repoPath?: string; readOrder?: number;
}): PrWatchResult {
  const db = tables(); const repo = input.repo.toLowerCase();
  return db.transaction(() => {
    const row = db.prepare('SELECT baseline FROM github_pr_watch_baselines WHERE scope=? AND repo=? AND number=?').get(input.scope, repo, input.number) as { baseline: string } | undefined;
    const prior = row ? JSON.parse(row.baseline) as Baseline : undefined;
    const readOrder = input.readOrder ?? beginPrWatchRead();
    if (prior && readOrder <= prior.readOrder) return { changes: [], commentUpdatesPaused: prior.commentWakes > 3, superseded: true, githubApiCalls: githubApiCallStats() };
    const own = db.prepare('SELECT kind,id FROM github_pr_watch_own_remarks WHERE scope=? AND repo=? AND number=?').all(input.scope, repo, input.number) as Array<{ kind: string; id: number }>;
    const excludeOwn = (values: RemarkSignature[]) => values.filter(value => !own.some(saved => saved.kind === value[0] && saved.id === value[1]));
    const signatures = (kind: 'comments' | 'reviews', values: Remark[]): RemarkSignature[] => excludeOwn(values.map(value => [value.kind ?? kind, value.id, hash([value.author, value.body, value.state ?? ''])] as RemarkSignature))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    // New posting receipts can identify a remark that an overlapping read already saw.
    // Rebase both sides of the comparison; bookkeeping never becomes a deletion event.
    if (prior?.commentSignatures && prior.comments !== '') prior.comments = hash(excludeOwn(prior.commentSignatures));
    if (prior?.reviewSignatures && prior.reviews !== '') prior.reviews = hash(excludeOwn(prior.reviewSignatures));
    const commentSignatures = input.discussionIncomplete ? excludeOwn(prior?.commentSignatures ?? []) : signatures('comments', input.comments);
    const reviewSignatures = input.discussionIncomplete ? excludeOwn(prior?.reviewSignatures ?? []) : signatures('reviews', input.reviews);
    const next: Baseline = { head: input.head, state: input.state,
      checks: input.checksUnavailable ? prior?.checks ?? '' : hash(input.checks),
      comments: input.discussionIncomplete ? prior?.comments ?? '' : hash(commentSignatures),
      reviews: input.discussionIncomplete ? prior?.reviews ?? '' : hash(reviewSignatures), commentSignatures, reviewSignatures,
      commentWakes: prior?.commentWakes ?? 0, generation: prior?.generation ?? 0, readOrder };
    const changes: PrWatchChange[] = prior ? (['head', 'checks', 'state', 'comments', 'reviews'] as const).filter(kind => prior[kind] !== '' && next[kind] !== prior[kind]) : [];
    const substantive = changes.some(kind => kind !== 'comments');
    if (substantive) next.commentWakes = 0;
    else if (changes.includes('comments')) next.commentWakes += 1;
    const commentUpdatesPaused = next.commentWakes > 3;
    const actionable = changes.filter(kind => kind !== 'comments' || !commentUpdatesPaused);
    if (changes.length) next.generation += 1;
    db.prepare('INSERT INTO github_pr_watch_baselines VALUES (?,?,?,?,?) ON CONFLICT(scope,repo,number) DO UPDATE SET baseline=excluded.baseline,updated_at=excluded.updated_at').run(input.scope, repo, input.number, JSON.stringify(next), Date.now());
    db.prepare('DELETE FROM github_pr_watch_baselines WHERE rowid NOT IN (SELECT rowid FROM github_pr_watch_baselines ORDER BY updated_at DESC LIMIT 256)').run();
    if (actionable.length && input.repoPath) recordAutomationSourceEvent({ sourceKind: 'repository', sourceId: `github:${repo}#${input.number}`, repoPath: input.repoPath,
      eventType: 'pull_request_updated', fingerprint: hash([input.scope, repo, input.number, next.generation, actionable, next]),
      payload: { pullRequestNumber: input.number, headSha: input.head, changes: actionable }, occurredAt: Date.now() });
    return { changes: actionable, commentUpdatesPaused, githubApiCalls: githubApiCallStats() };
  })();
}
