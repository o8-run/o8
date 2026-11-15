import { NextRequest, NextResponse } from 'next/server';

import { findLatestLaneByPacket, getLane } from '@/lib/lane/registry';
import { requirePanelAuth } from '@/lib/panel/auth';
import { rankArchitectureAttention } from '@/lib/review/architecture-attention';
import { ArchitectureDeltaInputError } from '@/lib/review/architecture-delta';
import { filterArchitectureResult } from '@/lib/review/architecture-scope';

import { ArchitectureReviewChangedError, buildArchitectureReviewTarget, buildLaneArchitectureReviewTarget } from '@/lib/review/architecture-review-target';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_SCOPE_PATHS = 6_000;
const MAX_PATH_LENGTH = 1_024;

interface AttentionBody {
  expectedAnalysisId?: unknown;
  scopePaths?: unknown;
}

function parseBody(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'A JSON object request body is required.' } as const;
  }
  const body = value as AttentionBody;
  const expectedAnalysisId = typeof body.expectedAnalysisId === 'string'
    ? body.expectedAnalysisId.trim()
    : '';
  if (!/^[a-f0-9]{24}$/.test(expectedAnalysisId)) {
    return { error: 'A valid architecture analysis id is required.' } as const;
  }
  if (!Array.isArray(body.scopePaths) || body.scopePaths.length === 0 || body.scopePaths.length > MAX_SCOPE_PATHS) {
    return { error: 'Review scope paths are invalid.' } as const;
  }
  const scopePaths = body.scopePaths.filter((value): value is string => (
    typeof value === 'string' && value.length > 0 && value.length <= MAX_PATH_LENGTH
  ));
  if (scopePaths.length !== body.scopePaths.length) {
    return { error: 'Review scope paths are invalid.' } as const;
  }
  return { expectedAnalysisId, scopePaths: [...new Set(scopePaths)] } as const;
}

async function analyzeRequestTarget(laneId: string | null, workspace: string | null, params: URLSearchParams) {
  if (laneId) {
    const lane = getLane(laneId) ?? findLatestLaneByPacket(laneId);
    if (!lane) return { error: 'No review lane found for that id or packet.', status: 404 } as const;
    return buildLaneArchitectureReviewTarget(lane, params);
  }
  if (!workspace) return { error: 'A review lane or workspace is required.', status: 400 } as const;
  return { result: await buildArchitectureReviewTarget(workspace, params), repoPath: workspace } as const;
}

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const laneId = request.nextUrl.searchParams.get('lane')?.trim() || null;
  const workspace = request.nextUrl.searchParams.get('workspace')?.trim() || null;
  if (!laneId && !workspace) {
    return NextResponse.json({ ok: false, error: 'A review lane or workspace is required.' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'A JSON request body is required.' }, { status: 400 });
  }
  const parsed = parseBody(body);
  if ('error' in parsed) {
    return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  }

  try {
    const analyzed = await analyzeRequestTarget(laneId, workspace, request.nextUrl.searchParams);
    if ('error' in analyzed) {
      return NextResponse.json({ ok: false, error: analyzed.error }, { status: analyzed.status });
    }
    if (analyzed.result.analysisId !== parsed.expectedAnalysisId) {
      return NextResponse.json({
        ok: false,
        error: 'Architecture evidence changed while the advisory lens was loading.',
        kind: 'stale_analysis',
      }, { status: 409 });
    }
    const scoped = filterArchitectureResult(analyzed.result, parsed.scopePaths);
    return NextResponse.json(await rankArchitectureAttention(scoped, { laneId, repoPath: analyzed.repoPath! }), {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to build the advisory review lens.';
    const status = error instanceof ArchitectureReviewChangedError ? 409 : error instanceof ArchitectureDeltaInputError ? 400 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
