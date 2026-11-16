import { NextResponse } from 'next/server';
import { cachedGitHubPreview, parseGitHubLink } from '@/lib/link-preview/github';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** What a transcript link pill's hover card shows. Only GitHub repository, issue and pull request links. */
export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get('url') ?? '';
  const link = raw.length <= 2_000 ? parseGitHubLink(raw) : null;
  if (!link) return NextResponse.json({ ok: false, error: 'No preview for this link.' }, { status: 404 });
  try {
    return NextResponse.json({ ok: true, preview: await cachedGitHubPreview(link) });
  } catch {
    return NextResponse.json({ ok: false, error: 'GitHub did not answer.' }, { status: 502 });
  }
}
