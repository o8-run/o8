import { NextResponse } from 'next/server';
import { githubInstallationFetch } from '@/lib/github-broker/auth';

export const dynamic = 'force-dynamic';

/** Read-only timing and nullable mergeability omitted by the compact PR mirror. */
export async function GET(request: Request, { params }: { params: Promise<{ number: string }> }) {
  const { number } = await params;
  const repo = new URL(request.url).searchParams.get('repo') ?? '';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !/^[1-9]\d*$/.test(number) || !Number.isSafeInteger(Number(number))) {
    return NextResponse.json({ error: 'Invalid pull request address.' }, { status: 400 });
  }
  try {
    const options = { signal: AbortSignal.timeout(18_000) };
    const metadata = await githubInstallationFetch(repo, `/repos/${repo}/pulls/${number}`, options, { priority: 'background' });
    if (!metadata.response.ok) throw new Error('PR unavailable');
    const pr = await metadata.response.json() as { head?: { sha?: string }; mergeable?: boolean | null };
    if (!pr.head?.sha || !/^[a-f0-9]{40,64}$/i.test(pr.head.sha)) throw new Error('Head unavailable');
    const runs = await githubInstallationFetch(repo, `/repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`, options, { priority: 'background' });
    if (!runs.response.ok || runs.scope !== metadata.scope) throw new Error('Checks unavailable');
    const body = await runs.response.json() as { check_runs?: Array<{ name?: string; started_at?: string | null; completed_at?: string | null }> };
    if (!Array.isArray(body.check_runs)) throw new Error('Checks unavailable');
    return NextResponse.json({ headSha: pr.head.sha, mergeable: typeof pr.mergeable === 'boolean' ? pr.mergeable : null,
      timings: body.check_runs.filter(check => typeof check.name === 'string').map(check => {
        const start = Date.parse(check.started_at ?? '');
        const end = check.completed_at ? Date.parse(check.completed_at) : Date.now();
        return { name: check.name, durationMs: Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null };
      }) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Pull request checks could not be read. Retry.' }, { status: 502 });
  }
}
