import { laneGit, laneGitSync, LaneGitMetadataError } from '@/lib/lane/lane-git';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePacketAttributionBase, type PacketDiffBaseResolution } from '@/lib/diff/base-resolution';
import { resolveLaneAttributionBase } from '@/lib/lane/attribution-base';
import { readLaneCreationBaseCommit } from '@/lib/lane/creation-base';
import { isSafeGitRef } from '@/lib/git/refs';
import { readHeadSha } from '@/lib/lane/head-sha-lock';
import { resolveLaneReviewTarget } from '@/lib/lane/review-target';
import type { Lane } from '@/lib/lane/types';

const COMMAND_MAX_BUFFER = 32 * 1024 * 1024;

export interface LaneDiffFacts {
  changedFiles: string[];
  fileChanges: LaneFileChange[];
  addedLines: string[];
  addedDiffLines: AddedDiffLine[];
}

export interface AddedDiffLine {
  file: string;
  line: number | null;
  text: string;
}

export interface LaneSpokenDiffFacts extends LaneDiffFacts {
  headSha: string;
  against: string;
  diffBase: PacketDiffBaseResolution;
  stat: string;
  fingerprint: string;
  snapshotTreeHash: string;
  dirtyFiles: string[];
  untrackedFiles: string[];
}

export type LaneFileChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';

export interface LaneFileChange {
  path: string;
  status: LaneFileChangeStatus;
  previousPath?: string;
}

export function extractAddedLines(diff: string): string[] {
  return extractAddedDiffLines(diff).map((line) => line.text);
}

function parseDiffPath(value: string): string | null {
  const candidate = value.trim();
  if (!candidate || candidate === '/dev/null') return null;
  return candidate.startsWith('b/') ? candidate.slice(2) : candidate;
}

/** Preserve the source file and new-file line number for every added line. */
export function extractAddedDiffLines(diff: string): AddedDiffLine[] {
  const added: AddedDiffLine[] = [];
  let currentFile: string | null = null;
  let nextNewLine: number | null = null;

  for (const rawLine of diff.split('\n')) {
    if (rawLine.startsWith('+++ ')) {
      currentFile = parseDiffPath(rawLine.slice(4));
      nextNewLine = null;
      continue;
    }
    if (rawLine.startsWith('@@ ')) {
      const match = /\+(\d+)(?:,\d+)?/.exec(rawLine);
      nextNewLine = match ? Number(match[1]) : null;
      continue;
    }
    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      if (currentFile) {
        added.push({ file: currentFile, line: nextNewLine, text: rawLine });
      }
      if (nextNewLine !== null) nextNewLine += 1;
      continue;
    }
    if (rawLine.startsWith('\\ No newline at end of file')) continue;
    if (!rawLine.startsWith('-') && nextNewLine !== null) nextNewLine += 1;
  }
  return added;
}

/** Parse `git diff --stat` output into per-file insertion/deletion counts. */
export function parseDiffStat(stat: string): Array<{ file: string; insertions: number; deletions: number }> {
  const results: Array<{ file: string; insertions: number; deletions: number }> = [];
  for (const line of stat.split('\n')) {
    // Format: " src/foo.ts | 42 +++++-----"  or  " src/foo.ts | 10 ++++"
    const match = line.match(/^\s*(.+?)\s*\|\s*(\d+)\s/);
    if (!match) continue;
    const file = match[1].trim();
    const plusMatch = line.match(/(\d+)\s*insertion/);
    const minusMatch = line.match(/(\d+)\s*deletion/);
    // Fallback: count + and - symbols in the bar chart
    const barMatch = line.match(/\|\s*\d+\s+([\s+\-]+)$/);
    let insertions = plusMatch ? parseInt(plusMatch[1], 10) : 0;
    let deletions = minusMatch ? parseInt(minusMatch[1], 10) : 0;
    if (!plusMatch && !minusMatch && barMatch) {
      const bar = barMatch[1];
      insertions = (bar.match(/\+/g) || []).length;
      deletions = (bar.match(/-/g) || []).length;
    }
    if (file && (insertions > 0 || deletions > 0)) {
      results.push({ file, insertions, deletions });
    }
  }
  return results;
}

export function parseNameStatus(output: string): LaneFileChange[] {
  const tokens = output.split('\0');
  const changes: LaneFileChange[] = [];

  for (let index = 0; index < tokens.length;) {
    const rawStatus = tokens[index++]?.trim();
    if (!rawStatus) continue;
    const statusCode = rawStatus[0];
    if (statusCode === 'R' || statusCode === 'C') {
      const previousPath = tokens[index++] ?? '';
      const path = tokens[index++] ?? '';
      if (path) {
        changes.push({ path, previousPath: previousPath || undefined, status: 'renamed' });
      }
      continue;
    }

    const path = tokens[index++] ?? '';
    if (!path) continue;
    const status: LaneFileChangeStatus = statusCode === 'A'
      ? 'added'
      : statusCode === 'D'
        ? 'deleted'
        : 'modified';
    changes.push({ path, status });
  }

  return changes;
}

export interface LaneDiffStat {
  files: number;
  insertions: number;
  deletions: number;
}

/**
 * Files and lines a lane's worktree changed since its base, committed and
 * uncommitted tracked edits together. Reads only: a lane without a creation
 * receipt compares with its local base branch instead of fetching.
 */
export async function getLaneDiffStat(
  lane: Pick<Lane, 'id' | 'baseBranch' | 'worktreePath' | 'repoPath'>,
): Promise<LaneDiffStat> {
  const cwd = lane.worktreePath;
  if (!cwd) throw new Error('Lane has no worktree for a diff stat.');
  const runGit = (args: string[]) => laneGit(cwd, lane.repoPath, args, {
    timeout: 10_000,
    maxBuffer: COMMAND_MAX_BUFFER,
  });
  const headSha = await readHeadSha(cwd, lane.repoPath);
  const creationBase = readLaneCreationBaseCommit(lane.id);
  const base = lane.baseBranch || 'main';
  if (!creationBase && !isSafeGitRef(base)) throw new Error(`Unsafe base branch for diff: ${base}`);
  const against = creationBase
    ? (await resolvePacketAttributionBase(cwd, base, headSha, creationBase, runGit)).comparisonRef
    : (await runGit(['merge-base', base, headSha])).stdout.trim();
  const { stdout } = await runGit(['diff', '--numstat', against]);
  const stat: LaneDiffStat = { files: 0, insertions: 0, deletions: 0 };
  for (const line of stdout.split('\n')) {
    const [added, removed] = line.split('\t');
    if (removed === undefined) continue;
    stat.files += 1;
    // Binary files report "-" for both counts.
    stat.insertions += Number(added) || 0;
    stat.deletions += Number(removed) || 0;
  }
  return stat;
}

function readGitOutput(cwd: string, repoPath: string, args: string[]): string {
  return laneGitSync(cwd, repoPath, args, {
    timeout: 10_000,
    maxBuffer: 10 * 1024 * 1024,
  }).trim();
}

async function readGitOutputAsync(cwd: string, repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await laneGit(cwd, repoPath, args, {
    timeout: 10_000,
    maxBuffer: COMMAND_MAX_BUFFER,
  });
  return stdout;
}

function parseUntrackedFiles(output: string): LaneFileChange[] {
  return output
    .split('\0')
    .filter(Boolean)
    .map((path) => ({ path, status: 'untracked' as const }));
}

async function hashUntrackedFiles(cwd: string, repoPath: string, paths: string[]): Promise<string[]> {
  if (paths.length > 500) {
    throw new Error(`Spoken review refused ${paths.length} untracked files; clean or commit the worktree first.`);
  }
  const hashes: string[] = [];
  for (const path of paths) {
    const hash = await readGitOutputAsync(cwd, repoPath, ['hash-object', '--no-filters', '--', path]);
    hashes.push(`${path}\0${hash.trim()}`);
  }
  return hashes;
}

async function readWorktreeTreeHash(cwd: string, repoPath: string): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), 'o8-spoken-review-index-'));
  const indexPath = join(tempDir, 'index');
  try {
    await laneGit(cwd, repoPath, ['read-tree', 'HEAD'], {
      indexFile: indexPath,
      timeout: 10_000,
      maxBuffer: COMMAND_MAX_BUFFER,
    });
    await laneGit(cwd, repoPath, ['add', '-A', '--', '.'], {
      indexFile: indexPath,
      timeout: 10_000,
      maxBuffer: COMMAND_MAX_BUFFER,
    });
    const { stdout } = await laneGit(cwd, repoPath, ['write-tree'], {
      indexFile: indexPath,
      timeout: 10_000,
      maxBuffer: COMMAND_MAX_BUFFER,
    });
    return stdout.trim();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export function spokenReviewSnapshotFingerprint(
  headSha: string,
  against: string,
  snapshotTreeHash: string,
) {
  return createHash('sha256')
    .update(headSha)
    .update('\0')
    .update(against)
    .update('\0')
    .update(snapshotTreeHash)
    .digest('hex');
}

/**
 * Read the exact evidence used by Symon's spoken packet review.
 *
 * Unlike the legacy synchronous risk helper below, this projection includes
 * committed changes, tracked dirty changes, and untracked paths. It also locks
 * every result to one HEAD and fails closed instead of falling back to an
 * unrelated previous commit.
 */
export async function getLaneSpokenDiffFacts(
  lane: Lane,
  options?: { pinnedCreationBaseCommit: string },
): Promise<LaneSpokenDiffFacts> {
  const pinnedBase = options?.pinnedCreationBaseCommit;
  if (options !== undefined && (typeof pinnedBase !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(pinnedBase))) {
    throw new Error('Pinned snapshot base must be a full Git object ID.');
  }
  const cwd = resolveLaneReviewTarget(lane).cwd;
  const repoPath = lane.repoPath;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const headSha = await readHeadSha(cwd, repoPath);
    // A caller holding a creation receipt can prohibit the legacy remote-base
    // fallback even if that receipt disappears while this observation runs.
    const runGit = (args: string[]) => laneGit(cwd, repoPath, args);
    const diffBase = pinnedBase
      ? await resolvePacketAttributionBase(cwd, lane.baseBranch, headSha, pinnedBase, runGit)
      : await resolveLaneAttributionBase(lane, cwd, headSha, runGit);
    const against = diffBase.mergeBase ?? diffBase.comparisonRef;
    const [stat, diff, nameStatus, dirtyNameOnly, untracked, snapshotTreeHash] = await Promise.all([
      readGitOutputAsync(cwd, repoPath, ['diff', '--stat', against]),
      readGitOutputAsync(cwd, repoPath, ['diff', against, '--no-color', '-U2']),
      readGitOutputAsync(cwd, repoPath, ['diff', '--name-status', '-z', '--find-renames', against]),
      readGitOutputAsync(cwd, repoPath, ['diff', '--name-only', '-z', 'HEAD']),
      readGitOutputAsync(cwd, repoPath, ['ls-files', '--others', '--exclude-standard', '-z']),
      readWorktreeTreeHash(cwd, repoPath),
    ]);
    const untrackedFiles = untracked.split('\0').filter(Boolean);
    const untrackedHashes = await hashUntrackedFiles(cwd, repoPath, untrackedFiles);
    const currentHeadSha = await readHeadSha(cwd, repoPath);
    if (currentHeadSha !== headSha) continue;

    const [currentDiff, currentNameStatus, currentDirtyNameOnly, currentUntracked, currentSnapshotTreeHash] = await Promise.all([
      readGitOutputAsync(cwd, repoPath, ['diff', against, '--no-color', '-U2']),
      readGitOutputAsync(cwd, repoPath, ['diff', '--name-status', '-z', '--find-renames', against]),
      readGitOutputAsync(cwd, repoPath, ['diff', '--name-only', '-z', 'HEAD']),
      readGitOutputAsync(cwd, repoPath, ['ls-files', '--others', '--exclude-standard', '-z']),
      readWorktreeTreeHash(cwd, repoPath),
    ]);
    const currentUntrackedFiles = currentUntracked.split('\0').filter(Boolean);
    const currentUntrackedHashes = await hashUntrackedFiles(cwd, repoPath, currentUntrackedFiles);
    if (
      currentDiff !== diff
      || currentNameStatus !== nameStatus
      || currentDirtyNameOnly !== dirtyNameOnly
      || currentUntracked !== untracked
      || currentUntrackedHashes.join('\0') !== untrackedHashes.join('\0')
      || currentSnapshotTreeHash !== snapshotTreeHash
    ) continue;

    const trackedChanges = parseNameStatus(nameStatus);
    const trackedPaths = new Set(trackedChanges.map((entry) => entry.path));
    const untrackedChanges = parseUntrackedFiles(untracked)
      .filter((entry) => !trackedPaths.has(entry.path));
    const fileChanges = [...trackedChanges, ...untrackedChanges];

    return {
      headSha,
      against,
      diffBase,
      stat: stat.trim(),
      fingerprint: spokenReviewSnapshotFingerprint(headSha, against, snapshotTreeHash),
      snapshotTreeHash,
      dirtyFiles: dirtyNameOnly.split('\0').filter(Boolean),
      untrackedFiles,
      changedFiles: fileChanges.map((entry) => entry.path),
      fileChanges,
      addedLines: extractAddedLines(diff),
      addedDiffLines: extractAddedDiffLines(diff),
    };
  }

  throw new Error('Worktree HEAD moved while computing spoken review evidence. Retry the review.');
}

function readGitOutputWithFallback(cwd: string, repoPath: string, primaryArgs: string[], fallbackArgs: string[]): string {
  try {
    return readGitOutput(cwd, repoPath, primaryArgs);
  } catch (error) {
    if (error instanceof LaneGitMetadataError) throw error;
    try {
      return readGitOutput(cwd, repoPath, fallbackArgs);
    } catch (error) {
      if (error instanceof LaneGitMetadataError) throw error;
      return '';
    }
  }
}

export function getLaneDiffFacts(
  lane: Pick<Lane, 'baseBranch' | 'worktreePath' | 'repoPath'>,
  comparisonRef?: string,
): LaneDiffFacts {
  const cwd = lane.worktreePath || lane.repoPath;
  const repoPath = lane.repoPath;
  if (!cwd) {
    throw new Error('Lane has no repository path for diff facts.');
  }

  let baseRef = comparisonRef || lane.baseBranch;
  if (!comparisonRef && !baseRef.startsWith('refs/')) {
    const localRef = `refs/heads/${baseRef}`;
    try {
      readGitOutput(cwd, repoPath, ['show-ref', '--verify', '--quiet', localRef]);
      baseRef = localRef;
    } catch (error) {
      if (error instanceof LaneGitMetadataError) throw error;
      baseRef = `refs/remotes/origin/${baseRef}`;
    }
  }
  const baseRange = `${baseRef}...HEAD`;
  const stat = readGitOutputWithFallback(
    cwd,
    repoPath,
    ['diff', '--stat', baseRange],
    ['diff', '--stat', 'HEAD~1'],
  );
  const diff = readGitOutputWithFallback(
    cwd,
    repoPath,
    ['diff', baseRange, '--no-color', '-U2'],
    ['diff', 'HEAD~1', '--no-color', '-U2'],
  );
  const nameStatus = readGitOutputWithFallback(
    cwd,
    repoPath,
    ['diff', '--name-status', '-z', baseRange],
    ['diff', '--name-status', '-z', 'HEAD~1'],
  );
  const fileChanges = parseNameStatus(nameStatus);

  return {
    changedFiles: fileChanges.length > 0
      ? fileChanges.map((entry) => entry.path)
      : stat ? parseDiffStat(stat).map((entry) => entry.file) : [],
    fileChanges,
    addedLines: extractAddedLines(diff),
    addedDiffLines: extractAddedDiffLines(diff),
  };
}
