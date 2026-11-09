import { mkdtemp, realpath, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { materializationAwareExecFile } from '@/lib/worktree/materialization-execution';
import { listReposFresh } from '@/lib/repos/registry';

const execFileAsync = materializationAwareExecFile;

export async function git(
  cwd: string,
  args: string[],
  opts: { timeout?: number; maxBuffer?: number } = {},
) {
  return execFileAsync('git', args, {
    windowsHide: true,
    cwd,
    timeout: opts.timeout ?? 60_000,
    maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024,
  });
}

export type GitCommandRunner = typeof git;

export type CurrentBranchResolution =
  | { state: 'attached'; branch: string; evidence: string }
  | { state: 'detached'; evidence: string }
  | { state: 'unknown'; evidence: string };

function commandOutput(value: unknown): string {
  return typeof value === 'string' ? value.trim()
    : value instanceof Buffer ? value.toString('utf8').trim()
    : '';
}

export function gitErrorMessage(error: unknown): string {
  const err = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
  const stderr = commandOutput(err.stderr);
  const stdout = commandOutput(err.stdout);
  const message = typeof err.message === 'string' ? err.message.trim() : String(error);
  return stderr || stdout || message || 'Git command failed.';
}

export async function worktreeExistsOnDisk(worktreePath: string): Promise<boolean> {
  try {
    const dirStat = await stat(worktreePath);
    if (!dirStat.isDirectory()) return false;
    const gitStat = await stat(`${worktreePath}/.git`);
    return gitStat.isFile() || gitStat.isDirectory();
  } catch {
    return false;
  }
}

export async function currentBranch(cwd: string): Promise<string> {
  const { stdout } = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5000 });
  return stdout.trim();
}

/**
 * Resolve branch attachment without treating an empty probe as proof that HEAD
 * is detached. `git symbolic-ref` exit 1 is the documented detached result;
 * an empty successful response or any other failure is inconclusive and must
 * remain retryable.
 */
export async function resolveCurrentBranch(
  cwd: string,
  runGit: GitCommandRunner = git,
): Promise<CurrentBranchResolution> {
  try {
    const { stdout } = await runGit(
      cwd,
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      { timeout: 5000 },
    );
    const branch = stdout.trim();
    if (!branch) {
      return {
        state: 'unknown',
        evidence: 'The branch probe exited successfully but returned no branch name.',
      };
    }
    return {
      state: 'attached',
      branch,
      evidence: `HEAD is attached to ${branch}.`,
    };
  } catch (error) {
    const code = Number((error as NodeJS.ErrnoException).code);
    const stderr = commandOutput((error as { stderr?: unknown }).stderr);
    // materializationAwareExecFile invokes a Node ownership guard before Git.
    // Guard throws also exit 1, but carry stderr. Require Git's silent exit 1
    // plus a readable HEAD commit before calling the checkout detached.
    if (code === 1 && !stderr) {
      try {
        const { stdout } = await runGit(cwd, ['rev-parse', '--verify', 'HEAD'], { timeout: 5000 });
        if (stdout.trim()) {
          return {
            state: 'detached',
            evidence: 'git symbolic-ref refused silently and the detached HEAD commit is readable.',
          };
        }
      } catch (confirmationError) {
        return {
          state: 'unknown',
          evidence: `The branch probe was inconclusive and HEAD confirmation failed: ${gitErrorMessage(confirmationError)}`,
        };
      }
    }
    return {
      state: 'unknown',
      evidence: `The branch probe was inconclusive: ${gitErrorMessage(error)}`,
    };
  }
}

export async function readHeadSha(cwd: string): Promise<string> {
  const { stdout } = await git(cwd, ['rev-parse', 'HEAD'], { timeout: 5000 });
  return stdout.trim();
}

export async function commitDirtyWorktree(
  worktreePath: string,
  commitMessage: string,
): Promise<void> {
  await git(worktreePath, ['add', '-A']);
  const { stdout: porcelain } = await git(
    worktreePath,
    ['status', '--porcelain'],
    { timeout: 5000 },
  );
  if (porcelain.trim()) {
    await git(worktreePath, ['commit', '-m', commitMessage]);
  }
}

export interface DetachedIntegrationWorktree {
  path: string;
  cleanup: () => Promise<void>;
}

// Repo-local config can be written by the repository's workers, so only keys
// that can neither run a command nor redirect or intercept the fetch reach the
// clone. Credential helpers, SSH commands, URL rewrites and HTTP settings stay
// in the operator's global config, which the clone still reads.
function isTransportConfigKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized === 'ssh.variant' || normalized === 'remote.origin.url';
}

function resolveRemoteUrl(sourceWorktreePath: string, value: string): string {
  if (
    !value
    || isAbsolute(value)
    || value.startsWith('~')
    || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
    || /^[a-z][a-z0-9+.-]*::/i.test(value)
    || /^[^/\\:]+:.+/.test(value)
  ) return value;
  return resolve(sourceWorktreePath, value);
}

/**
 * The origin the operator registered for `repoPath`, from the stored registry
 * record: the registered URL, the repository itself when it was registered
 * without one, or null when the repository is not registered.
 */
async function registeredOrigin(repoPath: string): Promise<string | null> {
  const canonical = await realpath(repoPath).catch(() => resolve(repoPath));
  const entry = (await listReposFresh()).find((repo) => (
    resolve(repo.localPath) === resolve(repoPath) || resolve(repo.localPath) === canonical
  ));
  if (!entry) return null;
  const url = entry.remoteUrl?.trim();
  return url ? resolveRemoteUrl(repoPath, url) : repoPath;
}

async function copyTransportConfig(
  sourceWorktreePath: string,
  integrationPath: string,
): Promise<void> {
  const { stdout } = await git(sourceWorktreePath, [
    'config',
    '--local',
    '--includes',
    '--null',
    '--list',
  ], { timeout: 5000 });
  const values = new Map<string, string[]>();
  for (const record of stdout.split('\0')) {
    if (!record) continue;
    const separator = record.indexOf('\n');
    const key = separator < 0 ? record : record.slice(0, separator);
    if (!isTransportConfigKey(key)) continue;
    const rawValue = separator < 0 ? '' : record.slice(separator + 1);
    const value = key.toLowerCase() === 'remote.origin.url'
      ? resolveRemoteUrl(sourceWorktreePath, rawValue)
      : rawValue;
    const entries = values.get(key) ?? [];
    entries.push(value);
    values.set(key, entries);
  }

  for (const [key, entries] of values) {
    try {
      await git(integrationPath, ['config', '--local', '--unset-all', key], { timeout: 5000 });
    } catch {
      // Missing destination keys are expected before the first copy.
    }
    for (const value of entries) {
      await git(integrationPath, ['config', '--local', '--add', key, value], { timeout: 5000 });
    }
  }
}

async function removeIntegrationParentBestEffort(parent: string): Promise<void> {
  try {
    await rm(parent, { recursive: true, force: true });
  } catch (error) {
    console.warn(
      `[lane-merge] Could not remove disposable integration clone ${parent}: ${gitErrorMessage(error)}`,
    );
  }
}

/**
 * Materialize an exact reviewed commit in a disposable shared clone.
 * Rebase and verification can mutate this checkout without exposing a mutable
 * packet checkout to the merge path or registering worktree metadata that can
 * outlive a timeout.
 */
export async function createDetachedIntegrationWorktree(input: {
  repoPath: string;
  sourceWorktreePath: string;
  sourceSha: string;
}): Promise<DetachedIntegrationWorktree> {
  const parent = await mkdtemp(join(tmpdir(), 'o8-reviewed-integration-'));
  const integrationPath = join(parent, 'worktree');
  try {
    await git(input.repoPath, [
      'clone',
      '--shared',
      '--no-checkout',
      input.repoPath,
      integrationPath,
    ], { timeout: 30_000 });
    await git(integrationPath, [
      'fetch',
      '--no-tags',
      input.sourceWorktreePath,
      input.sourceSha,
    ], { timeout: 30_000 });
    await copyTransportConfig(input.sourceWorktreePath, integrationPath);
    // A registered repository fetches from the origin the operator registered,
    // never one its config names now.
    const origin = await registeredOrigin(input.repoPath);
    if (origin) await git(integrationPath, ['config', '--local', 'remote.origin.url', origin], { timeout: 5000 });
    for (const key of ['user.name', 'user.email']) {
      try {
        const { stdout } = await git(input.sourceWorktreePath, ['config', '--get', key]);
        if (stdout.trim()) await git(integrationPath, ['config', key, stdout.trim()]);
      } catch {
        // Global identity may still satisfy rebase; failures surface normally.
      }
    }
    await git(integrationPath, ['checkout', '--detach', input.sourceSha]);
  } catch (error) {
    await removeIntegrationParentBestEffort(parent);
    throw error;
  }

  for (const name of ['node_modules', '.env', '.env.local']) {
    const source = join(input.sourceWorktreePath, name);
    const target = join(integrationPath, name);
    try {
      await stat(source);
      await symlink(source, target);
    } catch {
      // Optional ignored runtime inputs are best-effort. Verification reports
      // a real missing dependency or environment failure through its own gate.
    }
  }

  return {
    path: integrationPath,
    cleanup: () => removeIntegrationParentBestEffort(parent),
  };
}

export async function amendViaO8Suffix(
  worktreePath: string,
  fallbackSubject?: string,
): Promise<void> {
  try {
    const { stdout: tipSubject } = await git(
      worktreePath,
      ['log', '-1', '--pretty=%s'],
      { timeout: 5000 },
    );
    const subject = tipSubject.trim();
    if (subject && !subject.includes('[via-o8]')) {
      const nextSubject = subject === 'auto-commit: agent work before review'
        && fallbackSubject?.trim()
        ? fallbackSubject.trim()
        : subject;
      await git(worktreePath, [
        'commit',
        '--amend',
        '-m',
        `${nextSubject} [via-o8]`,
        '--allow-empty',
      ]);
    }
  } catch {
    // Best-effort tag for changelog rendering. Never block a valid merge.
  }
}

export function mergeRefForLane(laneId: string): string {
  return `refs/o8/merge/${laneId.replace(/[^A-Za-z0-9._-]/g, '-')}`;
}

export async function deleteRefBestEffort(repoPath: string, ref: string): Promise<void> {
  try {
    await git(repoPath, ['update-ref', '-d', ref], { timeout: 5000 });
  } catch {
    // Temporary integration refs are best-effort cleanup only.
  }
}

export async function pushWorkerBranchBestEffort(
  worktreePath: string,
  actualBranch: string,
  sourceSha: string,
): Promise<void> {
  try {
    await git(worktreePath, [
      'push',
      'origin',
      `${sourceSha}:refs/heads/${actualBranch}`,
    ], { timeout: 60_000 });
    console.log(`[lane-merge] Pushed worker branch ${actualBranch} to origin before fast-forward.`);
  } catch (error) {
    console.warn(
      `[lane-merge] Worker branch push skipped for ${actualBranch}: ${gitErrorMessage(error)}`,
    );
  }
}

export async function pushWorkerBranchLeaseBestEffort(
  worktreePath: string,
  actualBranch: string,
  sourceSha: string,
  expectedRemoteSha: string,
): Promise<void> {
  const destination = `refs/heads/${actualBranch}`;
  try {
    await git(worktreePath, [
      'push',
      `--force-with-lease=${destination}:${expectedRemoteSha}`,
      'origin',
      `${sourceSha}:${destination}`,
    ], { timeout: 60_000 });
    console.log(`[lane-merge] Updated worker branch ${actualBranch} to the exact retry candidate.`);
  } catch (error) {
    console.warn(
      `[lane-merge] Retry candidate push skipped for ${actualBranch}: ${gitErrorMessage(error)}`,
    );
  }
}

export async function pushExactBase(
  repoPath: string,
  baseBranch: string,
  sourceSha: string,
  expectedRemoteSha?: string,
): Promise<void> {
  const destination = `refs/heads/${baseBranch}`;
  await git(repoPath, [
    'push',
    ...(expectedRemoteSha
      ? [`--force-with-lease=${destination}:${expectedRemoteSha}`]
      : []),
    'origin',
    `${sourceSha}:${destination}`,
  ], { timeout: 60_000 });
}

export async function hasPushRemote(repoPath: string, remote = 'origin'): Promise<boolean> {
  const { stdout: remotesOutput } = await git(repoPath, ['remote'], { timeout: 5000 });
  const remotes = remotesOutput.split('\n').map((value) => value.trim()).filter(Boolean);
  if (!remotes.includes(remote)) return false;
  const { stdout } = await git(
    repoPath,
    ['remote', 'get-url', '--push', remote],
    { timeout: 5000 },
  );
  return stdout.trim().length > 0;
}

export async function exactPushLeaseForCandidate(
  repoPath: string,
  originBaseRef: string | null,
  candidateRef: string,
): Promise<{ safe: boolean; expectedRemoteSha?: string }> {
  if (!originBaseRef) return { safe: true };
  const { stdout } = await git(repoPath, ['rev-parse', originBaseRef], { timeout: 5000 });
  const expectedRemoteSha = stdout.trim();
  return {
    safe: await isAncestor(repoPath, expectedRemoteSha, candidateRef),
    expectedRemoteSha,
  };
}

export async function fetchWorkerHeadIntoMainRepo(
  repoPath: string,
  worktreePath: string,
  sourceSha: string,
  integrationRef: string,
): Promise<void> {
  await git(repoPath, [
    'fetch',
    worktreePath,
    `+${sourceSha}:${integrationRef}`,
  ], { timeout: 60_000 });
}

export async function refExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await git(cwd, ['rev-parse', '--verify', ref], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export async function refPointsTo(
  cwd: string,
  ref: string,
  expectedSha: string,
): Promise<boolean> {
  try {
    const { stdout } = await git(cwd, ['rev-parse', ref], { timeout: 5000 });
    return stdout.trim() === expectedSha;
  } catch {
    return false;
  }
}

export async function isAncestor(
  cwd: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export async function refreshOriginBaseBestEffort(
  repoPath: string,
  baseBranch: string,
): Promise<string | null> {
  try {
    await git(repoPath, ['fetch', 'origin', baseBranch, '--quiet'], { timeout: 60_000 });
  } catch (error) {
    console.warn(`[lane-merge] Could not refresh origin/${baseBranch} before fast-forward: ${gitErrorMessage(error)}`);
  }

  const originRef = `origin/${baseBranch}`;
  return await refExists(repoPath, originRef) ? originRef : null;
}
