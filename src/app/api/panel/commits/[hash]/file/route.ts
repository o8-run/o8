export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execFileSync } from '@/lib/providers/child-process';
import { isUtf8 } from 'node:buffer';
import { readViewerRevision } from '@/lib/files/viewer-revision';
import { isWorkspaceFileError, readWorkspaceFile } from '@/lib/fs/workspace-file';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';

const REPO_ROOT = process.env.CORTEX_IDE_REPO || process.env.CORTEX_IDE_REVIEW_REPO_ROOT || process.cwd();

function resolveRoot(workspace?: string | null) {
  if (!workspace) return REPO_ROOT;
  return workspace.startsWith('~')
    ? workspace.replace('~', homedir())
    : workspace;
}

function safeRepoPath(root: string, filePath: string) {
  const resolved = resolve(root, filePath);
  const rel = relative(root, resolved);
  if (isAbsolute(filePath) || filePath.split(/[\\/]/).includes('..') || rel.startsWith('..') || isAbsolute(rel)) {
    return null;
  }
  return resolved;
}

function normalizeStatus(code: string | undefined) {
  const prefix = code?.charAt(0) ?? '';
  switch (prefix) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'M':
      return 'modified';
    default:
      return 'unknown';
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ hash: string }> },
) {
  const { hash } = await params;
  const { searchParams } = new URL(request.url);
  const filePath = searchParams.get('path');
  const root = resolveRoot(searchParams.get('workspace'));
  const preview = searchParams.get('preview') === '1';

  if (!/^[a-f0-9]{7,40}$/i.test(hash)) {
    return NextResponse.json({ error: 'Invalid commit hash' }, { status: 400 });
  }

  if (!filePath) {
    return NextResponse.json({ error: 'path param required' }, { status: 400 });
  }

  const absoluteFilePath = safeRepoPath(root, filePath);
  if (!absoluteFilePath) {
    return NextResponse.json({ error: 'Path outside repository' }, { status: 400 });
  }

  try {
    let bytes: Buffer | null = null;
    let large = false;
    let revision = {};
    if (preview) {
      const loaded = await readViewerRevision(root, filePath, true);
      ({ bytes, large } = loaded);
      revision = { headSha: loaded.headSha, branch: loaded.branch,
        workspaceHash: loaded.workspaceHash, workspaceRevision: loaded.workspaceRevision };
    } else {
      try { bytes = (await readWorkspaceFile(root, filePath)).bytes; }
      catch (error) { if (!isWorkspaceFileError(error) || error.code !== 'workspace_file_not_found') throw error; }
    }
    let status = 'unknown';
    try {
      const nameStatus = execFileSync(
        'git',
        ['diff-tree', '--no-commit-id', '--name-status', '-r', '-M', hash, '--', filePath],
        { windowsHide: true, cwd: root, encoding: 'utf-8', timeout: 5000 },
      ).trim();
      if (nameStatus) {
        status = normalizeStatus(nameStatus.split('\t')[0]);
      }
    } catch {
      status = 'unknown';
    }

    let commitBytes: Buffer | null = null;
    let snapshotLarge = false;
    let commitSource: 'commit' | 'parent' | null = null;
    for (const [spec, source] of [[`${hash}:${filePath}`, 'commit'], [`${hash}^:${filePath}`, 'parent']] as const) {
      try {
        const size = Number(execFileSync('git', ['cat-file', '-s', spec], {
          cwd: root, encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: 'pipe',
        }).trim());
        if (preview && size > 100000) snapshotLarge = true;
        else commitBytes = execFileSync('git', ['show', spec], {
          cwd: root, windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024, stdio: 'pipe',
        });
        commitSource = source;
        break;
      } catch { /* Deleted paths use their parent snapshot. */ }
    }
    const commitContent = commitBytes?.toString('utf8') ?? null;

    const workspaceExists = bytes !== null;
    const binary = bytes !== null && (bytes.includes(0) || !isUtf8(bytes));
    const workspaceContent = bytes?.toString('utf8') ?? null;
    const truncated = preview && (large || snapshotLarge || (workspaceContent?.length ?? 0) > 100000);
    const commitBinary = commitBytes !== null && (commitBytes.includes(0) || !isUtf8(commitBytes));

    let note = '';
    if (status === 'deleted') {
      note = workspaceExists
        ? 'Deleted in the selected commit. The right side shows your current workspace file.'
        : 'Deleted in the selected commit. Saving here recreates the file in your workspace.';
    } else if (!workspaceExists && commitContent !== null) {
      note = 'File is not present in the current workspace. Saving here will restore it.';
    } else if (!workspaceExists && commitContent === null) {
      note = 'This path has no readable commit snapshot or live workspace file yet.';
    } else if (workspaceExists && commitContent === null) {
      note = 'Using the current workspace file because the exact commit snapshot is unavailable.';
    }

    return NextResponse.json({
      file: {
        path: filePath,
        status,
        ...revision, binary: binary || commitBinary, truncated,
        commitContent: preview ? commitContent?.slice(0, 100000) ?? null : commitContent,
        commitSource,
        workspaceContent: preview ? workspaceContent?.slice(0, 100000) ?? null : workspaceContent,
        workspaceExists,
        note,
      },
    });
  } catch (err) {
    return NextResponse.json({ error: 'Workspace comparison refused' }, { status: isWorkspaceFileError(err) ? err.status : 500 });
  }
}
