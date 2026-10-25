import { viewerJson } from '@/lib/viewers/response';
export const dynamic = 'force-dynamic';

import { getLocalCommitDiffFiles, isValidCommitHash, resolveWorkspaceRoot } from '@/lib/panel/git-commits';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const sha = searchParams.get('sha');
  const workspace = searchParams.get('workspace');

  if (!sha) {
    return viewerJson({ error: 'sha param required' }, { status: 400 });
  }

  if (!isValidCommitHash(sha)) {
    return viewerJson({ error: 'Invalid commit hash' }, { status: 400 });
  }

  try {
    const files = getLocalCommitDiffFiles(sha, workspace);
    return viewerJson({
      sha,
      workspace: resolveWorkspaceRoot(workspace),
      files,
    });
  } catch (error) {
    return viewerJson({
      sha,
      workspace: resolveWorkspaceRoot(workspace),
      files: [],
      error: error instanceof Error ? error.message : 'Failed to fetch commit diff',
    }, { status: 500 });
  }
}
