import { execFile } from '@/lib/providers/child-process';

import { materializationAwareExecFile, materializationAwareInvocation } from './materialization-execution';

/** Drop the donor's branch ownership before a new standalone clone is dispatched. */
export async function finalizeCloneBranchRefs(
  repositoryPath: string,
  workspacePath: string,
  branch: string,
  baseBranch: string,
  hasOrigin: boolean,
): Promise<void> {
  const options = { windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 };
  const [inherited, upstream] = await Promise.all([
    materializationAwareExecFile('git', ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/remotes'], {
      ...options, cwd: workspacePath,
    }),
    materializationAwareExecFile('git', ['for-each-ref', '--format=%(refname) %(objectname) %(symref)', 'refs/remotes/origin', 'refs/heads'], {
      ...options, cwd: repositoryPath,
    }),
  ]);
  const desired = new Map<string, string>();
  const sourceRefs = new Set<string>();
  for (const line of upstream.stdout.trim().split('\n')) {
    const [ref, object, symbolic] = line.trim().split(' ');
    if (!ref || !object || symbolic) continue;
    sourceRefs.add(ref);
    if (hasOrigin && ref.startsWith('refs/remotes/origin/')) desired.set(ref, object);
  }
  const baseName = baseBranch.replace(/^refs\/heads\//, '');
  const baseRef = `refs/heads/${baseName}`;
  const inheritedRefs = inherited.stdout.trim().split('\n').filter(Boolean).map((line) => line.split(' '));
  const upstreamBase = desired.get(`refs/remotes/origin/${baseName}`);
  if (baseRef !== `refs/heads/${branch}` && (sourceRefs.has(baseRef) || upstreamBase)) {
    // Existing diff/park consumers still resolve the base by its local name.
    // Anchor it in true upstream history, or the selected base for a local repo.
    const selectedBase = upstreamBase ?? (await materializationAwareExecFile('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
      ...options, cwd: workspacePath,
    })).stdout.trim();
    desired.set(baseRef, selectedBase);
  }
  const commands = ['start'];
  for (const [ref] of inheritedRefs) {
    if (ref === `refs/heads/${branch}`) continue;
    const object = desired.get(ref);
    commands.push(object ? `update ${ref} ${object}` : `delete ${ref}`);
    desired.delete(ref);
  }
  for (const [ref, object] of desired) commands.push(`create ${ref} ${object}`);
  commands.push('prepare', 'commit', '');
  // Keep the existing captured-cwd guard, including for the transaction's stdin.
  // --no-deref removes a cloned origin/HEAD alias without deleting its target.
  const invocation = materializationAwareInvocation('git', ['update-ref', '--no-deref', '--stdin'], workspacePath);
  await new Promise<void>((resolve, reject) => {
    const child = execFile(invocation.command, invocation.args, { ...options, cwd: workspacePath }, (error) => {
      if (error) reject(error);
      else resolve();
    });
    child.stdin?.on('error', reject);
    child.stdin?.end(commands.join('\n'));
  });
  if (!hasOrigin) {
    // clone --local invents an origin pointing at the donor in local-only repos.
    await materializationAwareExecFile('git', ['remote', 'remove', 'origin'], { ...options, cwd: workspacePath });
  }
}
