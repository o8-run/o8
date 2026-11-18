import { resolveGitBinary } from '@/lib/git/binary';
import { execFile } from '@/lib/providers/child-process';
import { promisify } from 'node:util';

import { LaneGitMetadataError } from '@/lib/lane/lane-git';

import { isSafeGitRef } from '@/lib/git/refs';

const execFileAsync = promisify(execFile);
const COMMAND_MAX_BUFFER = 1024 * 1024;
const DEFAULT_FETCH_TIMEOUT_MS = 4_000;
const FETCH_MEMO_TTL_MS = 60_000;
const OBJECT_ID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export type DiffBaseGitRunner = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

interface FetchOutcome {
  comparisonRef: string;
  fetchedRemoteBase: boolean;
  usedFallback: boolean;
  warning: string | null;
}

export interface PacketDiffBaseResolution {
  baseBranch: string;
  requestedRef: string;
  comparisonRef: string;
  mergeBase: string | null;
  fetchedRemoteBase: boolean;
  usedFallback: boolean;
  warning: string | null;
}

function gitErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return String(error || 'unknown git error');
}

async function gitStdout(cwd: string, args: string[], timeout = DEFAULT_FETCH_TIMEOUT_MS): Promise<string> {
  const { stdout } = await execFileAsync(resolveGitBinary(), args, {
    windowsHide: true,
    cwd,
    timeout,
    maxBuffer: COMMAND_MAX_BUFFER,
  });
  return stdout.trim();
}

async function refExists(cwd: string, ref: string, runGit?: DiffBaseGitRunner): Promise<boolean> {
  try {
    if (runGit) await runGit(['rev-parse', '--verify', '--quiet', ref]);
    else await gitStdout(cwd, ['rev-parse', '--verify', '--quiet', ref], 5_000);
    return true;
  } catch (error) {
    if (error instanceof LaneGitMetadataError) throw error;
    return false;
  }
}

const fetchMemo = new Map<string, FetchOutcome & { attemptedAt: number }>();

export function resetPacketDiffBaseFetchMemoForTest(): void {
  fetchMemo.clear();
}

async function resolveFetchOutcome(
  cwd: string,
  base: string,
  originRef: string,
  fetchTimeoutMs: number,
  runGit?: DiffBaseGitRunner,
): Promise<FetchOutcome> {
  const execute = runGit
    ? async (args: string[]) => (await runGit(args)).stdout.trim()
    : (args: string[]) => gitStdout(cwd, args, fetchTimeoutMs);
  const memoKey = `${cwd}\0${base}\0${runGit ? 'host-lane' : 'default'}`;
  const cached = fetchMemo.get(memoKey);
  if (cached && Date.now() - cached.attemptedAt < FETCH_MEMO_TTL_MS) {
    return {
      comparisonRef: cached.comparisonRef,
      fetchedRemoteBase: cached.fetchedRemoteBase,
      usedFallback: cached.usedFallback,
      warning: cached.warning,
    };
  }

  let outcome: FetchOutcome;
  try {
    await execute(['fetch', 'origin', base, '--quiet']);
    if (await refExists(cwd, originRef, runGit)) {
      outcome = {
        comparisonRef: originRef,
        fetchedRemoteBase: true,
        usedFallback: false,
        warning: null,
      };
    } else {
      outcome = {
        comparisonRef: base,
        fetchedRemoteBase: false,
        usedFallback: true,
        warning: `Fetched origin ${base}, but ${originRef} is unavailable; using local ${base}.`,
      };
    }
  } catch (error) {
    if (error instanceof LaneGitMetadataError) throw error;
    outcome = {
      comparisonRef: base,
      fetchedRemoteBase: false,
      usedFallback: true,
      warning: `Could not refresh ${originRef}: ${gitErrorMessage(error)}; using local ${base}.`,
    };
  }

  fetchMemo.set(memoKey, { ...outcome, attemptedAt: Date.now() });
  return outcome;
}

/** Canonical remote/base decision before local diff computation. */
export async function resolvePacketDiffBaseTarget(
  cwd: string, baseBranch: string, fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS, runGit?: DiffBaseGitRunner,
) {
  const base = baseBranch.trim() || 'main';
  if (!isSafeGitRef(base)) throw new Error(`Unsafe base branch for diff: ${base}`);
  const originRef = `origin/${base}`;
  const outcome = await resolveFetchOutcome(cwd, base, originRef, fetchTimeoutMs, runGit);
  return { baseBranch: base, requestedRef: originRef, ...outcome };
}

export async function resolvePacketDiffBase(
  cwd: string,
  baseBranch: string,
  headSha: string,
  fetchTimeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
  runGit?: DiffBaseGitRunner,
): Promise<PacketDiffBaseResolution> {
  const fetchOutcome = await resolvePacketDiffBaseTarget(cwd, baseBranch, fetchTimeoutMs, runGit);
  const base = fetchOutcome.baseBranch, originRef = fetchOutcome.requestedRef;
  let usedFallback = fetchOutcome.usedFallback;
  let warning = fetchOutcome.warning;

  let mergeBase: string | null = null;
  try {
    mergeBase = runGit
      ? (await runGit(['merge-base', fetchOutcome.comparisonRef, headSha])).stdout.trim()
      : await gitStdout(cwd, ['merge-base', fetchOutcome.comparisonRef, headSha]);
  } catch (error) {
    if (error instanceof LaneGitMetadataError) throw error;
    usedFallback = true;
    warning = warning
      ? `${warning} merge-base failed for ${fetchOutcome.comparisonRef}: ${gitErrorMessage(error)}.`
      : `merge-base failed for ${fetchOutcome.comparisonRef}: ${gitErrorMessage(error)}.`;
  }

  return {
    baseBranch: base,
    requestedRef: originRef,
    comparisonRef: fetchOutcome.comparisonRef,
    mergeBase,
    fetchedRemoteBase: fetchOutcome.fetchedRemoteBase,
    usedFallback,
    warning,
  };
}

/** Resolve the exact baseline for work attributed to one packet. */
export async function resolvePacketAttributionBase(
  cwd: string,
  baseBranch: string,
  headSha: string,
  creationBaseCommit?: string | null,
  runGit?: DiffBaseGitRunner,
): Promise<PacketDiffBaseResolution> {
  const base = baseBranch.trim() || 'main';
  if (!isSafeGitRef(base)) {
    throw new Error(`Unsafe base branch for diff: ${base}`);
  }

  const creationBase = creationBaseCommit?.trim().toLowerCase() ?? '';
  if (creationBase) {
    if (!OBJECT_ID_PATTERN.test(creationBase)) {
      throw new Error('Saved packet creation base is not a full Git object ID.');
    }
    try {
      const execute = runGit
        ? async (args: string[]) => (await runGit(args)).stdout.trim()
        : (args: string[]) => gitStdout(cwd, args, 5_000);
      const resolved = (await execute(['rev-parse', '--verify', `${creationBase}^{commit}`])).toLowerCase();
      if (resolved !== creationBase) {
        throw new Error('the saved object did not resolve to itself');
      }
      await execute(['merge-base', '--is-ancestor', creationBase, headSha]);
      return {
        baseBranch: base,
        requestedRef: creationBase,
        comparisonRef: creationBase,
        mergeBase: creationBase,
        fetchedRemoteBase: false,
        usedFallback: false,
        warning: null,
      };
    } catch (error) {
      if (error instanceof LaneGitMetadataError) throw error;
      throw new Error(`Saved packet creation base ${creationBase} is unavailable: ${gitErrorMessage(error)}`);
    }
  }

  // Legacy lanes predate creation receipts. Preserve their remote-first
  // behavior because they may have been created from either local or remote
  // base state, and guessing local can attribute upstream commits to a packet.
  return resolvePacketDiffBase(cwd, base, headSha, undefined, runGit);
}
