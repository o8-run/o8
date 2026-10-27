import { viewerGitJson } from '@/lib/viewers/git-response';
import { getDefaultLlmRepoRoot } from '@/lib/llm/repo-scope';
import { viewerJson } from '@/lib/viewers/response';
import { NextRequest } from 'next/server';
import { getReviewFileDetail } from '@/lib/review/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const reviewPath = request.nextUrl.searchParams.get('path')?.trim();

  if (!reviewPath) {
    return viewerJson({ error: 'Review file path is required.' }, { status: 400 });
  }

  try {
    const file = await getReviewFileDetail(reviewPath);
    return viewerGitJson(
      { file }, getDefaultLlmRepoRoot(), {},
      {
        headers: {
          'Cache-Control': 'no-store, max-age=0',
        },
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load review file detail';
    const status = message.includes('no longer part of the live review surface') ? 404 : 500;

    return viewerJson({ error: message }, { status });
  }
}
