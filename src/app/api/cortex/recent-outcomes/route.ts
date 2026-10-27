/**
 * GET /api/cortex/recent-outcomes?repoPath=<absolute-path>&limit=3
 *
 * Read-only window into the `session_outcomes` ledger for a single repo.
 * Used by the Context Recall Card (#742) to show the last N outcomes for
 * the same repo a packet is targeting — a quick "what just happened on
 * this codebase" signal next to directives + symbol graph.
 *
 * Response shape:
 *   {
 *     ok: true,
 *     outcomes: Array<{
 *       id: string;
 *       outcome: 'succeeded' | 'failed' | 'partial' | 'interrupted'
 *         | 'adopted_elsewhere' | 'superseded' | 'spec_changed' | 'wontfix';
 *       summary: string;
 *       runtime: 'codex' | 'claude-code' | 'gemini' | 'opencode';
 *       branch: string | null;
 *       completedAt: string;
 *       reviewApproved: boolean | null;
 *       durationMs: number | null;
 *     }>;
 *   }
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';
import { getDb, sessionOutcomes } from '@/lib/db';
import { liveOutcomeFilter } from '@/lib/cortex/decay';
import { withTiming } from '@/lib/cortex/diagnostics';
import { getActiveProjectScopeForRepo } from '@/lib/repos/projects';

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  if (params.has('inventory')) {
    const { outcomeMemoryInventory } = await import('@/lib/cortex/outcome-memory');
    return outcomeMemoryInventory(request);
  }
  const repoPath = params.get('repoPath')?.trim() ?? '';
  if (!repoPath) {
    return NextResponse.json({ ok: false, error: 'repoPath is required.' }, { status: 400 });
  }
  const limitRaw = Number.parseInt(params.get('limit') ?? '3', 10);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(10, limitRaw)) : 3;
  const projectId = params.get('projectId')?.trim()
    || (await getActiveProjectScopeForRepo(repoPath)).projectId;

  const db = getDb();
  if (!db) {
    return NextResponse.json(
      { ok: true, outcomes: [] },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  }

  try {
    const rows = await withTiming('recall.recent-outcomes', () => db
      .select({
        id: sessionOutcomes.id,
        outcome: sessionOutcomes.outcome,
        summary: sessionOutcomes.summary,
        runtime: sessionOutcomes.runtime,
        branch: sessionOutcomes.branch,
        completedAt: sessionOutcomes.completedAt,
        reviewApproved: sessionOutcomes.reviewApproved,
        durationMs: sessionOutcomes.durationMs,
      })
      .from(sessionOutcomes)
      .where(and(
        eq(sessionOutcomes.repoPath, repoPath),
        eq(sessionOutcomes.projectId, projectId),
        liveOutcomeFilter(),
      ))
      .orderBy(desc(sessionOutcomes.completedAt))
      .limit(limit));

    return NextResponse.json(
      { ok: true, outcomes: rows },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load recent outcomes.';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const { deleteRetainedMemory } = await import('@/lib/cortex/forget');
  return deleteRetainedMemory(request, 'outcome');
}
