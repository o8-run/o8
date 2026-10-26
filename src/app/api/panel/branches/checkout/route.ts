export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { execFileSync } from '@/lib/providers/child-process';
import { isSafeGitRef } from '@/lib/git/refs';
import { knowledgeSourceWriteRefusal } from '@/lib/cortex/knowledge/sources';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      repoPath: string;
      branch: string;
      stash?: boolean;
      force?: boolean;
    };

    const { repoPath, branch, stash, force } = body;
    if (!repoPath || !branch) {
      return NextResponse.json({ error: 'repoPath and branch required' }, { status: 400 });
    }
    if (!isSafeGitRef(branch)) {
      return NextResponse.json({ error: 'Invalid branch name' }, { status: 400 });
    }

    const cwd = repoPath.replace(/^~/, process.env.HOME || require('os').homedir());
    const sourceRefusal = knowledgeSourceWriteRefusal(repoPath, cwd);
    if (sourceRefusal) return sourceRefusal;

    // Check for uncommitted changes
    let dirty = false;
    let dirtyFiles: string[] = [];
    try {
      const status = execFileSync('git', ['status', '--porcelain'], { windowsHide: true, cwd, timeout: 5000 }).toString().trim();
      if (status) {
        dirty = true;
        dirtyFiles = status.split('\n').slice(0, 10); // First 10 files
      }
    } catch {
      return NextResponse.json({ error: 'Failed to check git status' }, { status: 500 });
    }

    // If dirty and no stash/force requested, return warning
    if (dirty && !stash && !force) {
      return NextResponse.json({
        error: 'uncommitted_changes',
        dirty: true,
        fileCount: dirtyFiles.length,
        files: dirtyFiles,
        message: `${dirtyFiles.length} uncommitted change${dirtyFiles.length === 1 ? '' : 's'}. Stash or force checkout?`,
      }, { status: 409 });
    }

    // Stash if requested
    if (dirty && stash) {
      try {
        execFileSync('git', ['stash', 'push', '-m', `o8: auto-stash before switching to ${branch}`], {
          windowsHide: true,
          cwd, timeout: 10000,
        });
      } catch (err) {
        return NextResponse.json({
          error: `Stash failed: ${err instanceof Error ? err.message : 'unknown'}`,
        }, { status: 500 });
      }
    }

    // Checkout
    try {
      execFileSync('git', ['checkout', ...(force ? ['-f'] : []), branch], {
        windowsHide: true,
        cwd, timeout: 10000,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      return NextResponse.json({
        error: `Checkout failed: ${msg}`,
      }, { status: 500 });
    }

    // Verify current branch
    let currentBranch = branch;
    try {
      currentBranch = execFileSync('git', ['branch', '--show-current'], { windowsHide: true, cwd, timeout: 5000 }).toString().trim();
    } catch { /* use requested branch */ }

    return NextResponse.json({
      success: true,
      branch: currentBranch,
      stashed: Boolean(dirty && stash),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to checkout' },
      { status: 500 },
    );
  }
}
