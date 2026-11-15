import { resolveGitBinary } from '@/lib/git/binary';
import 'server-only';

import { execFile } from '@/lib/providers/child-process';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { PacketDiffBaseResolution } from '@/lib/diff/base-resolution';
import { isSafeGitRef } from '@/lib/git/refs';
import { resolveLaneAttributionBase } from '@/lib/lane/attribution-base';
import { readHeadSha } from '@/lib/lane/head-sha-lock';
import { laneGit } from '@/lib/lane/lane-git';
import {
  extractAddedDiffLines,
  extractAddedLines,
  getLaneSpokenDiffFacts,
  parseNameStatus,
  spokenReviewSnapshotFingerprint,
  type LaneSpokenDiffFacts,
} from '@/lib/lane/lane-diff-facts';
import { resolveLaneReviewTarget } from '@/lib/lane/review-target';
import type { Lane } from '@/lib/lane/types';
import { listRepos } from '@/lib/repos/registry';
import {
  getWorkspaceSnapshot,
  WorkspaceSnapshotCorruptError,
  type WorkspaceSnapshotRecord,
} from '@/lib/worktree/snapshot-state';

const execFileAsync = promisify(execFile);
const COMMAND_MAX_BUFFER = 32 * 1024 * 1024;
const GIT_TIMEOUT_MS = 10_000;
const OBJECT_ID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export const IMMUTABLE_REVIEW_UNAVAILABLE_CODE = 'immutable_review_unavailable' as const;

export class ImmutableReviewUnavailableError extends Error {
  readonly code = IMMUTABLE_REVIEW_UNAVAILABLE_CODE;

  constructor(
    readonly packetId: string,
    readonly reason: string,
  ) {
    super(`Immutable review is unavailable for packet ${packetId}: ${reason}`);
    this.name = 'ImmutableReviewUnavailableError';
  }
}

export interface MaterializedReviewSource {
  kind: 'materialized';
  cwd: string;
  branch: string;
  repositoryUuid: string | null;
  mergeAvailable: true;
}

export interface ImmutableSnapshotReviewSource {
  kind: 'immutable_snapshot';
  cwd: string;
  branch: string;
  repositoryUuid: string;
  baseCommit: string;
  headCommit: string;
  treeSha: string;
  recoveryRef: string;
  diffFingerprint: string;
  mergeAvailable: false;
}

export type LaneReviewSource = MaterializedReviewSource | ImmutableSnapshotReviewSource;

export interface LaneReviewDiff {
  source: LaneReviewSource;
  headSha: string;
  base: string;
  diffBase: PacketDiffBaseResolution;
  stat: string;
  full: string;
}

/** Binds optional review evidence to the exact diff, including tracked working changes. */
export function laneReviewRevision(laneId: string, review: LaneReviewDiff): string {
  return createHash('sha256').update(laneId).update('\0').update(review.headSha).update('\0')
    .update(review.diffBase.mergeBase ?? review.diffBase.comparisonRef).update('\0')
    .update(review.full).digest('hex');
}

function unavailable(snapshot: WorkspaceSnapshotRecord, reason: string): never {
  throw new ImmutableReviewUnavailableError(snapshot.packetId, reason);
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(resolveGitBinary(), args, {
    windowsHide: true,
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: COMMAND_MAX_BUFFER,
  });
  return stdout;
}

async function gitValue(cwd: string, args: string[]): Promise<string> {
  return (await gitOutput(cwd, args)).trim();
}

async function verifyObject(
  cwd: string,
  snapshot: WorkspaceSnapshotRecord,
  object: string,
  kind: 'commit' | 'tree',
  label: string,
): Promise<string> {
  if (!OBJECT_ID_PATTERN.test(object)) {
    unavailable(snapshot, `${label} is not an immutable Git object ID.`);
  }
  try {
    const resolved = await gitValue(cwd, ['rev-parse', '--verify', `${object}^{${kind}}`]);
    await gitOutput(cwd, ['cat-file', '-e', `${object}^{${kind}}`]);
    return resolved;
  } catch {
    unavailable(snapshot, `${label} object ${object} is missing or corrupt.`);
  }
}

async function verifyImmutableSnapshot(
  repositoryPath: string,
  snapshot: WorkspaceSnapshotRecord,
): Promise<ImmutableSnapshotReviewSource> {
  if (!isSafeGitRef(snapshot.recoveryRef) || !snapshot.recoveryRef.startsWith('refs/')) {
    unavailable(snapshot, 'the protected recovery ref is invalid.');
  }

  let cwd: string;
  try {
    cwd = await realpath(repositoryPath);
    const root = await realpath(await gitValue(cwd, ['rev-parse', '--show-toplevel']));
    if (root !== cwd) {
      unavailable(snapshot, 'the registered repository path is not its canonical Git root.');
    }
  } catch (error) {
    if (error instanceof ImmutableReviewUnavailableError) throw error;
    unavailable(snapshot, 'the registered repository object store is unavailable.');
  }

  const [baseCommit, headCommit, treeSha, recoveryHead] = await Promise.all([
    verifyObject(cwd, snapshot, snapshot.baseCommit, 'commit', 'base commit'),
    verifyObject(cwd, snapshot, snapshot.headCommit, 'commit', 'reviewed head'),
    verifyObject(cwd, snapshot, snapshot.treeSha, 'tree', 'reviewed tree'),
    gitValue(cwd, ['rev-parse', '--verify', `${snapshot.recoveryRef}^{commit}`]).catch(() => ''),
  ]);
  if (baseCommit !== snapshot.baseCommit) {
    unavailable(snapshot, 'the saved base does not resolve to its recorded commit.');
  }
  if (headCommit !== snapshot.headCommit) {
    unavailable(snapshot, 'the saved head does not resolve to its recorded commit.');
  }
  if (treeSha !== snapshot.treeSha) {
    unavailable(snapshot, 'the saved tree does not resolve to its recorded tree.');
  }
  if (recoveryHead !== snapshot.headCommit) {
    unavailable(snapshot, 'the protected recovery ref does not resolve to the reviewed head.');
  }

  const headTree = await gitValue(cwd, ['rev-parse', '--verify', `${snapshot.headCommit}^{tree}`])
    .catch(() => '');
  if (headTree !== snapshot.treeSha) {
    unavailable(snapshot, 'the reviewed head no longer resolves to the saved tree.');
  }
  const fingerprint = spokenReviewSnapshotFingerprint(
    snapshot.headCommit,
    snapshot.baseCommit,
    snapshot.treeSha,
  );
  if (fingerprint !== snapshot.diffFingerprint) {
    unavailable(snapshot, 'the saved diff fingerprint does not match the immutable review objects.');
  }

  return {
    kind: 'immutable_snapshot',
    cwd,
    branch: snapshot.branch,
    repositoryUuid: snapshot.repositoryUuid,
    baseCommit: snapshot.baseCommit,
    headCommit: snapshot.headCommit,
    treeSha: snapshot.treeSha,
    recoveryRef: snapshot.recoveryRef,
    diffFingerprint: snapshot.diffFingerprint,
    mergeAvailable: false,
  };
}

export async function resolveLaneReviewSource(lane: Lane): Promise<LaneReviewSource> {
  const repos = await listRepos();
  const laneRepoPath = path.resolve(lane.repoPath);
  const registeredRepo = repos.find((repo) => path.resolve(repo.localPath) === laneRepoPath) ?? null;

  if (lane.packetId) {
    const candidates = registeredRepo
      ? [registeredRepo]
      : repos;
    const matches: Array<{ repo: (typeof repos)[number]; snapshot: WorkspaceSnapshotRecord }> = [];
    for (const repo of candidates) {
      try {
        const snapshot = getWorkspaceSnapshot(repo.id, lane.packetId);
        if (
          snapshot
          && (snapshot.laneId === lane.id || (repo.id === registeredRepo?.id && snapshot.laneId === null))
        ) {
          matches.push({ repo, snapshot });
        }
      } catch (error) {
        if (error instanceof WorkspaceSnapshotCorruptError) {
          throw new ImmutableReviewUnavailableError(lane.packetId, 'the workspace snapshot receipt is corrupt.');
        }
        throw error;
      }
    }
    if (matches.length > 1) {
      throw new ImmutableReviewUnavailableError(
        lane.packetId,
        'more than one registered repository owns a snapshot for this packet.',
      );
    }
    const match = matches[0];
    if (match?.snapshot.state === 'parked') {
      return verifyImmutableSnapshot(match.repo.localPath, match.snapshot);
    }
    if (match?.snapshot.state === 'hibernating' || match?.snapshot.state === 'restoring') {
      throw new ImmutableReviewUnavailableError(
        lane.packetId,
        `the workspace is ${match.snapshot.state}; review is unavailable until reconciliation completes.`,
      );
    }
  }

  const target = resolveLaneReviewTarget(lane);
  return {
    kind: 'materialized',
    cwd: target.cwd,
    branch: target.branch,
    repositoryUuid: registeredRepo?.id ?? null,
    mergeAvailable: true,
  };
}

export function immutableSnapshotDiffBase(
  source: ImmutableSnapshotReviewSource,
  baseBranch: string,
): PacketDiffBaseResolution {
  return {
    baseBranch: baseBranch.trim() || 'main',
    requestedRef: source.baseCommit,
    comparisonRef: source.baseCommit,
    mergeBase: source.baseCommit,
    fetchedRemoteBase: false,
    usedFallback: false,
    warning: null,
  };
}

export async function readLaneReviewDiff(lane: Lane): Promise<LaneReviewDiff> {
  const source = await resolveLaneReviewSource(lane);
  if (source.kind === 'immutable_snapshot') {
    const diffBase = immutableSnapshotDiffBase(source, lane.baseBranch);
    try {
      const [stat, full, headTree, recoveryHead] = await Promise.all([
        gitOutput(source.cwd, ['diff', '--stat', source.baseCommit, source.headCommit, '--']),
        gitOutput(source.cwd, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', source.baseCommit, source.headCommit, '--']),
        gitValue(source.cwd, ['rev-parse', '--verify', `${source.headCommit}^{tree}`]),
        gitValue(source.cwd, ['rev-parse', '--verify', `${source.recoveryRef}^{commit}`]),
      ]);
      if (headTree !== source.treeSha || recoveryHead !== source.headCommit) {
        throw new Error('immutable objects changed during review');
      }
      return {
        source,
        headSha: source.headCommit,
        base: source.baseCommit,
        diffBase,
        stat,
        full,
      };
    } catch (error) {
      if (error instanceof ImmutableReviewUnavailableError) throw error;
      throw new ImmutableReviewUnavailableError(
        lane.packetId ?? lane.id,
        'the saved Git objects could not produce the reviewed diff.',
      );
    }
  }

  const base = (lane.baseBranch || 'main').trim();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const headSha = await readHeadSha(source.cwd, lane.repoPath);
    const diffBase = await resolveLaneAttributionBase(lane, source.cwd, headSha);
    const against = diffBase.mergeBase ?? diffBase.comparisonRef;
    const [stat, full] = await Promise.all([
      laneGit(source.cwd, lane.repoPath, ['diff', '--stat', against]).then(({ stdout }) => stdout).catch(() => ''),
      laneGit(source.cwd, lane.repoPath, ['diff', against]).then(({ stdout }) => stdout).catch(() => ''),
    ]);
    if (await readHeadSha(source.cwd, lane.repoPath) !== headSha) continue;
    return { source, headSha, base, diffBase, stat, full };
  }
  throw new Error('Worktree HEAD moved while computing diff. Retry o8_packet_diff before reviewing.');
}

/** Read spoken-review facts from immutable snapshot objects when the workspace is parked. */
export async function readLaneSpokenDiffFacts(lane: Lane): Promise<LaneSpokenDiffFacts> {
  const source = await resolveLaneReviewSource(lane);
  if (source.kind === 'materialized') return getLaneSpokenDiffFacts(lane);
  const diffBase = immutableSnapshotDiffBase(source, lane.baseBranch);
  try {
    const [stat, full, nameStatus, headTree, recoveryHead] = await Promise.all([
      gitOutput(source.cwd, ['diff', '--stat', source.baseCommit, source.headCommit, '--']),
      gitOutput(source.cwd, [
        'diff', '--no-color', '--no-ext-diff', '--no-textconv', source.baseCommit, source.headCommit, '--',
      ]),
      gitOutput(source.cwd, [
        'diff', '--name-status', '-z', '--find-renames', source.baseCommit, source.headCommit, '--',
      ]),
      gitValue(source.cwd, ['rev-parse', '--verify', `${source.headCommit}^{tree}`]),
      gitValue(source.cwd, ['rev-parse', '--verify', `${source.recoveryRef}^{commit}`]),
    ]);
    if (headTree !== source.treeSha || recoveryHead !== source.headCommit) {
      throw new Error('immutable objects changed during spoken review');
    }
    const fileChanges = parseNameStatus(nameStatus);
    return {
      headSha: source.headCommit,
      against: source.baseCommit,
      diffBase,
      stat: stat.trim(),
      fingerprint: source.diffFingerprint,
      snapshotTreeHash: source.treeSha,
      dirtyFiles: [],
      untrackedFiles: [],
      changedFiles: fileChanges.map((entry) => entry.path),
      fileChanges,
      addedLines: extractAddedLines(full),
      addedDiffLines: extractAddedDiffLines(full),
    };
  } catch (error) {
    if (error instanceof ImmutableReviewUnavailableError) throw error;
    throw new ImmutableReviewUnavailableError(
      lane.packetId ?? lane.id,
      'the saved Git objects could not produce spoken review evidence.',
    );
  }
}

export function immutableReviewUnavailablePayload(error: ImmutableReviewUnavailableError) {
  return {
    ok: false as const,
    error: {
      code: error.code,
      message: error.message,
      packetId: error.packetId,
    },
  };
}
