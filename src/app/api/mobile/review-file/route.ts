import { viewerGitJson } from '@/lib/viewers/git-response';
import { getDefaultLlmRepoRoot } from '@/lib/llm/repo-scope';
import { viewerJson } from '@/lib/viewers/response';
import { NextRequest } from 'next/server';
import { getReviewFileDetail } from '@/lib/review/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Server-side cache for review file content
const reviewFileCache = new Map<string, { data: unknown; timestamp: number; hash: string }>();
const REVIEW_FILE_CACHE_TTL = 10000; // 10 seconds — file diffs rarely change while idle

function simpleHash(obj: unknown): string {
  const str = JSON.stringify(obj);
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

export async function GET(request: NextRequest) {
  const reviewPath = request.nextUrl.searchParams.get('path')?.trim();

  if (!reviewPath) {
    return viewerJson(
      {
        error: 'Review file path is required.',
      },
      { status: 400 },
    );
  }

  try {
    const cached = reviewFileCache.get(reviewPath);
    if (cached && Date.now() - cached.timestamp < REVIEW_FILE_CACHE_TTL) {
      return viewerGitJson(
        { file: cached.data }, getDefaultLlmRepoRoot(), {},
        {
          headers: {
            'Cache-Control': 'private, max-age=10',
          },
        },
      );
    }

    const file = await getReviewFileDetail(reviewPath);
    const hash = simpleHash(file);

    // Only update cache if content actually changed
    reviewFileCache.set(reviewPath, { data: file, timestamp: Date.now(), hash });

    return viewerGitJson(
      { file }, getDefaultLlmRepoRoot(), {},
      {
        headers: {
          'Cache-Control': 'private, max-age=10',
        },
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load mobile review file detail';
    const status = message.includes('no longer part of the live review surface') ? 404 : 500;

    return viewerJson(
      {
        error: message,
      },
      { status },
    );
  }
}
