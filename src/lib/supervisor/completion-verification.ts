import { access } from 'node:fs/promises';

import {
  assertLaneHeadOnBranch, laneGit, LaneGitMetadataError, withLaneCommitDirectory, type LaneCommitDirectory,
} from '@/lib/lane/lane-git';

import { detectTypecheckSkip, NO_REPOSITORY_TYPESCRIPT, repositoryTypeScriptCompiler } from '@/lib/lane/typecheck-availability';
import { resolvePacketDiffBase } from '@/lib/diff/base-resolution';
import { runConfinedProcess } from '@/lib/sandbox/run-confined';

import { buildRuleCheckFailureMessage, runRuleCheck } from './rule-check';

const COMMAND_MAX_BUFFER = 10 * 1024 * 1024;
const TYPECHECK_TIMEOUT_MS = 120_000;
const TYPECHECK_OUTPUT_LIMIT = 12_000;

export type CompletionVerificationKind = 'typecheck' | 'rule-check';

export interface CompletionTypecheckResult {
  ok: boolean;
  output: string;
}

export interface CompletionVerificationResult {
  ok: boolean;
  kind: CompletionVerificationKind;
  output: string;
}

/**
 * Typechecks `cwd` with the TypeScript compiler installed in `installRoot`,
 * never one from the lane's checkout, under the confinement lane commands get
 * (#3412).
 */
export async function runCompletionTypecheck(cwd: string, installRoot: string): Promise<CompletionTypecheckResult> {
  const compiler = repositoryTypeScriptCompiler(installRoot);
  const skip = await detectTypecheckSkip(cwd);
  const skipped = skip.skip
    ? skip.reason
    : await access(compiler).then(() => undefined, () => NO_REPOSITORY_TYPESCRIPT);
  if (skipped) {
    console.warn(`[completion-verification] Skipping typecheck: ${skipped} (#1255).`);
    return { ok: true, output: '' };
  }
  try {
    const { stdout, stderr } = await runConfinedProcess(cwd, process.execPath, [compiler, '--noEmit'], {
      cwd,
      timeout: TYPECHECK_TIMEOUT_MS,
      maxBuffer: COMMAND_MAX_BUFFER,
    });

    return {
      ok: true,
      output: formatCommandOutput(stdout, stderr),
    };
  } catch (error) {
    const execError = error as {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      message?: string;
      status?: number | null;
      code?: number | string;
      signal?: NodeJS.Signals | null;
    };
    const commandOutput = formatCommandOutput(
      bufferToString(execError.stdout),
      bufferToString(execError.stderr),
    );
    const exitCode = typeof execError.status === 'number' ? execError.status
      : typeof execError.code === 'number' ? execError.code : undefined;

    const failureSummary = execError.signal
      ? `Process terminated by ${execError.signal}.`
      : exitCode !== undefined
        ? `Exit code ${exitCode}.`
        : execError.message?.trim() || 'Command failed.';

    return {
      ok: false,
      output: limitOutput(
        [failureSummary, commandOutput].filter(Boolean).join('\n\n') || 'Command failed with no output.',
      ),
    };
  }
}

export async function runCompletionVerification(
  cwd: string,
  baseRef: string,
  repoPath: string,
): Promise<CompletionVerificationResult> {
  const typecheck = await runCompletionTypecheck(cwd, repoPath);
  if (!typecheck.ok) {
    return {
      ok: false,
      kind: 'typecheck',
      output: typecheck.output,
    };
  }

  const comparisonRef = await resolveCompletionComparisonRef(cwd, baseRef, repoPath);
  const ruleCheck = await runRuleCheck(cwd, comparisonRef);
  if (!ruleCheck.ok) {
    return {
      ok: false,
      kind: 'rule-check',
      output: buildRuleCheckFailureMessage(ruleCheck),
    };
  }

  return { ok: true, kind: 'typecheck', output: '' };
}

async function resolveCompletionComparisonRef(cwd: string, baseRef: string, repoPath: string): Promise<string> {
  try {
    const { stdout } = await laneGit(cwd, repoPath, ['rev-parse', 'HEAD'], { maxBuffer: COMMAND_MAX_BUFFER });
    const resolution = await resolvePacketDiffBase(cwd, baseRef, stdout.trim(), undefined, (args) => laneGit(cwd, repoPath, args));
    return resolution.mergeBase ?? resolution.comparisonRef;
  } catch (error) {
    if (error instanceof LaneGitMetadataError) throw error;
    console.warn(`[completion-verification] Could not refresh ${baseRef}; using the recorded base ref.`, error);
    return baseRef;
  }
}

export function buildVerificationFailureSteerMessage(result: CompletionVerificationResult): string {
  if (result.kind === 'rule-check') {
    return [
      'Post-completion rule check failed. Do not stop here.',
      'These are CLAUDE.md invariants enforced by the supervisor — fix every violation and report completion again.',
      '',
      result.output,
    ].join('\n');
  }
  return buildTypecheckFailureSteerMessage(result.output);
}

function normalizeAutoCommitMessage(message?: string | null): string {
  const subject = message?.trim().replace(/\s+/g, ' ');
  if (!subject) return 'auto-commit: agent work before review';
  return subject.includes('[via-o8]') ? subject : `${subject} [via-o8]`;
}

export async function autoCommitCompletionWorktree(
  cwd: string,
  repoPath: string,
  commitMessage: string | null | undefined,
  laneBranch: string | null | undefined,
): Promise<boolean> {
  const { stdout: porcelain } = await laneGit(cwd, repoPath, ['status', '--porcelain'], { maxBuffer: COMMAND_MAX_BUFFER });
  if (!porcelain.trim()) {
    return false;
  }
  // Commit only onto the lane's branch, wherever the worker pointed HEAD.
  await assertLaneHeadOnBranch(cwd, repoPath, laneBranch);
  return commitLaneWork(cwd, repoPath, laneBranch, normalizeAutoCommitMessage(commitMessage));
}

/**
 * Commits a lane checkout's work, without o8's injected artifacts, onto the
 * lane's branch from a host-owned Git directory. A lane without a recorded
 * branch commits in its checkout's own Git state.
 */
export async function commitLaneWork(
  cwd: string,
  repoPath: string,
  laneBranch: string | null | undefined,
  message: string,
): Promise<boolean> {
  const commit = async (directory?: LaneCommitDirectory): Promise<boolean> => {
    const options = { ...directory?.options, maxBuffer: COMMAND_MAX_BUFFER };
    // `git status --porcelain` does not include ignored directories by default.
    // Passing explicit negative pathspecs for ignored dirs makes Git error when
    // those dirs exist, which is exactly what automation worktrees contain — so we
    // stage everything and then UNSTAGE o8-injected artifacts with `git reset`:
    // the safety-hook `.claude/settings.json` (otherwise blows the diff-budget merge
    // gate) and the `node_modules` symlink (otherwise pollutes the target repo's main).
    await laneGit(cwd, repoPath, ['add', '-A', '--', '.'], options);
    await laneGit(cwd, repoPath, ['reset', '-q', '--', '.claude', 'node_modules'], options);
    // If only o8-injected artifacts were dirty, nothing real remains to commit.
    try {
      await laneGit(cwd, repoPath, ['diff', '--cached', '--quiet'], options);
      return false; // exit 0 => no staged changes left after unstaging injected files
    } catch (error) {
      if (error instanceof LaneGitMetadataError) throw error;
      // non-zero exit => staged changes exist, proceed to commit
    }
    await laneGit(cwd, repoPath, ['commit', '--no-verify', '-m', message], options);
    if (directory) {
      const { stdout: commit } = await laneGit(cwd, repoPath, ['rev-parse', 'HEAD'], options);
      await directory.advance(commit.trim(), `commit: ${message}`);
      directory.syncIndex();
    }
    return true;
  };
  const branch = laneBranch?.trim();
  return branch ? withLaneCommitDirectory(cwd, repoPath, branch, commit) : commit();
}

export async function hasReviewableCompletionDiff(cwd: string, baseRef: string, repoPath: string): Promise<boolean> {
  const comparisonRef = await resolveCompletionComparisonRef(cwd, baseRef, repoPath);
  try {
    await laneGit(cwd, repoPath, ['diff', '--quiet', `${comparisonRef}...HEAD`], { maxBuffer: COMMAND_MAX_BUFFER });
    return false;
  } catch (error) {
    if (error instanceof LaneGitMetadataError) throw error;
    const status = (error as { status?: number | string | null; code?: number | string | null }).status
      ?? (error as { code?: number | string | null }).code;
    if (status === 1) {
      return true;
    }
  }

  try {
    await laneGit(cwd, repoPath, ['diff', '--quiet', 'HEAD~1..HEAD'], { maxBuffer: COMMAND_MAX_BUFFER });
    return false;
  } catch (error) {
    if (error instanceof LaneGitMetadataError) throw error;
    const status = (error as { status?: number | string | null; code?: number | string | null }).status
      ?? (error as { code?: number | string | null }).code;
    return status === 1;
  }
}

export function buildTypecheckFailureSteerMessage(output: string): string {
  return [
    'Post-completion verification failed. Do not stop here.',
    'Fix the TypeScript errors below, rerun `npx tsc --noEmit`, and only report completion after it passes.',
    '',
    'Typecheck output:',
    '```',
    limitOutput(output || 'TypeScript reported a failure with no output.'),
    '```',
  ].join('\n');
}

function formatCommandOutput(stdout: string, stderr: string): string {
  const trimmedStdout = stdout.trim();
  const trimmedStderr = stderr.trim();

  if (trimmedStdout && trimmedStderr) {
    return `${trimmedStdout}\n\nSTDERR:\n${trimmedStderr}`;
  }
  if (trimmedStdout) {
    return trimmedStdout;
  }
  if (trimmedStderr) {
    return `STDERR:\n${trimmedStderr}`;
  }
  return '';
}

function bufferToString(value?: string | Buffer): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Buffer) {
    return value.toString('utf-8');
  }
  return '';
}

function limitOutput(output: string): string {
  const normalized = output.trim();
  if (!normalized) {
    return 'Command failed with no output.';
  }
  if (normalized.length <= TYPECHECK_OUTPUT_LIMIT) {
    return normalized;
  }
  return `${normalized.slice(0, TYPECHECK_OUTPUT_LIMIT)}\n\n... (truncated)`;
}
