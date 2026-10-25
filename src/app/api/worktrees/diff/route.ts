import { viewerJson } from '@/lib/viewers/response';
/**
 * GET /api/worktrees/diff?sessionKey=<sessionKey>
 *                        [&worktreePath=<path>]
 *                        [&baseBranch=<name>]
 *                        [&file=<repo-relative-path>&headSha=<expected>]
 *
 * Legacy callers still receive a full unified diff. New callers can pin the
 * reviewed HEAD and request one exact file, keeping large mobile review
 * payloads bounded without weakening review identity.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { type NextRequest } from 'next/server';

import { findLaneBySession } from '@/lib/lane/registry';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import {
  collectBoundedDiffBody,
  collectWorktreeDiffSnapshot,
  FULL_DIFF_MAX_BYTES,
  parseDiffMaxBytes,
  SELECTED_DIFF_MAX_BYTES,
  validateRepoRelativePath,
  WorktreeHeadChangedError,
  type WorktreeDiffFile,
  worktreeDiffErrorMessage,
} from '@/lib/worktree/diff-transport';

interface DiffResponse {
  sessionKey: string | null;
  worktreePath: string | null;
  baseBranch: string | null;
  headSha: string | null;
  revision: string | null;
  filePath: string | null;
  files: WorktreeDiffFile[];
  diff: string;
  additions: number;
  deletions: number;
  fileCount: number;
  sizeBytes: number;
  sizeBytesExact: boolean;
  maxBytes: number;
  truncated: boolean;
  truncationReason?: 'max_bytes';
  error?: string;
}

function resolvePath(raw: string | null): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('~')) return trimmed.replace('~', homedir());
  return trimmed;
}

export async function GET(req: NextRequest) {
  // Operator or the operator's enrolled phone may read review diffs (the phone
  // reaches this over the relay with its device bearer); a dispatched worker has
  // no need for phone-review payloads.
  const principal = resolveRequestPrincipal(req);
  if (principal === 'worker') {
    return viewerJson({ error: 'A dispatched worker cannot read review diffs.' }, { status: 403 });
  }
  if (principal !== 'operator' && principal !== 'device') {
    return viewerJson({ error: 'Unauthorized.' }, { status: 401 });
  }

  const sessionKey = req.nextUrl.searchParams.get('sessionKey');
  const worktreePathParam = resolvePath(req.nextUrl.searchParams.get('worktreePath'));
  const baseBranchParam = req.nextUrl.searchParams.get('baseBranch');
  const expectedHeadSha = req.nextUrl.searchParams.get('headSha')?.trim() || null;
  const requestedFilePath = req.nextUrl.searchParams.get('file');
  let filePath: string | null = null;

  if (requestedFilePath !== null) {
    try {
      filePath = validateRepoRelativePath(requestedFilePath);
    } catch {
      return viewerJson({ error: 'invalid_file_path' }, { status: 400 });
    }
  }

  let worktreePath = worktreePathParam || null;
  let baseBranch = baseBranchParam || null;

  if (!worktreePath && sessionKey) {
    try {
      const lane = findLaneBySession(sessionKey);
      if (lane) {
        worktreePath = lane.worktreePath ?? lane.repoPath ?? null;
        if (!baseBranch) baseBranch = lane.baseBranch ?? null;
      }
    } catch {
      // Keep the legacy structured-error response below.
    }
  }

  const hardMaxBytes = filePath ? SELECTED_DIFF_MAX_BYTES : FULL_DIFF_MAX_BYTES;
  const maxBytes = parseDiffMaxBytes(req.nextUrl.searchParams.get('maxBytes'), hardMaxBytes, hardMaxBytes);
  const empty = (error: string): DiffResponse => ({
    sessionKey,
    worktreePath,
    baseBranch,
    headSha: null,
    revision: null,
    filePath,
    files: [],
    diff: '',
    additions: 0,
    deletions: 0,
    fileCount: 0,
    sizeBytes: 0,
    sizeBytesExact: true,
    maxBytes,
    truncated: false,
    error,
  });

  if (!worktreePath) return viewerJson(empty('worktree_not_found'));
  if (!existsSync(worktreePath)) return viewerJson(empty('worktree_path_missing'));

  try {
    const snapshot = await collectWorktreeDiffSnapshot(worktreePath, baseBranch, expectedHeadSha);
    const body = await collectBoundedDiffBody(worktreePath, snapshot, filePath, maxBytes);
    const selectedFiles = filePath
      ? snapshot.files.filter((file) => file.path === filePath)
      : snapshot.files;
    const additions = selectedFiles.reduce((sum, file) => sum + file.additions, 0);
    const deletions = selectedFiles.reduce((sum, file) => sum + file.deletions, 0);
    const value: DiffResponse = {
      sessionKey,
      worktreePath,
      baseBranch,
      headSha: snapshot.headSha,
      revision: snapshot.revision,
      filePath,
      files: selectedFiles,
      diff: body.diff,
      additions,
      deletions,
      fileCount: selectedFiles.length,
      sizeBytes: body.sizeBytes,
      sizeBytesExact: body.sizeBytesExact,
      maxBytes: body.maxBytes,
      truncated: body.truncated,
      ...(body.truncated ? { truncationReason: 'max_bytes' as const } : {}),
    };
    return viewerJson(value, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (error) {
    if (error instanceof WorktreeHeadChangedError) {
      return viewerJson({
        error: 'head_changed',
        expectedHeadSha: error.expectedHeadSha,
        currentHeadSha: error.currentHeadSha,
      }, { status: 409, headers: { 'Cache-Control': 'no-store, max-age=0' } });
    }
    return viewerJson(empty(worktreeDiffErrorMessage(error)));
  }
}
