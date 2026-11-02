import { pendingNetworkQuestionCards } from '@/lib/bots/question-store';
import { NextResponse } from 'next/server';
import { serverTimingHeaders } from '@/lib/performance/server-timing';
import { bulkDismissInboxItems, dismissInboxItem, escalateInboxItem, listInboxItems, summarizeInboxItems } from '@/lib/supervisor/inbox';
import { readMaintainerFeed } from '@/lib/inbox/maintainer-feed';
import type { MaintainerFeed } from '@/lib/inbox/maintainer-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const startedAt = performance.now();
  const { searchParams } = new URL(request.url);
  let questions;
  if (searchParams.get('includeQuestions') === '1') {
    try { questions = pendingNetworkQuestionCards(searchParams.get('questionsRepoPath') || undefined); }
    catch { questions = { questionError: 'Local questions are unavailable. Refresh to retry.' }; }
  }
  if (searchParams.get('questionsOnly') === '1') return NextResponse.json(questions ?? {});
  const includeDismissed = searchParams.get('includeDismissed') === '1';
  const includeAllProjects = searchParams.get('scope') === 'all';
  const projectId = searchParams.get('projectId');
  const items = listInboxItems({ includeDismissed, includeAllProjects, projectId });
  let maintainer: MaintainerFeed | null = null;
  let maintainerError: string | null = null;
  if (searchParams.get('includeMaintainer') === '1') {
    try { maintainer = await readMaintainerFeed(searchParams.has('maintainerRepoPath') ? searchParams.getAll('maintainerRepoPath') : undefined); }
    catch { maintainerError = 'Connected GitHub data is unavailable. Try refreshing the inbox.'; }
  }
  return NextResponse.json(
    { items, ...questions, summary: summarizeInboxItems(items), ...(searchParams.get('includeMaintainer') === '1' ? { maintainer, maintainerError } : {}) },
    { headers: serverTimingHeaders(startedAt) },
  );
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const action = typeof body?.action === 'string' ? body.action : null;
  const id = typeof body?.id === 'string' ? body.id.trim() : null;

  if (action === 'dismiss' && id) {
    dismissInboxItem(id);
    return NextResponse.json({ ok: true });
  }
  if (action === 'escalate' && id) {
    // Handed to the orchestrator via "Add to orchestrator chat" — heal-bot
    // auto-resolves once the faulting packet's lane merges.
    escalateInboxItem(id);
    return NextResponse.json({ ok: true });
  }
  if (action === 'clear') {
    return NextResponse.json({ ok: true, dismissed: bulkDismissInboxItems() });
  }

  return NextResponse.json({ ok: false, error: 'Unknown action' }, { status: 400 });
}
