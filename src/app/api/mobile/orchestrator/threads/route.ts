export const dynamic = 'force-dynamic';

/**
 * GET /api/mobile/orchestrator/threads — list recent orchestrator threads for
 * the mobile Orchestrator tab.
 * POST /api/mobile/orchestrator/threads — create a desktop-owned built-in
 * o8/Claude thread so mobile and desktop share the same `thoughts-*` id.
 *
 * Reads ~/.o8/chat-history/thoughts-*.json directly (same pattern as the
 * desktop OrchestratorHistorySidebar, which calls /api/v2/chat-history/list
 * with ?include=orchestrator). Projects each thread into a tiny mobile-shaped
 * payload with title, last activity, runtime, status, repo context, and count.
 *
 * Returns: { threads: MobileOrchestratorThread[] } — at most 20 most-recent.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { legacyInboxPin } from '@/lib/inbox/preferences';
import { inboxProjection, inboxRunStartedAt, inboxSubject } from '@/lib/inbox/store';
import { threadGitContext } from '@/lib/repos/thread-git-context';
import { isOrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import type { MobileOrchestratorBackend } from '@/lib/mobile/types';
import { OrchestratorThreadProjectError } from '@/lib/mobile/orchestrator-thread-project';
import {
  createMobileOrchestratorThread,
  listArchivedOrchestratorThreadIds,
  listMobileOrchestratorThreads,
} from '@/lib/mobile/orchestrator-thread-history';

export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };

export async function GET(request: NextRequest) {
  // ?archived=1 → just the archived `thoughts-*` ids (no recency cap, both
  // backends). The restore pipeline uses this to drop archived threads that
  // would otherwise resurrect as workspace tabs on reload. See terminal-restore.
  if (request.nextUrl.searchParams.get('archived') === '1') {
    try {
      return NextResponse.json({ archivedIds: listArchivedOrchestratorThreadIds() }, { headers: NO_STORE });
    } catch (error) {
      console.log('[mobile-orchestrator] archived id list failed', error);
      return NextResponse.json({ archivedIds: [] }, { headers: NO_STORE });
    }
  }

  // ?backend=<id> → only that backend's threads; otherwise → non-openclaw
  // threads (the default Orchestrator surface; untagged/legacy threads count
  // as non-openclaw). The runtime backend union includes Hermes/Collide.
  const rawBackend = request.nextUrl.searchParams.get('backend')?.trim() || null;
  if (rawBackend && !isOrchestratorBackendId(rawBackend)) {
    return NextResponse.json({ threads: [] }, { headers: NO_STORE });
  }
  const backend = rawBackend as MobileOrchestratorBackend | null;

  // ?limit=N — the lister already supports it (default stays 20); the desktop
  // rail passes a higher ceiling so long histories aren't silently truncated.
  const rawLimit = Number.parseInt(request.nextUrl.searchParams.get('limit') ?? '', 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 500) : undefined;
  const rawOffset = Number.parseInt(request.nextUrl.searchParams.get('offset') ?? '', 10);
  const offset = Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : undefined;

  try {
    const threads = listMobileOrchestratorThreads({ backend, limit, ...(offset === undefined ? {} : { offset }) });
    return NextResponse.json({ threads: threads.map(thread => {
      const subject = inboxSubject('conversation', thread.id, thread.repoPath, thread.projectId);
      const projection = inboxProjection(subject, null, undefined, legacyInboxPin(thread));
      // Additive sidebar context: owner/repo (or folder) and the worktree's live branch.
      const git = threadGitContext(thread.repoPath);
      const remoteSlug = thread.githubOwner && thread.githubRepo ? `${thread.githubOwner}/${thread.githubRepo}` : null;
      return { ...thread, ...projection, pinned: projection.pinnedAt != null,
        repoSlug: remoteSlug ?? git.repoSlug ?? thread.repoName, branch: git.branch ?? thread.repoBranch, runStartedAt: inboxRunStartedAt(subject) };
    }) }, { headers: NO_STORE });
  } catch (error) {
    console.log('[mobile-orchestrator] thread list failed', error);
    return NextResponse.json({ threads: [] }, { headers: NO_STORE });
  }
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as
    | {
        repoPath?: string;
        projectId?: unknown;
        title?: string | null;
        repoName?: string | null;
        repoBranch?: string | null;
        backend?: string | null;
        agent?: string | null;
        reveal?: boolean;
      }
    | null;

  if (!body || typeof body.repoPath !== 'string' || !body.repoPath.trim()) {
    return NextResponse.json({ error: 'repoPath is required' }, { status: 400, headers: NO_STORE });
  }

  const backend = body.backend === undefined || body.backend === null || body.backend === ''
    ? null
    : isOrchestratorBackendId(body.backend) ? body.backend : null;
  if (body.backend && !backend) {
    return NextResponse.json({ error: 'Invalid backend' }, { status: 400, headers: NO_STORE });
  }

  try {
    const thread = createMobileOrchestratorThread({
      repoPath: body.repoPath,
      projectId: body.projectId,
      title: body.title,
      repoName: body.repoName,
      repoBranch: body.repoBranch,
      backend,
      agent: body.agent,
      reveal: body.reveal,
    });
    return NextResponse.json({ thread }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof OrchestratorThreadProjectError) {
      return NextResponse.json({ error: error.toPayload() }, { status: 422, headers: NO_STORE });
    }
    const message = error instanceof Error ? error.message : 'Failed to create orchestrator thread.';
    return NextResponse.json({ error: message }, { status: 400, headers: NO_STORE });
  }
}
