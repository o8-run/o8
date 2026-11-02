import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveRepoPathFromRegistry } from '@/lib/repos/repo-path-registry';
import { autoCompactOrchestratorThread } from '@/lib/orchestrator/auto-compact';
import { isOrchestratorHomePath, resolveOrchestratorRepoPath } from '@/lib/orchestrator/repo-path';
import { readCompactionOperation } from '@/lib/orchestrator/compaction-status-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  const repoPath = request.nextUrl.searchParams.get('repoPath')?.trim() ?? '';
  const threadId = request.nextUrl.searchParams.get('threadId')?.trim() ?? '';
  if (!repoPath || !/^thoughts-[\w-]+$/.test(threadId)) return NextResponse.json({ error: 'repoPath and threadId are required' }, { status: 400 });
  const home = isOrchestratorHomePath(repoPath) ? resolveOrchestratorRepoPath(repoPath) : null;
  const resolved = home ? null : await resolveRepoPathFromRegistry(repoPath);
  if (resolved && !resolved.ok) return NextResponse.json({ error: resolved.message }, { status: resolved.status });
  const root = home ?? (resolved?.ok ? resolved.repoRoot : null);
  if (!root) return NextResponse.json({ error: 'Unable to resolve repoPath' }, { status: 400 });
  try {
    return NextResponse.json({ operation: await readCompactionOperation({ repoPath: root, threadId }) }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch {
    return NextResponse.json({ error: 'Compaction status could not be verified' }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = await request.json().catch(() => null) as {
    repoPath?: unknown;
    runningTotal?: unknown;
    contextSource?: unknown;
    messages?: unknown;
    threadId?: unknown;
    keepTailCount?: unknown;
    trigger?: unknown;
  } | null;
  const repoPath = typeof body?.repoPath === 'string' ? body.repoPath.trim() : '';
  if (!repoPath) {
    return NextResponse.json({ ok: false, error: 'repoPath is required' }, { status: 400 });
  }
  const threadId = typeof body?.threadId === 'string' ? body.threadId.trim() : '';
  if (!threadId.startsWith('thoughts-')) {
    return NextResponse.json({ ok: false, error: 'threadId is required' }, { status: 400 });
  }

  const resolvedHomePath = isOrchestratorHomePath(repoPath)
    ? resolveOrchestratorRepoPath(repoPath)
    : null;
  const resolved = resolvedHomePath ? null : await resolveRepoPathFromRegistry(repoPath);
  if (resolved && !resolved.ok) {
    return NextResponse.json({ ok: false, error: resolved.message }, { status: resolved.status });
  }
  const repoRoot = resolvedHomePath ?? (resolved?.ok ? resolved.repoRoot : null);
  if (!repoRoot) {
    return NextResponse.json({ ok: false, error: 'Unable to resolve repoPath' }, { status: 400 });
  }

  try {
    const result = await autoCompactOrchestratorThread({
      repoPath: repoRoot,
      threadId,
      runningTotal: typeof body?.runningTotal === 'number' ? body.runningTotal : undefined,
      contextSource: typeof body?.contextSource === 'string' ? body.contextSource : undefined,
      keepTailCount: typeof body?.keepTailCount === 'number' ? body.keepTailCount : undefined,
      trigger: body?.trigger === 'manual' || body?.trigger === 'handoff' ? body.trigger : 'auto',
    });
    return NextResponse.json({ ok: true, ...result }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Compaction failed',
    }, {
      status: 500,
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  }
}
