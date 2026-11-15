import 'server-only';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from '@/lib/providers/child-process';
import { resolveGitBinary } from '@/lib/git/binary';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { findRepoByIdSync } from '@/lib/repos/registry';
import { withResourceLease } from '@/lib/leases/resource-lease-guard';
import { laneGit, laneGitArguments, laneGitEnvironment } from '@/lib/lane/lane-git';
import { runConfinedProcess, ranUnconfined } from '@/lib/sandbox/run-confined';
import { buildQueuePlan, queueGit, type QueueSources } from './plan';
import { readQueueRecord, writeQueueRecord, queueRoot } from './store';
import { IntegrationQueueError, queueSpecSchema, type QueueAttempt, type QueuePlan, type QueueSpec } from './types';

function repoFor(id: string) {
  const repo = findRepoByIdSync(id);
  if (!repo) throw new IntegrationQueueError('Registered repository not found.', 404);
  return repo;
}
function projection(plan: QueuePlan | null, attempt: QueueAttempt | null, history: QueueAttempt[]) {
  const current = !!plan && attempt?.inputHash === plan.inputHash;
  return { schema: 'o8/integration-queue/v1', plan,
    attempt: attempt && !current ? { ...attempt, execution: attempt.execution ?? { status: attempt.status, reason: attempt.reason }, status: 'stale', reason: 'Target, source, dependencies, checks or effective policy changed. Prepare a new candidate.' } : attempt,
    history, nextAction: 'human',
    reason: 'Verification is evidence only. An operator must resolve blockers and use the existing governed publication path; no publication was requested.' };
}
export async function readIntegrationQueue(repoId: string) {
  const repo = repoFor(repoId);
  const record = readQueueRecord(repoId);
  if (!record) return projection(null, null, []);
  const { plan } = await buildQueuePlan(repoId, repo.localPath, record.spec);
  return projection(plan, record.attempts.at(-1) ?? null, record.attempts);
}

async function candidateWorkspace(repoPath: string, targetSha: string, order: string[], sources: QueueSources, plan: QueuePlan, workspace: string) {
  // Clone, fetch and merge write only our new checkout. Source branches,
  // worktrees, remote refs and coordination ownership are never changed.
  await promisify(execFile)(resolveGitBinary(), laneGitArguments(['clone', '--quiet', '--no-checkout', '--no-hardlinks', '--', repoPath, workspace]), {
    cwd: workspace, env: laneGitEnvironment(true), timeout: 120000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  });
  await queueGit(workspace, ['checkout', '--quiet', '--detach', targetSha]);
  for (const id of order) {
    const lane = sources.get(id)!;
    const sha = plan.entries.find(entry => entry.id === id)!.headSha!;
    await laneGit(workspace, workspace, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--', lane.worktreePath || lane.repoPath, sha], { timeout: 120000 });
    try {
      await laneGit(workspace, workspace, ['merge', '--quiet', '--no-ff', '--no-edit', '-m', 'Integration candidate', sha], {
        timeout: 120000, identity: { name: 'o8', email: 'noreply@o8.local' },
      });
    } catch {
      const conflicts = await queueGit(workspace, ['diff', '--name-only', '--diff-filter=U']);
      if (conflicts) throw new IntegrationQueueError(`Candidate conflict while integrating ${id}. An operator must scope a correction or change the order.`, 422);
      throw new IntegrationQueueError(`Candidate preparation failed for ${id}. Inspect its source and Git state.`);
    }
  }
  return { headSha: await queueGit(workspace, ['rev-parse', 'HEAD']), treeSha: await queueGit(workspace, ['rev-parse', 'HEAD^{tree}']) };
}
async function verifyChecks(workspace: string, spec: QueueSpec, attempt: QueueAttempt, save: () => void) {
  for (const check of spec.checks) {
    try {
      const run = await runConfinedProcess(workspace, check.command, check.args, { cwd: workspace, timeout: check.timeoutMs, maxBuffer: 4 * 1024 * 1024 });
      attempt.checks.push({ name: check.name, verdict: 'pass', exitCode: 0, unconfined: run.unconfined });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      attempt.checks.push({ name: check.name, verdict: 'fail', exitCode: typeof code === 'number' ? code : null, unconfined: ranUnconfined(error) });
      attempt.status = 'failed';
      attempt.reason = `Required combined-result check ${check.name} failed or did not complete. Inspect this candidate before assigning a correction.`;
      save(); return;
    }
    save();
    if (await queueGit(workspace, ['rev-parse', 'HEAD']) !== attempt.candidate!.headSha
      || await queueGit(workspace, ['status', '--porcelain', '--untracked-files=no'])) {
      attempt.status = 'failed';
      attempt.reason = `Required check ${check.name} modified the candidate. Its result cannot verify the recorded tree.`;
      return;
    }
  }
  attempt.status = 'passed';
}
/** Explicit operator invocation. The publication lease serializes preparation
 * with other repository actions, but this service never calls publication. */
export async function prepareIntegrationQueue(repoId: string, input: unknown) {
  const parsed = queueSpecSchema.safeParse(input);
  if (!parsed.success) throw new IntegrationQueueError('Specify a target ref, unique accepted task IDs and at least one required check with command, args and timeoutMs.', 400);
  const spec = parsed.data;
  const repo = repoFor(repoId);
  const guarded = await withResourceLease({ resource: `repo-tree:${repo.localPath}`,
    owner: { id: `integration-queue:${process.pid}`, label: 'integration-queue', pid: process.pid },
    actor: 'system:integration-queue', maxWaitMs: 0,
  }, async () => {
    const previous = readQueueRecord(repoId);
    const { plan, sources } = await buildQueuePlan(repoId, repo.localPath, spec);
    // Keep failed attempts. A crash has no publication to replay; only a new
    // owned checkout may restart verification after reacquiring the lease.
    const history = previous?.attempts ?? [];
    for (const prior of history) if (prior.status === 'verifying') {
      prior.status = 'interrupted'; prior.reason = 'Verification was interrupted. A new candidate is required; no publication was requested.';
      prior.execution = { status: prior.status, reason: prior.reason };
      prior.finishedAt = new Date().toISOString();
    }
    const attempt: QueueAttempt = { id: randomUUID(), inputHash: plan.inputHash, startedAt: new Date().toISOString(), finishedAt: null,
      status: 'verifying', execution: null, targetSha: plan.targetSha, sources: plan.entries.map(entry => ({ id: entry.id, headSha: entry.headSha })),
      evidence: { spec, plan }, order: plan.order, candidate: null, checks: [], reason: null, publication: 'not_requested' };
    const record = { version: 1 as const, repoId, spec, attempts: [...history, attempt] };
    const save = () => writeQueueRecord(record);
    save();
    if (!plan.targetSha || !plan.order.length || plan.blockers.length) {
      attempt.status = 'blocked'; attempt.reason = plan.blockers.join(' ') || 'No eligible reviewed change. Inspect the entry blockers.';
    } else {
      const workspace = await mkdtemp(join(queueRoot(), 'candidate-'));
      try {
        attempt.candidate = await candidateWorkspace(repo.localPath, plan.targetSha, plan.order, sources, plan, workspace);
        save();
        await verifyChecks(workspace, spec, attempt, save);
      } catch (error) {
        attempt.status = error instanceof IntegrationQueueError && error.status === 422 ? 'conflict' : 'blocked';
        attempt.reason = error instanceof IntegrationQueueError ? error.message : 'Candidate preparation or verification is unreadable. An operator must inspect the recorded inputs.';
      } finally { await rm(workspace, { recursive: true, force: true }); }
    }
    attempt.execution = { status: attempt.status, reason: attempt.reason };
    const fresh = await buildQueuePlan(repoId, repo.localPath, spec);
    if (fresh.plan.inputHash !== plan.inputHash) {
      attempt.status = 'stale'; attempt.reason = 'Target, source, dependencies or effective policy changed during verification. Prepare a new candidate.';
    }
    attempt.finishedAt = new Date().toISOString(); save();
    return projection(fresh.plan, attempt, record.attempts);
  });
  if (guarded.state !== 'completed') throw new IntegrationQueueError('The repository integration owner is busy or unavailable. Inspect the repository lease and retry.', 409);
  return guarded.value;
}
