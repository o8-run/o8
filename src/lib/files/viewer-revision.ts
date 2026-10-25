import 'server-only';
import { createHash } from 'node:crypto';
import { realpathSync, lstatSync, readlinkSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { NextResponse } from 'next/server';
import { execFileSync } from '@/lib/providers/child-process';
import { isWorkspaceFileError, openWorkspaceFile } from '@/lib/fs/workspace-file';

const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const git = (root: string, ...args: string[]) => execFileSync('git', args, {
  cwd: root, encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 8 * 1024 * 1024, stdio: 'pipe',
});

/** Opaque revisions stay separate from bounded text previews. */
export async function readViewerRevision(workspace: string, path?: string, bounded = false) {
  const root = realpathSync(workspace);
  if (path && (isAbsolute(path) || path.split(/[\\/]/).includes('..'))) throw new Error('Invalid workspace path');
  const headSha = git(root, 'rev-parse', 'HEAD').trim();
  const branch = git(root, 'rev-parse', '--symbolic-full-name', 'HEAD').trim();
  let bytes: Buffer | null = null;
  let large = false;
  if (path) {
    try {
      const opened = await openWorkspaceFile(root, path, 'read');
      try {
        large = bounded && Number(opened.stat.size) > 100000;
        if (large) {
          const preview = Buffer.alloc(100000);
          const { bytesRead } = await opened.handle.read(preview, 0, preview.length, 0);
          bytes = preview.subarray(0, bytesRead);
        } else bytes = await opened.handle.readFile();
      } finally { await opened.handle.close(); }
    }
    catch (error) { if (!isWorkspaceFileError(error) || error.code !== 'workspace_file_not_found') throw error; }
  }
  if (large) return { headSha, branch, workspaceHash: null, workspaceRevision: null, bytes, large };
  // The action stages all working bytes. Index-only transitions must not
  // invalidate those bytes, including a failed commit that already staged them.
  const changed = git(root, 'diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', 'HEAD', '--', '.');
  const untracked = git(root, 'ls-files', '--others', '--exclude-standard', '-z');
  const paths = [...new Set((changed + untracked).split('\0').filter(Boolean))].sort();
  const fingerprint = createHash('sha256');
  for (const entry of paths) {
    fingerprint.update(entry).update('\0');
    let stat;
    try { stat = lstatSync(join(root, entry)); }
    catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) { fingerprint.update('missing'); continue; }
      throw error;
    }
    fingerprint.update(String(stat.mode & 0o111));
    if (stat.isSymbolicLink()) fingerprint.update(readlinkSync(join(root, entry)));
    else if (stat.isDirectory()) fingerprint.update(git(join(root, entry), 'rev-parse', 'HEAD'));
    else {
      const opened = await openWorkspaceFile(root, entry, 'read');
      try {
        const hash = createHash('sha256');
        const chunk = Buffer.alloc(65536);
        for (;;) {
          const { bytesRead } = await opened.handle.read(chunk, 0, chunk.length, null);
          if (!bytesRead) break;
          hash.update(chunk.subarray(0, bytesRead));
        }
        fingerprint.update(hash.digest('hex'));
      } finally { await opened.handle.close(); }
    }
    fingerprint.update('\0');
  }
  if (git(root, 'rev-parse', 'HEAD').trim() !== headSha || git(root, 'rev-parse', '--symbolic-full-name', 'HEAD').trim() !== branch) throw new Error('Workspace changed while reading');
  return { headSha, branch, workspaceHash: bytes === null ? null : digest(bytes), workspaceRevision: fingerprint.digest('hex'), bytes, large };
}

/** Legacy desktop callers remain compatible; native callers carry all read tokens. */
export async function guardViewerRevision(root: string, body: Record<string, unknown>) {
  if (body.expectedHeadSha === undefined) return null;
  if (typeof body.expectedHeadSha !== 'string' || !/^[a-f0-9]{40}$/i.test(body.expectedHeadSha) || typeof body.expectedBranch !== 'string') {
    return NextResponse.json({ error: 'Invalid workspace revision' }, { status: 400 });
  }
  try {
    const current = await readViewerRevision(root, typeof body.path === 'string' ? body.path : undefined);
    if (current.headSha !== body.expectedHeadSha || current.branch !== body.expectedBranch
      || ('expectedHash' in body && current.workspaceHash !== body.expectedHash)
      || (body.expectedWorkspaceRevision !== undefined && current.workspaceRevision !== body.expectedWorkspaceRevision)) {
      return NextResponse.json({ error: 'Workspace changed. Draft retained; reload before retrying.' }, { status: 409 });
    }
    return null;
  } catch {
    return NextResponse.json({ error: 'Workspace revision unavailable. Draft retained.' }, { status: 409 });
  }
}
