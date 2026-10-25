import { viewerJson } from '@/lib/viewers/response';
export const dynamic = 'force-dynamic';

import { getLocalCommitDetail, isValidCommitHash } from '@/lib/panel/git-commits';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ hash: string }> },
) {
  const { hash } = await params;
  const { searchParams } = new URL(request.url);
  const workspace = searchParams.get('workspace');

  if (!isValidCommitHash(hash)) {
    return viewerJson({ error: 'Invalid commit hash' }, { status: 400 });
  }

  try {
    const commit = getLocalCommitDetail(hash, workspace);

    return viewerJson({
      commit,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return viewerJson({ error: message }, { status: 500 });
  }
}
