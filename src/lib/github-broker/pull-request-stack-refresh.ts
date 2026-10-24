import 'server-only';
import { randomUUID } from 'node:crypto';
import { getSqlite } from '@/lib/db';
import { githubInstallationFetch } from './auth';
import { readPullRequestStack } from './pull-request-stack';

function queue() {
  const db = getSqlite();
  db.exec(`CREATE TABLE IF NOT EXISTS github_pr_stack_refresh_queue (
    repo TEXT NOT NULL, number INTEGER NOT NULL, generation TEXT NOT NULL,
    claim_id TEXT, lease_until INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(repo,number))`);
  return db;
}
/** Signed deliveries coalesce durably; no provider request runs in the webhook response. */
export function enqueuePullRequestStackRefresh(repo: string, number: number) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isSafeInteger(number) || number < 1) return;
  queue().prepare(`INSERT INTO github_pr_stack_refresh_queue (repo,number,generation) VALUES (?,?,?)
    ON CONFLICT(repo,number) DO UPDATE SET generation=excluded.generation,retry_at=0`).run(repo.toLowerCase(), number, randomUUID());
}
/** After-response work and the supervisor share a bounded, crash-recoverable claim. */
export async function drainPullRequestStackRefresh() {
  const now = Date.now();
  const row = queue().prepare('SELECT repo,number,generation FROM github_pr_stack_refresh_queue WHERE lease_until < ? AND retry_at <= ? ORDER BY retry_at ASC, rowid ASC LIMIT 1')
    .get(now, now) as { repo: string; number: number; generation: string } | undefined;
  const claimId = randomUUID();
  if (!row || !queue().prepare('UPDATE github_pr_stack_refresh_queue SET lease_until=?,claim_id=? WHERE repo=? AND number=? AND generation=? AND lease_until < ?')
    .run(now + 60_000, claimId, row.repo, row.number, row.generation, now).changes) return;
  let settled = false;
  try {
    const signal = AbortSignal.timeout(8_000);
    // A minimal current PR read establishes immutable identity and current credential scope.
    const { response, scope } = await githubInstallationFetch(row.repo, `/repos/${row.repo}/pulls/${row.number}`, { signal }, { priority: 'background', share: false });
    if (!response.ok) { await response.body?.cancel(); return; }
    const pr = await response.json() as { id?: number; number?: number; base?: { repo?: { id?: number } } };
    if (pr.number !== row.number || !Number.isSafeInteger(pr.id) || Number(pr.id) < 1 || !Number.isSafeInteger(pr.base?.repo?.id) || Number(pr.base?.repo?.id) < 1) return;
    const result = await readPullRequestStack(row.repo, row.number, scope, { identity: { repositoryId: pr.base!.repo!.id!, pullRequestId: pr.id! }, trigger: 'webhook', priority: 'background', signal });
    settled = result.status === 'ready' || result.status === 'none';
  } catch { /* The durable intent remains available after disconnect, timeout or quota refusal. */ }
  finally {
    if (settled) queue().prepare('DELETE FROM github_pr_stack_refresh_queue WHERE repo=? AND number=? AND generation=? AND claim_id=?').run(row.repo, row.number, row.generation, claimId);
    else queue().prepare('UPDATE github_pr_stack_refresh_queue SET retry_at=? WHERE repo=? AND number=? AND generation=? AND claim_id=?').run(Date.now() + 60_000, row.repo, row.number, row.generation, claimId);
    queue().prepare('UPDATE github_pr_stack_refresh_queue SET lease_until=0,claim_id=NULL WHERE repo=? AND number=? AND claim_id=?').run(row.repo, row.number, claimId);
  }
}
