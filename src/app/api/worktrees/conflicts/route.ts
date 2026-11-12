/**
 * Worktree Conflicts API
 *
 * GET  /api/worktrees/conflicts?repo=<path>&deep=true  — Enhanced conflict report
 *
 * Fast mode (default): file-level overlap scan, <100ms
 * Deep mode (?deep=true): line-level analysis on all overlaps, 500ms-2s
 *
 * @see https://github.com/o8-run/o8/issues/69
 */

export const dynamic = 'force-dynamic';

import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { WorktreeManager } from '@/lib/worktree/manager';
import { generateConflictReport } from '@/lib/worktree/conflicts';

export async function GET(req: NextRequest) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  const repo = req.nextUrl.searchParams.get('repo');
  if (!repo) {
    return NextResponse.json({ error: 'repo parameter required' }, { status: 400 });
  }

  const deep = req.nextUrl.searchParams.get('deep') === 'true';

  try {
    // This read needs only persisted metadata, not the launch module's manager cache.
    const mgr = new WorktreeManager(repo);
    const worktrees = await mgr.list();
    const report = await generateConflictReport(worktrees, deep);

    return NextResponse.json(report, {
      headers: {
        'Cache-Control': 'no-cache, no-store',
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
