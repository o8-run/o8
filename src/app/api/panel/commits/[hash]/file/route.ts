import { viewerJson } from '@/lib/viewers/response';
export const dynamic = 'force-dynamic';

import { execFileSync } from '@/lib/providers/child-process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { relative, resolve } from 'node:path';

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
  if (rel.startsWith('..') || rel.startsWith('/')) {
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

  if (!/^[a-f0-9]{7,40}$/i.test(hash)) {
    return viewerJson({ error: 'Invalid commit hash' }, { status: 400 });
  }

  if (!filePath) {
    return viewerJson({ error: 'path param required' }, { status: 400 });
  }

  const absoluteFilePath = safeRepoPath(root, filePath);
  if (!absoluteFilePath) {
    return viewerJson({ error: 'Path outside repository' }, { status: 400 });
  }

  try {
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

    let commitContent: string | null = null;
    let commitSource: 'commit' | 'parent' | null = null;

    try {
      commitContent = execFileSync(
        'git',
        ['show', `${hash}:${filePath}`],
        { windowsHide: true, cwd: root, encoding: 'utf-8', timeout: 5000, maxBuffer: 1024 * 1024 },
      );
      commitSource = 'commit';
    } catch {
      try {
        commitContent = execFileSync(
          'git',
          ['show', `${hash}^:${filePath}`],
          { windowsHide: true, cwd: root, encoding: 'utf-8', timeout: 5000, maxBuffer: 1024 * 1024 },
        );
        commitSource = 'parent';
      } catch {
        commitContent = null;
        commitSource = null;
      }
    }

    const workspaceExists = existsSync(absoluteFilePath);
    const workspaceContent = workspaceExists
      ? readFileSync(absoluteFilePath, 'utf-8')
      : null;

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

    return viewerJson({
      file: {
        path: filePath,
        status,
        commitContent,
        commitSource,
        workspaceContent,
        workspaceExists,
        note,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return viewerJson({ error: message }, { status: 500 });
  }
}
