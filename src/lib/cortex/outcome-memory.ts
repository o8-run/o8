import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { getSqlite } from '@/lib/db';

/** The operator inventory includes expired memory and inactive projects. Recent recall remains live-only. */
export function outcomeMemoryInventory(request: NextRequest) {
  const headers = { 'Cache-Control': 'no-store' };
  if (resolveRequestPrincipal(request) !== 'operator') return NextResponse.json({ ok: false, error: 'Operator authority is required.' }, { status: 403, headers });
  const params = request.nextUrl.searchParams;
  const offset = Number(params.get('offset') ?? 0), limit = Number(params.get('limit') ?? 50);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    return NextResponse.json({ ok: false, error: 'Use a nonnegative offset and a limit from 1 to 100.' }, { status: 400, headers });
  }
  try {
    const repos = params.getAll('repoPath').map(value => value.trim()).filter(Boolean).map(value => path.resolve(value));
    const rows = getSqlite().prepare(`SELECT id, project_id AS projectId, repo_path AS repoPath, runtime,
      outcome, summary, completed_at AS completedAt, valid_to AS validTo
      FROM session_outcomes
      WHERE (@repos = '[]' OR repo_path IN (SELECT value FROM json_each(@repos)))
        AND (@allProjects OR project_id IS @projectId)
        AND (@query = '' OR instr(lower(COALESCE(summary, '') || ' ' || outcome || ' ' || runtime), @query) > 0)
      ORDER BY completed_at DESC, id LIMIT @limit OFFSET @offset
    `).all({ repos: JSON.stringify(repos), allProjects: Number(!params.has('projectId')),
      projectId: params.get('projectId')?.trim() || null,
      query: (params.get('query') ?? '').toLowerCase(), offset, limit: limit + 1 });
    return NextResponse.json({ ok: true, outcomes: rows.slice(0, limit), hasMore: rows.length > limit }, { headers });
  } catch {
    return NextResponse.json({ ok: false, error: 'Could not load retained outcomes. Try again.' }, { status: 500, headers });
  }
}
