import { NextResponse } from 'next/server';
import type { WorkflowReviewSnapshot } from '@/lib/fleet/types';
import { getWorkspaceReviewSnapshot } from '@/lib/review/workspace';
import { WorkspaceReviewError } from '@/lib/review/workspace-status';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EMPTY_SNAPSHOT: WorkflowReviewSnapshot = {
  generatedAt: new Date(0).toISOString(),
  repoSlug: '',
  repoPath: '',
  branch: '',
  ahead: 0,
  behind: 0,
  dirty: false,
  changedFiles: [],
  diffStat: '',
  recentCommits: [],
  worktrees: [],
  pullRequests: [],
  activeIssues: [],
};

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const workspacePath = searchParams.get('workspace');
    const repoSlug = searchParams.get('repo');
    const strictBranch = searchParams.get('strictBranch') === '1';
    // The Workspace changes view only needs local git working-tree data. When
    // changesOnly=1 the snapshot skips every network `gh` call — the slow path
    // that made a freshly-added repo blank for ~13s on first open (#1340).
    const changesOnly = searchParams.get('changesOnly') === '1';
    // fresh=1 reads Git now instead of a snapshot up to 20s old, for a view
    // that must agree with a diff it just read.
    const fresh = searchParams.get('fresh') === '1';

    // Do not let a missing workspace param silently fall through to
    // process.cwd(). The client is expected to pass an absolute workspace
    // path; when the user has no repo selected the panel should render an
    // empty state, not whichever repo the Node server is sitting in.
    if (!workspacePath && !process.env.CORTEX_IDE_REVIEW_REPO_ROOT) {
      return NextResponse.json(
        { ...EMPTY_SNAPSHOT, generatedAt: new Date().toISOString() },
        { headers: { 'Cache-Control': 'no-store, max-age=0' } },
      );
    }

    const snapshot = await getWorkspaceReviewSnapshot({
      workspacePath,
      repoSlug,
      allowFallbackPullRequests: !strictBranch,
      changesOnly,
      fresh,
    });
    return NextResponse.json(snapshot, {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unable to load workflow review snapshot',
        code: error instanceof WorkspaceReviewError ? error.code : undefined,
      },
      { status: error instanceof WorkspaceReviewError ? error.status : 500 },
    );
  }
}
