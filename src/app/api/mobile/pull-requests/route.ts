import { NextResponse, type NextRequest } from 'next/server';
import { listMobileOrchestratorThreads } from '@/lib/mobile/orchestrator-thread-history';
import { mobileThreadPullRequests } from '@/lib/mobile/pull-request-projection';
import { normalizeRepoSlug } from '@/lib/github-broker/repo';
import { listRepos } from '@/lib/repos/registry';
import { GET as panelList } from '@/app/api/panel/prs/route';
import { GET as panelDetail } from '@/app/api/panel/prs/[number]/route';
import { GET as panelChecks } from '@/app/api/panel/prs/[number]/checks/route';
import { GET as panelTimeline } from '@/app/api/panel/prs/[number]/timeline/route';
import { GET as panelComments } from '@/app/api/panel/prs/[number]/comments/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PARTS = { detail: panelDetail, checks: panelChecks, timeline: panelTimeline, comments: panelComments } as const;

/**
 * The phone's Pull requests page. A phone never names a repository: it names
 * one of this computer's registered project folders, and the repository comes
 * from that project's own remote. The panel pull request routes stay
 * operator-only; this route reaches the same read handlers for those projects.
 */
async function projectPullRequests(request: NextRequest): Promise<Response | null> {
  const search = request.nextUrl.searchParams;
  const view = search.get('view');
  const number = search.get('number');
  if (view !== 'list' && number === null) return null;
  const repoPath = search.get('repoPath') ?? '';
  const project = (await listRepos()).find(repo => repo.localPath === repoPath);
  const repo = normalizeRepoSlug(project?.remoteUrl);
  if (!project || !repo) return NextResponse.json({ error: 'This project has no pull requests to read.' }, { status: 404 });
  const origin = request.nextUrl.origin;
  if (view === 'list') {
    const state = search.get('state') ?? 'open';
    const page = search.get('page') ?? '1';
    if (!['open', 'closed', 'all'].includes(state) || !/^[1-9]\d{0,3}$/.test(page)) return NextResponse.json({ error: 'Choose a valid pull request state and page.' }, { status: 400 });
    const query = new URLSearchParams({ view: 'list', state, page, repo });
    return panelList(new Request(`${origin}/api/panel/prs?${query}`, { signal: request.signal }));
  }
  const part = search.get('part') ?? 'detail';
  const page = search.get('page') ?? '1';
  if (!/^[1-9]\d{0,8}$/.test(number ?? '') || !Object.hasOwn(PARTS, part) || !/^[1-9]\d{0,3}$/.test(page)) {
    return NextResponse.json({ error: 'Choose a valid pull request.' }, { status: 400 });
  }
  const query = new URLSearchParams({ repo, page });
  const suffix = part === 'detail' ? '' : `/${part}`;
  return PARTS[part as keyof typeof PARTS](
    new Request(`${origin}/api/panel/prs/${number}${suffix}?${query}`, { signal: request.signal }),
    { params: Promise.resolve({ number: number! }) },
  );
}

export async function GET(request: NextRequest) {
  const project = await projectPullRequests(request).catch(() => NextResponse.json({ error: 'Pull requests unavailable.' }, { status: 503 }));
  if (project) return project;
  try {
    const ids: string[] = [];
    for (const backend of [null, 'openclaw'] as const) {
      for (let offset = 0; ; offset += 500) {
        const threads = listMobileOrchestratorThreads({ backend, limit: 500, offset });
        ids.push(...threads.map(thread => thread.id));
        if (threads.length < 500) break;
      }
    }
    const rows = await mobileThreadPullRequests(ids);
    const pullRequests = rows.filter(pr => pr.state === 'open').map(({ changedFiles: _count, ...pr }) => pr);
    return NextResponse.json({ pullRequests, updatedAt: rows.map(pr => pr.updatedAt ?? '').sort().at(-1) ?? null },
      { headers: { 'Cache-Control': 'private, max-age=15' } });
  } catch {
    return NextResponse.json({ error: 'Pull requests unavailable.' }, { status: 503 });
  }
}
