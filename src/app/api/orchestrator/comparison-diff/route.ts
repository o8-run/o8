export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execFile } from '@/lib/providers/child-process';
import { promisify } from 'node:util';
import os from 'node:os';

import { parseChangedFiles } from '@/lib/review/workspace';

const execFileAsync = promisify(execFile);

/**
 * #1293 — best-of-N compare matrix file list.
 *
 * The compare grid needs each candidate's OWN committed diff (`git diff
 * <base>...HEAD`, three-dot from the merge-base — robust to `main` advancing),
 * NOT the working-tree diff `useWorkspaceChanges` returns. A candidate commits
 * its work, so the working tree is clean (or holds incidental WIP like a stale
 * Cargo.lock); the working-tree path showed that WIP instead of the candidate's
 * actual change. This is a stateless per-worktree read (no module cache / cwd
 * singleton), so two candidates can't collide.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const worktreeParam = searchParams.get('worktree') ?? searchParams.get('workspace');
  const base = (searchParams.get('base') || 'main').trim();

  // A base beginning with '-' is read by git as an option (e.g. --output=FILE),
  // turning this read into a file write; constrain it to a safe ref shape.
  if (base.startsWith('-') || base.length > 256 || !/^[\w./-]+$/.test(base)) {
    return NextResponse.json({ error: 'invalid base ref' }, { status: 400 });
  }

  if (!worktreeParam) {
    return NextResponse.json({ error: 'worktree param required' }, { status: 400 });
  }
  const home = os.homedir();
  const cwd = worktreeParam.startsWith('~') ? worktreeParam.replace('~', home) : worktreeParam;

  const run = async (args: string[]) => {
    try {
      const { stdout } = await execFileAsync('git', args, { windowsHide: true, cwd, timeout: 8000, maxBuffer: 10 * 1024 * 1024 });
      return stdout;
    } catch {
      return '';
    }
  };

  const range = `${base}...HEAD`;
  const [nameStatusRaw, numStatRaw] = await Promise.all([
    run(['diff', '--name-status', '--relative', '-M', range]),
    run(['diff', '--numstat', '--relative', '-M', range]),
  ]);

  // Committed diff has no untracked files — pass an empty untracked blob.
  const changedFiles = parseChangedFiles(nameStatusRaw, numStatRaw, '');

  return NextResponse.json(
    { changedFiles, base },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  );
}
