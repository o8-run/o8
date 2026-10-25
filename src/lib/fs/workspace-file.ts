import 'server-only';

import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import { safeJoin } from '@/lib/fs/safe-path';
import { assertNotKnowledgeSource, KnowledgeSourceWriteError } from '@/lib/cortex/knowledge/sources';

export type WorkspaceFileOpenMode = 'read' | 'read-write';

export type WorkspaceFileErrorCode =
  | 'workspace_file_not_found'
  | 'workspace_identity_mismatch'
  | 'workspace_not_regular_file'
  | 'workspace_path_invalid'
  | 'workspace_symlink_refused'
  | 'workspace_hardlink_refused'
  | 'knowledge_source_read_only'
  | 'workspace_file_open_failed';

export class WorkspaceFileError extends Error {
  constructor(
    public readonly code: WorkspaceFileErrorCode,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'WorkspaceFileError';
  }
}

function assertWritableTarget(filePath: string): void {
  try { assertNotKnowledgeSource(filePath); } catch (error) {
    if (error instanceof KnowledgeSourceWriteError) throw new WorkspaceFileError('knowledge_source_read_only', error.message, 403);
    throw error;
  }
}

function assertSingleWritableLink(stat: { nlink: number | bigint }): void {
  if (stat.nlink !== 1 && stat.nlink !== BigInt(1)) {
    throw new WorkspaceFileError('workspace_hardlink_refused', 'Files with multiple hard links cannot be edited.', 403);
  }
}

export interface OpenWorkspaceFileOptions {
  /** Create the final file only when it does not exist. Parent directories must already exist. */
  create?: boolean;
  /** Test seam for deterministically exercising a swap between open and validation. */
  afterOpen?: (path: string, handle: FileHandle) => void | Promise<void>;
}

export interface OpenWorkspaceFileResult {
  handle: FileHandle;
  lexicalPath: string;
  realPath: string;
  stat: Awaited<ReturnType<FileHandle['stat']>>;
  created: boolean;
}

export interface ReadWorkspaceFileResult {
  bytes: Buffer;
  lexicalPath: string;
  realPath: string;
  stat: Awaited<ReturnType<FileHandle['stat']>>;
}

export interface WriteWorkspaceFileResult {
  created: boolean;
  previousBytes: Buffer | null;
  lexicalPath: string;
  realPath: string;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function sameIdentity(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function nodeErrorCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null;
}

function openFlags(mode: WorkspaceFileOpenMode, create: boolean): number {
  const access = mode === 'read' ? constants.O_RDONLY : constants.O_RDWR;
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  return access | noFollow | (create ? constants.O_CREAT | constants.O_EXCL : 0);
}

async function openHandle(
  path: string,
  mode: WorkspaceFileOpenMode,
  allowCreate: boolean,
): Promise<{ handle: FileHandle; created: boolean }> {
  try {
    return { handle: await open(path, openFlags(mode, false)), created: false };
  } catch (error) {
    const code = nodeErrorCode(error);
    if (code === 'ELOOP') {
      throw new WorkspaceFileError('workspace_symlink_refused', 'Symbolic-link file targets are not allowed.', 403);
    }
    if (code !== 'ENOENT' || !allowCreate || mode === 'read') {
      if (code === 'ENOENT') {
        throw new WorkspaceFileError('workspace_file_not_found', 'File not found.', 404);
      }
      throw new WorkspaceFileError('workspace_file_open_failed', 'Could not open workspace file.', 500);
    }
  }

  try {
    return { handle: await open(path, openFlags(mode, true), 0o600), created: true };
  } catch (error) {
    const code = nodeErrorCode(error);
    if (code === 'ELOOP') {
      throw new WorkspaceFileError('workspace_symlink_refused', 'Symbolic-link file targets are not allowed.', 403);
    }
    if (code === 'ENOENT') {
      throw new WorkspaceFileError('workspace_file_not_found', 'The workspace file parent directory does not exist.', 404);
    }
    throw new WorkspaceFileError('workspace_file_open_failed', 'Could not create workspace file.', 500);
  }
}

/**
 * Open first, then prove the opened descriptor belongs to a regular file under
 * the canonical workspace root. Every caller must perform I/O through the
 * returned handle and close it; reopening `lexicalPath` or `realPath` revives
 * the validate-then-open race this helper closes.
 */
export async function openWorkspaceFile(
  root: string,
  relPath: string,
  mode: WorkspaceFileOpenMode,
  options: OpenWorkspaceFileOptions = {},
): Promise<OpenWorkspaceFileResult> {
  if (isAbsolute(relPath)) {
    throw new WorkspaceFileError('workspace_path_invalid', 'File path must be relative to the workspace.', 403);
  }
  const lexicalPath = safeJoin(root, relPath);
  if (!lexicalPath) {
    throw new WorkspaceFileError('workspace_path_invalid', 'File path must stay inside the workspace.', 403);
  }

  if (mode === 'read-write') assertWritableTarget(lexicalPath);
  const { handle, created } = await openHandle(lexicalPath, mode, options.create === true);
  try {
    const descriptorStat = await handle.stat();
    if (!descriptorStat.isFile()) {
      throw new WorkspaceFileError('workspace_not_regular_file', 'Workspace target must be a regular file.', 400);
    }
    if (mode === 'read-write') assertSingleWritableLink(descriptorStat);

    await options.afterOpen?.(lexicalPath, handle);

    let realRoot: string;
    let realPath: string;
    try {
      [realRoot, realPath] = await Promise.all([
        realpath(resolve(root)),
        realpath(lexicalPath),
      ]);
    } catch {
      throw new WorkspaceFileError('workspace_identity_mismatch', 'Workspace file changed while it was being opened.', 409);
    }
    if (!isWithin(realRoot, realPath)) {
      throw new WorkspaceFileError('workspace_path_invalid', 'Opened file resolves outside the workspace.', 403);
    }

    let resolvedStat: Awaited<ReturnType<typeof lstat>>;
    let lexicalStat: Awaited<ReturnType<typeof lstat>>;
    try {
      [resolvedStat, lexicalStat] = await Promise.all([
        lstat(realPath),
        lstat(lexicalPath),
      ]);
    } catch {
      throw new WorkspaceFileError('workspace_identity_mismatch', 'Workspace file changed while it was being validated.', 409);
    }
    if (lexicalStat.isSymbolicLink()) {
      throw new WorkspaceFileError('workspace_symlink_refused', 'Symbolic-link file targets are not allowed.', 403);
    }
    if (!sameIdentity(descriptorStat, resolvedStat) || !sameIdentity(descriptorStat, lexicalStat)) {
      throw new WorkspaceFileError('workspace_identity_mismatch', 'Workspace file identity changed after open.', 409);
    }
    if (mode === 'read-write') {
      assertSingleWritableLink(resolvedStat);
      assertSingleWritableLink(lexicalStat);
    }

    return { handle, lexicalPath, realPath, stat: descriptorStat, created };
  } catch (error) {
    await handle.close().catch(() => {});
    if (error instanceof WorkspaceFileError) throw error;
    throw new WorkspaceFileError('workspace_file_open_failed', 'Could not validate workspace file.', 500);
  }
}

export async function readWorkspaceFile(root: string, relPath: string): Promise<ReadWorkspaceFileResult> {
  const opened = await openWorkspaceFile(root, relPath, 'read');
  try {
    return {
      bytes: await opened.handle.readFile(),
      lexicalPath: opened.lexicalPath,
      realPath: opened.realPath,
      stat: opened.stat,
    };
  } finally {
    await opened.handle.close();
  }
}

export async function writeWorkspaceFile(
  root: string,
  relPath: string,
  content: string | Uint8Array,
): Promise<WriteWorkspaceFileResult> {
  const opened = await openWorkspaceFile(root, relPath, 'read-write', { create: true });
  try {
    const previousBytes = opened.created ? null : await opened.handle.readFile();
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf-8') : Buffer.from(content);
    assertWritableTarget(opened.realPath);
    assertSingleWritableLink(await opened.handle.stat());
    await opened.handle.truncate(0);
    if (bytes.byteLength > 0) await opened.handle.write(bytes, 0, bytes.byteLength, 0);
    await opened.handle.sync();
    return {
      created: opened.created,
      previousBytes,
      lexicalPath: opened.lexicalPath,
      realPath: opened.realPath,
    };
  } finally {
    await opened.handle.close();
  }
}

export function isWorkspaceFileError(error: unknown): error is WorkspaceFileError {
  return error instanceof WorkspaceFileError;
}
